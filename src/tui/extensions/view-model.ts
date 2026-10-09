import { duplicateGroups, folderKey, marksOf, usageOf } from "../../extensions/inventory.js";
import type { EffectiveState, Extension, Inventory, Mark } from "../../extensions/model.js";
import {
  accountStates,
  projectName,
  shortProfile,
  stateHere,
  tilde,
  tildeIn,
  viewFrom,
  whereLabel,
} from "../../extensions/present.js";
import { samePath } from "../../extensions/read.js";
import { pluginState, relevantIn, stateOf } from "../../extensions/state.js";
import type { ToolName } from "../../types.js";

export { shortProfile, tilde } from "../../extensions/present.js";

export type Tab = "skills" | "mcp" | "hooks";
export const TABS: readonly Tab[] = ["skills", "mcp", "hooks"];
export const TAB_LABEL: Record<Tab, string> = { skills: "Skills", mcp: "MCP", hooks: "Hooks" };

export type Filter = "all" | "loaded" | "cleanup" | "duplicates" | "off";
export const FILTERS: readonly Filter[] = ["all", "loaded", "cleanup", "duplicates", "off"];
export const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  loaded: "Loaded here",
  cleanup: "Cleanup",
  duplicates: "Duplicates",
  off: "Off",
};

export const MARK_LABEL: Record<Mark, string> = {
  cleanup: "cleanup",
  shadowed: "shadowed",
  "broken-link": "broken link",
  differs: "differs",
};

export type GroupRow = { type: "group"; key: string; label: string; count: number; open: boolean; state?: string };
export type ItemRow = {
  type: "item";
  key: string;
  group: string;
  name: string;
  items: Extension[];
  tools: ToolName[];
  state: string;
  used: string;
  /** MCP: how many accounts define it. Hooks: the command. */
  extra: string;
  marks: Mark[];
};
export type Row = GroupRow | ItemRow;

export type ViewOptions = {
  tab: Tab;
  filter: Filter;
  query: string;
  project?: string;
  /** Groups the user opened or closed, by key; the rest keep their default. */
  open: Record<string, boolean>;
  now: number;
};

const DAY = 86_400_000;
const KIND: Record<Tab, Extension["kind"]> = { skills: "skill", mcp: "mcp", hooks: "hook" };

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
 * One column of a table drawn without separators: `text` cut to `width` less COLUMN_GAP, then
 * padded to `width`. A cut text then still has the gap before the next column, where `cell`
 * would run its ellipsis into it.
 */
export function column(text: string, width: number): string {
  return cell(text, width - COLUMN_GAP).padEnd(Math.max(0, width));
}

type GroupInfo = { key: string; label: string; order: number; open: boolean; plugin?: string; project?: string };

/** Which group a row goes in, its order, and whether it starts open. */
function groupOf(item: Extension, tab: Tab, project: string | undefined, homeDir: string): GroupInfo {
  const loc = item.location;
  if (loc.scope === "plugin") {
    const name = (loc.plugin ?? "").split("@")[0];
    const plugin = loc.plugin ? { plugin: loc.plugin } : {};
    // A plugin installed for one project is its own group, switched in that project's settings.
    if (loc.project !== undefined) {
      return {
        key: `plugin:${loc.plugin}|${loc.project}`,
        label: `Plugin · ${name} · ${projectName(loc.project, homeDir)}`,
        order: 3,
        open: false,
        ...plugin,
        project: loc.project,
      };
    }
    return { key: `plugin:${loc.plugin}`, label: `Plugin · ${name}`, order: 3, open: false, ...plugin };
  }
  if (loc.project !== undefined) {
    const here = project !== undefined && samePath(loc.project, project);
    return {
      key: `project:${loc.project}`,
      label: `Project · ${projectName(loc.project, homeDir)}`,
      order: here ? 2 : 7,
      open: here,
    };
  }
  const user = {
    key: "global",
    label: tab === "skills" ? "Global" : tab === "mcp" ? "User" : "User settings",
    order: 0,
    open: true,
  };
  switch (loc.scope) {
    case "account":
      return tab === "skills"
        ? { key: `account:${loc.profile}`, label: `Account · ${shortProfile(loc.profile ?? "")}`, order: 1, open: true }
        : user;
    case "synced":
      return { key: "synced", label: "Synced from claude.ai", order: 4, open: false };
    case "builtin":
      return { key: "builtin", label: "Built-in", order: 5, open: false };
    case "managed":
      return { key: "managed", label: "Managed by your organization", order: 6, open: false };
    default:
      return user;
  }
}

