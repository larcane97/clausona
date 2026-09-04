import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { getAdapter } from "../tools/registry.js";
import type { ToolCredential } from "../tools/types.js";
import type { QuotaSnapshot, QuotaWindows, ToolName } from "../types.js";
import { cooldownUntil, isFresh, QUOTA_TIMEOUT_MS, QuotaHttpError } from "./quota.js";

const DEFAULT_CACHE_PATH = path.join(homedir(), ".clausona", "quota.json");

/** Renew a hair before expiry so a token cannot lapse mid-request. */
const RENEW_MARGIN_MS = 60 * 1000;

/** A lock older than this is treated as abandoned by a crashed process. */
const LOCK_STALE_MS = 60 * 1000;

type QuotaCache = {
  version: 1;
  /** ms epoch until which a tool's endpoint is left alone after a 429. */
  cooldowns: Partial<Record<ToolName, number>>;
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
  return { session: snapshot.session, weekly: snapshot.weekly, scoped: snapshot.scoped };
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
  const lockPath = path.join(lockDir, `${key}.lock`);
  await mkdir(lockDir, { recursive: true }).catch(() => {});

  const acquire = async () => {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  if (!(await acquire())) {
    const age = await stat(lockPath)
      .then((info) => Date.now() - info.mtimeMs)
      .catch(() => Number.POSITIVE_INFINITY);
    // Only reclaim a lock old enough that its owner cannot still be mid-renewal.
    if (age < LOCK_STALE_MS) return null;
    await rm(lockPath, { force: true }).catch(() => {});
    if (!(await acquire())) return null;
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

export type QuotaTarget = {
  id: string;
  tool: ToolName;
  configDir: string;
};

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

async function fetchOne(
  target: QuotaTarget,
  cache: QuotaCache,
  now: number,
  allowRenew: boolean,
  lockDir: string,
): Promise<{ snapshot: QuotaSnapshot; cooldown?: number }> {
  const cached = cache.profiles[target.id];
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
 * a failure state instead.
 */
export async function collectQuotas(
  targets: QuotaTarget[],
  options: { refresh?: boolean; renew?: boolean; now?: number; cachePath?: string } = {},
): Promise<Record<string, QuotaSnapshot>> {
  if (targets.length === 0) return {};

  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const cache = await readCache(cachePath);
  const result: Record<string, QuotaSnapshot> = {};

  const pending: QuotaTarget[] = [];
  for (const target of targets) {
    const cached = cache.profiles[target.id];
    if (cached && !options.refresh && isFresh(cached, now)) {
      result[target.id] = cached;
      continue;
    }

    const cooldownUntilMs = cache.cooldowns[target.tool] ?? 0;
    if (cooldownUntilMs > now) {
      result[target.id] = degraded("cooldown", cached, now);
      continue;
    }

    pending.push(target);
  }

  if (pending.length === 0) return result;

  const allowRenew = options.renew ?? true;
  const lockDir = path.join(path.dirname(cachePath), "locks");
  const settled = await Promise.all(pending.map((target) => fetchOne(target, cache, now, allowRenew, lockDir)));

  pending.forEach((target, index) => {
    const { snapshot, cooldown } = settled[index];
    result[target.id] = snapshot;
    cache.profiles[target.id] = snapshot;
    if (cooldown !== undefined) {
      // One 429 pauses the whole tool: the limit is per-IP, not per-account, so
      // retrying with a different profile's token would only extend the block.
      cache.cooldowns[target.tool] = Math.max(cache.cooldowns[target.tool] ?? 0, cooldown);
    }
  });

  await writeCache(cachePath, cache);
  return result;
}
