import type { QuotaSnapshot, QuotaWindow, ScopedQuotaWindow, ToolName } from "../types.js";
import { foldProfileName } from "./profile-name.js";
import { isSessionLength, mostUsedWindow } from "./quota.js";
import { type Route, type RouteTool, toolsOf } from "./route-config.js";
import { compareIds, type Expansion, expandPatterns, type Member, splitToolPrefix } from "./route-patterns.js";

/**
 * Picks a profile for a route. Pure: the caller brings the members, their quota and the pick
 * record. One number drives everything - an account's usage, the highest of its 5H and 7D
 * windows and, when the run names a model, of that model's own windows - through the stages: pool
 * under maxUsage by strategy, fallback under maxUsage in listed order, anyone under 100% by lowest
 * usage, else nobody.
 */

/** Past the cut, any account under this can run: one at 100% of a window cannot. */
export const FULL = 100;

/** A failed reading's last numbers are trusted this long. */
export const STALE_LIMIT_MS = 60 * 60 * 1000;

/** `expiring` prefers weekly windows that reset within this long. */
export const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;

export type UsageWindow = "5H" | "7D";

/** A window of a model limit, as quota.ts reads it, labelled by the limit's name: `Opus`, `GPT-5.3-Codex-Spark`. */
export type ScopedWindow = ScopedQuotaWindow;

/**
 * `window` is where the percent came from: `5H`, `7D`, or the model limit the run's model falls
 * under, by scopedWindowName (`Opus`, `GPT-5.3-Codex-Spark 7D`).
 */
export type Usage = { percent: number; window: string; stale: boolean };

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
  /** The limit on the run's model, when the run names one and the account reports a limit on it. */
  scoped?: ScopedWindow;
  /**
   * Every window of the limits on the run's model, `scoped` the most used, when there is more than
   * one (a Codex limit's 5H and 7D): the account is free again once each that is full has reset.
   */
  scopedWindows?: ScopedWindow[];
  usage?: Usage;
  lastPickedAt?: string;
  skip?: SkipReason;
  status: "picked" | "eligible" | "over-limit" | "skipped";
};

/**
 * The stage that found the pick, as `--json` names it (`stage`): `pool`, an account of the pool
 * under the cut, by the strategy; `fallback`, the first fallback account under the cut; and
 * `overflow`, when nobody was under the cut and the one with the most left, still under 100%, was
 * taken.
 */
export type Stage = "pool" | "fallback" | "overflow";

export type Outcome =
  | { kind: "picked"; id: string; stage: Stage; reason: string }
  | { kind: "none"; soonest?: { id: string; at: string } };

export type Ranking = {
  route: Route;
  rows: Row[];
  excluded: Array<{ id: string; pattern: string }>;
  /** Glob and email patterns of `from` and `fallback` that match nobody, each once. */
  emptyPatterns: string[];
  /** Patterns of `exclude` that match nobody, names too: a typo there leaves in the account meant to go. */
  emptyExcludes: string[];
  outcome: Outcome;
  /** The model the run names, as RankInput has it. */
  model?: string;
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
  /**
   * The model the run names (`claude --model opus`, `codex -m …`): the account's limit on that
   * model counts as a third window. Without it, no model's limit counts.
   */
  model?: string;
};

/** Letters, digits and dots make up a word of a model's name: `gpt-5.3` is one word, not `gpt-5` and `3`. */
const WORD_CHAR = /[a-z0-9.]/;

/**
 * Whether a run of `model` falls under the limit labelled `label`: the label, ignoring case, is a
 * word (or a run of words) of the model's name. `opus`, `claude-opus-4-5` and `opus[1m]` fall
 * under `Opus`, and `gpt-5.3-codex-spark` under `GPT-5.3-Codex-Spark`; `gpt-5.3-codex` does not,
 * nor does `opusplan`, which runs Opus only while planning. Nothing is guessed: a model whose
 * name does not hold the label counts no limit.
 *
 * A hyphen ends a word, so a label that begins a longer model's name takes that model too: a
 * limit labelled `GPT-5.3-Codex` would count for `gpt-5.3-codex-spark`, which Codex names as
 * another model (in Claude's names, what follows is a version or a date). No such label is
 * reported today, and the extra match only makes an account look fuller than it is.
 */
export function modelFallsUnder(model: string, label: string): boolean {
  const name = model.toLowerCase();
  const word = label.toLowerCase();
  if (word === "") return false;
  for (let at = name.indexOf(word); at !== -1; at = name.indexOf(word, at + 1)) {
    const before = name[at - 1];
    const after = name[at + word.length];
    if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) {
      return true;
    }
  }
  return false;
}

/**
 * Which window of its model limit `limit` is, `5H` or `7D`, by the length the tool gives: Codex
 * gives it, and one Codex limit can have both. Claude's limits do not say, and are all weekly.
 */
export function scopedWindowKind(limit: ScopedWindow): UsageWindow | undefined {
  if (!limit.windowSeconds) return undefined;
  return isSessionLength(limit.windowSeconds) ? "5H" : "7D";
}

