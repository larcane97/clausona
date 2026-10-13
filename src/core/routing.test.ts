import { describe, expect, it } from "vitest";

import type { QuotaSnapshot, ToolName } from "../types.js";
import { parseCodexQuota } from "./quota.js";
import { type RouteSpec, withDefaults } from "./route-config.js";
import type { Member } from "./route-patterns.js";
import { blockingReset, modelFallsUnder, rankRoute, scopedLimitFor, scopedWindowName, usageOf } from "./routing.js";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function snap(five: number | undefined, seven: number | undefined, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    state: "ok",
    fetchedAt: NOW,
    ...(five === undefined ? {} : { session: { usedPercent: five, resetsAt: inHours(2) } }),
    ...(seven === undefined ? {} : { weekly: { usedPercent: seven, resetsAt: inHours(96) } }),
    ...extra,
  };
}

function member(id: string, extra: Partial<Member> = {}): Member {
  const [tool, name] = id.split(":") as [ToolName, string];
  return {
    id,
    tool,
    name,
    email: `${name}@example.com`,
    kind: "subscription",
    sharesSessions: true,
    configDir: `/h/${name}`,
    ...extra,
  };
}

const A = member("claude:a");
const B = member("claude:b");
const C = member("claude:c");
const SOLO = member("claude:solo", { sharesSessions: false });
const GLM = member("claude:glm", { kind: "api", email: "" });
const CX = member("codex:x");

function rank(
  spec: Omit<RouteSpec, "tool">,
  quotas: Record<string, QuotaSnapshot>,
  options: { lastPicked?: Record<string, string>; resume?: boolean; members?: Member[]; model?: string } = {},
) {
  return rankRoute({
    route: withDefaults({ tool: "claude", ...spec }),
    members: options.members ?? [A, B, C, CX],
    quotas,
    lastPicked: options.lastPicked ?? {},
    now: NOW,
    resume: options.resume ?? false,
    ...(options.model ? { model: options.model } : {}),
  });
}

/**
 * A reading with limits on single models, as quota.ts stores them: the most used is `scoped`. A
 * Codex limit's windows come with their length, and one limit can have two.
 */
function withLimits(
  base: QuotaSnapshot,
  limits: Array<[label: string, percent: number, resetsAt?: string, windowSeconds?: number]>,
) {
  const scopedLimits = limits.map(([label, usedPercent, resetsAt, windowSeconds]) => ({
    label,
    usedPercent,
    resetsAt: resetsAt ?? null,
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
  }));
  const scoped = [...scopedLimits].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return { ...base, scoped, scopedLimits };
}

describe("usageOf", () => {
  it("is the higher window, named", () => {
    expect(usageOf(snap(20, 70), NOW)).toEqual({ usage: { percent: 70, window: "7D", stale: false } });
    expect(usageOf(snap(40, 30), NOW)).toEqual({ usage: { percent: 40, window: "5H", stale: false } });
  });

  it("uses the windows the account reports", () => {
    expect(usageOf(snap(undefined, 6), NOW)).toEqual({ usage: { percent: 6, window: "7D", stale: false } });
  });

  it("uses a failed reading's numbers for an hour, marked stale", () => {
    const cooled = snap(10, 20, { state: "cooldown", fetchedAt: NOW - 59 * 60_000 });
    expect(usageOf(cooled, NOW)).toEqual({ usage: { percent: 20, window: "7D", stale: true } });
    const old = snap(10, 20, { state: "error", fetchedAt: NOW - 61 * 60_000 });
    expect(usageOf(old, NOW)).toEqual({ skip: "no-reading" });
  });

  it("says why there is no usage", () => {
    expect(usageOf(undefined, NOW)).toEqual({ skip: "no-reading" });
    expect(usageOf(snap(1, 1, { state: "missing" }), NOW)).toEqual({ skip: "signed-out" });
    expect(usageOf(snap(1, 1, { state: "expired" }), NOW)).toEqual({ skip: "expired" });
    expect(usageOf(snap(undefined, undefined), NOW)).toEqual({ skip: "no-reading" });
  });
});

