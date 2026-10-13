import { describe, expect, it, vi } from "vitest";

import type { SpendReading } from "../types.js";
import { QuotaHttpError } from "./quota.js";
import {
  budgetWindow,
  OPENROUTER_KEY_URL,
  parseLiteLlmKeyInfo,
  parseOpenRouterKey,
  periodEnd,
  periodStart,
  readSpend,
  spendProvider,
  withBaselines,
} from "./spend.js";

// Wednesday 2026-10-14, 09:30 UTC.
const NOW = Date.parse("2026-10-14T09:30:00.000Z");
// Built from pieces so the source never holds a key-shaped string.
const KEY = ["sk", "gw", "Qm7Zt4Wb9Lp2"].join("-");

/** A stand-in fetch that answers once, and records what it was asked. No test reaches a network. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(text, { status, headers }));
}

const read = (stub: ReturnType<typeof answer>, baseUrl: string, authScheme: "bearer" | "api-key" = "bearer") =>
  readSpend({ baseUrl, authScheme }, KEY, {
    fetch: stub as unknown as typeof fetch,
    signal: new AbortController().signal,
    now: NOW,
  });

describe("periods", () => {
  it("are UTC days, weeks from Monday and months from the 1st", () => {
    expect(periodStart(NOW, "day")).toBe("2026-10-14T00:00:00.000Z");
    expect(periodStart(NOW, "week")).toBe("2026-10-12T00:00:00.000Z");
    expect(periodStart(NOW, "month")).toBe("2026-10-01T00:00:00.000Z");
    expect(periodEnd(NOW, "day")).toBe("2026-10-15T00:00:00.000Z");
    expect(periodEnd(NOW, "week")).toBe("2026-10-19T00:00:00.000Z");
    expect(periodEnd(NOW, "month")).toBe("2026-11-01T00:00:00.000Z");
    // A Sunday is the end of its week, not the start of the next.
    expect(periodStart(Date.parse("2026-10-18T23:00:00.000Z"), "week")).toBe("2026-10-12T00:00:00.000Z");
    expect(periodEnd(Date.parse("2026-12-31T23:00:00.000Z"), "month")).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("spendProvider", () => {
  it("tells OpenRouter by its host, and asks anything else as a LiteLLM proxy", () => {
    expect(spendProvider("https://openrouter.ai/api")).toBe("openrouter");
    expect(spendProvider("https://openrouter.ai.evil.example/api")).toBe("litellm");
    expect(spendProvider("https://gw.example.com")).toBe("litellm");
  });
});

describe("readSpend: LiteLLM", () => {
  it("asks <baseUrl>/key/info with the profile's own key in its own header, and reads the spend", async () => {
    const stub = answer(200, {
      key: "hashed-or-not, never read",
      info: { spend: 7.25, max_budget: 50, budget_duration: "30d", budget_reset_at: "2026-11-01T00:00:00Z" },
    });
    expect(await read(stub, "https://gw.example.com/anthropic/?team=a#x", "api-key")).toEqual({
      totalUsd: 7.25,
      totalResetsAt: "2026-11-01T00:00:00.000Z",
      limit: { usd: 50, resetsAt: "2026-11-01T00:00:00.000Z", per: "month" },
    });
    const [url, init] = stub.mock.calls[0];
    expect(url).toBe("https://gw.example.com/anthropic/key/info");
    expect(init?.headers).toEqual({ Accept: "application/json", "x-api-key": KEY });
    expect(init?.redirect).toBe("error");
    await read(stub, "https://gw.example.com", "bearer");
    expect(stub.mock.calls[1][1]?.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${KEY}` });
  });

  it("reads a LiteLLM time with no zone as UTC, wherever clausona runs", () => {
    // Off UTC, as the machine running clausona may well be.
    vi.stubEnv("TZ", "Asia/Seoul");
    try {
      const read = (at: string) =>
        parseLiteLlmKeyInfo({ info: { spend: 1, max_budget: 5, budget_duration: "1d", budget_reset_at: at } })?.limit
          ?.resetsAt;
      expect(read("2026-11-01T00:00:00.244000")).toBe("2026-11-01T00:00:00.244Z");
      expect(read("2026-11-01 00:00:00")).toBe("2026-11-01T00:00:00.000Z");
      expect(read("2026-11-01T09:00:00+09:00")).toBe("2026-11-01T00:00:00.000Z");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a key with no limit, and a limit that never renews", () => {
    expect(parseLiteLlmKeyInfo({ info: { spend: 3, max_budget: null } })).toEqual({ totalUsd: 3 });
    expect(parseLiteLlmKeyInfo({ info: { spend: 3, max_budget: 10, budget_reset_at: "2026-11-01" } })).toEqual({
      totalUsd: 3,
      limit: { usd: 10, resetsAt: null },
    });
  });

  // LiteLLM's reset job zeroes the spend of any key with a budget_duration, max_budget or not.
  it("keeps when a key with a budget_duration and no max_budget is reset, with no limit", () => {
    const reading = parseLiteLlmKeyInfo({
      info: { spend: 3, max_budget: null, budget_duration: "1d", budget_reset_at: "2026-10-15T00:00:00" },
    });
    expect(reading).toEqual({ totalUsd: 3, totalResetsAt: "2026-10-15T00:00:00.000Z" });
    // Without a budget it has no limit, as before.
    expect(budgetWindow(reading as SpendReading, undefined, NOW)).toBeUndefined();
  });

  it("gives no spend reading for a 404, a body that is not JSON, or one of another shape", async () => {
    // A LiteLLM proxy behind a gateway that does not pass /key/info on answers 404.
    expect(await read(answer(404, { detail: "Not Found" }), "https://gw.example.com")).toBeNull();
    expect(await read(answer(200, "<html>gateway</html>"), "https://gw.example.com")).toBeNull();
    expect(await read(answer(200, { data: { usage: 1 } }), "https://gw.example.com")).toBeNull();
    expect(await read(answer(200, { info: { spend: "7" } }), "https://gw.example.com")).toBeNull();
  });

  it("throws any other refusal with its status, and never puts the key in it", async () => {
    const error = await read(answer(429, {}, { "retry-after": "120" }), "https://gw.example.com").catch((e) => e);
    expect(error).toBeInstanceOf(QuotaHttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: "120" });
    expect(String(error.message)).not.toContain(KEY);
  });

  it("does not ask a base URL clausona would not store", async () => {
    const stub = answer(200, { info: { spend: 1 } });
    await expect(read(stub, "https://admin:pw@gw.example.com")).rejects.toThrow(
      "the profile's base URL cannot be used",
    );
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("readSpend: OpenRouter", () => {
  const body = {
    data: {
      label: "team key",
      usage: 40,
      usage_daily: 1.5,
      usage_weekly: 6,
      usage_monthly: 12,
      limit: 50,
      limit_remaining: 38,
      limit_reset: "monthly",
    },
  };

  it("asks openrouter.ai's key endpoint with a Bearer key, whatever the profile's auth scheme", async () => {
    const stub = answer(200, body);
    expect(await read(stub, "https://openrouter.ai/api", "api-key")).toEqual({
      totalUsd: 40,
      periods: { day: 1.5, week: 6, month: 12 },
      limit: { usd: 50, resetsAt: "2026-11-01T00:00:00.000Z", per: "month", remainingUsd: 38 },
    });
    expect(stub.mock.calls[0][0]).toBe(OPENROUTER_KEY_URL);
    expect(stub.mock.calls[0][1]?.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${KEY}` });
  });

  it("tolerates missing fields", () => {
    expect(parseOpenRouterKey({ data: { usage: 2, limit: null } }, NOW)).toEqual({ totalUsd: 2 });
    expect(parseOpenRouterKey({ data: { usage: 2, limit: 10 } }, NOW)).toEqual({
      totalUsd: 2,
      limit: { usd: 10, resetsAt: null },
    });
    expect(parseOpenRouterKey({ data: {} }, NOW)).toBeNull();
  });
});

describe("budgetWindow", () => {
  it("counts a budget against the spend the provider reports for its period", () => {
    const reading = { totalUsd: 40, periods: { day: 1.5, week: 6, month: 12 } };
    expect(budgetWindow(reading, { usd: 20, per: "month" }, NOW)).toEqual({
      usedPercent: 60,
      resetsAt: "2026-11-01T00:00:00.000Z",
      spentUsd: 12,
      limitUsd: 20,
      source: "budget",
      per: "month",
    });
  });

  it("replaces the provider's limit with the budget, and uses that limit when there is none", () => {
    const reading = {
      totalUsd: 30,
      limit: { usd: 50, resetsAt: null },
      baselines: { month: { start: "2026-10-01T00:00:00.000Z", totalUsd: 25 } },
    };
    expect(budgetWindow(reading, { usd: 10, per: "month" }, NOW)).toMatchObject({
      usedPercent: 50,
      spentUsd: 5,
      source: "budget",
    });
    expect(budgetWindow(reading, undefined, NOW)).toEqual({
      usedPercent: 60,
      resetsAt: null,
      spentUsd: 30,
      limitUsd: 50,
      source: "provider",
    });
    // OpenRouter says what is left of its limit.
    expect(
      budgetWindow({ totalUsd: 40, limit: { usd: 50, resetsAt: null, remainingUsd: 45 } }, undefined, NOW),
    ).toMatchObject({ usedPercent: 10, spentUsd: 5 });
    expect(budgetWindow({ totalUsd: 30 }, undefined, NOW)).toBeUndefined();
  });

  it("reads a spend over the limit as full", () => {
    expect(budgetWindow({ totalUsd: 80, limit: { usd: 50, resetsAt: null } }, undefined, NOW)?.usedPercent).toBe(100);
    expect(budgetWindow({ totalUsd: 1, limit: { usd: 0, resetsAt: null } }, undefined, NOW)?.usedPercent).toBe(100);
  });
});

describe("withBaselines", () => {
  it("counts a running total from clausona's first reading in each period", () => {
    const first = withBaselines({ totalUsd: 100 }, undefined, NOW);
    expect(first.baselines).toEqual({
      day: { start: "2026-10-14T00:00:00.000Z", totalUsd: 100 },
      week: { start: "2026-10-12T00:00:00.000Z", totalUsd: 100 },
      month: { start: "2026-10-01T00:00:00.000Z", totalUsd: 100 },
    });
    // Spend before that first reading is not counted.
    expect(budgetWindow(first, { usd: 20, per: "month" }, NOW)?.spentUsd).toBe(0);
    const later = withBaselines({ totalUsd: 107 }, first, NOW + 60_000);
    expect(budgetWindow(later, { usd: 20, per: "month" }, NOW + 60_000)).toMatchObject({
      spentUsd: 7,
      usedPercent: 35,
    });
    // The next day starts its own count; the month goes on with its own.
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    const next = withBaselines({ totalUsd: 110 }, later, tomorrow);
    expect(next.baselines?.day).toEqual({ start: "2026-10-15T00:00:00.000Z", totalUsd: 110 });
    expect(budgetWindow(next, { usd: 20, per: "month" }, tomorrow)?.spentUsd).toBe(10);
  });

  it("keeps what the period spent when the provider sets its count back to 0", () => {
    const first = withBaselines({ totalUsd: 100 }, undefined, NOW);
    const before = withBaselines({ totalUsd: 106 }, first, NOW);
    const after = withBaselines({ totalUsd: 2 }, before, NOW);
    expect(budgetWindow(after, { usd: 20, per: "month" }, NOW)?.spentUsd).toBe(8);
    expect(budgetWindow(withBaselines({ totalUsd: 5 }, after, NOW), { usd: 20, per: "month" }, NOW)?.spentUsd).toBe(11);
  });

  it("keeps what the period spent across a provider reset the readings did not see as a drop", () => {
    // A key that LiteLLM resets daily, under a $100 monthly budget.
    const day = 24 * 60 * 60 * 1000;
    const resetsAt = (at: number) => new Date(at + day).toISOString();
    const first = withBaselines({ totalUsd: 0, limit: { usd: 50, resetsAt: resetsAt(NOW) } }, undefined, NOW);
    const later = withBaselines({ totalUsd: 30, limit: { usd: 50, resetsAt: resetsAt(NOW) } }, first, NOW + 1000);
    // The next day the count began again at 0, and its reset time moved on; it has climbed to 35.
    const next = withBaselines(
      { totalUsd: 35, limit: { usd: 50, resetsAt: resetsAt(NOW + day) } },
      later,
      NOW + day + 2000,
    );
    expect(budgetWindow(next, { usd: 100, per: "month" }, NOW + day + 2000)?.spentUsd).toBe(65);
  });

  it("keeps what the period spent across a reset seen only by its moved time, on a key with no max_budget", () => {
    // A key LiteLLM resets daily, with no limit of its own, under a $100 monthly budget.
    const info = (spend: number, resetsAt: string) =>
      parseLiteLlmKeyInfo({
        info: { spend, max_budget: null, budget_duration: "1d", budget_reset_at: resetsAt },
      }) as SpendReading;
    const day = 24 * 60 * 60 * 1000;
    const first = withBaselines(info(0, "2026-10-15T00:00:00"), undefined, NOW);
    const later = withBaselines(info(30, "2026-10-15T00:00:00"), first, NOW + 1000);
    // The next day the count began again at 0, and its reset time moved on; it has climbed to 35.
    const next = withBaselines(info(35, "2026-10-16T00:00:00"), later, NOW + day + 2000);
    expect(budgetWindow(next, { usd: 100, per: "month" }, NOW + day + 2000)?.spentUsd).toBe(65);
  });

  it("tells a reset from a reading stored before the reset time was kept on its own", () => {
    // Stored by an older clausona: the reset time only on its limit.
    const day = 24 * 60 * 60 * 1000;
    const limit = { usd: 50, resetsAt: "2026-10-15T00:00:00.000Z", per: "day" as const };
    const first = withBaselines({ totalUsd: 0, limit }, undefined, NOW);
    const stored = withBaselines({ totalUsd: 30, limit }, first, NOW + 1000);
    const info = (spend: number, resetsAt: string) =>
      parseLiteLlmKeyInfo({
        info: { spend, max_budget: 50, budget_duration: "1d", budget_reset_at: resetsAt },
      }) as SpendReading;
    const month = { usd: 100, per: "month" as const };
    // The same reset time is no reset; one moved on is.
    const same = withBaselines(info(32, "2026-10-15T00:00:00"), stored, NOW + 2000);
    expect(budgetWindow(same, month, NOW + 2000)?.spentUsd).toBe(32);
    const moved = withBaselines(info(35, "2026-10-16T00:00:00"), stored, NOW + day + 2000);
    expect(budgetWindow(moved, month, NOW + day + 2000)?.spentUsd).toBe(65);
  });

  // LiteLLM moves budget_reset_at without zeroing the spend when the key's budget_duration is sent
  // again (`/key/update`, the admin UI's Edit Key). Its reset job only resets a key once that time
  // has passed.
  it("counts no reset when the reset time moves before it has passed and the total did not fall", () => {
    const info = (spend: number, resetsAt: string) =>
      parseLiteLlmKeyInfo({
        info: { spend, max_budget: null, budget_duration: "30d", budget_reset_at: resetsAt },
      }) as SpendReading;
    const month = { usd: 100, per: "month" as const };
    const first = withBaselines(info(0, "2026-11-01T00:00:00"), undefined, NOW);
    const later = withBaselines(info(30, "2026-11-01T00:00:00"), first, NOW + 1000);
    // The key edited: its reset time is 30 days on from the edit, and its spend still 30.
    const edited = withBaselines(info(32, "2026-11-13T09:31:00"), later, NOW + 60_000);
    expect(budgetWindow(edited, month, NOW + 60_000)?.spentUsd).toBe(32);
  });

  it("counts a late provider reset once, and not while its reset time has only passed", () => {
    // A key LiteLLM resets daily, under a $100 monthly budget. LiteLLM's job resets a key some
    // minutes after its budget_reset_at, and moves that time on as it does.
    const at = (iso: string) => Date.parse(iso);
    const month = { usd: 100, per: "month" as const };
    const read = (previous: SpendReading | undefined, when: string, total: number, resets: string) => {
      const reading = withBaselines(
        { totalUsd: total, limit: { usd: 50, resetsAt: resets, per: "day" } },
        previous,
        at(when),
      );
      return { reading, spent: budgetWindow(reading, month, at(when))?.spentUsd };
    };
    const one = read(undefined, "2026-10-14T08:00:00Z", 0, "2026-10-15T00:00:00.000Z");
    const two = read(one.reading, "2026-10-14T20:00:00Z", 30, "2026-10-15T00:00:00.000Z");
    expect(two.spent).toBe(30);
    // Past the reset time, before the job has run: the old total, no reset yet.
    const late = read(two.reading, "2026-10-15T00:05:00Z", 31, "2026-10-15T00:00:00.000Z");
    expect(late.spent).toBe(31);
    // The job has run: the total fell and the time moved on, one reset.
    const reset = read(late.reading, "2026-10-15T00:20:00Z", 0.5, "2026-10-16T00:00:00.000Z");
    expect(reset.spent).toBe(31.5);
    const evening = read(reset.reading, "2026-10-15T18:00:00Z", 10, "2026-10-16T00:00:00.000Z");
    expect(evening.spent).toBe(41);
    // A reset time already past and never moved (a proxy late with its own reset) is no reset either.
    const stale = read(undefined, "2026-10-14T08:00:00Z", 10, "2026-10-13T00:00:00.000Z");
    expect(read(stale.reading, "2026-10-14T09:00:00Z", 12, "2026-10-13T00:00:00.000Z").spent).toBe(2);
  });

  it("leaves a reading that reports its periods alone", () => {
    const reading = { totalUsd: 1, periods: { day: 1 } };
    expect(withBaselines(reading, undefined, NOW)).toBe(reading);
  });
});