function profilesOf(inv: Inventory, project: string): string[] {
  return inv.projects.find((p) => samePath(p.path, project))?.profiles.filter((id) => id.startsWith("claude:")) ?? [];
}

/**
 * The state of each item, read in its own project - each account's, for a Claude MCP server
 * every account sees. Read the way `ls` reads it, so the dashboard and the CLI agree.
 */
function statesOf(inv: Inventory, items: Extension[], project: string | undefined): EffectiveState[] {
  return items.flatMap(
    (item) => accountStates(inv, item, project)?.map((a) => a.state) ?? [stateHere(inv, item, project)],
  );
}

function rowState(inv: Inventory, items: Extension[], project: string | undefined): string {
  const states = statesOf(inv, items, project);
  if (states.length > 0 && states.every((s) => s.shadowedBy)) return "shadowed";
  const values = states.map((s) => s.value);
  const unique = [...new Set(values)];
  if (unique.length === 1) return unique[0] ?? "on";
  if (items[0]?.kind === "mcp") return `${values.filter((v) => v === "on").length}/${values.length} on`;
  return unique.join(" / ");
}

/**
 * Whether every Claude copy in a row is shadowed. Claude Code records a skill's use under its
 * name, and a shadowed copy never loads, so the count under that name is the winning copy's.
 */
function shadowedEverywhere(inv: Inventory, items: Extension[], now: number): boolean {
  const claude = items.filter((i) => i.location.tool === "claude");
  return claude.length > 0 && claude.every((i) => marksOf(inv, i, now).includes("shadowed"));
}

function rowUsed(inv: Inventory, items: Extension[], now: number): string {
  if (items[0]?.kind !== "skill") return "";
  if (!items.some((i) => i.location.tool === "claude") || shadowedEverywhere(inv, items, now)) return "—";
  const usage = usageOf(inv, items);
  if (!usage) return "0";
  return usage.lastUsedAt === undefined ? String(usage.total) : `${usage.total} · ${ago(usage.lastUsedAt, now)}`;
}

/**
 * The accounts that hold any of `items`: an account's own server, or a plugin's server in each
 * account that has the plugin. None for a `.mcp.json` server, which every account sees.
 */
function accountsOf(items: Extension[]): string[] {
  const accounts = items.flatMap((i) => [i.location.profile, ...(i.location.accounts ?? [])]);
  return [...new Set(accounts.filter((p): p is string => p !== undefined))];
}

function rowExtra(items: Extension[], homeDir: string): string {
  const first = items[0];
  if (first?.kind === "hook") return tildeIn(first.summary?.command ?? first.summary?.prompt ?? "", homeDir);
  if (first?.kind !== "mcp") return "";
  const accounts = accountsOf(items);
  return accounts.length > 0 ? `${accounts.length} acct` : "shared";
}

function duplicateIds(inv: Inventory, tab: Tab): Set<string> {
  if (tab === "skills")
    return new Set(
      duplicateGroups(inv.items)
        .flat()
        .map((i) => i.id),
    );
  const kind = KIND[tab];
  const byKey = new Map<string, string[]>();
  for (const item of inv.items) {
    if (item.kind !== kind) continue;
    const key = tab === "hooks" ? (item.summary?.command ?? item.id) : item.name;
    byKey.set(key, [...(byKey.get(key) ?? []), item.id]);
  }
  return new Set([...byKey.values()].filter((ids) => ids.length > 1).flat());
}

