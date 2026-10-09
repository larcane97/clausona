import type { ToolName } from "../types.js";
import { marksOf } from "./inventory.js";
import type { Extension, Inventory } from "./model.js";
import { accountStates, projectName, stateHere } from "./present.js";
import { isWithin, pathKey, samePath } from "./read.js";
import { isMcpjsonServer, relevantIn } from "./state.js";

/**
 * Where every item is, seen from one project, and what each place holds: the scope list on the
 * left of the Extensions screen and `ls --scope`. Pure: it reads the inventory and nothing else.
 */

export type { ToolName } from "../types.js";

export type ItemKind = "skill" | "mcp" | "hook";

export type ScopeId =
  | "loaded"
  | "project"
  | "parents"
  | "global"
  | "cloud"
  | "plugins"
  | "builtin"
  | "managed"
  | "other"
  | "unused";

export const SCOPE_LABEL: Record<ScopeId, (tool: ToolName) => string> = {
  loaded: () => "Loaded here",
  project: () => "Project",
  parents: () => "Parent folders",
  global: () => "Global",
  cloud: () => "Cloud",
  plugins: () => "Plugins",
  builtin: (tool) => (tool === "claude" ? "Built into Claude Code" : "Built into Codex"),
  managed: () => "Managed",
  other: () => "Other projects",
  unused: () => "Not used in 90 days",
};

export type ScopeEntry = { id: ScopeId; label: string; count: number };

/** The left pane's order per tool and kind. */
const ORDER: Record<ToolName, Record<ItemKind, readonly ScopeId[]>> = {
  claude: {
    skill: ["loaded", "project", "global", "cloud", "plugins", "builtin", "other", "unused"],
    mcp: ["loaded", "project", "parents", "global", "plugins", "managed", "other"],
    hook: ["loaded", "project", "global", "plugins", "managed", "other"],
  },
  codex: {
    skill: ["loaded", "project", "global", "builtin", "other"],
    mcp: ["loaded", "project", "global", "other"],
    hook: ["loaded", "project", "global", "other"],
  },
};

/** Shown even at 0: an empty project or nothing loaded is worth seeing. */
const ALWAYS: ReadonlySet<ScopeId> = new Set(["loaded", "project"]);

/** Where an item can be deleted one by one - the places "Not used in 90 days" covers. */
const UNUSED_FROM: ReadonlySet<ScopeId> = new Set(["global", "project", "other"]);

/** Items of one tool and kind: what a plugin brings is among them, the plugin items are not. */
function ofKind(inv: Inventory, tool: ToolName, kind: ItemKind): Extension[] {
  return inv.items.filter((item) => item.kind === kind && item.location.tool === tool);
}

/** The left pane, in order, empty optional scopes left out. */
export function scopesFor(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  project: string | undefined,
  now: number,
): ScopeEntry[] {
  const entries: ScopeEntry[] = [];
  for (const id of ORDER[tool][kind]) {
    const count =
      id === "other"
        ? otherProjects(inv, tool, kind, project).length
        : rowsIn(inv, tool, kind, id, project, now).length;
    if (count > 0 || ALWAYS.has(id)) entries.push({ id, label: SCOPE_LABEL[id](tool), count });
  }
  return entries;
}

/** Where an item lives, seen from `project` (never "loaded"/"unused", which are derived). */
export function homeScope(item: Extension, project: string | undefined): Exclude<ScopeId, "loaded" | "unused"> {
  const loc = item.location;
  if (loc.scope === "plugin" || item.kind === "plugin") {
    // A plugin installed for one project is that project's; installed for everyone, everyone's.
    return loc.project !== undefined && !samePath(loc.project, project) ? "other" : "plugins";
  }
  if (loc.scope === "synced") return "cloud";
  if (loc.scope === "builtin") return "builtin";
  if (loc.scope === "managed") return "managed";
  if (loc.project === undefined) return "global";
  if (samePath(loc.project, project)) return "project";
  // A dir's .mcp.json loads in every project below it.
  if (isMcpjsonServer(item) && isWithin(project, loc.project)) return "parents";
  return "other";
}

/**
 * The items a scope's table lists. For "plugins", the plugin items (kind "plugin") that bring at
 * least one item of `kind`. For "other", pass `otherProject`; without it, returns [].
 */
