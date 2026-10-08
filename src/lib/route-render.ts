import { type Route, type RouteSpec, withDefaults } from "../core/route-config.js";
import { blockingReset, type Ranking, type Row, type SkipReason, type Usage } from "../core/routing.js";
import type { QuotaWindow } from "../types.js";
import { bold, dim } from "./cli-style.js";
import { formatAge, formatResetIn } from "./format.js";

/** Text and JSON for routing. Pure: `now` comes in, nothing is read. */

/** How the route a run used was found. PR 2 adds `dir:<path>`, `default` and `active`. */
export type ResolvedBy = "flag" | "inline";

export function usageText(usage?: Usage): string {
  if (!usage) return "—";
  return `${Math.round(usage.percent)}% ${usage.window}${usage.stale ? " (stale)" : ""}`;
}

export function skipText(row: Row): string {
  switch (row.skip) {
    case "signed-out":
      return `signed out (clausona login ${row.id})`;
    case "expired":
      return `sign-in expired (clausona login ${row.id})`;
    case "no-reading":
      return "no quota reading (try clausona list --refresh)";
    case "not-registered":
      return "not registered";
    case "keeps-own-sessions":
      return "keeps its own sessions, so it cannot resume a shared one";
    case "api-not-supported":
      return "API profile: routes take subscription profiles only for now";
    default:
      return "";
  }
}

const routeLabel = (name: string | undefined) => (name ? `route ${name}` : "inline route");

export function describeSpec(spec: RouteSpec): string {
  const route = withDefaults(spec);
  return [
    route.tool,
    route.strategy,
    `max ${route.maxUsage}%`,
    `reserve ${route.reserveUsage}%`,
    `from ${route.from.join(", ")}`,
    ...(route.exclude.length ? [`exclude ${route.exclude.join(", ")}`] : []),
    ...(route.fallback.length ? [`fallback ${route.fallback.join(", ")}`] : []),
  ].join(" · ");
}

export function renderNote(name: string | undefined, ranking: Ranking): string {
  const { outcome, route } = ranking;
  if (outcome.kind !== "picked") return "";
  const usage = ranking.rows.find((row) => row.id === outcome.id)?.usage;
  const shown = usage ? `${Math.round(usage.percent)}% (${usage.window})${usage.stale ? " stale" : ""}` : "—";
  const stage = outcome.stage === "pool" ? "" : ` (${outcome.stage})`;
  const tail =
    outcome.stage === "pool"
      ? route.strategy
      : outcome.stage === "fallback"
        ? `every pool member at or above ${route.maxUsage}%`
        : `every member at or above ${route.maxUsage}%`;
  return `→ ${bold(outcome.id)} · ${routeLabel(name)}${stage} · usage ${shown} · ${dim(tail)}`;
}

const percent = (window: QuotaWindow | undefined) => (window ? `${Math.round(window.usedPercent)}%` : "—");

/** Wide enough for the widest usage, `100% 5H (stale)`. */
const USAGE_WIDTH = 15;

/** When a row was last picked; a time that cannot be read is "never", as ranking treats it. */
function lastPickedText(row: Row, now: number): string {
  if (row.skip) return "—";
  const at = row.lastPickedAt ? Date.parse(row.lastPickedAt) : Number.NaN;
  return Number.isNaN(at) ? "never" : formatAge(at, new Date(now));
}

/** Why a route has no rows: its patterns matched nobody, or its exclude took everyone they matched. */
function nobodyText(ranking: Ranking): string {
  const { route } = ranking;
  const after = ranking.excluded.length ? ` after excluding ${route.exclude.join(", ")}` : "";
  return `No profile matches ${route.from.join(", ")}${after}.`;
}

function statusText(row: Row, ranking: Ranking): string {
  if (row.status === "picked" && ranking.outcome.kind === "picked") return `picked: ${ranking.outcome.reason}`;
  if (row.status === "skipped") return `skipped: ${skipText(row)}`;
  if (row.status === "over-limit") return `at or above ${ranking.route.maxUsage}%`;
  return "";
}

