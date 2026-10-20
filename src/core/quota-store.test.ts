import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { ToolAdapter, ToolCredential } from "../tools/types.js";
import type { QuotaSnapshot } from "../types.js";
import { QUOTA_FRESH_MS, QUOTA_TIMEOUT_MS, QuotaHttpError } from "./quota.js";

const getAdapter = vi.hoisted(() => vi.fn());
vi.mock("../tools/registry.js", () => ({ getAdapter }));

const { cachedQuotas, collectQuotas, forgetQuota } = await import("./quota-store.js");

const NOW = 1_800_000_000_000;
const TARGET = { id: "claude:work", tool: "claude" as const, configDir: "/tmp/.claude-work" };

let tmp: string;
let cachePath: string;

function seedCache(contents: unknown) {
  writeFileSync(cachePath, JSON.stringify(contents), "utf8");
}

function readCacheFile() {
  return JSON.parse(readFileSync(cachePath, "utf8"));
}

/** A stand-in adapter whose credential and fetch behaviour each test decides. */
function stubAdapter(overrides: Partial<ToolAdapter> = {}) {
  const adapter = {
    readCredential: vi.fn(async (): Promise<ToolCredential | null> => ({ accessToken: "t", refreshToken: "r" })),
    fetchQuota: vi.fn(async () => ({ session: { usedPercent: 5, resetsAt: null } })),
    ...overrides,
  } as unknown as ToolAdapter;
  getAdapter.mockReturnValue(adapter);
  return adapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(path.join(tmpdir(), "clausona-quota-"));
  cachePath = path.join(tmp, "quota.json");
  return () => rmSync(tmp, { recursive: true, force: true });
});

