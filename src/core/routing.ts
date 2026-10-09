import type { QuotaSnapshot, QuotaWindow, ToolName } from "../types.js";
import { type Route, type RouteTool, toolsOf } from "./route-config.js";
import { compareIds, type Expansion, expandPatterns, type Member, splitToolPrefix } from "./route-patterns.js";

/**
 * Picks a profile for a route. Pure: the caller brings the members, their quota and the pick
 * record. One number drives everything - an account's usage, the higher of its 5H and 7D
 * windows - through the stages: pool under maxUsage by strategy, fallback under maxUsage in
 * listed order, anyone under 100% by lowest usage, else nobody.
 */

/** Past the cut, any account under this can run: one at 100% of a window cannot. */
export const FULL = 100;

/** A failed reading's last numbers are trusted this long. */
export const STALE_LIMIT_MS = 60 * 60 * 1000;

/** `expiring` prefers weekly windows that reset within this long. */
export const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

export type UsageWindow = "5H" | "7D";

export type Usage = { percent: number; window: UsageWindow; stale: boolean };

export type SkipReason =
  | "signed-out"
  | "expired"
  | "no-reading"
  | "not-registered"
  | "keeps-own-sessions"
  | "api-not-supported";

export type Row = {
  id: string;
  role: "pool" | "fallback";
  /** The pattern the member came in by. */
  pattern: string;
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  usage?: Usage;
  lastPickedAt?: string;
  skip?: SkipReason;
  status: "picked" | "eligible" | "over-limit" | "skipped";
};

/**
 * `overflow`: everyone was at the cut or over it, and the one with the most left was taken. The
 * name is what `--json` says, kept from when a route had a limit for that stage.
 */
export type Stage = "pool" | "fallback" | "overflow";

export type Outcome =
  | { kind: "picked"; id: string; stage: Stage; reason: string }
  | { kind: "none"; soonest?: { id: string; at: string } };

export type Ranking = {
  route: Route;
  rows: Row[];
  excluded: Array<{ id: string; pattern: string }>;
  emptyPatterns: string[];
  outcome: Outcome;
};

export type RankInput = {
  route: Route;
  members: Member[];
  quotas: Record<string, QuotaSnapshot>;
  lastPicked: Record<string, string>;
  now: number;
  resume: boolean;
  /**
   * The one tool of an `all` route a run names (`clausona run claude --route any`): only that
   * tool's members are ranked, and the other tool's are left out entirely, not shown as rows.
   */
  onlyTool?: ToolName;
};

export function usageOf(snapshot: QuotaSnapshot | undefined, now: number): { usage?: Usage; skip?: SkipReason } {
  if (!snapshot) return { skip: "no-reading" };
  if (snapshot.state === "missing") return { skip: "signed-out" };
  if (snapshot.state === "expired") return { skip: "expired" };
  const present: Array<[UsageWindow, QuotaWindow]> = [];
  if (snapshot.session) present.push(["5H", snapshot.session]);
  if (snapshot.weekly) present.push(["7D", snapshot.weekly]);
  if (present.length === 0) return { skip: "no-reading" };
  const stale = snapshot.state !== "ok";
  if (stale && now - snapshot.fetchedAt >= STALE_LIMIT_MS) return { skip: "no-reading" };
  const [window, top] = present.reduce((best, entry) => (entry[1].usedPercent > best[1].usedPercent ? entry : best));
  return { usage: { percent: top.usedPercent, window, stale } };
}

const percentOf = (row: Row) => row.usage?.percent ?? Number.POSITIVE_INFINITY;
const byUsage = (a: Row, b: Row) => percentOf(a) - percentOf(b) || compareIds(a, b);