describe("model limits", () => {
  // Labels as the tools report them (quota.test.ts): Claude's display names, Codex's limit_name.
  // Model names as a run gives them: Claude Code's --model aliases and full names, Codex's -m.
  it.each([
    ["opus", "Opus", true],
    ["OPUS", "Opus", true],
    ["claude-opus-4-5", "Opus", true],
    ["claude-opus-4-5-20251101", "Opus", true],
    ["opus[1m]", "Opus", true],
    ["fable", "Fable", true],
    ["claude-fable-5-1", "Fable", true],
    ["claude-sonnet-4-5", "Sonnet", true],
    ["sonnet", "Opus", false],
    ["claude-sonnet-4-5", "Opus", false],
    // Opus only while planning: which limit a session spends is not known, so none counts.
    ["opusplan", "Opus", false],
    ["default", "Opus", false],
    ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", true],
    ["GPT-5.3-Codex-Spark", "GPT-5.3-Codex-Spark", true],
    // The model the Spark limit is not on, and a short name the limit does not spell out.
    ["gpt-5.3-codex", "GPT-5.3-Codex-Spark", false],
    ["codex-spark", "GPT-5.3-Codex-Spark", false],
    ["gpt-5-codex", "GPT-5.3-Codex-Spark", false],
    // A label that begins a longer name takes it too: Codex's Spark is another model than a
    // GPT-5.3-Codex limit would be on (docs/routing.md says so).
    ["gpt-5.3-codex-spark", "GPT-5.3-Codex", true],
    // A version is one word: a limit labelled GPT-5 would not take gpt-5.3's runs.
    ["gpt-5.3-codex", "GPT-5", false],
    ["gpt-5", "GPT-5", true],
    ["opus", "", false],
  ])("a run of %s falls under %s: %s", (model, label, expected) => {
    expect(modelFallsUnder(model, label)).toBe(expected);
  });

  it.each([
    // [5H, 7D, the Opus limit, model] → usage
    [20, 30, 90, "opus", { percent: 90, window: "Opus" }],
    [20, 95, 90, "opus", { percent: 95, window: "7D" }],
    [99, 30, 90, "claude-opus-4-5", { percent: 99, window: "5H" }],
    [20, 30, 90, "sonnet", { percent: 30, window: "7D" }],
    [20, 30, 90, undefined, { percent: 30, window: "7D" }],
  ] as const)("5H %d, 7D %d and Opus %d for a run of %s: %o", (five, seven, opus, model, expected) => {
    const quota = withLimits(snap(five, seven), [
      ["Fable", 99],
      ["Opus", opus],
    ]);
    expect(usageOf(quota, NOW, model)).toEqual({ usage: { ...expected, stale: false } });
  });

  it("takes the most used of several limits a model falls under", () => {
    const quota = withLimits(snap(1, 1), [
      ["Opus", 40],
      ["claude-opus-4-5", 70],
    ]);
    expect(scopedLimitFor(quota, "claude-opus-4-5")?.usedPercent).toBe(70);
    expect(scopedLimitFor(quota, "opus")?.usedPercent).toBe(40);
  });

  it("matches a reading cached before every limit was kept against its one most used limit", () => {
    const old: QuotaSnapshot = { ...snap(1, 1), scoped: { label: "Opus", usedPercent: 88, resetsAt: null } };
    expect(usageOf(old, NOW, "opus")).toEqual({ usage: { percent: 88, window: "Opus", stale: false } });
    expect(usageOf(old, NOW, "fable")).toEqual({ usage: { percent: 1, window: "5H", stale: false } });
  });

  it("ranks by the model's limit, keeps it on the row, and waits for its reset", () => {
    const quotas = {
      "claude:a": withLimits(snap(10, 10), [["Opus", 100, inHours(30)]]),
      "claude:b": withLimits(snap(20, 20), [["Opus", 10, inHours(30)]]),
    };
    const opus = rank({ strategy: "headroom" }, quotas, { members: [A, B], model: "opus" });
    expect(opus.outcome).toMatchObject({ kind: "picked", id: "claude:b" });
    expect(opus.model).toBe("opus");
    expect(opus.rows[0]).toMatchObject({ id: "claude:a", status: "over-limit", scoped: { label: "Opus" } });
    expect(blockingReset(opus.rows[0], 100)).toBe(inHours(30));
    // Without a model, no limit on one counts.
    const plain = rank({ strategy: "headroom" }, quotas, { members: [A, B] });
    expect(plain.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(plain.rows[0].scoped).toBeUndefined();
    expect(plain.model).toBeUndefined();
  });

  // A Codex limit can have a 5-hour and a weekly window (quota.test.ts): a run counts the higher,
  // as an account's own 5H and 7D, and names it by the window.
  it.each([
    // [5H, 7D, Spark's 5-hour window, Spark's weekly window] → usage of a Spark run
    [10, 20, 90, 30, { percent: 90, window: "GPT-5.3-Codex-Spark 5H" }],
    [10, 20, 30, 95, { percent: 95, window: "GPT-5.3-Codex-Spark 7D" }],
    [10, 60, 30, 40, { percent: 60, window: "7D" }],
  ] as const)("5H %d, 7D %d and Spark 5H %d, 7D %d for a Spark run: %o", (five, seven, sparkFive, sparkWeek, expected) => {
    const quota = withLimits(snap(five, seven), [
      ["GPT-5.3-Codex-Spark", sparkFive, inHours(3), 18000],
      ["GPT-5.3-Codex-Spark", sparkWeek, inHours(100), 604800],
    ]);
    expect(usageOf(quota, NOW, "gpt-5.3-codex-spark")).toEqual({ usage: { ...expected, stale: false } });
    expect(usageOf(quota, NOW, "gpt-5.3-codex").usage?.window).not.toContain("Spark");
  });

  it.each([
    [undefined, "Opus"],
    [18000, "Opus 5H"],
    // At or below a day is the session window, as an account's own Codex windows are read.
    [86400, "Opus 5H"],
    [604800, "Opus 7D"],
  ])("names a model limit's window %o long %s", (windowSeconds, name) => {
    const limit = { label: "Opus", usedPercent: 1, resetsAt: null, ...(windowSeconds ? { windowSeconds } : {}) };
    expect(scopedWindowName(limit)).toBe(name);
  });

  it("does not pick an account whose weekly limit on the run's model is used up in the second window", () => {
    const CY = member("codex:y");
    const sparkReading = (fiveHour: number, weekly: number) =>
      parseCodexQuota({
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1_791_000_000 } },
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            rate_limit: {
              primary_window: { used_percent: fiveHour, limit_window_seconds: 18000, reset_at: 1_790_000_000 },
              secondary_window: { used_percent: weekly, limit_window_seconds: 604800, reset_at: 1_791_000_000 },
            },
          },
        ],
      });
    const quotas = {
      "codex:x": { state: "ok" as const, fetchedAt: NOW, ...sparkReading(0, 100) },
      "codex:y": { state: "ok" as const, fetchedAt: NOW, ...sparkReading(20, 30) },
    };
    const ranking = rankRoute({
      route: withDefaults({ tool: "codex", strategy: "headroom" }),
      members: [CX, CY],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
      model: "gpt-5.3-codex-spark",
    });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "codex:y" });
    expect(ranking.rows[0]).toMatchObject({
      id: "codex:x",
      status: "over-limit",
      usage: { percent: 100, window: "GPT-5.3-Codex-Spark 7D" },
    });
  });

  it("names the model limit's reset as the soonest when it is the one holding an account back", () => {
    const quotas = { "claude:a": withLimits(snap(10, 10), [["Opus", 100, inHours(3)]]) };
    expect(rank({}, quotas, { members: [A], model: "opus" }).outcome).toEqual({
      kind: "none",
      soonest: { id: "claude:a", at: inHours(3) },
    });
  });
});