function passes(inv: Inventory, item: Extension, o: ViewOptions, duplicates: Set<string>): boolean {
  switch (o.filter) {
    case "all":
      return true;
    case "loaded": {
      if (!relevantIn(item, o.project)) return false;
      // Claude Code does not start a .mcp.json server until it is approved.
      return statesOf(inv, [item], o.project).some(
        (s) => s.value !== "off" && s.value !== "pending-approval" && !s.shadowedBy,
      );
    }
    case "cleanup":
      return marksOf(inv, item, o.now).includes("cleanup");
    case "duplicates":
      return duplicates.has(item.id);
    case "off":
      return statesOf(inv, [item], o.project).some((s) => s.value === "off");
  }
}

function matches(item: Extension, query: string): boolean {
  const haystack = [item.name, item.description ?? "", item.location.file, ...Object.values(item.summary ?? {})];
  return haystack.some((text) => text.toLowerCase().includes(query));
}

/**
 * The rows of one tab: a header per group, then one row per name in it - so the Claude and
 * Codex copies of `eli5` share a row - unless the group is closed. A hook is a row of its own:
 * two commands on one event are two hooks, not two copies of one. Searching or filtering opens
 * every group, so a match is never hidden behind one.
 */
export function buildRows(inv: Inventory, o: ViewOptions): Row[] {
  const kind = KIND[o.tab];
  const query = o.query.trim().toLowerCase();
  const forced = query !== "" || o.filter !== "all";
  const duplicates = duplicateIds(inv, o.tab);
  const groups = new Map<string, { info: GroupInfo; byKey: Map<string, { name: string; items: Extension[] }> }>();
  for (const item of inv.items) {
    if (item.kind !== kind || !passes(inv, item, o, duplicates)) continue;
    if (query && !matches(item, query)) continue;
    const info = groupOf(item, o.tab, o.project, inv.homeDir);
    const group = groups.get(info.key) ?? { info, byKey: new Map() };
    groups.set(info.key, group);
    const rowKey = o.tab === "hooks" ? item.id : item.name;
    const row = group.byKey.get(rowKey) ?? { name: item.name, items: [] };
    row.items.push(item);
    group.byKey.set(rowKey, row);
  }
  const rows: Row[] = [];
  const ordered = [...groups.values()].sort(
    (a, b) => a.info.order - b.info.order || a.info.label.localeCompare(b.info.label),
  );
  for (const { info, byKey } of ordered) {
    const open = forced || (o.open[info.key] ?? info.open);
    const state = info.plugin ? pluginState(inv, info.plugin, info.project ?? o.project).value : undefined;
    rows.push({
      type: "group",
      key: info.key,
      label: info.label,
      count: byKey.size,
      open,
      ...(state ? { state } : {}),
    });
    if (!open) continue;
    // A stable sort: hooks of one event stay in the inventory's order, which is by id.
    for (const [rowKey, { name, items }] of [...byKey.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name))) {
      rows.push({
        type: "item",
        key: `${info.key}|${rowKey}`,
        group: info.key,
        name,
        items,
        tools: [...new Set(items.map((i) => i.location.tool))],
        state: rowState(inv, items, o.project),
        used: rowUsed(inv, items, o.now),
        extra: rowExtra(items, inv.homeDir),
        marks: [...new Set(items.flatMap((i) => marksOf(inv, i, o.now)))],
      });
    }
  }
  return rows;
}

/** How many item rows a tab has under the current filter and search, every group open. */
export function countItems(inv: Inventory, o: ViewOptions): number {
  const open = new Proxy({}, { get: () => true }) as Record<string, boolean>;
  return buildRows(inv, { ...o, open }).filter((r) => r.type === "item").length;
}

