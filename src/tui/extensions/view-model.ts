import type { Extension, Inventory } from "../../extensions/model.js";
import { shortProfile } from "../../extensions/present.js";
import { samePath } from "../../extensions/read.js";
import { claudeMcpTaken, relevantIn, stateOf } from "../../extensions/state.js";

export { shortProfile, tilde } from "../../extensions/present.js";

/**
 * Text helpers the Extensions screen's parts share - a cell, a column, wrapped lines, how long
 * ago, how long a read took - and the MCP matrix. The tables are screen-model.ts's.
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

/** The MCP servers a project can start, by account: Claude's per-account switches side by side. */
export function buildMatrix(inv: Inventory, project: string): Matrix {
  const servers = inv.items.filter((i) => i.kind === "mcp" && relevantIn(i, project));
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
        const codex = column.key === "codex";
        const candidates = servers
          .filter((i) => i.name === name && (codex ? i.location.tool === "codex" : inClaudeColumn(i, column.key)))
          .sort((a, b) => SCOPE_RANK.indexOf(a.location.scope) - SCOPE_RANK.indexOf(b.location.scope));
        const item = (codex ? undefined : claudeMcpTaken(inv, name, project, column.key)) ?? candidates[0];
        if (!item) return "absent";
        const value = stateOf(inv, item, project, column.key === "codex" ? undefined : column.key).value;
        return value === "off" ? "off" : value === "pending-approval" ? "pending" : "on";
      }),
    })),
  };
}

/** How long a read took: milliseconds under a second, else seconds to one decimal place. */
export function took(ms: number): string {
  return Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}