describe("strategies", () => {
  const quotas = { "claude:a": snap(20, 70), "claude:b": snap(40, 30), "claude:c": snap(10, 50) };

  it("headroom picks the lowest usage", () => {
    const { outcome } = rank({ strategy: "headroom" }, quotas);
    expect(outcome).toEqual({ kind: "picked", id: "claude:b", stage: "pool", reason: "lowest usage" });
  });

  it("round-robin picks the one never picked, then the one picked longest ago", () => {
    const first = rank({ strategy: "round-robin" }, quotas);
    // Nobody picked before: the lowest usage goes first.
    expect(first.outcome).toMatchObject({ kind: "picked", id: "claude:b" });

    const lastPicked = { "claude:b": inHours(-1), "claude:a": inHours(-3), "claude:c": inHours(-2) };
    expect(rank({ strategy: "round-robin" }, quotas, { lastPicked }).outcome).toMatchObject({ id: "claude:a" });
  });

  it("round-robin takes every member in turn", () => {
    const lastPicked: Record<string, string> = {};
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { outcome } = rank({ strategy: "round-robin" }, quotas, { lastPicked });
      if (outcome.kind !== "picked") throw new Error("expected a pick");
      order.push(outcome.id);
      lastPicked[outcome.id] = inHours(i);
    }
    expect(order).toEqual(["claude:b", "claude:c", "claude:a", "claude:b"]);
  });

  it("round-robin puts a member never picked ahead of one picked, whatever its usage", () => {
    // a has the highest usage of the three, and goes first as the only one never picked.
    const lastPicked = { "claude:b": inHours(-3), "claude:c": inHours(-1) };
    expect(rank({ strategy: "round-robin" }, quotas, { lastPicked }).outcome).toMatchObject({ id: "claude:a" });
    // Two never picked: the lower usage of those two, not b, who was picked longest ago.
    expect(
      rank({ strategy: "round-robin" }, quotas, { lastPicked: { "claude:b": inHours(-3) } }).outcome,
    ).toMatchObject({ id: "claude:c" });
  });

  it("expiring picks a weekly window that resets within 24 hours", () => {
    const soon = { ...quotas, "claude:a": snap(20, 70, { weekly: { usedPercent: 70, resetsAt: inHours(10) } }) };
    expect(rank({ strategy: "expiring" }, soon).outcome).toEqual({
      kind: "picked",
      id: "claude:a",
      stage: "pool",
      reason: "weekly limit resets within 24h",
    });
  });

  // An older reading can hold a reset time already past: that week is over, so the pick stands.
  it("expiring keeps a weekly reset already past, and says it has reset", () => {
    const past = { ...quotas, "claude:a": snap(20, 70, { weekly: { usedPercent: 70, resetsAt: inHours(-1) } }) };
    expect(rank({ strategy: "expiring" }, past).outcome).toEqual({
      kind: "picked",
      id: "claude:a",
      stage: "pool",
      reason: "weekly limit has reset",
    });
  });

  it("expiring falls back to the lowest usage when nothing resets soon", () => {
    expect(rank({ strategy: "expiring" }, quotas).outcome).toMatchObject({ id: "claude:b" });
  });
});

