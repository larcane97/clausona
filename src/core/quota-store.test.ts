import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { ToolAdapter, ToolCredential } from "../tools/types.js";
import type { QuotaSnapshot } from "../types.js";
import { QuotaHttpError } from "./quota.js";

const getAdapter = vi.hoisted(() => vi.fn());
vi.mock("../tools/registry.js", () => ({ getAdapter }));

const { collectQuotas } = await import("./quota-store.js");

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
    // The one that could not take the lock backs off rather than rotating anyway.
    expect([a[TARGET.id]?.state, b[TARGET.id]?.state].sort()).toEqual(["expired", "ok"]);
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