describe("collectQuotas", () => {
  it("fetches and caches when there is nothing on disk", async () => {
    const adapter = stubAdapter();

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
    expect(result[TARGET.id]).toMatchObject({ state: "ok", session: { usedPercent: 5 } });
    expect(readCacheFile().profiles[TARGET.id].state).toBe("ok");
  });

  it("serves a recent snapshot without touching the network", async () => {
    const adapter = stubAdapter();
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: { [TARGET.id]: { state: "ok", fetchedAt: NOW - 60_000, weekly: { usedPercent: 42, resetsAt: null } } },
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.weekly?.usedPercent).toBe(42);
  });

  it("re-fetches a recent snapshot when refresh is requested", async () => {
    const adapter = stubAdapter();
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: { [TARGET.id]: { state: "ok", fetchedAt: NOW - 60_000, weekly: { usedPercent: 42, resetsAt: null } } },
    });

    await collectQuotas([TARGET], { now: NOW, cachePath, refresh: true });

    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it("never calls the endpoint without a credential", async () => {
    const adapter = stubAdapter({ readCredential: vi.fn(async () => null) });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.state).toBe("missing");
  });

  it("renews a lapsed credential instead of giving up on it", async () => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new", refreshToken: "r2", expiresAt: NOW + 8 * 3600_000 })),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.renewCredential).toHaveBeenCalledTimes(1);
    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
    // The renewed credential, not the lapsed one, is what reaches the endpoint.
    expect((adapter.fetchQuota as Mock).mock.calls[0][0]).toMatchObject({ accessToken: "new" });
    expect(result[TARGET.id]?.state).toBe("ok");
  });

  it("reports expired when renewal fails", async () => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => {
        throw new QuotaHttpError(400);
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.state).toBe("expired");
  });

  it.each([
    400, 401, 403,
  ])("reports expired when the token endpoint refuses the refresh token with a %i", async (status) => {
    stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => {
        throw new QuotaHttpError(status);
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("expired");
  });

  // Only a refusal says the sign-in is gone. A renewal that could not be asked this time says
  // nothing about it, so the account keeps its last numbers, as for any failed lookup, rather
  // than reading as one to sign in again: `csn list` hides an expired account's numbers.
  it.each<[string, () => Promise<ToolCredential | null>]>([
    ["a running Claude Code holds its refresh lock", async () => null],
    [
      "the token endpoint cannot be reached",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "the token endpoint fails",
      async () => {
        throw new QuotaHttpError(503);
      },
    ],
    [
      "the token endpoint is rate limited",
      async () => {
        throw new QuotaHttpError(429);
      },
    ],
  ])("reports an error, not expired, when %s", async (_, renew) => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(renew),
    });
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: {
        [TARGET.id]: { state: "ok", fetchedAt: NOW - 30 * 60_000, weekly: { usedPercent: 42, resetsAt: null } },
      },
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]).toMatchObject({ state: "error", weekly: { usedPercent: 42 } });
  });

  it("reports an error, not expired, when a 401's renewal could not be asked", async () => {
    stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW + 3600_000 })),
      renewCredential: vi.fn(async () => null),
      fetchQuota: vi.fn(async () => {
        throw new QuotaHttpError(401);
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("error");
  });

  it("does not renew a credential with no refresh token", async () => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new" })),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.renewCredential).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.state).toBe("expired");
  });

  it("leaves a lapsed credential alone when renewal is disabled", async () => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new" })),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath, renew: false });

    expect(adapter.renewCredential).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.state).toBe("expired");
  });

  it("renews once on a 401 from a credential that still looked valid", async () => {
    const fetchQuota = vi
      .fn()
      .mockRejectedValueOnce(new QuotaHttpError(401))
      .mockResolvedValueOnce({ session: { usedPercent: 5, resetsAt: null } });
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW + 3600_000 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new", refreshToken: "r2" })),
      fetchQuota,
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.renewCredential).toHaveBeenCalledTimes(1);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
    expect(result[TARGET.id]?.state).toBe("ok");
  });

  it("renews at most once, so a still-rejected token cannot spin", async () => {
    const fetchQuota = vi.fn().mockRejectedValue(new QuotaHttpError(401));
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW + 3600_000 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new", refreshToken: "r2" })),
      fetchQuota,
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.renewCredential).toHaveBeenCalledTimes(1);
    expect(fetchQuota).toHaveBeenCalledTimes(2);
    expect(result[TARGET.id]?.state).toBe("expired");
  });

  it("maps a 401 to expired but keeps the last known numbers", async () => {
    stubAdapter({
      fetchQuota: vi.fn(async () => {
        throw new QuotaHttpError(401);
      }),
    });
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: {
        [TARGET.id]: { state: "ok", fetchedAt: NOW - 30 * 60_000, weekly: { usedPercent: 42, resetsAt: null } },
      },
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]).toMatchObject({ state: "expired", weekly: { usedPercent: 42 } });
    // fetchedAt still points at when those numbers were true, not at this attempt.
    expect(result[TARGET.id]?.fetchedAt).toBe(NOW - 30 * 60_000);
  });

  it("records a tool-wide cooldown from a 429 Retry-After", async () => {
    stubAdapter({
      fetchQuota: vi.fn(async () => {
        throw new QuotaHttpError(429, "3600");
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("cooldown");
    expect(readCacheFile().cooldowns.claude).toBe(NOW + 3_600_000);
  });

  it("makes no request at all while the tool is cooling down", async () => {
    const adapter = stubAdapter();
    seedCache({
      version: 1,
      cooldowns: { claude: NOW + 60_000 },
      profiles: {
        [TARGET.id]: { state: "ok", fetchedAt: NOW - 30 * 60_000, weekly: { usedPercent: 42, resetsAt: null } },
      },
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]).toMatchObject({ state: "cooldown", weekly: { usedPercent: 42 } });
  });

  it("asked to refresh while cooling down, still makes no request and keeps every scoped limit", async () => {
    const adapter = stubAdapter();
    const opus = { usedPercent: 100, resetsAt: null, label: "Opus" };
    seedCache({
      version: 1,
      cooldowns: { claude: NOW + 60_000 },
      profiles: {
        [TARGET.id]: { state: "ok", fetchedAt: NOW - 60_000, scoped: opus, scopedLimits: [opus] },
      },
    });

    const result = await collectQuotas([TARGET], { refresh: true, now: NOW, cachePath });

    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(result[TARGET.id]).toMatchObject({ state: "cooldown", scopedLimits: [opus] });
  });

  it("resumes fetching once the cooldown has elapsed", async () => {
    const adapter = stubAdapter();
    seedCache({ version: 1, cooldowns: { claude: NOW - 1 }, profiles: {} });

    await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it("one profile's 429 stops the rest of that tool's fetches from being retried later", async () => {
    stubAdapter({
      fetchQuota: vi.fn(async () => {
        throw new QuotaHttpError(429, "600");
      }),
    });
    const second = { id: "claude:other", tool: "claude" as const, configDir: "/tmp/.claude-other" };

    await collectQuotas([TARGET, second], { now: NOW, cachePath });

    expect(readCacheFile().cooldowns.claude).toBe(NOW + 600_000);
  });

  it("degrades to error on an unexpected status", async () => {
    stubAdapter({
      fetchQuota: vi.fn(async () => {
        throw new QuotaHttpError(500);
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("error");
    expect(readCacheFile().cooldowns).toEqual({});
  });

  it("degrades to error when the request throws or times out", async () => {
    stubAdapter({
      fetchQuota: vi.fn(async () => {
        throw new Error("aborted");
      }),
    });

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("error");
  });

  it("ignores a cache file it cannot understand", async () => {
    const adapter = stubAdapter();
    writeFileSync(cachePath, "{ not json", "utf8");

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
    expect(result[TARGET.id]?.state).toBe("ok");
  });

  it("lets only one concurrent renewal through, so the token rotates once", async () => {
    // Two clausona processes hitting the same lapsed profile: the loser must not
    // fire a second rotation, which would invalidate whatever the winner just stored.
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { accessToken: "new", refreshToken: "r2", expiresAt: NOW + 8 * 3600_000 };
      }),
    });

    const [a, b] = await Promise.all([
      collectQuotas([TARGET], { now: NOW, cachePath }),
      collectQuotas([TARGET], { now: NOW, cachePath }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(adapter.renewCredential).toHaveBeenCalledTimes(1);
    // The one that could not take the lock backs off rather than rotating anyway, and its
    // reading failed for that moment only: the sign-in is the one the other just renewed.
    expect([a[TARGET.id]?.state, b[TARGET.id]?.state].sort()).toEqual(["error", "ok"]);
  });

  it("does no work for an empty target list", async () => {
    const adapter = stubAdapter();

    expect(await collectQuotas([], { now: NOW, cachePath })).toEqual({});
    expect(adapter.readCredential).not.toHaveBeenCalled();
  });

  it("treats a tool with no quota support as missing", async () => {
    getAdapter.mockReturnValue({} as ToolAdapter);

    const result: Record<string, QuotaSnapshot> = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(result[TARGET.id]?.state).toBe("missing");
  });
});

/**
 * A profile's store can hold another account's sign-in, and the usage endpoint answers for whoever
 * the token is: those numbers sat beside the profile's own name (#207).
 */
describe("collectQuotas: whose sign-in a reading was taken with", () => {
  const OWN = { ...TARGET, account: "work@example.com" };
  const reading = { session: { usedPercent: 37, resetsAt: null }, weekly: { usedPercent: 81, resetsAt: null } };

  function stubSignedInAs(account: string | null, accessToken = "t") {
    return stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken, refreshToken: "r" })),
      fetchQuota: vi.fn(async () => reading),
      credentialAccount: vi.fn(async () => account),
    });
  }

  it("keeps none of another account's numbers, and says whose sign-in it found", async () => {
    stubSignedInAs("other@example.com");

    const result = await collectQuotas([OWN], { now: NOW, cachePath });

    expect(result[OWN.id]).toEqual({ state: "other_account", fetchedAt: NOW, signedInAs: "other@example.com" });
    expect(readCacheFile().profiles[OWN.id]).toEqual(result[OWN.id]);
  });

  it("keeps the reading of the account the profile is registered to", async () => {
    // Addresses compare case-insensitively, as `clausona login` compares them.
    stubSignedInAs("Work@Example.com");

    const result = await collectQuotas([OWN], { now: NOW, cachePath });

    expect(result[OWN.id]).toEqual({ ...reading, state: "ok", fetchedAt: NOW });
  });

  it("keeps the reading when the account cannot be told, and asks again next time", async () => {
    const adapter = stubSignedInAs(null);

    const first = await collectQuotas([OWN], { now: NOW, cachePath });
    await collectQuotas([OWN], { now: NOW, cachePath, refresh: true });

    expect(first[OWN.id]?.state).toBe("ok");
    expect(adapter.credentialAccount).toHaveBeenCalledTimes(2);
    expect(readCacheFile().identities).toEqual({});
  });

  it("asks once per token, and keeps a hash of it rather than the token", async () => {
    const adapter = stubSignedInAs("other@example.com", "token-one");

    await collectQuotas([OWN], { now: NOW, cachePath });
    const again = await collectQuotas([OWN], { now: NOW, cachePath, refresh: true });

    expect(adapter.credentialAccount).toHaveBeenCalledTimes(1);
    expect(again[OWN.id]).toMatchObject({ state: "other_account", signedInAs: "other@example.com" });
    const cacheText = readFileSync(cachePath, "utf8");
    expect(cacheText).not.toContain("token-one");
    expect(readCacheFile().identities[OWN.id]).toEqual({
      token: expect.stringMatching(/^[0-9a-f]{16}$/),
      account: "other@example.com",
    });
  });

  it("asks again about a new token", async () => {
    stubSignedInAs("other@example.com", "token-one");
    await collectQuotas([OWN], { now: NOW, cachePath });

    // Signed in again, to the right account this time.
    const adapter = stubSignedInAs("work@example.com", "token-two");
    const result = await collectQuotas([OWN], { now: NOW, cachePath, refresh: true });

    expect(adapter.credentialAccount).toHaveBeenCalledTimes(1);
    expect(result[OWN.id]?.state).toBe("ok");
  });

  it("checks the renewed credential, the one the numbers were read with", async () => {
    const adapter = stubAdapter({
      readCredential: vi.fn(async () => ({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 })),
      renewCredential: vi.fn(async () => ({ accessToken: "new", refreshToken: "r2", expiresAt: NOW + 3600_000 })),
      fetchQuota: vi.fn(async () => reading),
      credentialAccount: vi.fn(async () => "work@example.com"),
    });

    await collectQuotas([OWN], { now: NOW, cachePath });

    expect((adapter.credentialAccount as Mock).mock.calls[0][0]).toMatchObject({ accessToken: "new" });
  });

  it("asks nothing for a profile with no registered account", async () => {
    const adapter = stubSignedInAs("other@example.com");

    const result = await collectQuotas([TARGET], { now: NOW, cachePath });

    expect(adapter.credentialAccount).not.toHaveBeenCalled();
    expect(result[TARGET.id]?.state).toBe("ok");
  });
});

describe("forgetQuota", () => {
  it("drops one profile's reading, so the next read asks again", async () => {
    const kept = { state: "ok", fetchedAt: NOW, weekly: { usedPercent: 3, resetsAt: null } };
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: {
        [TARGET.id]: { state: "other_account", fetchedAt: NOW, signedInAs: "b@example.com" },
        "claude:b": kept,
      },
    });

    await forgetQuota(TARGET.id, { cachePath });

    expect(readCacheFile().profiles).toEqual({ "claude:b": kept });
  });

  it("does not throw without a cache", async () => {
    await expect(forgetQuota(TARGET.id, { cachePath })).resolves.toBeUndefined();
  });
});

