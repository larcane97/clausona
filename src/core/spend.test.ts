import { describe, expect, it, vi } from "vitest";

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
      limit: { usd: 50, resetsAt: "2026-11-01T00:00:00.000Z", per: "month" },
    });
    const [url, init] = stub.mock.calls[0];
    expect(url).toBe("https://gw.example.com/anthropic/key/info");
    expect(init?.headers).toEqual({ Accept: "application/json", "x-api-key": KEY });
    expect(init?.redirect).toBe("error");
    await read(stub, "https://gw.example.com", "bearer");
    expect(stub.mock.calls[1][1]?.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${KEY}` });
  });

  it("reads a key with no limit, and a limit that never renews", () => {
    expect(parseLiteLlmKeyInfo({ info: { spend: 3, max_budget: null } })).toEqual({ totalUsd: 3 });
    expect(parseLiteLlmKeyInfo({ info: { spend: 3, max_budget: 10, budget_reset_at: "2026-11-01" } })).toEqual({
      totalUsd: 3,
      limit: { usd: 10, resetsAt: null },
    });
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
    const later = withBaselines({ totalUsd: 30, limit: { usd: 50, resetsAt: resetsAt(NOW) } }, first, NOW + 1000, NOW);
    // The next day the count began again at 0, and has climbed to 35 by the next reading.
    const next = withBaselines(
      { totalUsd: 35, limit: { usd: 50, resetsAt: resetsAt(NOW + day) } },
      later,
      NOW + day + 2000,
      NOW + 1000,
    );
    expect(budgetWindow(next, { usd: 100, per: "month" }, NOW + day + 2000)?.spentUsd).toBe(65);
    // A reset already past when the last reading was taken is not taken for a new one.
    const stale = { totalUsd: 10, limit: { usd: 50, resetsAt: new Date(NOW - day).toISOString() } };
    const base = withBaselines(stale, undefined, NOW);
    const after = withBaselines({ ...stale, totalUsd: 12 }, base, NOW + 1000, NOW);
    expect(budgetWindow(after, { usd: 100, per: "month" }, NOW + 1000)?.spentUsd).toBe(2);
  });

  it("leaves a reading that reports its periods alone", () => {
    const reading = { totalUsd: 1, periods: { day: 1 } };
    expect(withBaselines(reading, undefined, NOW)).toBe(reading);
  });
});
