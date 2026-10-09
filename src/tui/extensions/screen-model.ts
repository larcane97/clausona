import { accountsWord, fromLabel, hookWhen, scopeSentence, tagsOf, usageCells } from "../../extensions/describe.js";
import type { Extension, Inventory } from "../../extensions/model.js";
import { projectName, tilde, tildeIn } from "../../extensions/present.js";
import {
  type ItemKind,
  type OtherProject,
  otherProjects,
  pluginContents,
  rowsIn,
  SCOPE_LABEL,
  type ScopeEntry,
  type ScopeId,
  type ScopeRow,
  type ToolName,
} from "../../extensions/scopes.js";
import { COLUMN_GAP, cell, column } from "./view-model.js";

/**
 * What the Extensions screen shows, before ink draws it: one table per tool, kind and scope, its
 * cells cut to the width, and where the two panes go. Pure: it reads the inventory and nothing else.
 */

export type Tool = ToolName;
export type Kind = ItemKind;

/** The bar's second level, in order: 1, 2, 3. */
export const KINDS: readonly Kind[] = ["skill", "mcp", "hook"];
export const KIND_LABEL: Record<Kind, string> = { skill: "Skills", mcp: "MCP", hook: "Hooks" };

/** A column's title and width, its gap included. A muted column is drawn muted, as DESCRIPTION is. */
export type Column = { key: string; title: string; width: number; align?: "right"; muted?: true };

export type TagTone = "muted" | "warning" | "error";

/**
 * One line of a table: its cells, each as wide as its column, and the tag after them, cut to what
 * is left. A row of the inventory carries `row`; a line of the Other projects list, `project`.
 */
export type TableRow = {
  key: string;
  cells: string[];
  tag?: { text: string; tone: TagTone };
  row?: ScopeRow;
  project?: OtherProject;
};

/**
 * The right pane. `count` is the scope's rows before the search, as the left pane counts them.
 * `empty` is what to say in place of rows when there are none; "" when there are rows, or when
 * the header has said it already.
 */
export type Table = { header: string; count: number; columns: Column[]; rows: TableRow[]; empty: string };

/**
 * How a column takes room: the first (`lead`, NAME or WHEN) as much as its widest cell; a `fixed`
 * one as much as its widest cell, up to FIXED_MAX; a `flex` one - a description, a command, a
 * path - what the others leave.
 */
type Fit = "lead" | "fixed" | "flex";

/**
 * A column's title and how it is drawn. `search: false` keeps a count or a time out of what a
 * search reads: "/2" is not every row used twice or two days ago.
 */
type Head = { key: string; title: string; fit: Fit; align?: "right"; muted?: true; search?: false };
type Spec<T> = Head & { text: (line: T) => string };

/** The room a tag takes at least, when a row has one. */
const TAG_MIN = 12;
/** The fewest columns NAME (or WHEN) keeps before the tag gives way: 8 characters and the gap. */
const LEAD_MIN = 8 + COLUMN_GAP;
/** The fewest columns a flex column keeps before NAME gives way. */
const FLEX_MIN = 12;
/** The most a FROM, WHERE or ACCOUNTS takes: a long plugin, folder or account name is cut. */
const FIXED_MAX = 18 + COLUMN_GAP;

/** `text` in a column: cut with an ellipsis, then the gap; right-aligned before the gap for a count. */
export function columnText(text: string, col: Pick<Column, "width" | "align">): string {
  if (col.align !== "right") return column(text, col.width);
  const room = col.width - COLUMN_GAP;
  const fitted = room <= 0 ? "" : text.length > room ? cell(text, room) : text.padStart(room);
  return fitted.padEnd(Math.max(0, col.width));
}

/** A row's primary copy, which stands for the row: rows are never empty. */
function firstOf(row: ScopeRow): Extension {
  return row.items[0] as Extension;
}

