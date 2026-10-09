import path from "node:path";

import {
  accountsWord,
  containsWords,
  type DetailLine,
  fromLabel,
  hookWhen,
  scopeSentence,
  tagsOf,
  usageCells,
  whereLabel,
} from "../../extensions/describe.js";
import type { Extension, Inventory } from "../../extensions/model.js";
import { projectName, tilde, tildeIn } from "../../extensions/present.js";
import { pathKey, samePath } from "../../extensions/read.js";
import {
  homeScope,
  type ItemKind,
  rowKey,
  rowsIn,
  type ScopeEntry,
  type ScopeId,
  type ScopeRow,
  type ToolName,
} from "../../extensions/scopes.js";
import { COLUMN_GAP, cell, column, wrapText } from "./view-model.js";

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
 * is left, and the row of the inventory it shows.
 */
export type TableRow = {
  key: string;
  cells: string[];
  tag?: { text: string; tone: TagTone };
  row: ScopeRow;
};

/**
 * The right pane. `count` is the scope's rows before the search, as the left pane counts them;
 * `countText` is how the header says it: "13", or "1 of 13" - the matches of them - while a
 * search is on. `empty` is what to say in place of rows when there are none; "" when there are
 * rows, or when the header has said it already.
 */
export type Table = {
  header: string;
  count: number;
  countText: string;
  columns: Column[];
  rows: TableRow[];
  empty: string;
};

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
    // As the CLI's WHERE says it: Project, Global, or another project's name.
    const where = (row: ScopeRow) => whereLabel(firstOf(row), inv, project);
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

type Line = { key: string; texts: string[]; tag?: string; haystack: string[]; row: ScopeRow };

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
        row: l.row,
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