export function renderExplain(name: string | undefined, ranking: Ranking, now: number): string {
  const { route, rows } = ranking;
  const label = (row: Row) => `${row.id}${row.role === "fallback" ? " (fallback)" : ""}`;
  const width = Math.max("PROFILE".length, ...rows.map((row) => label(row).length));
  const lines = [
    `${bold(routeLabel(name))} ${dim(`(${route.tool} · ${route.strategy} · max ${route.maxUsage}% · reserve ${route.reserveUsage}%)`)}`,
    dim(
      `    ${"PROFILE".padEnd(width)}  ${"5H".padStart(4)}  ${"7D".padStart(4)}  ${"USAGE".padEnd(USAGE_WIDTH)}  LAST PICKED`,
    ),
  ];
  for (const row of rows) {
    const mark = row.status === "picked" ? "→ " : "  ";
    const last = lastPickedText(row, now);
    lines.push(
      `  ${mark}${label(row).padEnd(width)}  ${percent(row.fiveHour).padStart(4)}  ${percent(row.sevenDay).padStart(4)}  ${usageText(row.usage).padEnd(USAGE_WIDTH)}  ${last.padEnd(11)}  ${statusText(row, ranking)}`.trimEnd(),
    );
  }
  if (rows.length === 0) lines.push(`    ${nobodyText(ranking)}`);
  if (ranking.excluded.length) {
    lines.push(
      dim(`  excluded by pattern: ${ranking.excluded.map((entry) => `${entry.id} (${entry.pattern})`).join(", ")}`),
    );
  }
  if (ranking.emptyPatterns.length) lines.push(dim(`  match nobody: ${ranking.emptyPatterns.join(", ")}`));
  if (ranking.outcome.kind === "none") lines.push("", "  Nobody can be picked now; `clausona run` would exit 75.");
  return lines.join("\n");
}

/** Skips decided without a quota reading: quotaTargets leaves these members out (route-service.ts). */
const NOT_LOOKED_UP: ReadonlySet<SkipReason> = new Set(["not-registered", "api-not-supported", "keeps-own-sessions"]);

export function renderNoAccount(name: string | undefined, ranking: Ranking, now: number): string {
  const { route, rows, outcome } = ranking;
  const lines = [`No account is available for ${routeLabel(name)}.`];
  if (rows.length === 0) {
    lines.push(`    ${nobodyText(ranking)} See clausona route list.`);
    return lines.join("\n");
  }
  const soonest = outcome.kind === "none" ? outcome.soonest?.id : undefined;
  const width = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) {
    const detail = row.skip
      ? skipText(row)
      : `${usageText(row.usage)}, resets in ${formatResetIn(blockingReset(row, route.reserveUsage), new Date(now))}`;
    lines.push(`    ${row.id.padEnd(width)}  ${detail}${row.id === soonest ? "   ← soonest" : ""}`);
  }
  // Only rows whose quota was looked up count: an unregistered name or an API profile has none to read.
  const looked = rows.filter((row) => !row.skip || !NOT_LOOKED_UP.has(row.skip));
  if (looked.length > 0 && looked.every((row) => row.skip === "no-reading")) {
    lines.push("  No quota could be read for any member: check the network, or run clausona list --refresh.");
  }
  const way = soonest ?? rows.find((row) => !row.skip)?.id;
  lines.push(`  Retry later, or name a profile: clausona run ${way ?? "<profile>"}`);
  return lines.join("\n");
}

export type RouteListEntry = {
  name: string;
  route: Route;
  members: string[];
  fallbackMembers: string[];
  excluded: string[];
  unknownNames: string[];
  emptyPatterns: string[];
};

export function renderRouteList(entries: RouteListEntry[]): string {
  const width = Math.max(...entries.map((entry) => entry.name.length));
  const lines: string[] = [];
  for (const entry of entries) {
    const { route } = entry;
    lines.push(
      `  ${bold(entry.name.padEnd(width))}  ${route.tool} · ${route.strategy} · max ${route.maxUsage}% · reserve ${route.reserveUsage}%`,
    );
    const indent = " ".repeat(width + 4);
    lines.push(
      dim(
        `${indent}from ${route.from.join(", ")}${route.exclude.length ? ` · exclude ${route.exclude.join(", ")}` : ""}${route.fallback.length ? ` · fallback ${route.fallback.join(", ")}` : ""} · ${entry.members.length} member(s)`,
      ),
    );
    for (const name of entry.unknownNames) lines.push(`${indent}⚠ '${name}' is not registered`);
    for (const pattern of entry.emptyPatterns) lines.push(`${indent}⚠ '${pattern}' matches nobody`);
  }
  return lines.join("\n");
}

