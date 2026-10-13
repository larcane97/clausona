import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { getAdapter } from "../tools/registry.js";
import type { ToolCredential } from "../tools/types.js";
import type { QuotaSnapshot, QuotaWindows, ToolName } from "../types.js";
import { checkBaseUrl } from "./api-url.js";
import { acquireFileLock } from "./file-lock.js";
import { cooldownUntil, isFresh, QUOTA_TIMEOUT_MS, QuotaHttpError } from "./quota.js";
import type { Budget } from "./route-budgets.js";
import { budgetWindow, periodStart, readSpend, type SpendEndpoint, withBaselines } from "./spend.js";

const DEFAULT_CACHE_PATH = path.join(homedir(), ".clausona", "quota.json");

/** Renew a hair before expiry so a token cannot lapse mid-request. */
const RENEW_MARGIN_MS = 60 * 1000;

/** A lock older than this is treated as abandoned by a crashed process. */
const LOCK_STALE_MS = 60 * 1000;

type QuotaCache = {
  version: 1;
  /**
   * ms epoch until which an endpoint is left alone after a 429: a tool's usage endpoint, by the
   * tool's name, or an API profile's provider, by the profile's id.
   */
  cooldowns: Record<string, number>;
  profiles: Record<string, QuotaSnapshot>;
};

// Must build a fresh object every call: a shared constant would be spread shallowly,
// leaving every caller mutating the same `cooldowns` and `profiles` maps.
function emptyCache(): QuotaCache {
  return { version: 1, cooldowns: {}, profiles: {} };
}

async function readCache(cachePath: string): Promise<QuotaCache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<QuotaCache>;
    if (parsed.version !== 1) return emptyCache();
    return {
      version: 1,
      cooldowns: parsed.cooldowns ?? {},
      profiles: parsed.profiles ?? {},
    };
  } catch {
    return emptyCache();
  }
}

async function writeCache(cachePath: string, cache: QuotaCache): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(tmpPath, cachePath);
  } catch {
    // A quota cache that cannot be persisted only costs an extra fetch next time.
  }
}

function windowsOf(snapshot: QuotaSnapshot): QuotaWindows {
  return {
    session: snapshot.session,
    weekly: snapshot.weekly,
    scoped: snapshot.scoped,
    ...(snapshot.scopedLimits ? { scopedLimits: snapshot.scopedLimits } : {}),
  };
}

function hasWindows(snapshot: QuotaSnapshot | undefined): snapshot is QuotaSnapshot {
  return Boolean(snapshot && (snapshot.session ?? snapshot.weekly ?? snapshot.scoped));
}

/**
 * Reports a failure without throwing away what was last known. The numbers stay
 * attached (stamped with when they were true) so the UI can dim them rather than
 * blanking the row, while `state` explains why they were not refreshed.
 */
function degraded(state: QuotaSnapshot["state"], cached: QuotaSnapshot | undefined, now: number): QuotaSnapshot {
  if (hasWindows(cached)) return { ...windowsOf(cached), state, fetchedAt: cached.fetchedAt };
  return { state, fetchedAt: now };
}

/**
 * Serializes renewal per profile. Two processes renewing the same credential would
 * each rotate the refresh token, and whichever wrote first would be left holding a
 * token the provider has already invalidated.
 */
async function withRenewalLock<T>(lockDir: string, profileId: string, fn: () => Promise<T>): Promise<T | null> {
  const key = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 16);
  // A lock that cannot be created at all - a locks directory clausona may not write - skips
  // the renewal as a held one does, rather than failing the quota read.
  const release = await acquireFileLock(path.join(lockDir, `${key}.lock`), { staleMs: LOCK_STALE_MS }).catch(
    () => null,
  );
  if (!release) return null;

  try {
    return await fn();
  } finally {
    await release();
  }
}

export type QuotaTarget = {
  id: string;
  tool: ToolName;
  configDir: string;
  /** An API profile's: its spend is read from its provider, instead of plan quota from the tool's. */
  api?: ApiQuotaTarget;
};

export type ApiQuotaTarget = SpendEndpoint & {
  /**
   * Resolves the profile's key; called only when the cache cannot answer. `signal` aborts when
   * the reading's time is up, and whatever it started for the key is then to be stopped.
   */
  readKey: (signal: AbortSignal) => Promise<string>;
  /** The clausona budget, which replaces the provider key's limit. */
  budget?: Budget;
};

/** The endpoint a 429 pauses: the tool's usage endpoint, or the API profile's own provider. */
const cooldownKey = (target: QuotaTarget) => (target.api ? target.id : target.tool);

/**
 * Renews under a lock, returning null when renewal is impossible or another process
 * already holds the lock. Errors are contained: a profile that cannot be renewed is
 * reported as expired rather than failing the whole listing.
 */