export function itemsIn(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  scope: ScopeId,
  project: string | undefined,
  now: number,
  otherProject?: string,
): Extension[] {
  switch (scope) {
    case "loaded":
      return ofKind(inv, tool, kind).filter((item) => loadsHere(inv, item, project));
    case "plugins":
      return inv.items.filter(
        (item) =>
          item.kind === "plugin" &&
          item.location.tool === tool &&
          homeScope(item, project) === "plugins" &&
          pluginContents(inv, item)[kind].length > 0,
      );
    case "other":
      if (otherProject === undefined) return [];
      return ofKind(inv, tool, kind).filter(
        (item) => homeScope(item, project) === "other" && samePath(item.location.project, otherProject),
      );
    case "unused":
      // Codex keeps no usage record, so nothing of it is called unused.
      if (tool !== "claude" || kind !== "skill") return [];
      return ofKind(inv, tool, kind).filter(
        (item) => UNUSED_FROM.has(homeScope(item, project)) && marksOf(inv, item, now).includes("cleanup"),
      );
    default:
      return ofKind(inv, tool, kind).filter((item) => homeScope(item, project) === scope);
  }
}

/**
 * A table row: one item, or every account's copy of one thing - a Claude MCP server several
 * accounts' .claude.json define, a Cloud skill several accounts have, a plugin installed in
 * several accounts and what it brings - under one name.
 */
export type ScopeRow = { key: string; name: string; items: Extension[] };

/**
 * A Claude MCP server one account's `.claude.json` holds: a user-scope one, or a local one for
 * one project. Each account's copy of a name is its own item; a row puts them back together.
 */
export function isAccountServer(item: Extension): boolean {
  const loc = item.location;
  return (
    item.kind === "mcp" &&
    loc.tool === "claude" &&
    loc.profile !== undefined &&
    (loc.scope === "account" || loc.scope === "local")
  );
}

/**
 * The install scope - user, project or local - a plugin's item came from. The sources keep it in
 * the item's id alone, as the second part of its owner (`pluginOwner` in claude-context.ts:
 * `<plugin>|<scope>|<project>|<install path>`). Undefined when the id does not read so.
 */
function installScope(item: Extension): string | undefined {
  const plugin = item.location.plugin;
  const prefix = `${item.kind}:claude:plugin:${plugin}|`;
  if (plugin === undefined || !item.id.startsWith(prefix)) return undefined;
  const scope = item.id.slice(prefix.length).split("|", 1)[0];
  return scope === "user" || scope === "project" || scope === "local" ? scope : undefined;
}

function dirKey(dir: string | undefined): string {
  return dir === undefined ? "-" : pathKey(dir);
}

/**
 * A row's key. Every account's copy of one thing shares one, built from where the thing is
 * stored, not where it is seen from, and the same with one copy as with many:
 * - a Claude MCP server in accounts' `.claude.json`: `mcp:claude:<account|local>:<project or ->:<name>`;
 * - a Cloud skill: `skill:claude:synced:-:<name>`;
 * - a plugin install: `plugin:claude:<install scope>:<project or ->:<plugin id>`, and what it
 *   brings `<kind>:claude:plugin:<install scope>:<project or ->:<plugin id>:<name>`, a hook's
 *   name with its place in its file (`#<group>.<index>`), so two hooks on one event are two rows.
 *
 * Every other item - an account's own skills folder too, which is a folder of its own - is a row
 * of its own, keyed by its id.
 */
export function rowKey(item: Extension): string {
  const loc = item.location;
  if (isAccountServer(item)) {
    return `mcp:claude:${loc.scope}:${dirKey(loc.scope === "local" ? loc.project : undefined)}:${item.name}`;
  }
  if (loc.tool !== "claude") return item.id;
  if (item.kind === "skill" && loc.scope === "synced") return `skill:claude:synced:-:${item.name}`;
  const install = loc.scope === "plugin" ? installScope(item) : undefined;
  if (install === undefined) return item.id;
  const where = `${install}:${dirKey(loc.project)}:${loc.plugin}`;
  if (item.kind === "plugin") return `plugin:claude:${where}`;
  const at = item.id.lastIndexOf("#");
  const name = item.kind === "hook" && at >= 0 ? `${item.name}${item.id.slice(at)}` : item.name;
  return `${item.kind}:claude:plugin:${where}:${name}`;
}

/** Whether the item is one account's or one install's copy of a thing whose copies make one row. */
export function isAccountCopy(item: Extension): boolean {
  return rowKey(item) !== item.id;
}

/** Primary first: by the first account that holds the item, as the inventory orders accounts. */
function byAccount(inv: Inventory): (a: Extension, b: Extension) => number {
  const rank = (item: Extension) => {
    const at = inv.claudeProfiles.indexOf(item.location.profile ?? item.location.accounts?.[0] ?? "");
    return at < 0 ? inv.claudeProfiles.length : at;
  };
  return (a, b) => rank(a) - rank(b);
}