function pickedAt(row: Row): number {
  const at = row.lastPickedAt ? Date.parse(row.lastPickedAt) : Number.NaN;
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

function under(rows: Row[], limit: number): Row[] {
  return rows.filter((row) => !row.skip && row.usage !== undefined && row.usage.percent < limit);
}

function byStrategy(route: Route, candidates: Row[], now: number): { row: Row; reason: string } {
  if (route.strategy === "round-robin") {
    const [row] = [...candidates].sort((a, b) => {
      const ta = pickedAt(a);
      const tb = pickedAt(b);
      // Two never-picked members (both -Infinity) are a tie, not NaN.
      if (ta !== tb) return ta < tb ? -1 : 1;
      return byUsage(a, b);
    });
    return { row, reason: "next in turn" };
  }
  if (route.strategy === "expiring") {
    const soon = candidates.filter((row) => {
      const at = row.sevenDay?.resetsAt ? Date.parse(row.sevenDay.resetsAt) : Number.NaN;
      return !Number.isNaN(at) && at - now <= EXPIRING_WITHIN_MS;
    });
    if (soon.length > 0) return { row: [...soon].sort(byUsage)[0], reason: "weekly limit resets within 24h" };
    return { row: [...candidates].sort(byUsage)[0], reason: "lowest usage (no weekly reset within 24h)" };
  }
  return { row: [...candidates].sort(byUsage)[0], reason: "lowest usage" };
}

/** When every window at or above `limit` will have reset; null when one has no known reset. */
export function blockingReset(row: Row, limit: number): string | null {
  const blocking = [row.fiveHour, row.sevenDay].filter(
    (window): window is QuotaWindow => window !== undefined && window.usedPercent >= limit,
  );
  if (blocking.length === 0 || blocking.some((window) => !window.resetsAt)) return null;
  const ms = Math.max(...blocking.map((window) => Date.parse(window.resetsAt as string)));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function soonestReset(rows: Row[], limit: number): { id: string; at: string } | undefined {
  let best: { id: string; at: string } | undefined;
  for (const row of rows) {
    if (row.skip || !row.usage) continue;
    const at = blockingReset(row, limit);
    if (at && (!best || at < best.at)) best = { id: row.id, at };
  }
  return best;
}

/** Why the overflow stage took its account; route-render.ts shows the same words. */
export const mostLeftReason = (route: Route) => `most room left (all over ${route.maxUsage}%)`;

function decide(route: Route, rows: Row[], now: number): Outcome {
  const pool = under(
    rows.filter((row) => row.role === "pool"),
    route.maxUsage,
  );
  if (pool.length > 0) {
    const { row, reason } = byStrategy(route, pool, now);
    return { kind: "picked", id: row.id, stage: "pool", reason };
  }
  const fallback = under(
    rows.filter((row) => row.role === "fallback"),
    route.maxUsage,
  );
  if (fallback.length > 0) {
    return { kind: "picked", id: fallback[0].id, stage: "fallback", reason: `first fallback under ${route.maxUsage}%` };
  }
  const overflow = under(rows, FULL).sort(byUsage);
  if (overflow.length > 0) {
    return { kind: "picked", id: overflow[0].id, stage: "overflow", reason: mostLeftReason(route) };
  }
  return { kind: "none", soonest: soonestReset(rows, FULL) };
}

/** A name that matched nobody, as its row shows it: an `all` route's bare name is either tool's. */
function qualified(name: string, tool: RouteTool): string {
  if (name.includes(":") || tool === "all") return name;
  return `${tool}:${name}`;
}

function rowFor(member: Member, role: Row["role"], pattern: string, input: RankInput): Row {
  const lastPickedAt = input.lastPicked[member.id];
  const base: Row = { id: member.id, role, pattern, status: "eligible", ...(lastPickedAt ? { lastPickedAt } : {}) };
  // In this version a route takes subscription profiles only; PR 4 gives API profiles a usage.
  if (member.kind === "api") return { ...base, skip: "api-not-supported", status: "skipped" };
  if (input.resume && !member.sharesSessions) return { ...base, skip: "keeps-own-sessions", status: "skipped" };
  const snapshot = input.quotas[member.id];
  const { usage, skip } = usageOf(snapshot, input.now);
  return {
    ...base,
    ...(snapshot?.session ? { fiveHour: snapshot.session } : {}),
    ...(snapshot?.weekly ? { sevenDay: snapshot.weekly } : {}),
    ...(usage ? { usage } : {}),
    ...(skip ? { skip, status: "skipped" as const } : {}),
  };
}

export function rankRoute(input: RankInput): Ranking {
  const { route, onlyTool } = input;
  const tools = toolsOf(route.tool);
  // Expanded over every tool of the route even when a run names one, so that a name only the
  // other tool has is left out of the run rather than called not registered.
  const members = input.members.filter((member) => tools.includes(member.tool));
  const inRun = (tool: string | null) => !onlyTool || tool === null || tool === onlyTool;
  const excludedBy = new Map<string, string>();
  for (const { member, pattern } of expandPatterns(route.exclude, members).members) excludedBy.set(member.id, pattern);

  const rows: Row[] = [];
  const excluded: Ranking["excluded"] = [];
  const add = (role: Row["role"], expansion: Expansion) => {
    for (const { member, pattern } of expansion.members) {
      if (!inRun(member.tool)) continue;
      // A member already in the pool stays there; listing it as a fallback too changes nothing.
      if (rows.some((row) => row.id === member.id)) continue;
      const by = excludedBy.get(member.id);
      if (by !== undefined) {
        if (!excluded.some((entry) => entry.id === member.id)) excluded.push({ id: member.id, pattern: by });
        continue;
      }
      rows.push(rowFor(member, role, pattern, input));
    }
    for (const name of expansion.unknownNames) {
      if (!inRun(splitToolPrefix(name.trim()).prefix)) continue;
      const id = qualified(name, route.tool);
      // Named in both lists, or as `gone` and `claude:gone`: still one row, where it was first named.
      if (rows.some((row) => row.id === id)) continue;
      rows.push({ id, role, pattern: name, skip: "not-registered", status: "skipped" });
    }
  };
  const pool = expandPatterns(route.from, members);
  const fallback = expandPatterns(route.fallback, members);
  add("pool", pool);
  add("fallback", fallback);

  const outcome = decide(route, rows, input.now);
  for (const row of rows) {
    if (row.skip) continue;
    if (outcome.kind === "picked" && row.id === outcome.id) row.status = "picked";
    else if (row.usage && row.usage.percent >= route.maxUsage) row.status = "over-limit";
  }
  // As with unknown names: a pattern of the other tool that matches nobody is not this run's.
  const emptyPatterns = [...pool.emptyPatterns, ...fallback.emptyPatterns].filter((pattern) =>
    inRun(splitToolPrefix(pattern.trim()).prefix),
  );
  return { route, rows, excluded, emptyPatterns, outcome };
}