/** Wraps ids into lines of at most `width` characters, comma-separated. */
function wrapIds(ids: string[], indent: string, width = 76): string[] {
  const lines: string[] = [];
  let line = "";
  for (const id of ids) {
    const next = line ? `${line}, ${id}` : id;
    if (indent.length + next.length > width && line) {
      lines.push(`${indent}${line},`);
      line = id;
    } else {
      line = next;
    }
  }
  if (line) lines.push(`${indent}${line}`);
  return lines;
}

export function renderCreateScreen(
  name: string,
  spec: RouteSpec,
  ranking: Ranking,
  andRun: boolean,
): { body: string; question: string } {
  const route = withDefaults(spec);
  const pool = ranking.rows.filter((row) => row.role === "pool");
  const usable = pool.filter((row) => !row.skip);
  // What a run could take at the pool stage now: not skipped, and under the cut.
  const underCut = usable.filter((row) => row.usage !== undefined && row.usage.percent < route.maxUsage);
  const indent = " ".repeat(12);
  const lines = [
    `Create '${name}' now?`,
    `  pool      ${route.from.join(", ")} · ${underCut.length} of ${pool.length} account(s) under ${route.maxUsage}% now`,
    ...wrapIds(
      usable.map((row) => row.id),
      indent,
    ),
    ...pool.filter((row) => row.skip).map((row) => `${indent}${row.id} (${skipText(row)})`),
    ...(route.exclude.length ? [`  exclude   ${route.exclude.join(", ")}`] : []),
    ...(route.fallback.length ? [`  fallback  ${route.fallback.join(", ")}`] : []),
    `  strategy  ${route.strategy} · max ${route.maxUsage}% · reserve ${route.reserveUsage}%`,
  ];
  return { body: lines.join("\n"), question: andRun ? "[Y]es and run · [e]dit · [n]o " : "[Y]es · [e]dit · [n]o " };
}

/*
 * The JSON shapes are documented in docs/routing.md, and fields are only ever added. Each object
 * is built field by field, never passed through, so renaming or adding an internal field cannot
 * change what a script reads.
 */

const usageJson = (usage: Usage | undefined) =>
  usage ? { percent: usage.percent, window: usage.window, stale: usage.stale } : null;

const windowJson = (window: QuotaWindow | undefined) =>
  window ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? null } : null;

const soonestJson = (soonest: { id: string; at: string } | undefined) =>
  soonest ? { id: soonest.id, at: soonest.at } : null;

export function pickJson(name: string | undefined, ranking: Ranking): object {
  const { outcome } = ranking;
  if (outcome.kind === "none") {
    return {
      profile: null,
      route: name ?? null,
      stage: null,
      usage: null,
      reason: "no account is available",
      soonest: soonestJson(outcome.soonest),
    };
  }
  const usage = usageJson(ranking.rows.find((row) => row.id === outcome.id)?.usage);
  return { profile: outcome.id, route: name ?? null, stage: outcome.stage, usage, reason: outcome.reason };
}

export function explainJson(name: string | undefined, resolvedBy: ResolvedBy, ranking: Ranking): object {
  const { route, outcome } = ranking;
  return {
    route: name ?? null,
    resolvedBy,
    settings: {
      tool: route.tool,
      from: [...route.from],
      exclude: [...route.exclude],
      strategy: route.strategy,
      maxUsage: route.maxUsage,
      reserveUsage: route.reserveUsage,
      fallback: [...route.fallback],
    },
    outcome:
      outcome.kind === "picked"
        ? { kind: outcome.kind, id: outcome.id, stage: outcome.stage, reason: outcome.reason }
        : { kind: outcome.kind, ...(outcome.soonest ? { soonest: soonestJson(outcome.soonest) } : {}) },
    members: ranking.rows.map((row) => ({
      profile: row.id,
      role: row.role,
      matchedBy: row.pattern,
      status: row.status,
      skipReason: row.skip ?? null,
      usage: usageJson(row.usage),
      fiveHour: windowJson(row.fiveHour),
      sevenDay: windowJson(row.sevenDay),
      lastPickedAt: row.lastPickedAt ?? null,
    })),
    excluded: ranking.excluded.map((entry) => ({ profile: entry.id, matchedBy: entry.pattern })),
    emptyPatterns: [...ranking.emptyPatterns],
  };
}
