import { describe, expect, it } from "vitest";

import { cooldownUntil, isFresh, parseClaudeQuota, parseCodexQuota, QUOTA_DEFAULT_COOLDOWN_MS } from "./quota.js";

// Trimmed from a live GET /api/oauth/usage response.
const CLAUDE_PAYLOAD = {
  five_hour: { utilization: 1.0, resets_at: "2026-09-04T02:19:59.919263+00:00", limit_dollars: null },
  seven_day: { utilization: 45.0, resets_at: "2026-09-04T19:59:59.919283+00:00", limit_dollars: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 1,
      severity: "normal",
      resets_at: "2026-09-04T02:19:59Z",
      scope: null,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 45,
      severity: "normal",
      resets_at: "2026-09-04T19:59:59Z",
      scope: null,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 77,
      severity: "warning",
      resets_at: "2026-09-04T19:59:59Z",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

// Trimmed from a live GET /backend-api/codex/usage response.
const CODEX_PAYLOAD = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 604800,
      reset_after_seconds: 530735,
      reset_at: 1789001823,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1789001823 } },
    },
  ],
};

/**
 * A model limit with both of its slots filled: a 5-hour primary and a weekly secondary. Codex
 * types a model limit's `rate_limit` as it types the account's own (RateLimitStatusDetails in
 * openai/codex), draws both windows on /status, and users report GPT-5.3-Codex-Spark with a
 * 5-hour and a weekly limit. Not captured live: built to that type, window fields only.
 */
const codexModelLimit = (
  fiveHour: number | null,
  weekly: number | null,
  lengths: { fiveHour?: number; weekly?: number } = { fiveHour: 18000, weekly: 604800 },
) => ({
  limit_name: "GPT-5.3-Codex-Spark",
  metered_feature: "codex_bengalfox",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window:
      fiveHour === null
        ? null
        : {
            used_percent: fiveHour,
            limit_window_seconds: lengths.fiveHour,
            reset_after_seconds: 3600,
            reset_at: 1788488223,
          },
    secondary_window:
      weekly === null
        ? null
        : {
            used_percent: weekly,
            limit_window_seconds: lengths.weekly,
            reset_after_seconds: 530735,
            reset_at: 1789001823,
          },
  },
});

describe("parseClaudeQuota", () => {
  it("maps the five-hour and seven-day windows", () => {
    const quota = parseClaudeQuota(CLAUDE_PAYLOAD);

    expect(quota?.session).toEqual({ usedPercent: 1, resetsAt: "2026-09-04T02:19:59.919Z" });
    expect(quota?.weekly).toEqual({ usedPercent: 45, resetsAt: "2026-09-04T19:59:59.919Z" });
  });

  it("picks the highest model-scoped weekly limit", () => {
    const quota = parseClaudeQuota({
      ...CLAUDE_PAYLOAD,
      limits: [
        ...CLAUDE_PAYLOAD.limits,
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 90,
          severity: "critical",
          resets_at: "2026-09-05T00:00:00Z",
          scope: { model: { display_name: "Opus" }, surface: null },
        },
      ],
    });

    expect(quota?.scoped).toEqual({ usedPercent: 90, resetsAt: "2026-09-05T00:00:00.000Z", label: "Opus" });
  });

  it("keeps every model-scoped weekly limit, for routing", () => {
    const quota = parseClaudeQuota({
      ...CLAUDE_PAYLOAD,
      limits: [
        ...CLAUDE_PAYLOAD.limits,
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 20,
          severity: "normal",
          resets_at: "2026-09-05T00:00:00Z",
          scope: { model: { display_name: "Opus" }, surface: null },
        },
      ],
    });

    expect(quota?.scopedLimits).toEqual([
      { usedPercent: 77, resetsAt: "2026-09-04T19:59:59.000Z", label: "Fable" },
      { usedPercent: 20, resetsAt: "2026-09-05T00:00:00.000Z", label: "Opus" },
    ]);
    expect(quota?.scoped?.label).toBe("Fable");
  });

  it("keeps the first of two limits on different models as high, whichever resets later", () => {
    const quota = parseClaudeQuota({
      ...CLAUDE_PAYLOAD,
      limits: [
        ...CLAUDE_PAYLOAD.limits,
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 77,
          severity: "warning",
          resets_at: "2026-09-05T00:00:00Z",
          scope: { model: { display_name: "Opus" }, surface: null },
        },
      ],
    });

    expect(quota?.scoped?.label).toBe("Fable");
  });

  it("omits windows the account does not have", () => {
    const quota = parseClaudeQuota({ five_hour: { utilization: 3, resets_at: null }, seven_day: null, limits: null });

    expect(quota?.session).toEqual({ usedPercent: 3, resetsAt: null });
    expect(quota?.weekly).toBeUndefined();
    expect(quota?.scoped).toBeUndefined();
  });

  it("returns null when no window is present", () => {
    expect(parseClaudeQuota({ five_hour: null, seven_day: null, limits: [] })).toBeNull();
    expect(parseClaudeQuota(null)).toBeNull();
    expect(parseClaudeQuota("nope")).toBeNull();
  });

  it("clamps out-of-range utilization", () => {
    const quota = parseClaudeQuota({ five_hour: { utilization: 140, resets_at: null } });

    expect(quota?.session?.usedPercent).toBe(100);
  });
});