async function renewCredential(
  target: QuotaTarget,
  credential: ToolCredential,
  signal: AbortSignal,
  lockDir: string,
): Promise<ToolCredential | null> {
  const adapter = getAdapter(target.tool);
  if (!adapter.renewCredential || !credential.refreshToken) return null;

  return withRenewalLock(lockDir, target.id, async () => {
    try {
      return (await adapter.renewCredential?.(target.configDir, credential, signal)) ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * A spend read that failed: the last reading's spend kept, for the periods it counts from, and
 * nothing a route can use, since `state` says why it is not current.
 */
function unread(state: QuotaSnapshot["state"], cached: QuotaSnapshot | undefined, now: number): QuotaSnapshot {
  if (!cached?.spend) return { state, fetchedAt: now };
  return {
    state,
    fetchedAt: cached.fetchedAt,
    spend: cached.spend,
    ...(cached.budget ? { budget: cached.budget } : {}),
  };
}

/**
 * An API profile's snapshot with its `budget` window worked out again for the limit that applies
 * now: a budget set or cleared since the reading counts at once.
 */
function withBudget(snapshot: QuotaSnapshot, api: ApiQuotaTarget, now: number): QuotaSnapshot {
  if (snapshot.state !== "ok" || !snapshot.spend) return snapshot;
  const { budget: _old, ...rest } = snapshot;
  const budget = budgetWindow(snapshot.spend, api.budget, now);
  return budget ? { ...rest, budget } : rest;
}

/** Settles as `promise` does, or rejects once `signal` aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("aborted"));
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * Reads an API profile's spend, as fetchOne reads plan quota, and the same failures say the same.
 * The key is read within the reading's time: a key command that hangs (a vault waiting to be
 * unlocked) is stopped with it, and the profile is left out of that run rather than holding up
 * the others. A base URL that could never be asked is refused before any key is read.
 */
async function fetchSpend(
  target: QuotaTarget & { api: ApiQuotaTarget },
  cached: QuotaSnapshot | undefined,
  now: number,
  fetchImpl: typeof fetch,
): Promise<{ snapshot: QuotaSnapshot; cooldown?: number }> {
  if (!checkBaseUrl(target.api.baseUrl).ok) return { snapshot: unread("error", cached, now) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
  let key: string;
  try {
    key = await untilAborted(target.api.readKey(controller.signal), controller.signal);
  } catch {
    clearTimeout(timer);
    return { snapshot: unread("missing", cached, now) };
  }
  try {
    const reading = await readSpend(target.api, key, { fetch: fetchImpl, signal: controller.signal, now });
    // Kept like any failure, so that a run does not ask again on every launch, and with the last
    // spend reported, whose periods' baselines a later reading counts from.
    if (!reading) {
      return {
        snapshot: {
          state: "error",
          fetchedAt: now,
          noSpendReading: true,
          ...(cached?.spend ? { spend: cached.spend } : {}),
        },
      };
    }
    const spend = {
      ...withBaselines(reading, cached?.spend, now, cached?.spend?.takenAt ?? cached?.fetchedAt),
      takenAt: now,
    };
    return { snapshot: withBudget({ state: "ok", fetchedAt: now, spend }, target.api, now) };
  } catch (error) {
    if (error instanceof QuotaHttpError) {
      if (error.status === 401 || error.status === 403) return { snapshot: unread("expired", cached, now) };
      if (error.status === 429) {
        return { snapshot: unread("cooldown", cached, now), cooldown: cooldownUntil(error.retryAfter, now) };
      }
    }
    return { snapshot: unread("error", cached, now) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(
  target: QuotaTarget,
  cache: QuotaCache,
  now: number,
  allowRenew: boolean,
  lockDir: string,
  fetchImpl: typeof fetch,
): Promise<{ snapshot: QuotaSnapshot; cooldown?: number }> {
  const cached = cache.profiles[target.id];
  if (target.api) return fetchSpend({ ...target, api: target.api }, cached, now, fetchImpl);
  const adapter = getAdapter(target.tool);

  if (!adapter.readCredential || !adapter.fetchQuota) {
    return { snapshot: degraded("missing", cached, now) };
  }

  let credential = await adapter.readCredential(target.configDir);
  if (!credential) {
    return { snapshot: degraded("missing", cached, now) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);

  // At most one renewal per lookup, so a profile whose refresh token is also dead
  // cannot spin.
  let renewed = false;

  const renew = async (): Promise<boolean> => {
    if (!allowRenew || renewed) return false;
    renewed = true;
    const next = await renewCredential(target, credential as ToolCredential, controller.signal, lockDir);
    if (!next) return false;
    credential = next;
    return true;
  };

  try {
    // A lapsed access token can still be renewed from the refresh token, so this is
    // worth doing rather than reporting expired straight away.
    if (credential.expiresAt !== undefined && credential.expiresAt <= now + RENEW_MARGIN_MS) {
      if (!(await renew())) return { snapshot: degraded("expired", cached, now) };
    }

    for (;;) {
      try {
        const windows = await adapter.fetchQuota(credential, controller.signal);
        if (!windows) return { snapshot: degraded("error", cached, now) };
        return { snapshot: { ...windows, state: "ok", fetchedAt: now } };
      } catch (error) {
        if (error instanceof QuotaHttpError) {
          // A token can be rejected while still looking valid by the clock — revoked
          // elsewhere, or skew — so a 401 earns one renewal attempt too.
          if (error.status === 401 || error.status === 403) {
            if (await renew()) continue;
            return { snapshot: degraded("expired", cached, now) };
          }
          if (error.status === 429) {
            return {
              snapshot: degraded("cooldown", cached, now),
              cooldown: cooldownUntil(error.retryAfter, now),
            };
          }
        }
        return { snapshot: degraded("error", cached, now) };
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves quota for every target, preferring the on-disk cache and touching the
 * network only for entries that are stale and whose endpoint is not cooling down.
 * Never throws and never rejects: a profile that cannot be resolved comes back with
 * a failure state instead. `refresh` reads every entry again; `refreshBefore` (ms epoch)
 * only those fetched before then, so a reading another process took since is reused.
 *
 * An API profile's target reads its spend instead (spend.ts), with `fetch` - the global one
 * unless given - and comes back with a `budget` window for the limit that applies. A cached
 * reading from before its budget's period began is read again.
 */
export async function collectQuotas(
  targets: QuotaTarget[],
  options: {
    refresh?: boolean;
    refreshBefore?: number;
    renew?: boolean;
    now?: number;
    cachePath?: string;
    fetch?: typeof fetch;
  } = {},
): Promise<Record<string, QuotaSnapshot>> {
  if (targets.length === 0) return {};

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const cache = await readCache(cachePath);
  const result: Record<string, QuotaSnapshot> = {};

  const pending: QuotaTarget[] = [];
  // An API profile's window worked out again for a budget set or cleared since its reading: kept,
  // so that `list` and the dashboard, which read only the cache, show the limit that counts now.
  let rewound = false;
  for (const target of targets) {
    const cached = cache.profiles[target.id];
    const budget = target.api?.budget;
    const outdated = (snapshot: QuotaSnapshot) =>
      options.refresh ||
      snapshot.fetchedAt < (options.refreshBefore ?? Number.NEGATIVE_INFINITY) ||
      (budget !== undefined && snapshot.fetchedAt < Date.parse(periodStart(now, budget.per)));
    if (cached && !outdated(cached) && isFresh(cached, now)) {
      const served = target.api ? withBudget(cached, target.api, now) : cached;
      if (served !== cached && !isDeepStrictEqual(served.budget, cached.budget)) {
        cache.profiles[target.id] = served;
        rewound = true;
      }
      result[target.id] = served;
      continue;
    }

    const cooldownUntilMs = cache.cooldowns[cooldownKey(target)] ?? 0;
    if (cooldownUntilMs > now) {
      result[target.id] = target.api ? unread("cooldown", cached, now) : degraded("cooldown", cached, now);
      continue;
    }

    pending.push(target);
  }

  if (pending.length === 0) {
    if (rewound) await writeCache(cachePath, cache);
    return result;
  }

  const allowRenew = options.renew ?? true;
  const lockDir = path.join(path.dirname(cachePath), "locks");
  const fetchImpl = options.fetch ?? fetch;
  const settled = await Promise.all(
    pending.map((target) => fetchOne(target, cache, now, allowRenew, lockDir, fetchImpl)),
  );

  pending.forEach((target, index) => {
    const { snapshot, cooldown } = settled[index];
    result[target.id] = snapshot;
    cache.profiles[target.id] = snapshot;
    if (cooldown !== undefined) {
      // One 429 pauses the whole tool: the limit is per-IP, not per-account, so
      // retrying with a different profile's token would only extend the block. An API
      // profile's provider is its own, and pauses only that profile.
      const key = cooldownKey(target);
      cache.cooldowns[key] = Math.max(cache.cooldowns[key] ?? 0, cooldown);
    }
  });

  await writeCache(cachePath, cache);
  return result;
}

/**
 * What the cache holds for these profiles, with nothing fetched and no key read: how `list` and
 * the dashboard show an API profile's last spend reading.
 */
export async function cachedQuotas(
  ids: string[],
  options: { cachePath?: string } = {},
): Promise<Record<string, QuotaSnapshot>> {
  if (ids.length === 0) return {};
  const cache = await readCache(options.cachePath ?? DEFAULT_CACHE_PATH);
  return Object.fromEntries(ids.flatMap((id) => (Object.hasOwn(cache.profiles, id) ? [[id, cache.profiles[id]]] : [])));
}
