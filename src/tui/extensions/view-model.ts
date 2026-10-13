import { type Refusal, refusalText } from "../../extensions/actions.js";
import type { Extension, Inventory } from "../../extensions/model.js";
import { shortProfile } from "../../extensions/present.js";
import { samePath } from "../../extensions/read.js";
import { isAccountCopy, rowKey, type ScopeRow } from "../../extensions/scopes.js";
import { claudeMcpTaken, codexTrusted, relevantIn, stateOf } from "../../extensions/state.js";

export { shortProfile, tilde } from "../../extensions/present.js";

/**
 * Text helpers the Extensions screen's parts share - a cell, a column, wrapped lines, how long
 * ago, how long a read took - and the MCP matrix: its cells, what space on one changes, and how
 * its columns scroll. The tables are screen-model.ts's.
 */

const DAY = 86_400_000;

export function ago(then: number, now: number): string {
  const ms = Math.max(0, now - then);
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < DAY) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 60 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

/** `text` cut to `width` with an ellipsis, then padded to it: one line, always. */
export function cell(text: string, width: number): string {
  if (width <= 0) return "";
  const cut = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return cut.padEnd(width);
}

/**
 * `text` in lines of at most `width` characters, broken at spaces, and inside a word longer than
 * a line: a command line or a URL is read in full, however long, where `cell` would cut it.
 */
export function wrapText(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/ +/).filter(Boolean)) {
    if (line !== "" && line.length + 1 + word.length <= room) {
      line += ` ${word}`;
      continue;
    }
    if (line !== "") lines.push(line);
    let rest = word;
    for (; rest.length > room; rest = rest.slice(room)) lines.push(rest.slice(0, room));
    line = rest;
  }
  return line !== "" || lines.length === 0 ? [...lines, line] : lines;
}

/**
 * One column of a table drawn without separators: `text` cut to `width` less COLUMN_GAP, then
 * padded to `width`. A cut text then still has the gap before the next column, where `cell`
 * would run its ellipsis into it.
 */
export function column(text: string, width: number): string {
  return cell(text, width - COLUMN_GAP).padEnd(Math.max(0, width));
}

/** The spaces before each column after the name, in the header and in every row. */
export const COLUMN_GAP = 2;

function profilesOf(inv: Inventory, project: string): string[] {
  return inv.projects.find((p) => samePath(p.path, project))?.profiles.filter((id) => id.startsWith("claude:")) ?? [];
}

export type MatrixCell = "on" | "off" | "pending" | "absent";
export type Matrix = { columns: { key: string; label: string }[]; rows: { name: string; cells: MatrixCell[] }[] };

/**
 * Codex's servers, most specific first: a project's config.toml before Codex's own. A Claude
 * account's column takes the copy Claude Code takes, local > project > user (`claudeMcpTaken`,
 * the rule the states use); a plugin's servers go by names of their own, so none outranks them.
 */
const SCOPE_RANK = ["project", "global"];

/**
 * Whether a Claude server is in one account: its own, or one every account sees - which, for a
 * plugin's server, is only every account that has the plugin installed.
 */
function inClaudeColumn(item: Extension, profile: string): boolean {
  const loc = item.location;
  if (loc.tool !== "claude") return false;
  if (loc.profile !== undefined) return loc.profile === profile;
  // As accountStates reads it: a plugin item with no accounts recorded is in every account.
  return loc.scope !== "plugin" || loc.accounts === undefined || loc.accounts.includes(profile);
}

function serversIn(inv: Inventory, project: string): Extension[] {
  return inv.items.filter((i) => i.kind === "mcp" && relevantIn(i, project));
}

/**
 * The copy of `name` a column shows: the one its Claude account takes, or the one Codex starts -
 * its most specific, leaving out a project's copy where Codex does not trust the project, and one
 * another copy hides. With none left, Codex's most specific, which is off.
 */
function cellItem(
  inv: Inventory,
  servers: readonly Extension[],
  name: string,
  column: string,
  project: string,
): Extension | undefined {
  const codex = column === "codex";
  const candidates = servers
    .filter((i) => i.name === name && (codex ? i.location.tool === "codex" : inClaudeColumn(i, column)))
    .sort((a, b) => SCOPE_RANK.indexOf(a.location.scope) - SCOPE_RANK.indexOf(b.location.scope));
  if (!codex) return claudeMcpTaken(inv, name, project, column) ?? candidates[0];
  const starts = (i: Extension) =>
    (i.location.scope !== "project" || codexTrusted(inv, i.location.project)) &&
    stateOf(inv, i, project).shadowedBy === undefined;
  return candidates.find(starts) ?? candidates[0];
}

