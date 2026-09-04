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
    });
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