describe("parseCodexQuota", () => {
  it("classifies windows by their declared width, not their position", () => {
    const quota = parseCodexQuota(CODEX_PAYLOAD);

    // primary_window is seven days here, so it must land on `weekly`.
    expect(quota?.weekly).toEqual({ usedPercent: 12, resetsAt: "2026-09-10T00:57:03.000Z" });
    expect(quota?.session).toBeUndefined();
  });

  it("treats a sub-day window as the session window", () => {
    const quota = parseCodexQuota({
      rate_limit: {
        primary_window: { used_percent: 8, limit_window_seconds: 18000, reset_at: 1789001823 },
        secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1789501823 },
      },
    });

    expect(quota?.session?.usedPercent).toBe(8);
    expect(quota?.weekly?.usedPercent).toBe(55);
  });

  it("surfaces the highest additional rate limit as the scoped window", () => {
    const quota = parseCodexQuota(CODEX_PAYLOAD);

    expect(quota?.scoped).toEqual({
      usedPercent: 40,
      resetsAt: "2026-09-10T00:57:03.000Z",
      label: "GPT-5.3-Codex-Spark",
      windowSeconds: 604800,
    });
  });

  // [5-hour window, weekly window] → the one the dashboard shows: whichever is higher stops the
  // model first, as an account's own 5H and 7D do; of two as high, the weekly one, which resets
  // later and so holds the model longer. Either slot can also come alone.
  it.each([
    [90, 30, { usedPercent: 90, resetsAt: "2026-09-04T02:17:03.000Z", windowSeconds: 18000 }],
    [10, 95, { usedPercent: 95, resetsAt: "2026-09-10T00:57:03.000Z", windowSeconds: 604800 }],
    [100, 100, { usedPercent: 100, resetsAt: "2026-09-10T00:57:03.000Z", windowSeconds: 604800 }],
    [null, 70, { usedPercent: 70, resetsAt: "2026-09-10T00:57:03.000Z", windowSeconds: 604800 }],
  ] as const)("reads both windows of a model limit (5h %o, weekly %o) and shows the higher", (five, week, shown) => {
    const quota = parseCodexQuota({ ...CODEX_PAYLOAD, additional_rate_limits: [codexModelLimit(five, week)] });

    expect(quota?.scoped).toEqual({ ...shown, label: "GPT-5.3-Codex-Spark" });
  });

  it("keeps each window of a model limit with its length, for routing", () => {
    const quota = parseCodexQuota({ ...CODEX_PAYLOAD, additional_rate_limits: [codexModelLimit(20, 85)] });

    expect(quota?.scopedLimits).toEqual([
      { usedPercent: 20, resetsAt: "2026-09-04T02:17:03.000Z", label: "GPT-5.3-Codex-Spark", windowSeconds: 18000 },
      { usedPercent: 85, resetsAt: "2026-09-10T00:57:03.000Z", label: "GPT-5.3-Codex-Spark", windowSeconds: 604800 },
    ]);
    // The account's own windows are read as before.
    expect(quota?.weekly?.usedPercent).toBe(12);
    expect(quota?.session).toBeUndefined();
  });

  it("keeps a model limit's windows without a length, and still shows the higher", () => {
    const quota = parseCodexQuota({
      ...CODEX_PAYLOAD,
      additional_rate_limits: [codexModelLimit(20, 85, {})],
    });

    expect(quota?.scopedLimits?.map((limit) => [limit.usedPercent, limit.windowSeconds])).toEqual([
      [20, undefined],
      [85, undefined],
    ]);
    expect(quota?.scoped?.usedPercent).toBe(85);
  });

  it("keeps every additional rate limit, for routing", () => {
    const quota = parseCodexQuota({
      ...CODEX_PAYLOAD,
      additional_rate_limits: [
        ...CODEX_PAYLOAD.additional_rate_limits,
        { limit_name: "codex_other", rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 900 } } },
      ],
    });

    expect(quota?.scopedLimits?.map((limit) => [limit.label, limit.usedPercent])).toEqual([
      ["GPT-5.3-Codex-Spark", 40],
      ["codex_other", 70],
    ]);
    expect(quota?.scoped?.label).toBe("codex_other");
  });

  it("has no scoped limits when the account reports none", () => {
    const quota = parseCodexQuota({ rate_limit: CODEX_PAYLOAD.rate_limit });

    expect(quota?.scoped).toBeUndefined();
    expect(quota?.scopedLimits).toBeUndefined();
  });

  it("returns null when the payload carries no windows", () => {
    expect(parseCodexQuota({ rate_limit: { primary_window: null, secondary_window: null } })).toBeNull();
    expect(parseCodexQuota(undefined)).toBeNull();
  });
});

describe("cache policy", () => {
  const now = 1_800_000_000_000;

  it("serves a snapshot fetched within the freshness window", () => {
    expect(isFresh({ fetchedAt: now - 60_000 }, now)).toBe(true);
    expect(isFresh({ fetchedAt: now - 10 * 60_000 }, now)).toBe(false);
  });

  it("rejects a snapshot stamped in the future", () => {
    expect(isFresh({ fetchedAt: now + 60_000 }, now)).toBe(false);
  });
});

describe("cooldownUntil", () => {
  it("honours Retry-After", () => {
    expect(cooldownUntil("3600", 1000)).toBe(1000 + 3600 * 1000);
  });

  it("falls back when the header is absent or unusable", () => {
    expect(cooldownUntil(null, 1000)).toBe(1000 + QUOTA_DEFAULT_COOLDOWN_MS);
    expect(cooldownUntil("soon", 1000)).toBe(1000 + QUOTA_DEFAULT_COOLDOWN_MS);
    expect(cooldownUntil("-5", 1000)).toBe(1000 + QUOTA_DEFAULT_COOLDOWN_MS);
  });

  it("caps an absurd Retry-After at a day", () => {
    expect(cooldownUntil("999999", 0)).toBe(24 * 60 * 60 * 1000);
  });
});