export type DetailLine = { label?: string; text: string; tone?: "muted" | "warning" | "error" | "healthy" };

/** The detail pane's lines for one row: what, where, its state here, and how much it is used. */
export function detailOf(inv: Inventory, row: ItemRow, project: string | undefined, now: number): DetailLine[] {
  const first = row.items[0];
  if (!first) return [];
  const lines: DetailLine[] = [];
  const description = row.items.find((i) => i.description)?.description;
  if (description) lines.push({ text: description });
  for (const item of row.items) {
    lines.push({
      label: "Where",
      text: `${item.location.tool === "claude" ? "Claude" : "Codex"} ${whereLabel(item, inv.homeDir)} · ${tilde(item.location.file, inv.homeDir)}`,
    });
    if (item.link) {
      lines.push({
        label: "",
        text: `→ ${tilde(item.link.target, inv.homeDir)}${item.link.broken ? " (broken link)" : ""}`,
        tone: item.link.broken ? "error" : "muted",
      });
    }
  }
  if (first.kind === "skill") {
    // Across the whole duplicate group, which can hold copies this row does not list - a
    // project's copy of a global skill is a row of its own.
    const group = duplicateGroups(inv.items).find((g) => g.some((i) => i.id === first.id));
    const hashes = new Set((group ?? []).map((i) => inv.hashes[i.id]).filter((h): h is string => h !== undefined));
    if (group && hashes.size > 0) {
      // A folder counts once, however many links lead to it; a broken link holds no copy.
      const folders = new Set(group.filter((i) => !i.link?.broken).map(folderKey));
      const copies = `${folders.size} ${folders.size === 1 ? "copy" : "copies"}`;
      lines.push({
        label: "Copies",
        text: hashes.size === 1 ? `${copies} · same content` : `${copies} · ${hashes.size} versions`,
        tone: hashes.size === 1 ? "muted" : "warning",
      });
    }
  }
  for (const item of row.items) {
    const tool = item.location.tool === "claude" ? "C" : "X";
    // An item with a project of its own is read there, so only one with none anywhere is global.
    const label = viewFrom(item, project) ? "Here" : "Globally";
    // A server every account sees is switched per account: one line each, as ls --json has it.
    // What one account holds is read in that account, so its line names it too.
    const byAccount = accountStates(inv, item, project);
    const owner = item.location.profile ? `${shortProfile(item.location.profile)} ` : "";
    const states = byAccount?.map(({ profile, state }) => ({ who: `${shortProfile(profile)} `, state })) ?? [
      { who: owner, state: stateHere(inv, item, project) },
    ];
    for (const { who, state } of states) {
      const from = state.setBy ? ` (${tilde(state.setBy.file, inv.homeDir)})` : "";
      lines.push({
        label,
        text: `${tool} ${who}${state.value}${from}${state.shadowedBy ? " · a global skill of the same name wins" : ""}`,
        ...(state.value === "off" ? { tone: "warning" as const } : {}),
      });
    }
  }
  if (first.kind === "skill") {
    // skillOverrides in other projects matter only to a Claude skill no project owns: a plugin's
    // skill ignores them, and a project's own is read in its project on the Here line.
    const overridable = row.items.some(
      (i) => i.location.tool === "claude" && i.location.project === undefined && i.location.scope !== "plugin",
    );
    const offIn = overridable
      ? inv.facts.claudeSkillOverrides
          .filter((o) => o.project && o.map[first.name] === "off" && !samePath(o.project, project))
          .map((o) => projectName(o.project ?? "", inv.homeDir))
      : [];
    if (offIn.length > 0) lines.push({ label: "Off in", text: [...new Set(offIn)].join(", ") });
    const usage = usageOf(inv, row.items);
    if (shadowedEverywhere(inv, row.items, now)) {
      lines.push({ label: "Used", text: "counted under the copy that wins", tone: "muted" });
    } else if (usage) {
      const top = Object.entries(usage.byProfile)
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([profile, count]) => `${shortProfile(profile)} ${count}`);
      const last = usage.lastUsedAt === undefined ? "" : ` · ${ago(usage.lastUsedAt, now)} ago`;
      lines.push({ label: "Used", text: `${usage.total}${last}${top.length ? ` · ${top.join(" · ")}` : ""}` });
    } else if (row.items.some((i) => i.location.tool === "claude")) {
      lines.push({ label: "Used", text: "never, in any account", tone: "muted" });
    }
  }
  if (first.kind === "mcp" || first.kind === "hook") {
    // Every copy's own: a server of one name can run another command in another account. A
    // command under the home dir reads as ~/…, as every path on screen does.
    const seen = new Set<string>();
    for (const item of row.items) {
      for (const [key, value] of Object.entries(item.summary ?? {})) {
        if (key === "event" && item.kind === "hook") continue;
        const label = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        if (seen.has(`${label}\0${value}`)) continue;
        seen.add(`${label}\0${value}`);
        lines.push({ label, text: tildeIn(value, inv.homeDir) });
      }
    }
  }
  if (first.kind === "mcp") {
    const accounts = accountsOf(row.items);
    if (accounts.length > 0) lines.push({ label: "Accounts", text: accounts.map(shortProfile).join(", ") });
  }
  return lines;
}