/** The right pane for a scope, filtered by `query`. */
export function buildTable(
  inv: Inventory,
  tool: Tool,
  kind: Kind,
  scope: ScopeId,
  project: string | undefined,
  now: number,
  width: number,
  query: string,
): Table {
  const header = scopeSentence(scope, tool, kind, inv, project);
  const q = query.trim();
  const rows = sortRows(rowsIn(inv, tool, kind, scope, project, now), kind, scope);
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
  const laid = layOut(specs, lines, width, q);
  const total = rows.length;
  const empty = laid.rows.length > 0 ? "" : total > 0 ? `Nothing matches /${q}.` : nothingIn(scope, project);
  const countText = q === "" ? String(total) : `${laid.rows.length} of ${total}`;
  return { header, count: total, countText, ...laid, empty };
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
/**
 * The lines a pane draws above its rows: the table's header and its column titles, or the
 * details' title and the blank line under it.
 */
export const PANE_HEAD_ROWS = 2;
/** The lines the scope list draws above the scopes: the project row and the rule under it. */
export const PROJECT_ROWS = 2;
/** The line the project list draws above the projects: its heading. */
export const LIST_HEAD_ROWS = 1;

/** The project list's last line, for looking from no project: user settings only. */
export const NO_PROJECT = "No project";
/** What follows the name of the project the folder csn was started in belongs to. */
const HERE = " (here)";
/** The project list's heading, before the kind's noun. */
const PROJECT_HEADING = "PROJECT";
/** The `✦` before the table's selected row and the space after it: the table's cells start after them. */
export const CURSOR_COLUMNS = 2;
/** The width from which the scope list and the table go side by side. */
export const TWO_PANES_FROM = 100;
/** The widest the scope list gets. */
const SCOPE_PANE_MAX = 32;

export type PaneLayout = { mode: "two" | "one"; scopeWidth: number; tableWidth: number; height: number };

/**
 * Two panes at >= 100 columns; scope pane = widest "label  count" + 4, or what the project row
 * and the project list take (`projects`, from projectPaneWidth) when that is more, at most 32.
 * Under 100, one pane at a time: the table and the details at the full width, the scope list and
 * the project list as wide as beside the table, left-aligned. Widths are inside Chrome's padding;
 * `height` is the panes' rows, so the frame is `rows - 2` at most (ink clears the scrollback for a
 * frame as tall as the terminal). A size that is not a number, as from a stream that is no
 * terminal, reads as 80 by 24.
 */
export function paneLayout(columns: number, rows: number, scopes: ScopeEntry[], projects = 0): PaneLayout {
  const across = Number.isFinite(columns) ? columns : 80;
  const down = Number.isFinite(rows) ? rows : 24;
  const width = Math.max(1, across - CHROME_COLUMNS);
  const height = Math.max(1, down - 2 - CHROME_ROWS);
  // The marker before a label ("▸ ") and two spaces before the divider. One pane alone keeps this
  // width too, so a count sits next to its label rather than across the terminal from it.
  const widest = Math.max(0, ...scopes.map((s) => `${s.label}  ${s.count}`.length));
  const scopeWidth = Math.min(SCOPE_PANE_MAX, Math.max(widest + 4, projects), width);
  if (across < TWO_PANES_FROM) return { mode: "one", scopeWidth, tableWidth: width, height };
  return { mode: "two", scopeWidth, tableWidth: Math.max(1, width - scopeWidth - DIVIDER_COLUMNS), height };
}

/** A line of the scope list: a scope, or the rule that sets Loaded and Not used in 90 days apart. */
export type ScopeLine = { type: "scope"; key: string; entry: ScopeEntry } | { type: "rule"; key: string };

/** The scope list's lines: a rule after Loaded and another before Not used in 90 days, when there. */
export function scopeLines(scopes: ScopeEntry[]): ScopeLine[] {
  const lines: ScopeLine[] = [];
  for (const entry of scopes) {
    const prev = lines.at(-1);
    // One rule where the two stand together: Loaded, then Not used in 90 days.
    if (prev?.type === "scope" && (prev.entry.id === "loaded" || entry.id === "unused")) {
      lines.push({ type: "rule", key: `rule-${entry.id}` });
    }
    lines.push({ type: "scope", key: entry.id, entry });
  }
  return lines;
}

/** A line of the project list: a recorded project, or No project. */
export type ProjectEntry = {
  key: string;
  /** Undefined for No project. */
  path?: string;
  name: string;
  /** The project the folder csn was started in belongs to: it reads "(here)". */
  here: boolean;
  /** The project everything is seen from now. */
  current: boolean;
  /** Its own rows of the tool and kind, as its Project scope lists them once it is picked. */
  count: number;
};

/** How many of each name there are. */
function counted(names: string[]): (name: string) => number {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return (name) => counts.get(name) ?? 0;
}

/**
 * Each recorded project's name, by path key: `projectName`, and the folder above it too where two
 * projects share a folder name - `work/site`, `mine/site` - or the path where even that is one.
 */
function projectNames(inv: Inventory): Map<string, string> {
  const named = inv.projects.map((p) => ({ dir: p.path, name: projectName(p.path, inv) }));
  const shared = counted(named.map((p) => p.name));
  const longer = named.map((p) =>
    shared(p.name) > 1 ? { ...p, name: path.join(path.basename(path.dirname(p.dir)), p.name) } : p,
  );
  const still = counted(longer.map((p) => p.name));
  return new Map(longer.map((p) => [pathKey(p.dir), still(p.name) > 1 ? tilde(p.dir, inv.homeDir) : p.name]));
}

/**
 * The project list: `project`, the one everything is seen from, first; then every other recorded
 * project, by name; then No project. `here` is the project of the folder csn was started in. Each
 * counts its own rows of the tool and kind - what its Project scope lists once it is picked -
 * read in one pass over the inventory.
 */
export function projectList(
  inv: Inventory,
  tool: Tool,
  kind: Kind,
  project: string | undefined,
  here: string | undefined,
): ProjectEntry[] {
  // An item is a project's own when, seen from that project, it is in Project: not a plugin's,
  // Cloud's, built in or managed. Counted in rows, as the table lists them.
  const own = new Map<string, Set<string>>();
  for (const item of inv.items) {
    const dir = item.location.project;
    if (item.kind !== kind || item.location.tool !== tool || dir === undefined) continue;
    if (homeScope(item, dir) !== "project") continue;
    const key = pathKey(dir);
    const rows = own.get(key) ?? new Set<string>();
    rows.add(rowKey(item));
    own.set(key, rows);
  }
  const names = projectNames(inv);
  const entry = (dir: string): ProjectEntry => {
    const key = pathKey(dir);
    return {
      key,
      path: dir,
      name: names.get(key) ?? projectName(dir, inv),
      here: samePath(dir, here),
      current: samePath(dir, project),
      count: own.get(key)?.size ?? 0,
    };
  };
  const first = project === undefined ? [] : [entry(project)];
  const others = inv.projects
    .filter((p) => !samePath(p.path, project))
    .map((p) => entry(p.path))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const none: ProjectEntry = { key: "none", name: NO_PROJECT, here: false, current: project === undefined, count: 0 };
  return [...first, ...others, none];
}

/** A project's count as the list says it: — for none. */
function countText(entry: ProjectEntry): string {
  return entry.count > 0 ? String(entry.count) : "—";
}

/**
 * The columns the project row and the project list take whole: the widest line - "▸ ", the name,
 * its " (here)", a space, the count, and the two columns before the divider - or the heading,
 * PROJECT and the kind's noun two apart, from where the marker is. The row is one of the lines,
 * shorter by its count. The same whichever project is picked, so the pane keeps its width.
 */
export function projectPaneWidth(entries: ProjectEntry[], noun: string): number {
  const countWidth = Math.max(0, ...entries.map((e) => countText(e).length));
  const widest = Math.max(0, ...entries.map((e) => e.name.length + (e.here ? HERE.length : 0) + 1 + countWidth));
  return Math.max(widest + 4, `${PROJECT_HEADING}  ${noun}`.length + 2);
}

/**
 * A project's name, and " (here)" for the folder's own, in `room` columns: the name is cut with …
 * first, so "(here)" stays while a letter of the name and its … are left beside it.
 */
export function projectLabel(name: string, here: boolean, room: number): { name: string; here: string } {
  const mark = here ? HERE : "";
  if (name.length + mark.length <= room) return { name, here: mark };
  if (here && room >= mark.length + 2) return { name: cell(name, room - mark.length), here: mark };
  return { name: cell(name, room).trimEnd(), here: "" };
}

/** A line of the project list as drawn after the marker: the name, its (here), the count right-aligned. */
export type ProjectLine = { key: string; name: string; here: string; count: string; entry: ProjectEntry };

/**
 * The project list in a pane `width` wide, laid out as the scope list is: after the marker's two
 * columns, each line runs to two columns before the divider - the name cut with … and the count,
 * or — for none, right-aligned. The heading is PROJECT where the marker is and the kind's noun
 * where the counts end, the noun left out when there is no room for both.
 */
export function projectListLines(
  entries: ProjectEntry[],
  noun: string,
  width: number,
): { title: string; noun: string; lines: ProjectLine[] } {
  const inner = Math.max(0, width - 4);
  const counts = entries.map(countText);
  const room = Math.max(0, inner - Math.max(0, ...counts.map((c) => c.length)) - 1);
  const lines = entries.map((entry, i) => {
    const label = projectLabel(entry.name, entry.here, room);
    const left = inner - label.name.length - label.here.length;
    const count = counts[i] ?? "";
    return { key: entry.key, ...label, count: count.length <= left ? count.padStart(left) : "", entry };
  });
  const head = Math.max(0, width - 2);
  const fits = PROJECT_HEADING.length + 2 + noun.length <= head;
  return fits
    ? { title: PROJECT_HEADING.padEnd(head - noun.length), noun, lines }
    : { title: cell(PROJECT_HEADING, head).trimEnd(), noun: "", lines };
}

/**
 * The lines a list `height` lines tall shows of `total`: all of them when they fit, else one
 * fewer, kept for the line that says how many more are below.
 */
export function listRoom(height: number, total: number): number {
  return total <= height || height < 2 ? Math.max(0, height) : height - 1;
}

/**
 * Keeps `cursor` inside a window `room` lines tall that starts at `top`, and the window inside the
 * `total` lines there are: when a search narrows the table, the window moves up rather than show
 * blank lines below the last row.
 */
export function scrolled(top: number, cursor: number, room: number, total: number): number {
  const kept = cursor < top ? cursor : cursor >= top + room ? cursor - room + 1 : top;
  return Math.max(0, Math.min(kept, total - room));
}

/**
 * The furthest a detail of `total` lines scrolls in `room` rows: to where the last line shows
 * under the line that says how many are above. Nothing scrolls when all fit, or when the room
 * cannot hold a line between the two markers.
 */
export function maxDetailTop(total: number, room: number): number {
  return total <= room || room < 3 ? 0 : total - (room - 1);
}

/**
 * The lines a detail shows from `top`: `start` to `end`, after a line that says how many are
 * above when any are, and before one that says how many are below when any are.
 */
export function detailWindow(
  total: number,
  room: number,
  top: number,
): { start: number; end: number; above: number; below: number } {
  const start = Math.max(0, Math.min(top, maxDetailTop(total, room)));
  if (total <= room || room < 3) return { start: 0, end: Math.min(total, room), above: 0, below: 0 };
  const shown = room - (start > 0 ? 1 : 0);
  const end = total - start <= shown ? total : start + shown - 1;
  return { start, end, above: start, below: total - end };
}

/** The column a detail line's label takes, its gap included. */
export const DETAIL_LABEL_WIDTH = 10;

export type DetailRow = DetailLine & { id: string };

/**
 * A detail's lines as the screen draws them in `width` columns, one row each. A long value
 * wraps under its label's column, a command or a URL too, so it is read in full; a line with no
 * label, as a description, wraps at the full width. Each row has an id of its own: two
 * accounts' lines can both read `on`.
 */
export function detailRows(lines: DetailLine[], width: number): DetailRow[] {
  const seen = new Map<string, number>();
  return lines.flatMap((line) => {
    const room = line.label === undefined ? width : width - DETAIL_LABEL_WIDTH;
    return wrapText(line.text, room).map((text, i) => {
      const label = line.label === undefined ? undefined : i === 0 ? line.label : "";
      const content = `${label ?? ""}\0${text}`;
      const repeat = seen.get(content) ?? 0;
      seen.set(content, repeat + 1);
      return {
        ...(label === undefined ? {} : { label }),
        text,
        ...(line.tone ? { tone: line.tone } : {}),
        id: `${content}\0${repeat}`,
      };
    });
  });
}
