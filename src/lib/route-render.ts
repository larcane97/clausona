import {
  DEFAULT_MAX_USAGE,
  type Route,
  type RouteOverrides,
  type RouteSpec,
  type RouteTool,
  type Strategy,
  toolsOf,
  withDefaults,
} from "../core/route-config.js";
import {
  blockingReset,
  type Ranking,
  type Row,
  type SkipReason,
  type Usage,
  type UsageWindow,
} from "../core/routing.js";
import type { QuotaWindow, ToolName } from "../types.js";
import { accent, bold, box, dim, dimmer, padEnd, secondary, truncate, warnIcon, yellow } from "./cli-style.js";
import { formatAge, formatQuotaPercent, formatResetIn, formatResetShort, styledQuota } from "./format.js";

/**
 * Text and JSON for routing. Pure: `now` and the terminal width come in, nothing is read. The
 * human text is laid out as `csn list` and `csn current` are: a blank line before and after, a
 * two-column indent, tables that shed columns rather than wrap a row, and settings in a box.
 */

/** How the route a run used was found. PR 2 adds `dir:<path>`, `default` and `active`. */
export type ResolvedBy = "flag" | "inline";

export function usageText(usage?: Usage): string {
  if (!usage) return "—";
  return `${Math.round(usage.percent)}% ${usage.window}${usage.stale ? " (stale)" : ""}`;
}