describe("stages", () => {
  it("cuts members at or above maxUsage and marks them", () => {
    const ranking = rank({}, { "claude:a": snap(0, 99), "claude:b": snap(80, 0), "claude:c": snap(10, 20) });
    expect(ranking.outcome).toMatchObject({ id: "claude:c", stage: "pool" });
    expect(ranking.rows.map((row) => [row.id, row.status])).toEqual([
      ["claude:a", "over-limit"],
      ["claude:b", "over-limit"],
      ["claude:c", "picked"],
    ]);
  });

  it("uses the first fallback under the cut when the pool has nobody", () => {
    const ranking = rank(
      { from: ["a", "b"], fallback: ["c"] },
      { "claude:a": snap(85, 0), "claude:b": snap(0, 92), "claude:c": snap(30, 30) },
    );
    expect(ranking.outcome).toEqual({
      kind: "picked",
      id: "claude:c",
      stage: "fallback",
      reason: "first fallback under 80%",
    });
  });

  it("takes the fallback in the order it is listed, not by name or usage", () => {
    const ranking = rank(
      { from: ["a"], fallback: ["c", "b"] },
      { "claude:a": snap(90, 0), "claude:b": snap(10, 10), "claude:c": snap(50, 50) },
    );
    expect(ranking.outcome).toMatchObject({ id: "claude:c", stage: "fallback" });
  });

  it("takes a glob fallback's matches in name order", () => {
    const ranking = rank(
      { from: ["a"], fallback: ["*"] },
      { "claude:a": snap(90, 0), "claude:b": snap(50, 50), "claude:c": snap(10, 10) },
      { members: [C, B, A] },
    );
    expect(ranking.rows.map((row) => [row.id, row.role])).toEqual([
      ["claude:a", "pool"],
      ["claude:b", "fallback"],
      ["claude:c", "fallback"],
    ]);
    expect(ranking.outcome).toMatchObject({ id: "claude:b", stage: "fallback" });
  });

  it("uses the member with the most left when everyone is over the cut", () => {
    const ranking = rank(
      { from: ["a", "b"], fallback: ["c"] },
      { "claude:a": snap(85, 0), "claude:b": snap(0, 92), "claude:c": snap(88, 0) },
    );
    expect(ranking.outcome).toEqual({
      kind: "picked",
      id: "claude:a",
      stage: "overflow",
      reason: "most room left (none under 80%)",
    });
  });

  // Not "all over": one member is signed out and one sits at the cut; none is under it.
  it("says none is under the cut when some are skipped or at it rather than over", () => {
    const ranking = rank(
      { from: ["a", "b", "c"] },
      { "claude:a": snap(85, 0), "claude:b": { state: "missing", fetchedAt: NOW }, "claude:c": snap(80, 0) },
    );
    expect(ranking.outcome).toEqual({
      kind: "picked",
      id: "claude:c",
      stage: "overflow",
      reason: "most room left (none under 80%)",
    });
  });

  // No limit past the cut: an account at 99% still runs when it is the one with the most left.
  it("uses the member with the most left at 99% too, a fallback member as well", () => {
    const quotas = { "claude:a": snap(100, 0), "claude:b": snap(0, 99.5), "claude:c": snap(99, 40) };
    expect(rank({ from: ["a", "b"], fallback: ["c"] }, quotas).outcome).toEqual({
      kind: "picked",
      id: "claude:c",
      stage: "overflow",
      reason: "most room left (none under 80%)",
    });
    expect(rank({ from: ["*"], maxUsage: 50 }, quotas).outcome).toMatchObject({
      id: "claude:c",
      reason: "most room left (none under 50%)",
    });
  });

  it("finds nobody only when every member is at 100% or cannot be used, and names the soonest reset", () => {
    const quotas = {
      "claude:a": snap(100, 0, { session: { usedPercent: 100, resetsAt: inHours(5) } }),
      "claude:b": snap(104, 0, { session: { usedPercent: 104, resetsAt: inHours(1) } }),
      "claude:c": snap(0, 100, { weekly: { usedPercent: 100, resetsAt: inHours(72) } }),
    };
    expect(rank({}, quotas).outcome).toEqual({ kind: "none", soonest: { id: "claude:b", at: inHours(1) } });
    const fullOrOut = { "claude:a": quotas["claude:a"], "claude:b": snap(1, 1, { state: "missing" }) };
    expect(rank({}, fullOrOut).outcome).toEqual({ kind: "none", soonest: { id: "claude:a", at: inHours(5) } });
  });

  it("ranks a member listed in both the pool and the fallback once, in the pool", () => {
    const ranking = rank(
      { from: ["*"], fallback: ["b"] },
      { "claude:a": snap(1, 1), "claude:b": snap(2, 2), "claude:c": snap(3, 3) },
    );
    expect(ranking.rows.filter((row) => row.id === "claude:b")).toEqual([expect.objectContaining({ role: "pool" })]);
  });
});