describe("collectQuotas: an API profile's spend", () => {
  // Wednesday 2026-10-14 in UTC, so a month and a week are under way.
  const AT = Date.parse("2026-10-14T09:30:00.000Z");
  // Built from pieces so the source never holds a key-shaped string.
  const KEY = ["sk", "gw", "Hd5Rk8Vn3Jc6"].join("-");

  /** A stand-in fetch: no test reaches a network. */
  function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
  }

  const apiTarget = (budget?: { usd: number; per: "day" | "week" | "month" }) => ({
    id: "claude:gw",
    tool: "claude" as const,
    configDir: "/tmp/.claude-gw",
    api: {
      baseUrl: "https://gw.example.com",
      authScheme: "bearer" as const,
      readKey: vi.fn(async (_signal: AbortSignal) => KEY),
      ...(budget ? { budget } : {}),
    },
  });

  const collect = (target: ReturnType<typeof apiTarget>, fetch: ReturnType<typeof stubFetch>, now = AT) =>
    collectQuotas([target], { now, cachePath, fetch: fetch as unknown as typeof globalThis.fetch });

  it("reads the spend, caches it as a budget window, and keeps the key out of the cache", async () => {
    const fetch = stubFetch(200, { info: { spend: 12, max_budget: 40 } });
    const result = await collect(apiTarget(), fetch);
    expect(result["claude:gw"]).toMatchObject({
      state: "ok",
      budget: { usedPercent: 30, spentUsd: 12, limitUsd: 40, source: "provider" },
    });
    const cached = readFileSync(cachePath, "utf8");
    expect(JSON.parse(cached).profiles["claude:gw"].budget.usedPercent).toBe(30);
    expect(cached).not.toContain(KEY);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("serves a fresh reading again for the limit that applies now, without asking or reading the key", async () => {
    const target = apiTarget();
    await collect(target, stubFetch(200, { info: { spend: 12, max_budget: 40 } }));
    const fetch = stubFetch(500, {});
    const budgeted = apiTarget({ usd: 20, per: "month" });
    const result = await collect(budgeted, fetch, AT + 60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(budgeted.api.readKey).not.toHaveBeenCalled();
    // The first reading this month is where a budget counts from.
    expect(result["claude:gw"]?.budget).toMatchObject({ spentUsd: 0, limitUsd: 20, source: "budget" });
    // Kept, for list and the dashboard, which read only the cache.
    expect(readCacheFile().profiles["claude:gw"].budget).toMatchObject({ limitUsd: 20, source: "budget" });
  });

  it("reads again a cached reading from before its budget's period began", async () => {
    await collect(apiTarget(), stubFetch(200, { info: { spend: 12 } }), Date.parse("2026-10-13T23:58:00.000Z"));
    const fetch = stubFetch(200, { info: { spend: 13 } });
    await collect(apiTarget({ usd: 5, per: "day" }), fetch, Date.parse("2026-10-14T00:01:00.000Z"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches a provider that gives no spend reading, so the next run does not ask again", async () => {
    const result = await collect(apiTarget({ usd: 20, per: "month" }), stubFetch(404, { detail: "Not Found" }));
    expect(result["claude:gw"]).toEqual({ state: "error", fetchedAt: AT, noSpendReading: true });
    const fetch = stubFetch(404, {});
    await collect(apiTarget({ usd: 20, per: "month" }), fetch, AT + 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the period's baselines through an answer with no spend reading", async () => {
    // A month counted from its first reading at $100.
    await collect(apiTarget({ usd: 20, per: "month" }), stubFetch(200, { info: { spend: 100 } }));
    const blip = await collect(apiTarget({ usd: 20, per: "month" }), stubFetch(404, {}), AT + QUOTA_FRESH_MS);
    expect(blip["claude:gw"]).toMatchObject({ state: "error", noSpendReading: true });
    const later = AT + 2 * QUOTA_FRESH_MS;
    const result = await collect(apiTarget({ usd: 20, per: "month" }), stubFetch(200, { info: { spend: 107 } }), later);
    expect(result["claude:gw"]?.budget).toMatchObject({ spentUsd: 7, usedPercent: 35 });
  });

  it("counts a late LiteLLM reset once, through the cache, as a run reads it", async () => {
    // A key LiteLLM resets daily, under a $100 monthly budget; its job resets the key some
    // minutes after budget_reset_at, and moves that time on as it does.
    const month = apiTarget({ usd: 100, per: "month" });
    const read = async (when: string, spend: number, resets: string) => {
      const info = { spend, max_budget: 50, budget_duration: "1d", budget_reset_at: resets };
      const result = await collect(month, stubFetch(200, { info }), Date.parse(when));
      return result["claude:gw"]?.budget?.spentUsd;
    };
    await read("2026-10-14T08:00:00Z", 0, "2026-10-15T00:00:00Z");
    expect(await read("2026-10-14T20:00:00Z", 30, "2026-10-15T00:00:00Z")).toBe(30);
    expect(await read("2026-10-15T00:05:00Z", 31, "2026-10-15T00:00:00Z")).toBe(31);
    expect(await read("2026-10-15T00:20:00Z", 0.5, "2026-10-16T00:00:00Z")).toBe(31.5);
    expect(await read("2026-10-15T18:00:00Z", 10, "2026-10-16T00:00:00Z")).toBe(41);
  });

  it("keeps in the cache when a LiteLLM key with no max_budget is reset, and counts the reset", async () => {
    const month = apiTarget({ usd: 100, per: "month" });
    const read = async (when: string, spend: number, resets: string) => {
      const info = { spend, max_budget: null, budget_duration: "1d", budget_reset_at: resets };
      const result = await collect(month, stubFetch(200, { info }), Date.parse(when));
      return result["claude:gw"]?.budget?.spentUsd;
    };
    await read("2026-10-14T08:00:00Z", 0, "2026-10-15T00:00:00Z");
    expect(await read("2026-10-14T20:00:00Z", 30, "2026-10-15T00:00:00Z")).toBe(30);
    expect(readCacheFile().profiles["claude:gw"].spend.totalResetsAt).toBe("2026-10-15T00:00:00.000Z");
    // Reset at midnight, and climbed past the last reading since.
    expect(await read("2026-10-15T18:00:00Z", 35, "2026-10-16T00:00:00Z")).toBe(65);
  });

  it("keeps the last reading's spend through a failure, and pauses only this profile after a 429", async () => {
    await collect(apiTarget(), stubFetch(200, { info: { spend: 12, max_budget: 40 } }));
    const result = await collect(apiTarget(), stubFetch(429, {}, { "retry-after": "600" }), AT + QUOTA_FRESH_MS);
    expect(result["claude:gw"]).toMatchObject({ state: "cooldown", fetchedAt: AT, spend: { totalUsd: 12 } });
    expect(readCacheFile().cooldowns).toEqual({ "claude:gw": AT + QUOTA_FRESH_MS + 600_000 });
    const fetch = stubFetch(200, { info: { spend: 13 } });
    expect((await collect(apiTarget(), fetch, AT + QUOTA_FRESH_MS + 1000))["claude:gw"]?.state).toBe("cooldown");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops waiting for a key that never comes once the reading's time is up, and reads the others", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hung = apiTarget();
      let asked: AbortSignal | undefined;
      hung.api.readKey.mockImplementation((signal: AbortSignal) => {
        asked = signal;
        return new Promise<string>(() => {});
      });
      const other = { ...apiTarget(), id: "claude:other" };
      stubAdapter();
      const fetch = stubFetch(200, { info: { spend: 1, max_budget: 10 } });
      const reading = collectQuotas([hung, other, TARGET], {
        now: AT,
        cachePath,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      // The cache is read first, from disk: the clock moves once the key is being read.
      while (!asked) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(QUOTA_TIMEOUT_MS);
      const result = await reading;
      // Left out of this run as a spend that could not be read; the command it started is told to stop.
      expect(result["claude:gw"]).toEqual({ state: "missing", fetchedAt: AT });
      expect(asked?.aborted).toBe(true);
      expect(result["claude:other"]?.state).toBe("ok");
      expect(result[TARGET.id]?.state).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each profile's reading a signal of its own, so many read at once share none", async () => {
    const signals: AbortSignal[] = [];
    const targets = Array.from({ length: 12 }, (_, n) => {
      const target = { ...apiTarget(), id: `claude:gw${n}` };
      target.api.readKey.mockImplementation(async (signal: AbortSignal) => {
        signals.push(signal);
        return KEY;
      });
      return target;
    });
    const warning = vi.spyOn(process, "emitWarning");
    try {
      await collectQuotas(targets, {
        now: AT,
        cachePath,
        fetch: stubFetch(200, { info: { spend: 1 } }) as unknown as typeof globalThis.fetch,
      });
      expect(new Set(signals).size).toBe(12);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("asks for no key for a base URL that could never be read", async () => {
    const target = apiTarget();
    target.api.baseUrl = "https://admin:pw@gw.example.com";
    const fetch = stubFetch(200, { info: { spend: 1 } });
    expect((await collect(target, fetch))["claude:gw"]?.state).toBe("error");
    expect(target.api.readKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says a key that cannot be read is missing, and a rejected one expired, without a request for the first", async () => {
    const fetch = stubFetch(200, { info: { spend: 1 } });
    const target = apiTarget();
    target.api.readKey.mockRejectedValueOnce(new Error("environment variable GW_KEY is unset or empty"));
    expect((await collect(target, fetch))["claude:gw"]?.state).toBe("missing");
    expect(fetch).not.toHaveBeenCalled();
    const rejected = await collectQuotas([apiTarget()], {
      now: AT,
      cachePath,
      refresh: true,
      fetch: stubFetch(401, {}) as unknown as typeof globalThis.fetch,
    });
    expect(rejected["claude:gw"]?.state).toBe("expired");
  });
});

describe("cachedQuotas", () => {
  it("returns what the cache holds for the ids asked, and fetches nothing", async () => {
    seedCache({
      version: 1,
      cooldowns: {},
      profiles: {
        "claude:gw": { state: "ok", fetchedAt: NOW - 3_600_000 },
        [TARGET.id]: { state: "ok", fetchedAt: NOW },
      },
    });
    expect(await cachedQuotas(["claude:gw", "claude:none", "constructor"], { cachePath })).toEqual({
      "claude:gw": { state: "ok", fetchedAt: NOW - 3_600_000 },
    });
  });
});