/**
 * The furthest a full-screen detail of `total` lines scrolls in `room` rows: to where the last
 * line shows under the line that says how many are above. Nothing scrolls when all fit, or when
 * the room cannot hold a line between the two markers.
 */
export function maxDetailTop(total: number, room: number): number {
  return total <= room || room < 3 ? 0 : total - (room - 1);
}

/**
 * The lines a full-screen detail shows from `top`: `start` to `end`, after a line that says how
 * many are above when any are, and before one that says how many are below when any are.
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

export type MatrixCell = "on" | "off" | "pending" | "absent";
export type Matrix = { columns: { key: string; label: string }[]; rows: { name: string; cells: MatrixCell[] }[] };

/** Most specific first, as Claude Code resolves a name defined in more than one scope. */
const SCOPE_RANK = ["local", "project", "account", "plugin", "global"];

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
        const candidates = servers
          .filter(
            (i) =>
              i.name === name && (column.key === "codex" ? i.location.tool === "codex" : inClaudeColumn(i, column.key)),
          )
          .sort((a, b) => SCOPE_RANK.indexOf(a.location.scope) - SCOPE_RANK.indexOf(b.location.scope));
        const item = candidates[0];
        if (!item) return "absent";
        const value = stateOf(inv, item, project, column.key === "codex" ? undefined : column.key).value;
        return value === "off" ? "off" : value === "pending-approval" ? "pending" : "on";
      }),
    })),
  };
}

export type Layout = {
  mode: "side" | "stacked" | "list";
  listWidth: number;
  listHeight: number;
  detailWidth: number;
  detailHeight: number;
};

/** The fewest lines the stacked list and detail each get: a shorter detail is a title and one line. */
const STACKED_MIN = 7;

/**
 * Where the detail pane goes: beside the list from 110 columns; under it from 64 when the body
 * has room for both at STACKED_MIN lines or more; else on its own screen, opened with enter.
 * Heights leave room for Chrome's header and footer, the tab bar and the key hints. A size that
 * is not a number, as from a stream that is no terminal, is read as 80 by 24.
 *
 * `listLines` is how many lines the list takes to show every row, its header included. Stacked,
 * the list gets those lines, within STACKED_MIN and body - STACKED_MIN, and the detail every
 * line left, so the body is filled and a long detail is not cut while the terminal has room.
 */