/** How a usage names a window of a model limit: `GPT-5.3-Codex-Spark 7D`, or `Opus` without a length. */
export function scopedWindowName(limit: ScopedWindow): string {
  const kind = scopedWindowKind(limit);
  return kind ? `${limit.label} ${kind}` : limit.label;
}

/** Every window of every limit a run of `model` falls under: a Codex limit can have a 5H and a 7D. */
function scopedWindowsFor(snapshot: QuotaSnapshot | undefined, model: string | undefined): ScopedWindow[] {
  if (!snapshot || !model) return [];
  // A reading an older clausona cached keeps only the most used limit: still the right one when
  // the model falls under it.
  const limits = snapshot.scopedLimits ?? (snapshot.scoped ? [snapshot.scoped] : []);
  return limits.filter((limit) => modelFallsUnder(model, limit.label));
}

/**
 * The account's limit on `model`: of the windows of every limit it falls under, the most used.
 * A Codex limit with a 5-hour and a weekly window counts the higher, as an account's own 5H and
 * 7D do, and of two as high, the one that resets later.
 */
export function scopedLimitFor(
  snapshot: QuotaSnapshot | undefined,
  model: string | undefined,
): ScopedWindow | undefined {
  return mostUsedWindow(scopedWindowsFor(snapshot, model));
}

export function usageOf(
  snapshot: QuotaSnapshot | undefined,
  now: number,
  model?: string,
): { usage?: Usage; skip?: SkipReason } {
  if (!snapshot) return { skip: "no-reading" };
  if (snapshot.state === "missing") return { skip: "signed-out" };
  if (snapshot.state === "expired") return { skip: "expired" };
  const present: Array<[string, QuotaWindow]> = [];
  if (snapshot.session) present.push(["5H", snapshot.session]);
  if (snapshot.weekly) present.push(["7D", snapshot.weekly]);
  const scoped = scopedLimitFor(snapshot, model);
  if (scoped) present.push([scopedWindowName(scoped), scoped]);
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
    const resetAt = (row: Row) => (row.sevenDay?.resetsAt ? Date.parse(row.sevenDay.resetsAt) : Number.NaN);
    const soon = candidates.filter((row) => {
      const at = resetAt(row);
      return !Number.isNaN(at) && at - now <= EXPIRING_WITHIN_MS;
    });
    if (soon.length > 0) {
      const row = [...soon].sort(byUsage)[0];
      // A reset already past is an older reading's: that week is over, which is as good a reason to
      // take the account, but not the same one.
      return { row, reason: resetAt(row) <= now ? "weekly limit has reset" : "weekly limit resets within 24h" };
    }
    return { row: [...candidates].sort(byUsage)[0], reason: "lowest usage (no weekly reset within 24h)" };
  }
  return { row: [...candidates].sort(byUsage)[0], reason: "lowest usage" };
}

/** When every window at or above `limit` will have reset; null when one has no known reset. */
export function blockingReset(row: Row, limit: number): string | null {
  const blocking = [row.fiveHour, row.sevenDay, ...(row.scopedWindows ?? [row.scoped])].filter(
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

/**
 * Why the overflow stage took its account; route-render.ts shows the same words. "None under", not
 * "all over": some may be skipped (signed out, no reading) rather than over, or sit at the cut.
 */
export const mostLeftReason = (route: Route) => `most room left (none under ${route.maxUsage}%)`;

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
  const { usage, skip } = usageOf(snapshot, input.now, input.model);
  const scoped = scopedLimitFor(snapshot, input.model);
  const scopedWindows = scopedWindowsFor(snapshot, input.model);
  return {
    ...base,
    ...(snapshot?.session ? { fiveHour: snapshot.session } : {}),
    ...(snapshot?.weekly ? { sevenDay: snapshot.weekly } : {}),
    ...(scoped ? { scoped } : {}),
    ...(scopedWindows.length > 1 ? { scopedWindows } : {}),
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
  const exclusion = expandPatterns(route.exclude, members);
  const excludedBy = new Map<string, string>();
  for (const { member, pattern } of exclusion.members) excludedBy.set(member.id, pattern);

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
  // As with unknown names: a pattern of the other tool that matches nobody is not this run's. One
  // listed in both from and fallback, or twice in either, is said once.
  const thisRun = (pattern: string) => inRun(splitToolPrefix(pattern.trim()).prefix);
  const emptyPatterns = once([...pool.emptyPatterns, ...fallback.emptyPatterns].filter(thisRun));
  const matchedNobody = new Set([...exclusion.emptyPatterns, ...exclusion.unknownNames]);
  const emptyExcludes = once(route.exclude.filter((pattern) => matchedNobody.has(pattern) && thisRun(pattern)));
  return {
    route,
    rows,
    excluded,
    emptyPatterns,
    emptyExcludes,
    outcome,
    ...(input.model ? { model: input.model } : {}),
  };
}

/** Each pattern once, where it first comes; two that differ only in case match the same accounts. */
function once(patterns: string[]): string[] {
  const seen = new Set<string>();
  return patterns.filter((pattern) => {
    const folded = foldProfileName(pattern);
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}
