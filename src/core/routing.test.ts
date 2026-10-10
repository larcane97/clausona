import { describe, expect, it } from "vitest";

import type { QuotaSnapshot, ToolName } from "../types.js";
import { type RouteSpec, withDefaults } from "./route-config.js";
import type { Member } from "./route-patterns.js";
import { blockingReset, rankRoute, usageOf } from "./routing.js";

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
  options: { lastPicked?: Record<string, string>; resume?: boolean; members?: Member[] } = {},
) {
  return rankRoute({
    route: withDefaults({ tool: "claude", ...spec }),
    members: options.members ?? [A, B, C, CX],
    quotas,
    lastPicked: options.lastPicked ?? {},
    now: NOW,
    resume: options.resume ?? false,
  });
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

  it("expiring picks a weekly window that resets within 24 hours", () => {
    const soon = { ...quotas, "claude:a": snap(20, 70, { weekly: { usedPercent: 70, resetsAt: inHours(10) } }) };
    expect(rank({ strategy: "expiring" }, soon).outcome).toEqual({
      kind: "picked",
      id: "claude:a",
      stage: "pool",
      reason: "weekly limit resets within 24h",
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

  it("uses the member with the most left when everyone is over the cut", () => {
    const ranking = rank(
      { from: ["a", "b"], fallback: ["c"] },
      { "claude:a": snap(85, 0), "claude:b": snap(0, 92), "claude:c": snap(88, 0) },
    );
    expect(ranking.outcome).toEqual({
      kind: "picked",
      id: "claude:a",
      stage: "overflow",
      reason: "most room left (all over 80%)",
    });
  });

  // No limit past the cut: an account at 99% still runs when it is the one with the most left.
  it("uses the member with the most left at 99% too, a fallback member as well", () => {
    const quotas = { "claude:a": snap(100, 0), "claude:b": snap(0, 99.5), "claude:c": snap(99, 40) };
    expect(rank({ from: ["a", "b"], fallback: ["c"] }, quotas).outcome).toEqual({
      kind: "picked",
      id: "claude:c",
      stage: "overflow",
      reason: "most room left (all over 80%)",
    });
    expect(rank({ from: ["*"], maxUsage: 50 }, quotas).outcome).toMatchObject({
      id: "claude:c",
      reason: "most room left (all over 50%)",
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

  // Review Focus 4: a pool member also listed as a fallback is one member, in the pool.
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

  // Review Focus 5: a removed profile named exactly does not stop the rest from being picked.
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

  // Review Focus 4
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
});