/**
 * itemsIn as rows. A row of copies holds every account's (or install's) copy, primary first, and
 * is listed when any copy is: in Loaded here, one account loading it is enough. Every other row
 * is one item, keyed by its id.
 */
export function rowsIn(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  scope: ScopeId,
  project: string | undefined,
  now: number,
  otherProject?: string,
): ScopeRow[] {
  const listed = itemsIn(inv, tool, kind, scope, project, now, otherProject);
  // Every account's copies by row key, read once: a row holds them all, listed here or not.
  const copies = new Map<string, Extension[]>();
  if (listed.some(isAccountCopy)) {
    for (const item of inv.items.filter(isAccountCopy).sort(byAccount(inv))) {
      const key = rowKey(item);
      copies.set(key, [...(copies.get(key) ?? []), item]);
    }
  }
  const rows = new Map<string, ScopeRow>();
  for (const item of listed) {
    const key = rowKey(item);
    if (!rows.has(key)) rows.set(key, { key, name: item.name, items: copies.get(key) ?? [item] });
  }
  return [...rows.values()];
}

export type OtherProject = { path: string; name: string; count: number };

/** Other projects that have at least one item of this tool and kind, by name. */
export function otherProjects(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  project: string | undefined,
): OtherProject[] {
  // Counted in rows, as the project's table lists them: the rows' keys, by project.
  const byKey = new Map<string, { path: string; rows: Set<string> }>();
  for (const item of ofKind(inv, tool, kind)) {
    const dir = item.location.project;
    if (dir === undefined || homeScope(item, project) !== "other") continue;
    const key = pathKey(dir);
    const known = byKey.get(key) ?? { path: dir, rows: new Set<string>() };
    known.rows.add(rowKey(item));
    byKey.set(key, known);
  }
  return [...byKey.values()]
    .map(({ path, rows }) => ({ path, name: projectName(path, inv), count: rows.size }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/**
 * Whether the item loads in `project` in at least one account: relevant there, not a broken link,
 * not off, not pending approval, not hidden by a nearer copy.
 */
export function loadsHere(inv: Inventory, item: Extension, project: string | undefined): boolean {
  // A link to nothing has no SKILL.md for Claude Code or Codex to read.
  if (!relevantIn(item, project) || item.link?.broken === true) return false;
  const states = accountStates(inv, item, project)?.map((a) => a.state) ?? [stateHere(inv, item, project)];
  // Claude Code does not start a .mcp.json server until it is approved.
  return states.some((s) => s.value !== "off" && s.value !== "pending-approval" && !s.shadowedBy);
}

/** Whether `item` is something the plugin install `install` brings. */
function brings(install: Extension, item: Extension): boolean {
  const own = install.location;
  const loc = item.location;
  if (loc.tool !== own.tool || loc.plugin !== own.plugin || installScope(item) !== installScope(install)) return false;
  // One install of the plugin: the same project (or none), files inside its install path.
  const sameProject = own.project === undefined ? loc.project === undefined : samePath(loc.project, own.project);
  return sameProject && isWithin(loc.file, own.file);
}

export type PluginContents = { skill: ScopeRow[]; mcp: ScopeRow[]; hook: ScopeRow[] };

/**
 * What a plugin brings, for its CONTAINS cell and details, in rows: for a row of a plugin's
 * installs, what each install brings, one row per thing across them, as rowsIn makes them.
 */
export function pluginContents(inv: Inventory, plugin: Extension | ScopeRow): PluginContents {
  const installs = "items" in plugin ? plugin.items : [plugin];
  const rows = {
    skill: new Map<string, ScopeRow>(),
    mcp: new Map<string, ScopeRow>(),
    hook: new Map<string, ScopeRow>(),
  };
  for (const item of inv.items) {
    if (item.kind === "plugin" || item.location.scope !== "plugin") continue;
    if (!installs.some((install) => brings(install, item))) continue;
    const key = rowKey(item);
    const row = rows[item.kind].get(key) ?? { key, name: item.name, items: [] };
    row.items.push(item);
    rows[item.kind].set(key, row);
  }
  const sorted = (map: Map<string, ScopeRow>) =>
    [...map.values()].map((row) => ({ ...row, items: [...row.items].sort(byAccount(inv)) }));
  return { skill: sorted(rows.skill), mcp: sorted(rows.mcp), hook: sorted(rows.hook) };
}