/** A tag in the words of `tagsOf`, coloured by what it says: a problem red, a chore amber. */
function toneOf(tag: string): TagTone {
  if (tag === "broken link") return "error";
  if (tag === "unused") return "warning";
  return "muted";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a plugin brings, the kinds it has: "14 skills · 1 hook". */
function containsWords(inv: Inventory, row: ScopeRow): string {
  const contents = pluginContents(inv, row);
  const parts = [
    contents.skill.length > 0 ? count(contents.skill.length, "skill") : "",
    contents.mcp.length > 0 ? count(contents.mcp.length, "MCP server") : "",
    contents.hook.length > 0 ? count(contents.hook.length, "hook") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** What a server or a hook runs: its command, URL or prompt, the home dir as ~. Already redacted. */
function runsWord(inv: Inventory, row: ScopeRow): string {
  const summary = firstOf(row).summary;
  return tildeIn(summary?.command ?? summary?.url ?? summary?.prompt ?? "", inv.homeDir);
}

/** The columns of a scope's table of rows, per the spec's Tables section. */
function rowSpecs(
  inv: Inventory,
  tool: Tool,
  kind: Kind,
  scope: ScopeId,
  project: string | undefined,
  now: number,
): Spec<ScopeRow>[] {
  const name: Spec<ScopeRow> = { key: "name", title: "NAME", fit: "lead", text: (row) => row.name };
  const lastUsed: Spec<ScopeRow> = {
    key: "last-used",
    title: "LAST USED",
    fit: "fixed",
    search: false,
    text: (row) => usageCells(inv, row, project, now)[1],
  };
  if (scope === "plugins") {
    return [name, { key: "contains", title: "CONTAINS", fit: "flex", text: (row) => containsWords(inv, row) }];
  }
  if (scope === "unused") {
    const where = (row: ScopeRow) => {
      const own = firstOf(row).location.project;
      return own === undefined ? SCOPE_LABEL.global(tool) : projectName(own, inv);
    };
    return [name, { key: "where", title: "WHERE", fit: "fixed", text: where }, lastUsed];
  }
  const lead: Spec<ScopeRow> =
    kind === "hook" ? { key: "when", title: "WHEN", fit: "lead", text: (row) => hookWhen(firstOf(row)) } : name;
  const from: Spec<ScopeRow>[] =
    scope === "loaded"
      ? [{ key: "from", title: "FROM", fit: "fixed", text: (row) => fromLabel(firstOf(row), inv, project) }]
      : [];
  const runs: Spec<ScopeRow> = { key: "runs", title: "RUNS", fit: "flex", text: (row) => runsWord(inv, row) };
  const rest: Record<Tool, Record<Kind, Spec<ScopeRow>[]>> = {
    claude: {
      skill: [
        {
          key: "uses",
          title: "USES",
          fit: "fixed",
          align: "right",
          search: false,
          text: (row) => usageCells(inv, row, project, now)[0],
        },
        lastUsed,
      ],
      mcp: [{ key: "accounts", title: "ACCOUNTS", fit: "fixed", text: (row) => accountsWord(inv, row) }],
      hook: [runs],
    },
    codex: {
      skill: [
        {
          key: "description",
          title: "DESCRIPTION",
          fit: "flex",
          muted: true,
          text: (row) => firstOf(row).description ?? "",
        },
      ],
      mcp: [runs],
      hook: [runs],
    },
  };
  return [lead, ...from, ...rest[tool][kind]];
}

/** The Other projects list, before one is opened. */
function otherSpecs(inv: Inventory): Spec<OtherProject>[] {
  return [
    { key: "project", title: "PROJECT", fit: "lead", text: (p) => p.name },
    { key: "path", title: "PATH", fit: "flex", text: (p) => tilde(p.path, inv.homeDir) },
    { key: "count", title: "COUNT", fit: "fixed", align: "right", search: false, text: (p) => String(p.count) },
  ];
}

/**
 * What a search looks in besides the row's cells: names, descriptions, files and summary values,
 * each as read and as shown.
 */
function rowHaystack(inv: Inventory, row: ScopeRow): string[] {
  return [
    row.name,
    ...row.items.flatMap((item) => [
      item.name,
      item.description ?? "",
      ...[item.location.file, ...Object.values(item.summary ?? {})].flatMap((text) => [
        text,
        tildeIn(text, inv.homeDir),
      ]),
    ]),
  ];
}

/** Rows by name; hooks by when they run, two on one event in the inventory's order. */
function sortRows(rows: ScopeRow[], kind: Kind, scope: ScopeId): ScopeRow[] {
  if (kind === "hook" && scope !== "plugins") {
    return [...rows].sort(
      (a, b) => hookWhen(firstOf(a)).localeCompare(hookWhen(firstOf(b))) || firstOf(a).id.localeCompare(firstOf(b).id),
    );
  }
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

type Line = { key: string; texts: string[]; tag?: string; haystack: string[]; row?: ScopeRow; project?: OtherProject };

/**
 * Each column's width, its gap included, summing to at most `width`. Every column starts as wide as
 * its widest cell or title (a fixed one up to FIXED_MAX), and when they do not fit, gives way in
 * turn: a flex column down to FLEX_MIN, then the lead down to LEAD_MIN, keeping the tag its
 * `tagRoom`; then the tag; then each column from the right, the lead last.
 */
function fitWidths(fits: Fit[], natural: number[], width: number, tagRoom: number): number[] {
  const widths = natural.map((w, i) => (fits[i] === "fixed" ? Math.min(w, FIXED_MAX) : w));
  const room = Math.max(0, width);
  const budget = Math.max(0, room - tagRoom);
  const at = (fit: Fit) => fits.flatMap((f, i) => (f === fit ? [i] : []));
  const steps = [
    ...at("flex").map((i) => ({ i, min: FLEX_MIN, limit: budget })),
    ...at("lead").map((i) => ({ i, min: LEAD_MIN, limit: budget })),
    ...fits.map((_, i) => ({ i: fits.length - 1 - i, min: 0, limit: room })),
  ];
  for (const { i, min, limit } of steps) {
    const over = widths.reduce((sum, w) => sum + w, 0) - limit;
    const w = widths[i] ?? 0;
    if (over > 0) widths[i] = Math.max(Math.min(min, w), w - over);
  }
  return widths;
}

/** Lines into a table: widths from every line, so the columns stay put while a search narrows them. */
function layOut(heads: Head[], lines: Line[], width: number, query: string): Pick<Table, "columns" | "rows"> {
  const natural = heads.map(
    (head, i) => Math.max(head.title.length, ...lines.map((l) => l.texts[i]?.length ?? 0)) + COLUMN_GAP,
  );
  const tagRoom = lines.some((l) => l.tag !== undefined) ? TAG_MIN : 0;
  const widths = fitWidths(
    heads.map((h) => h.fit),
    natural,
    width,
    tagRoom,
  );
  const columns: Column[] = heads.map((head, i) => ({
    key: head.key,
    title: head.title,
    width: widths[i] ?? 0,
    ...(head.align ? { align: head.align } : {}),
    ...(head.muted ? { muted: head.muted } : {}),
  }));
  const left = Math.max(0, width) - widths.reduce((sum, w) => sum + w, 0);
  const needle = query.toLowerCase();
  // What the row shows - WHEN, FROM, ACCOUNTS, CONTAINS, WHERE - in full, as well as what it holds.
  const searched = (l: Line) => [...l.texts.filter((_, i) => heads[i]?.search !== false), ...l.haystack];
  const rows = lines
    .filter((l) => needle === "" || searched(l).some((text) => text.toLowerCase().includes(needle)))
    .map((l): TableRow => {
      // Cut to what the columns leave; a tag with no room at all is left out.
      const text = l.tag === undefined ? "" : cell(l.tag, left).trimEnd();
      return {
        key: l.key,
        cells: columns.map((col, i) => columnText(l.texts[i] ?? "", col)),
        ...(l.tag !== undefined && text !== "" ? { tag: { text, tone: toneOf(l.tag) } } : {}),
        ...(l.row ? { row: l.row } : {}),
        ...(l.project ? { project: l.project } : {}),
      };
    });
  return { columns, rows };
}

/** What to say when a scope has nothing, before any search. */
function nothingIn(scope: ScopeId, project: string | undefined): string {
  if (scope === "project") return project === undefined ? "" : "Nothing in this project's own files.";
  if (scope === "loaded") return "Nothing is loaded here.";
  return "None.";
}

/** The right pane for a scope (or an other project when `otherProject` is set), filtered by `query`. */
export function buildTable(
  inv: Inventory,
  tool: Tool,
  kind: Kind,
  scope: ScopeId,
  project: string | undefined,
  now: number,
  width: number,
  query: string,
  otherProject?: string,
): Table {
  const header = scopeSentence(scope, tool, kind, inv, project, otherProject);
  const q = query.trim();
  let laid: Pick<Table, "columns" | "rows">;
  let total: number;
  if (scope === "other" && otherProject === undefined) {
    const projects = otherProjects(inv, tool, kind, project);
    const specs = otherSpecs(inv);
    const lines = projects.map((p) => ({
      key: p.path,
      texts: specs.map((spec) => spec.text(p)),
      haystack: [p.name, p.path, tilde(p.path, inv.homeDir)],
      project: p,
    }));
    laid = layOut(specs, lines, width, q);
    total = projects.length;
  } else {
    const rows = sortRows(rowsIn(inv, tool, kind, scope, project, now, otherProject), kind, scope);
    const specs = rowSpecs(inv, tool, kind, scope, project, now);
    const lines = rows.map((row) => {
      const tag = tagsOf(inv, row, project, now)[0];
      return {
        key: row.key,
        texts: specs.map((spec) => spec.text(row)),
        ...(tag !== undefined ? { tag } : {}),
        haystack: rowHaystack(inv, row),
        row,
      };
    });
    laid = layOut(specs, lines, width, q);
    total = rows.length;
  }
  const empty = laid.rows.length > 0 ? "" : total > 0 ? `Nothing matches /${q}.` : nothingIn(scope, project);
  return { header, count: total, ...laid, empty };
}

/**
 * The rows the screen's chrome takes, as ExtensionsScreen draws it: Chrome's header (padding,
 * title, gap, rule, gap: 5), the tool and kind bar and the line under it (2), and Chrome's footer
 * with a status line (gap, rule, gap, status, hints, padding: 6).
 */
export const CHROME_ROWS = 13;
/** The columns Chrome's padding takes, two a side. */
export const CHROME_COLUMNS = 4;
/** The `│` between the two panes and the space after it. */
export const DIVIDER_COLUMNS = 2;
/** The width from which the scope list and the table go side by side. */
export const TWO_PANES_FROM = 100;
/** The widest the scope list gets. */
const SCOPE_PANE_MAX = 32;

export type PaneLayout = { mode: "two" | "one"; scopeWidth: number; tableWidth: number; height: number };

/**
 * Two panes at >= 100 columns; scope pane = widest "label  count" + 4, at most 32. Under 100, one
 * pane at a time at the full width. Widths are inside Chrome's padding; `height` is the panes'
 * rows, so the frame is `rows - 2` at most (ink clears the scrollback for a frame as tall as the
 * terminal). A size that is not a number, as from a stream that is no terminal, reads as 80 by 24.
 */
export function paneLayout(columns: number, rows: number, scopes: ScopeEntry[]): PaneLayout {
  const across = Number.isFinite(columns) ? columns : 80;
  const down = Number.isFinite(rows) ? rows : 24;
  const width = Math.max(1, across - CHROME_COLUMNS);
  const height = Math.max(1, down - 2 - CHROME_ROWS);
  if (across < TWO_PANES_FROM) return { mode: "one", scopeWidth: width, tableWidth: width, height };
  // The marker before a label ("▸ ") and two spaces before the divider.
  const widest = Math.max(0, ...scopes.map((s) => `${s.label}  ${s.count}`.length));
  const scopeWidth = Math.min(SCOPE_PANE_MAX, widest + 4);
  return { mode: "two", scopeWidth, tableWidth: Math.max(1, width - scopeWidth - DIVIDER_COLUMNS), height };
}