export function skipText(row: Pick<Row, "id" | "skip">): string {
  switch (row.skip) {
    case "signed-out":
      return `signed out (clausona login ${row.id})`;
    case "expired":
      return `sign-in expired (clausona login ${row.id})`;
    case "no-reading":
      return "no quota reading (clausona list --refresh)";
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

/** skipText without the command that fixes it, for a line that lists accounts side by side. */
export const skipReason = (row: Pick<Row, "id" | "skip">) => skipText(row).replace(/ \(.*\)$/, "");

export function toolLabel(tool: RouteTool): string {
  return tool === "all" ? "claude + codex" : tool;
}

const STRATEGY_WORDS: Record<Strategy, string> = {
  "round-robin": "round-robin (next in turn)",
  headroom: "headroom (most room first)",
  expiring: "expiring (weekly limit resetting within 24h first)",
};

/** How a route takes its accounts, in the sentence that proposes a new one. */
const STRATEGY_PHRASES: Record<Strategy, string> = {
  "round-robin": "taking turns",
  headroom: "taking the one with the most room",
  expiring: "taking first the ones whose weekly limit resets within 24h",
};

const routeLabel = (name: string | undefined) => (name ? `route ${name}` : "inline route");

/**
 * The width of the terminal the text goes to. The exit-75 message and the new-route preview go to
 * stderr, which can be a terminal of its own while stdout is piped; the rest goes to stdout.
 */
const terminalWidth = (stream: "stdout" | "stderr" = "stdout") =>
  (stream === "stderr" ? process.stderr.columns : undefined) ?? process.stdout.columns ?? 120;

/** When a reset comes: `in 2h`, or `now` once it is due (a cached reading can outlive its reset). */
function resetsIn(at: string, now: number): string {
  const left = formatResetIn(at, new Date(now));
  return left === "now" ? left : `in ${left}`;
}

/** A string quoted for a POSIX shell, so a command in a message can be pasted as it is. */
const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * The field options a run or an explain was given, as the flags that give them again, in the
 * order the help lists them. A suggested command carries them, so that it ranks what was ranked.
 */
function fieldFlags(overrides: RouteOverrides): string[] {
  const flags: string[] = [];
  const patterns = (flag: string, list: string[] | undefined) => {
    if (list?.length) flags.push(`${flag} ${shellQuote(list.join(","))}`);
  };
  patterns("--from", overrides.from);
  patterns("--exclude", overrides.exclude);
  if (overrides.strategy !== undefined) flags.push(`--strategy ${overrides.strategy}`);
  if (overrides.maxUsage !== undefined) flags.push(`--max-usage ${overrides.maxUsage}`);
  if (overrides.reserveUsage !== undefined) flags.push(`--reserve-usage ${overrides.reserveUsage}`);
  patterns("--fallback", overrides.fallback);
  return flags;
}

/**
 * The options that make up a route as a command gives it: a saved route's are the ones given
 * over it; an unsaved route is nothing but its options, and without them its own from and
 * exclude say it.
 */
function routeFlags(name: string | undefined, route: Route, overrides: RouteOverrides | undefined): string[] {
  if (name) return fieldFlags(overrides ?? {});
  return fieldFlags({ from: route.from, ...(route.exclude.length ? { exclude: route.exclude } : {}), ...overrides });
}

// ─── Wrapping ───────────────────────────────────────────────────────

const NBSP = "\u00a0";
/** Holds an option and its value together even where an unbroken command is split. */
const GLUE = "\u202f";

/** A command, kept on one line by wrap() while it fits on one. */
const unbroken = (text: string) => text.replaceAll(" ", NBSP);

/**
 * A command of several parts - `clausona run`, then an option with its value, and so on - kept
 * on one line while it fits on one, and split only between its parts when it does not.
 */
const command = (parts: string[]) => parts.map((part) => part.replaceAll(" ", GLUE)).join(NBSP);

/**
 * Prose wrapped at `width`, each line starting with `indent`. A word longer than a line gets a
 * line to itself; an unbroken command longer than a line is split at its own spaces (a
 * command() only between its parts).
 */
function wrap(text: string, width: number, indent: string): string[] {
  const room = width - indent.length;
  const words = text
    .split(" ")
    .flatMap((word) => (word.length > room && word.includes(NBSP) ? word.split(NBSP) : [word]));
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((each) => `${indent}${each.replaceAll(NBSP, " ").replaceAll(GLUE, " ")}`);
}

// ─── Tables ─────────────────────────────────────────────────────────

type Style = (text: string) => string;
/** A run of text and the style it is printed in. */
type Segment = readonly [text: string, style?: Style];
/** A table cell: segments side by side, measured by their text so that colour never counts. */
type Cell = Segment[];

const cellLength = (cell: Cell) => cell.reduce((sum, [text]) => sum + text.length, 0);

/** The cell in its colours, cut with an ellipsis when it is longer than `width`. */
function paint(cell: Cell, width = Number.POSITIVE_INFINITY): string {
  const cut = cellLength(cell) > width;
  let room = cut ? width - 1 : width;
  let out = "";
  for (const [text, style] of cell) {
    if (room <= 0) break;
    const piece = text.slice(0, room);
    room -= piece.length;
    out += style ? style(piece) : piece;
  }
  return cut && width > 0 ? `${out}…` : out;
}

/** Where a table row starts: two columns, the row's mark (`▸` for the pick), one more. */
const INDENT = 4;
const GAP = 2;

type Column = {
  /** Printed over the column; empty for a column without a header (a status, a mark). */
  label: string;
  /** Spaces before the column. */
  gap?: number;
  /** Narrowest the column is, however short its cells. */
  minWidth?: number;
};

type TableRow =
  | { mark?: string; cells: Cell[] }
  /** A row whose second cell runs from the second column to the end of the line. */
  | { mark?: string; span: [Cell, Cell] };

/** Without `header`, the rows alone: no header line and no rule under it. */
type Table = { columns: Column[]; rows: TableRow[]; header?: boolean };

const gapBefore = (table: Table, column: number) => (column === 0 ? 0 : (table.columns[column].gap ?? GAP));

/** Each column's width: its widest cell, or its header. The last one is never padded. */
function measure(table: Table): number[] {
  return table.columns.map((column, i) =>
    Math.max(
      column.minWidth ?? 0,
      table.header === false ? 0 : column.label.length,
      ...table.rows.map((row) => {
        if ("cells" in row) return cellLength(row.cells[i] ?? []);
        return i === 0 ? cellLength(row.span[0]) : 0;
      }),
    ),
  );
}

function columnStarts(table: Table, widths: number[]): number[] {
  const starts: number[] = [];
  let at = INDENT;
  for (let i = 0; i < widths.length; i++) {
    at += gapBefore(table, i);
    starts.push(at);
    at += widths[i];
  }
  return starts;
}

/** The widest line the table prints, trailing blanks left out. */
function tableWidth(table: Table, widths: number[]): number {
  const starts = columnStarts(table, widths);
  const end = (i: number, length: number) => (length > 0 ? starts[i] + length : 0);
  const lines = [
    ...(table.header === false ? [] : table.columns.map((column, i) => end(i, column.label.trimEnd().length))),
    ...table.rows.flatMap((row) =>
      "cells" in row
        ? row.cells.map((cell, i) => end(i, cellLength(cell)))
        : [end(0, cellLength(row.span[0])), end(1, cellLength(row.span[1]))],
    ),
  ];
  return Math.max(0, ...lines);
}

/** A last column narrower than this takes room from the first one instead. */
const MIN_LAST = 12;

function renderTable(table: Table, widths: number[], width: number): string[] {
  const { columns, rows } = table;
  const last = columns.length - 1;
  const starts = columnStarts(table, widths);
  const lastRoom = Math.max(0, width - starts[last]);
  const spanRoom = Math.max(0, width - starts[1]);
  const gap = (i: number) => " ".repeat(gapBefore(table, i));

  const header = columns
    .map((column, i) => `${gap(i)}${i === last ? secondary(column.label) : padEnd(secondary(column.label), widths[i])}`)
    .join("");
  // The rule runs under the columns that have a header.
  const labelled = columns.reduce((found, column, i) => (column.label.trim() ? i : found), 0);
  const lastWidth = Math.min(
    lastRoom,
    Math.max(
      columns[last].label.length,
      ...rows.map((row) => ("cells" in row ? cellLength(row.cells[last] ?? []) : 0)),
    ),
  );
  const rule = starts[labelled] - INDENT + (labelled === last ? lastWidth : widths[labelled]);

  const lines =
    table.header === false
      ? []
      : [`${" ".repeat(INDENT)}${header}`, `${" ".repeat(INDENT)}${dimmer("─".repeat(rule))}`];
  for (const row of rows) {
    const first = "cells" in row ? (row.cells[0] ?? []) : row.span[0];
    let text = padEnd(paint(first, widths[0]), widths[0]);
    if ("span" in row) {
      text += `${gap(1)}${paint(row.span[1], spanRoom)}`;
    } else {
      for (let i = 1; i <= last; i++) {
        const cell = row.cells[i] ?? [];
        text += `${gap(i)}${i === last ? paint(cell, lastRoom) : padEnd(paint(cell), widths[i])}`;
      }
    }
    lines.push(`  ${row.mark ?? " "} ${text}`);
  }
  return lines.map((line) => line.trimEnd());
}

/**
 * The first layout, widest first, that fits `width` without wrapping a row, as `csn list` picks
 * one. When none does, the last is printed with its first and last columns cut to fit.
 */
function fitTable(candidates: Table[], width: number): string[] {
  for (const table of candidates) {
    const widths = measure(table);
    if (tableWidth(table, widths) <= width) return renderTable(table, widths, width);
  }
  const table = candidates[candidates.length - 1];
  const widths = measure(table);
  const last = widths.length - 1;
  const short = MIN_LAST - (width - columnStarts(table, widths)[last]);
  if (short > 0 && last > 0) widths[0] = Math.max(table.columns[0].label.length, widths[0] - short);
  return renderTable(table, widths, width);
}

/**
 * How wide a table's percentages are: three columns (`99%`), or four once one reads `100%`.
 * They are right-aligned to it, so ` 5%` lines up with `12%`, and a skipped member's reason
 * starts where the two-digit ones do.
 */
function percentWidth(rows: Row[]): number {
  const shown = rows.flatMap((row) => (row.skip ? [] : [row.fiveHour, row.sevenDay]));
  return Math.max(3, ...shown.map((window) => (window ? formatQuotaPercent(window).length : 0)));
}

/** The 5H or 7D column: room for the widest percentage and, with `withReset`, a reset time. */
function quotaColumn(which: UsageWindow, percent: number, withReset: boolean): Column {
  return { label: which.padStart(percent), minWidth: withReset ? percent + 5 : percent };
}

/**
 * One window of a row, as `csn list` shows it: the percentage in its severity colour, then when
 * the window resets, dimmed. The window that sets the row's usage is bold.
 */
function quotaCell(row: Row, which: UsageWindow, percentAt: number, withReset: boolean, now: number): Cell {
  const window = which === "5H" ? row.fiveHour : row.sevenDay;
  if (!window || row.skip) return [["—", dim]];
  const percent = formatQuotaPercent(window);
  const styled = styledQuota(window, row.usage?.stale ? "error" : "ok");
  const shown = row.usage?.window === which ? bold(styled) : styled;
  const cell: Cell = [
    [" ".repeat(Math.max(0, percentAt - percent.length))],
    [percent, (text) => (text === percent ? shown : text)],
  ];
  const reset = withReset ? formatResetShort(window.resetsAt, new Date(now)) : "";
  if (reset) cell.push([" "], [reset, dimmer]);
  return cell;
}

/** Why a route has no rows: its patterns matched nobody, or its exclude took everyone they matched. */
function nobodyText(ranking: Ranking): string {
  const { route } = ranking;
  const after = ranking.excluded.length ? ` after excluding ${route.exclude.join(", ")}` : "";
  return `No profile matches ${route.from.join(", ")}${after}.`;
}

// ─── route list ─────────────────────────────────────────────────────

/** What a route is, in the two lines `route list` and the Routes screen both break it into. */
export const ROUTE_IS = [
  "A route picks the account for you: the next one in turn that is",
  `under ${DEFAULT_MAX_USAGE}% of its 5-hour and weekly limits.`,
] as const;

export function renderRoutesEmpty(): string {
  const example = (command: string, text: string) => `    ${accent(command.padEnd(33))}${dim(text)}`;
  return [
    "",
    `  ${bold("No routes yet.")}`,
    "",
    ...ROUTE_IS.map((line) => `  ${line}`),
    "",
    example("clausona route add main", "every Claude account, taking turns"),
    example("clausona run --route main", "run on the account it picks"),
    example("clausona route", "create and edit routes in the dashboard"),
    "",
  ].join("\n");
}

/** A route as `route list` shows it; no ranking with `--no-quota`. */
export type RouteListRow = { name: string; route: Route; ranking?: Ranking };

type RouteColumn = "route" | "tool" | "strategy" | "limits" | "free" | "next";

const ROUTE_LABELS: Record<RouteColumn, string> = {
  route: "ROUTE",
  tool: "TOOL",
  strategy: "STRATEGY",
  limits: "LIMITS",
  free: "FREE NOW",
  next: "NEXT",
};

/** Widest first. TOOL goes first, then LIMITS, then STRATEGY; the name and who is free never do. */
const ROUTE_LAYOUTS: RouteColumn[][] = [
  ["route", "tool", "strategy", "limits", "free", "next"],
  ["route", "strategy", "limits", "free", "next"],
  ["route", "strategy", "free", "next"],
  ["route", "free", "next"],
];

/** Skips decided without a quota reading: quotaTargets leaves these members out (route-service.ts). */
const NOT_LOOKED_UP: ReadonlySet<SkipReason> = new Set(["not-registered", "api-not-supported", "keeps-own-sessions"]);

/**
 * Whether no quota could be read for any member (offline, say). Only rows whose quota was looked
 * up count: an unregistered name or an API profile has none to read.
 */
function nothingRead(rows: Row[]): boolean {
  const looked = rows.filter((row) => !row.skip || !NOT_LOOKED_UP.has(row.skip));
  return looked.length > 0 && looked.every((row) => row.skip === "no-reading");
}

/**
 * Members free now - not skipped, and under the cut - out of every member: a skipped one counts
 * (it is in the route, just unusable now), a name that is not registered does not.
 */
export function freeNow(ranking: Ranking): { free: number; members: number } {
  const members = ranking.rows.filter((row) => row.skip !== "not-registered");
  const free = members.filter(
    (row) => !row.skip && row.usage !== undefined && row.usage.percent < ranking.route.maxUsage,
  );
  return { free: free.length, members: members.length };
}

function nextCell(ranking: Ranking, now: number): Cell {
  const { outcome } = ranking;
  if (outcome.kind === "picked") return [[outcome.id, accent]];
  if (!outcome.soonest) return [["none", yellow]];
  return [[`none, soonest ${resetsIn(outcome.soonest.at, now)}`, yellow]];
}

/** `route list`: one row per route, then the warnings. No routes at all is the empty state. */
export function renderRouteTable(
  rows: RouteListRow[],
  warnings: string[],
  options: { width?: number; now?: number } = {},
): string {
  if (rows.length === 0) return renderRoutesEmpty();
  const width = options.width ?? terminalWidth();
  const now = options.now ?? Date.now();
  const cells = rows.map(({ name, route, ranking: given }): Record<RouteColumn, Cell> => {
    // A ranking with nothing read says nothing about who is free: dashes, as with --no-quota.
    const ranking = given && !nothingRead(given.rows) ? given : undefined;
    const count = ranking ? freeNow(ranking) : undefined;
    return {
      route: [[name]],
      tool: [[toolLabel(route.tool), secondary]],
      strategy: [[route.strategy, secondary]],
      limits: [[`${route.maxUsage}% / ${route.reserveUsage}%`, secondary]],
      free: count ? [[`${count.free} of ${count.members}`, count.free === 0 ? yellow : undefined]] : [["—", dim]],
      next: ranking ? nextCell(ranking, now) : [["—", dim]],
    };
  });
  const layouts = ROUTE_LAYOUTS.map(
    (keys): Table => ({
      columns: keys.map((key) => ({ label: ROUTE_LABELS[key] })),
      rows: cells.map((row) => ({ cells: keys.map((key) => row[key]) })),
    }),
  );
  const notes = warnings.flatMap((warning) =>
    wrap(warning, width, " ".repeat(INDENT)).map((line, i) => (i === 0 ? `  ${warnIcon} ${line.trimStart()}` : line)),
  );
  return ["", ...fitTable(layouts, width), ...(notes.length ? ["", ...notes] : []), ""].join("\n");
}

// ─── route explain / add / set ──────────────────────────────────────

/** The box's labels are padded, as `csn current` pads its own, so the values line up. */
const LABEL_WIDTH = 11;

/** A box line is its content plus eight columns: the indent, the borders and their padding. */
const BOX_CHROME = 8;

function settingsLines(route: Route, width: number): string[] {
  const room = Math.max(20, width - BOX_CHROME - LABEL_WIDTH);
  const entry = (label: string, value: string) =>
    wrap(value, room, "").map(
      (line, i) => `${i === 0 ? secondary(label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH)}${line}`,
    );
  return [
    ...entry("Tool", toolLabel(route.tool)),
    ...entry("Strategy", STRATEGY_WORDS[route.strategy]),
    ...entry("Limits", `skip at ${route.maxUsage}%, reserve up to ${route.reserveUsage}%`),
    ...entry(
      "Accounts",
      `${route.from.join(", ")}${route.exclude.length ? ` except ${route.exclude.join(", ")}` : ""}`,
    ),
    ...entry("Fallback", route.fallback.length ? route.fallback.join(", ") : "none"),
  ];
}

function statusCell(row: Row, ranking: Ranking): Cell {
  const { outcome, route } = ranking;
  if (row.status === "picked" && outcome.kind === "picked") {
    if (outcome.stage === "pool") return [["picked next", accent]];
    if (outcome.stage === "fallback") return [["picked: fallback", accent]];
    return [[`picked: reserve, most room up to ${route.reserveUsage}%`, accent]];
  }
  if (row.status === "over-limit") return [[`over ${route.maxUsage}%`, yellow]];
  if (row.skip) return [[skipText(row), dim]];
  return [];
}

/** When a member was last picked; a time that cannot be read is "never", as ranking treats it. */
function lastPickedCell(row: Row, now: number): Cell {
  if (row.skip || row.status === "over-limit") return [];
  const at = row.lastPickedAt ? Date.parse(row.lastPickedAt) : Number.NaN;
  return [[Number.isNaN(at) ? "never" : formatAge(at, new Date(now)), secondary]];
}

/** The pick first, then the others by usage, then the skipped; ranking order within each. */
export function detailOrder(rows: Row[]): Row[] {
  const group = (row: Row) => (row.status === "picked" ? 0 : row.skip ? 2 : 1);
  const usage = (row: Row) => row.usage?.percent ?? 0;
  return [...rows].sort((a, b) => group(a) - group(b) || (group(a) === 1 ? usage(a) - usage(b) : 0));
}

function memberLines(ranking: Ranking, width: number, now: number): string[] {
  const members = detailOrder(ranking.rows.filter((row) => row.skip !== "not-registered"));
  const others: Array<[string, string]> = [
    ...ranking.rows
      .filter((row) => row.skip === "not-registered")
      .map((row): [string, string] => [row.id, skipText(row)]),
    ...ranking.emptyPatterns.map((pattern): [string, string] => [pattern, "matches nobody"]),
    ...ranking.excluded.map((entry): [string, string] => [entry.id, `excluded by ${entry.pattern}`]),
  ];
  const otherRows = others.map(([id, text]): TableRow => ({ span: [[[id]], [[text, dim]]] }));
  if (members.length === 0) {
    const list: Table = { header: false, columns: [{ label: "" }, { label: "" }], rows: otherRows };
    return [
      ...wrap(nobodyText(ranking), width, " ".repeat(INDENT)),
      ...(otherRows.length ? fitTable([list], width) : []),
    ];
  }

  const roundRobin = ranking.route.strategy === "round-robin";
  const percent = percentWidth(members);
  // Widest first: dashes for a skipped member's quota, then its reason across those columns
  // instead, then no LAST PICKED, then no reset times.
  const layouts = [
    { lastPicked: roundRobin, resets: true, spanSkipped: false },
    { lastPicked: roundRobin, resets: true, spanSkipped: true },
    { lastPicked: false, resets: true, spanSkipped: true },
    { lastPicked: false, resets: false, spanSkipped: true },
  ];
  const tables = layouts.map(
    ({ lastPicked, resets, spanSkipped }): Table => ({
      columns: [
        { label: "ACCOUNT" },
        quotaColumn("5H", percent, resets),
        quotaColumn("7D", percent, resets),
        ...(lastPicked ? [{ label: "LAST PICKED" }] : []),
        { label: "" },
      ],
      rows: [
        ...members.map((row): TableRow => {
          const picked = row.status === "picked";
          const mark = picked ? accent("▸") : undefined;
          const account: Cell = [[row.id, picked ? accent : undefined]];
          if (row.role === "fallback") account.push([" (fallback)", dim]);
          const status = statusCell(row, ranking);
          if (row.skip && spanSkipped) return { mark, span: [account, status] };
          return {
            mark,
            cells: [
              account,
              quotaCell(row, "5H", percent, resets, now),
              quotaCell(row, "7D", percent, resets, now),
              ...(lastPicked ? [lastPickedCell(row, now)] : []),
              status,
            ],
          };
        }),
        ...otherRows,
      ],
    }),
  );
  return fitTable(tables, width);
}

/**
 * `route explain`, and what `route add` and `route set` show: the settings, then every member.
 * `onlyTool` is the tool an explain narrowed an `all` route to, as a run naming it would;
 * `overrides` are the field options the explain was given, which the run it names carries too.
 */
export function renderRouteDetail(
  name: string | undefined,
  ranking: Ranking,
  options: { width?: number; now?: number; onlyTool?: ToolName; overrides?: RouteOverrides } = {},
): string {
  const width = options.width ?? terminalWidth();
  const now = options.now ?? Date.now();
  const { route } = ranking;
  const title = truncate(name ?? "inline route", Math.max(8, width - 12));
  const lines = ["", box(title, settingsLines(route, width)), "", ...memberLines(ranking, width, now)];
  if (ranking.outcome.kind === "none") {
    const narrowed = route.tool === "all" ? options.onlyTool : undefined;
    // An unsaved route's tool is the run's tool word; on an `all` route the --from prefixes say it.
    const tool = narrowed ?? (name || route.tool === "all" ? undefined : route.tool);
    const run = command([
      tool ? `clausona run ${tool}` : "clausona run",
      ...(name ? [`--route ${name}`] : []),
      ...routeFlags(name, route, options.overrides),
    ]);
    lines.push("", ...wrap(`Nobody can be picked now; ${run} would exit 75.`, width, "  "));
  }
  lines.push("");
  return lines.join("\n");
}

// ─── csn run ────────────────────────────────────────────────────────

/** Why the picked member was picked, in a few words. */
function pickedWhy(ranking: Ranking): string {
  const { outcome, route } = ranking;
  if (outcome.kind !== "picked") return "";
  if (outcome.stage === "fallback") return "fallback";
  if (outcome.stage === "reserve") return "reserve";
  if (route.strategy === "round-robin") return "next in turn";
  // routing.ts says which of the two `expiring` took.
  if (route.strategy === "expiring" && outcome.reason.startsWith("weekly limit resets")) {
    return "weekly limit resets within 24h";
  }
  return "most room";
}

/** The one line a routed run says on stderr before it launches. */
export function renderNote(name: string | undefined, ranking: Ranking): string {
  const { outcome } = ranking;
  if (outcome.kind !== "picked") return "";
  const usage = ranking.rows.find((row) => row.id === outcome.id)?.usage;
  const parts = [routeLabel(name), pickedWhy(ranking)];
  if (usage) {
    parts.push(`${Math.round(usage.percent)}% of ${usage.window} used${usage.stale ? ", last reading" : ""}`);
  }
  return `  ${accent("▸")} ${bold(outcome.id)}  ${dim(parts.join(", "))}`;
}

/** A reset nobody knows sorts after every known one. */
const resetOrder = (at: string | null) => (at === null ? Number.MAX_SAFE_INTEGER : Date.parse(at));

/** When every window at or above the reserve will have reset, and which window that is. */
function freeAgainCell(row: Row, limit: number, at: string | null, now: number): Cell {
  if (!at) return [["—", dim]];
  const ms = Date.parse(at);
  const resetsThen = (window: QuotaWindow | undefined) =>
    window !== undefined &&
    window.usedPercent >= limit &&
    Boolean(window.resetsAt) &&
    Date.parse(window.resetsAt as string) === ms;
  const which: UsageWindow = resetsThen(row.sevenDay) ? "7D" : "5H";
  return [[`${resetsIn(at, now)} (${which} resets)`, secondary]];
}

/**
 * Exit 75's message: who is held back and until when, and what to do. NoAccountError prints it
 * after a `✘`, on stderr, so its first line is the headline and the rest is indented under it.
 * `onlyTool` is the tool a run narrowed an `all` route to: the message is about that tool's
 * accounts only, and so is the explain it points to.
 */
export function renderNoAccount(
  name: string | undefined,
  ranking: Ranking,
  options: { width?: number; now?: number; onlyTool?: ToolName } = {},
): string {
  const width = options.width ?? terminalWidth("stderr");
  const now = options.now ?? Date.now();
  const { route, rows, outcome } = ranking;
  const narrowed = route.tool === "all" ? options.onlyTool : undefined;
  const headline = `No ${narrowed ? `${narrowed} ` : ""}account in ${name ? `route ${name}` : "the inline route"} is free right now.`;
  const indent = " ".repeat(INDENT);
  if (rows.length === 0) {
    return [
      headline,
      "",
      ...wrap(`${nobodyText(ranking)} See ${unbroken("clausona route list")}.`, width, indent),
      "",
    ].join("\n");
  }

  const soonest = outcome.kind === "none" ? outcome.soonest : undefined;
  // Soonest free first, a reset nobody knows last, then the members that are skipped.
  const held = rows
    .filter((row) => !row.skip)
    .map((row) => ({ row, at: blockingReset(row, route.reserveUsage) }))
    .sort((a, b) => resetOrder(a.at) - resetOrder(b.at));
  const skipped = rows.filter((row) => row.skip);
  const percent = percentWidth(rows);
  const tables = [true, false].map(
    (resets): Table => ({
      // Nobody held back by a limit, only skipped members: their reasons, without a header.
      header: held.length > 0,
      columns: [
        { label: "ACCOUNT" },
        quotaColumn("5H", percent, resets),
        quotaColumn("7D", percent, resets),
        { label: "FREE AGAIN" },
        { label: "", gap: 3 },
      ],
      rows: [
        ...held.map(
          ({ row, at }): TableRow => ({
            cells: [
              [[row.id]],
              quotaCell(row, "5H", percent, resets, now),
              quotaCell(row, "7D", percent, resets, now),
              freeAgainCell(row, route.reserveUsage, at, now),
              row.id === soonest?.id ? [["soonest", accent]] : [],
            ],
          }),
        ),
        ...skipped.map((row): TableRow => ({ span: [[[row.id]], [[skipText(row), dim]]] })),
      ],
    }),
  );

  const explain = name
    ? `clausona route explain ${name}${narrowed ? ` --tool ${narrowed}` : ""}`
    : `clausona route explain --tool ${narrowed ?? route.tool} --from ${shellQuote(route.from.join(","))}`;
  const when = soonest ? formatResetIn(soonest.at, new Date(now)) : undefined;
  const again = when === "now" ? "now" : when ? `after ${unbroken(when)}` : "later";
  const advice = nothingRead(rows)
    ? `No quota could be read for any member: check the network, or run ${unbroken("clausona list --refresh")}.`
    : `Run again ${again}, or see everything with: ${unbroken(explain)}`;
  return [headline, "", ...fitTable(tables, width), "", ...wrap(advice, width, indent), ""].join("\n");
}

/** The longest a proposal's sentence runs before it wraps, as prose does in the help. */
const PROSE_WIDTH = 72;

/**
 * What `csn run --route <unknown>` proposes, before it asks whether to create it: the rule in a
 * sentence, then each account it would take with its usage now.
 */
export function renderNewRoutePreview(
  name: string,
  spec: RouteSpec,
  ranking: Ranking,
  options: { width?: number } = {},
): string {
  const width = options.width ?? terminalWidth("stderr");
  const route = withDefaults(spec);
  // An exact profile name reads as the account it is; a glob or an email pattern stays a pattern.
  const named = (pattern: string) =>
    route.tool === "all" || /[:@*?]/.test(pattern) ? pattern : `${route.tool}:${pattern}`;
  const except = route.exclude.length ? ` except ${route.exclude.map(named).join(", ")}` : "";
  const everyone = route.from.length === 1 && route.from[0] === "*";
  const accounts = everyone
    ? `every ${toolsOf(route.tool).join(" and ")} account${except}`
    : `${route.from.map(named).join(", ")}${except}`;
  const sentence = `Route ${name} does not exist yet. It would take ${accounts}, ${STRATEGY_PHRASES[route.strategy]} and skipping any at ${route.maxUsage}% or more:`;

  const usable = ranking.rows
    .filter((row) => !row.skip && row.usage)
    .sort((a, b) => (a.usage?.percent ?? 0) - (b.usage?.percent ?? 0));
  const items = [...usable, ...ranking.rows.filter((row) => row.skip || !row.usage)].map((row): Cell => {
    const cell: Cell = [[row.id]];
    if (row.role === "fallback") cell.push([" (fallback)", dim]);
    if (row.skip || !row.usage) return [...cell, [` (${skipReason(row)})`, dim]];
    const window: QuotaWindow = { usedPercent: row.usage.percent, resetsAt: null };
    const percent = formatQuotaPercent(window);
    const styled = styledQuota(window, row.usage.stale ? "error" : "ok");
    cell.push([" "], [percent, (text) => (text === percent ? styled : text)]);
    if (row.usage.percent >= route.maxUsage) cell.push([" (over)", yellow]);
    return cell;
  });
  const lines: string[] = [];
  let line: Cell[] = [];
  const lineLength = (cells: Cell[]) => cells.reduce((sum, cell) => sum + cellLength(cell), 0) + 3 * (cells.length - 1);
  for (const item of items) {
    if (line.length && INDENT + lineLength([...line, item]) > width) {
      lines.push(line.map((cell) => paint(cell)).join("   "));
      line = [];
    }
    line.push(item);
  }
  if (line.length) lines.push(line.map((cell) => paint(cell)).join("   "));

  return [
    "",
    ...wrap(sentence, Math.min(width, PROSE_WIDTH), "  "),
    "",
    ...(items.length
      ? lines.map((each) => `${" ".repeat(INDENT)}${each}`)
      : wrap(nobodyText(ranking), width, " ".repeat(INDENT))),
    "",
  ].join("\n");
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