/** The MCP servers a project can start, by account: Claude's per-account switches side by side. */
export function buildMatrix(inv: Inventory, project: string): Matrix {
  const servers = serversIn(inv, project);
  const recorded = profilesOf(inv, project);
  const claude = inv.claudeProfiles.filter(
    (p) => recorded.includes(p) || servers.some((i) => i.location.profile === p),
  );
  const columns = [
    ...claude.map((p) => ({ key: p, label: shortProfile(p) })),
    ...(servers.some((i) => i.location.tool === "codex") ? [{ key: "codex", label: "Codex" }] : []),
  ];
  const names = [...new Set(servers.map((i) => i.name))].sort();
  return {
    columns,
    rows: names.map((name) => ({
      name,
      cells: columns.map((column) => {
        const item = cellItem(inv, servers, name, column.key, project);
        if (!item) return "absent";
        const value = stateOf(inv, item, project, column.key === "codex" ? undefined : column.key).value;
        return value === "off" ? "off" : value === "pending-approval" ? "pending" : "on";
      }),
    })),
  };
}

/**
 * What space on a cell changes: the table's row of the copy the cell shows, for the column's
 * account alone - Codex's column has no accounts - or, for a cell with no server, why not.
 */
export type CellTarget = { row: ScopeRow; accounts?: readonly string[] } | { refused: string };

/**
 * The row `item` is in, as rowsIn puts it together: with every account's or install's copy that
 * shares its row key, primary first.
 */
function rowOf(inv: Inventory, item: Extension): ScopeRow {
  const key = rowKey(item);
  if (!isAccountCopy(item)) return { key, name: item.name, items: [item] };
  const rank = (copy: Extension) => {
    const at = inv.claudeProfiles.indexOf(copy.location.profile ?? copy.location.accounts?.[0] ?? "");
    return at < 0 ? inv.claudeProfiles.length : at;
  };
  const items = inv.items.filter((copy) => isAccountCopy(copy) && rowKey(copy) === key);
  return { key, name: item.name, items: items.sort((a, b) => rank(a) - rank(b)) };
}

/** What space on the cell of server `name` in `column` changes in `project`. */
export function cellTarget(
  inv: Inventory,
  project: string,
  name: string,
  column: { key: string; label: string },
): CellTarget {
  const item = cellItem(inv, serversIn(inv, project), name, column.key, project);
  if (!item) return { refused: `${column.label} has no ${name} here.` };
  return { row: rowOf(inv, item), ...(column.key === "codex" ? {} : { accounts: [column.key] }) };
}

/** The keys the matrix takes of those a refusal's words can name: space on a cell, and u. */
const MATRIX_KEYS = new Set(["space", "u"]);

/**
 * A refusal as the matrix says it, in the keys' voice. Words that name a key the matrix does not
 * take - `Press g …`, `Press d …` - say to press it on the server's row instead.
 */
export function matrixRefusal(refused: Refusal): string {
  const keys = refused.keys;
  const named = [...(keys ?? "").matchAll(/\b(?:press|with|or) (space|[a-z])\b/gi)].map((m) => m[1] ?? "");
  if (keys === undefined || named.every((key) => MATRIX_KEYS.has(key))) return refusalText(refused, "keys");
  return `${refused.reason} From its row, ${keys.charAt(0).toLowerCase()}${keys.slice(1)}`;
}

/** Room kept at the matrix header's end for ` ← → 99 more`, so a scrolled matrix says so in full. */
const SCROLL_NOTE = 12;

/** The two columns the brackets around the cursor's account and cell take. */
const BRACKETS = 2;

/**
 * The matrix's widths at `width`: the SERVER column's and each account's, each with the gap
 * after it, so a name or label that is cut keeps it - an account's with room for the brackets
 * the cursor's has - and the room the accounts have across.
 */
export function matrixWidths(matrix: Matrix, width: number): { nameWidth: number; colWidth: number; across: number } {
  const nameWidth = Math.min(24, Math.max(8, ...matrix.rows.map((r) => r.name.length), 6)) + COLUMN_GAP;
  const label = Math.max(0, ...matrix.columns.map((c) => c.label.length));
  const colWidth = Math.max(6, Math.min(12, label + BRACKETS + COLUMN_GAP));
  return { nameWidth, colWidth, across: width - 2 - nameWidth };
}

/**
 * How many account columns show from column `left`: all that fit, where every one fits from the
 * first; else as many as leave room for the note that says how many more there are.
 */
export function matrixFit(matrix: Matrix, width: number, left: number): number {
  const { colWidth, across } = matrixWidths(matrix, width);
  const all = Math.floor(across / colWidth);
  return left === 0 && all >= matrix.columns.length ? all : Math.max(1, Math.floor((across - SCROLL_NOTE) / colWidth));
}

/**
 * The first account column the matrix shows, moved from `left` as little as keeps the cursor's
 * `column` in sight: 0 where every column fits.
 */
export function matrixLeft(left: number, column: number, matrix: Matrix, width: number): number {
  const total = matrix.columns.length;
  const fit = matrixFit(matrix, width, 0);
  if (fit >= total) return 0;
  const at = Math.max(0, Math.min(total - 1, column));
  if (at < left) return at;
  if (at >= left + fit) return at - fit + 1;
  return Math.min(left, Math.max(0, total - fit));
}

/** How long a read took: milliseconds under a second, else seconds to one decimal place. */
export function took(ms: number): string {
  return Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}