describe("skips", () => {
  it("says why a member cannot be used", () => {
    const ranking = rank(
      { from: ["a", "b", "glm", "*"] },
      { "claude:a": snap(1, 1, { state: "missing" }), "claude:b": snap(1, 1, { state: "expired" }) },
      { members: [A, B, C, GLM] },
    );
    expect(ranking.rows.map((row) => [row.id, row.skip ?? row.status])).toEqual([
      ["claude:a", "signed-out"],
      ["claude:b", "expired"],
      ["claude:glm", "api-not-supported"],
      ["claude:c", "no-reading"],
    ]);
    expect(ranking.outcome).toEqual({ kind: "none", soonest: undefined });
  });

  // A route can name a profile that has since been removed.
  it("shows a name that is not registered and picks from the rest", () => {
    const ranking = rank(
      { from: ["gone", "*"] },
      { "claude:a": snap(1, 1), "claude:b": snap(5, 5), "claude:c": snap(9, 9) },
    );
    expect(ranking.rows.find((row) => row.id === "claude:gone")).toEqual({
      id: "claude:gone",
      role: "pool",
      pattern: "gone",
      skip: "not-registered",
      status: "skipped",
    });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
  });

  it("shows a name that is not registered once, however often it is listed", () => {
    const ranking = rank({ from: ["gone", "*"], fallback: ["claude:gone"] }, { "claude:a": snap(1, 1) });
    expect(ranking.rows.filter((row) => row.id === "claude:gone")).toEqual([
      { id: "claude:gone", role: "pool", pattern: "gone", skip: "not-registered", status: "skipped" },
    ]);
  });

  it("leaves excluded members out of every stage, the fallback included", () => {
    const ranking = rank(
      { from: ["*"], exclude: ["b"], fallback: ["b"] },
      { "claude:a": snap(90, 0), "claude:b": snap(1, 1), "claude:c": snap(90, 0) },
    );
    expect(ranking.excluded).toEqual([{ id: "claude:b", pattern: "b" }]);
    expect(ranking.rows.map((row) => row.id)).toEqual(["claude:a", "claude:c"]);
    expect(ranking.outcome).toMatchObject({ stage: "overflow" });
  });

  it("keeps a resumed run to profiles that share sessions", () => {
    const ranking = rank(
      {},
      { "claude:a": snap(50, 50), "claude:solo": snap(1, 1) },
      { members: [A, SOLO], resume: true },
    );
    expect(ranking.rows.find((row) => row.id === "claude:solo")?.skip).toBe("keeps-own-sessions");
    expect(ranking.outcome).toMatchObject({ id: "claude:a" });
  });

  it("never ranks another tool's profile", () => {
    const ranking = rank({}, { "codex:x": snap(0, 0) });
    expect(ranking.rows.some((row) => row.id === "codex:x")).toBe(false);
  });

  it("lists patterns that match nobody", () => {
    expect(rank({ from: ["*", "team-*"] }, {}).emptyPatterns).toEqual(["team-*"]);
  });

  it("lists a pattern that matches nobody once, though from and fallback both have it", () => {
    expect(rank({ from: ["a", "team-*"], fallback: ["Team-*", "x@nowhere.example.com"] }, {}).emptyPatterns).toEqual([
      "team-*",
      "x@nowhere.example.com",
    ]);
  });

  // A typo in an exclude leaves in the account it was meant to leave out.
  it("lists exclude patterns that match nobody, a name too, in the order they are given", () => {
    const ranking = rank({ exclude: ["persnal", "b", "old-*"] }, {});
    expect(ranking.emptyExcludes).toEqual(["persnal", "old-*"]);
    expect(rank({}, {}).emptyExcludes).toEqual([]);
  });
});