export function pickLayout(columns: number, rows: number, listLines = Number.POSITIVE_INFINITY): Layout {
  const across = Number.isFinite(columns) ? columns : 80;
  const down = Number.isFinite(rows) ? rows : 24;
  const width = Math.max(20, across - 4);
  const body = Math.max(6, down - 12);
  if (across >= 110) {
    const listWidth = Math.floor((width - 2) * 0.58);
    return { mode: "side", listWidth, listHeight: body, detailWidth: width - 2 - listWidth, detailHeight: body };
  }
  if (across >= 64 && body >= 2 * STACKED_MIN) {
    const listHeight = Math.min(Math.max(listLines, STACKED_MIN), body - STACKED_MIN);
    return { mode: "stacked", listWidth: width, listHeight, detailWidth: width, detailHeight: body - listHeight };
  }
  return { mode: "list", listWidth: width, listHeight: body, detailWidth: width, detailHeight: body };
}

/**
 * The rows a list `height` lines tall shows of `total`: all of them under the header when they
 * fit, else one line fewer, kept for the line that says how many more are below.
 */
export function listRoom(height: number, total: number): number {
  return total <= height - 1 ? Math.max(1, height - 1) : Math.max(1, height - 2);
}

/** The spaces before each column after the name, in the header and in every row. */
export const COLUMN_GAP = 2;

export type Columns = { name: number; tool: number; extra: number; used: number; state: number };

/** The width a row's name, its marks and its indent take, as ItemList draws them. */
function nameAndMarks(row: ItemRow): number {
  const tags = row.marks.map((m) => MARK_LABEL[m]).join(" ");
  return 2 + row.name.length + (tags ? 1 + tags.length : 0);
}

/**
 * The name column a tab needs: the widest name with its marks over every row of the tab, every
 * group open and no filter or search, so the columns stay put while the list scrolls, a group
 * opens or a search narrows it.
 */
export function nameWidth(inv: Inventory, tab: Tab, project: string | undefined, now: number): number {
  const open = new Proxy({}, { get: () => true }) as Record<string, boolean>;
  const rows = buildRows(inv, { tab, filter: "all", query: "", open, now, ...(project ? { project } : {}) });
  return Math.max(0, ...rows.map((r) => (r.type === "item" ? nameAndMarks(r) : 0)));
}

/** What the columns after the name take, each with its gap. */
function after(...widths: number[]): number {
  return widths.reduce((sum, w) => sum + (w > 0 ? w + COLUMN_GAP : 0), 0);
}

/**
 * Column widths for a list `width` wide whose names need `need` columns: optional columns go
 * before the name drops under 8, and the name takes what it needs of what they leave. What it
 * does not need is left after the last column, so the columns sit beside the names. With no
 * project there is no This project column: the spec hides it then.
 */
export function listColumns(tab: Tab, width: number, need = Number.POSITIVE_INFINITY, project = true): Columns {
  const inner = width - 2;
  const wanted = Math.max(8, need);
  if (tab === "hooks") {
    // The command is the last column and takes the rest: the name keeps to 40% and 28 at most.
    const name = Math.min(wanted, 28, Math.floor(inner * 0.4));
    const tool = inner >= 40 ? 4 : 0;
    return { name, tool, extra: Math.max(0, inner - name - after(tool) - COLUMN_GAP), used: 0, state: 0 };
  }
  if (tab === "mcp") {
    // Wide enough for the longest state word, pending-approval.
    const state = project ? 16 : 0;
    const extra = inner >= 60 ? 8 : 0;
    const tool = inner >= 40 ? 4 : 0;
    return { name: Math.min(wanted, Math.max(8, inner - after(tool, extra, state))), tool, extra, used: 0, state };
  }
  const state = !project ? 0 : inner >= 50 ? 20 : 12;
  const used = inner >= 70 ? 13 : 0;
  const tool = inner >= 40 ? 4 : 0;
  return { name: Math.min(wanted, Math.max(8, inner - after(tool, used, state))), tool, extra: 0, used, state };
}

/** How long a read took: milliseconds under a second, else seconds to one decimal place. */
export function took(ms: number): string {
  return Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}