describe("all routes", () => {
  const W = member("claude:work");
  const CT = member("codex:team");
  const quotas = { "claude:work": snap(30, 30), "codex:team": snap(10, 10) };

  it("ranks both tools' members together", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "all" }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
    });
    expect(ranking.rows.map((row) => row.id)).toEqual(["claude:work", "codex:team"]);
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "codex:team" });
  });

  it("narrows to one tool when the run names it", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "all" }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
      onlyTool: "claude",
    });
    expect(ranking.rows.map((row) => row.id)).toEqual(["claude:work"]);
  });

  it("matches a bare name in whichever tool has it, and shows an unknown name once", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "all", from: ["gone", "work"] }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
    });
    expect(ranking.rows.map((row) => [row.id, row.skip ?? row.status])).toEqual([
      ["claude:work", "picked"],
      ["gone", "not-registered"],
    ]);
  });

  // The other tool's members are left out of a narrowed run, not shown as rows: a name only that
  // tool has is not "not registered", and neither are its excluded members or prefixed names.
  it("leaves the other tool out of a narrowed run entirely", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "all", from: ["work", "team", "codex:gone", "gone"], exclude: ["codex:*"] }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
      onlyTool: "claude",
    });
    expect(ranking.rows.map((row) => [row.id, row.skip ?? row.status])).toEqual([
      ["claude:work", "picked"],
      ["gone", "not-registered"],
    ]);
    expect(ranking.excluded).toEqual([]);
  });

  it("leaves the other tool's patterns that match nobody out of a narrowed run", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "all", from: ["*", "codex:ops-*", "claude:ops-*", "ops-*"] }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
      onlyTool: "claude",
    });
    expect(ranking.emptyPatterns).toEqual(["claude:ops-*", "ops-*"]);
  });

  it("still names an unknown name by its tool on a one-tool route", () => {
    const ranking = rankRoute({
      route: withDefaults({ tool: "codex", from: ["gone", "team"] }),
      members: [W, CT],
      quotas,
      lastPicked: {},
      now: NOW,
      resume: false,
    });
    expect(ranking.rows.map((row) => row.id)).toEqual(["codex:team", "codex:gone"]);
  });
});

describe("blockingReset", () => {
  it("is the latest reset among the windows at or above the limit", () => {
    const ranking = rank(
      {},
      {
        "claude:a": snap(97, 98, {
          session: { usedPercent: 97, resetsAt: inHours(2) },
          weekly: { usedPercent: 98, resetsAt: inHours(30) },
        }),
      },
      { members: [A] },
    );
    expect(blockingReset(ranking.rows[0], 95)).toBe(inHours(30));
  });

  it("is null when a window at or above the limit has no reset time", () => {
    const ranking = rank(
      {},
      {
        "claude:a": snap(97, 98, {
          session: { usedPercent: 97, resetsAt: inHours(2) },
          weekly: { usedPercent: 98, resetsAt: null },
        }),
      },
      { members: [A] },
    );
    expect(blockingReset(ranking.rows[0], 95)).toBeNull();
  });

  it("is null when no window is at or above the limit", () => {
    const ranking = rank({}, { "claude:a": snap(94, 50) }, { members: [A] });
    expect(blockingReset(ranking.rows[0], 95)).toBeNull();
  });
});
