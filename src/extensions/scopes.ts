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
        : itemsIn(inv, tool, kind, id, project, now).length;
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

export type OtherProject = { path: string; name: string; count: number };

/** Other projects that have at least one item of this tool and kind, by name. */
export function otherProjects(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  project: string | undefined,
): OtherProject[] {
  const byKey = new Map<string, OtherProject>();
  for (const item of ofKind(inv, tool, kind)) {
    const dir = item.location.project;
    if (dir === undefined || homeScope(item, project) !== "other") continue;
    const key = pathKey(dir);
    const known = byKey.get(key);
    if (known) known.count += 1;
    else byKey.set(key, { path: dir, name: projectName(dir, inv), count: 1 });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/**
 * Whether the item loads in `project` in at least one account: relevant there, not off, not
 * pending approval, not hidden by a nearer copy.
 */
export function loadsHere(inv: Inventory, item: Extension, project: string | undefined): boolean {
  if (!relevantIn(item, project)) return false;
  const states = accountStates(inv, item, project)?.map((a) => a.state) ?? [stateHere(inv, item, project)];
  // Claude Code does not start a .mcp.json server until it is approved.
  return states.some((s) => s.value !== "off" && s.value !== "pending-approval" && !s.shadowedBy);
}

/** The plugin items of `kind`'s tool that a plugin item brings, for its CONTAINS cell and details. */
export function pluginContents(
  inv: Inventory,
  plugin: Extension,
): { skill: Extension[]; mcp: Extension[]; hook: Extension[] } {
  const contents: { skill: Extension[]; mcp: Extension[]; hook: Extension[] } = { skill: [], mcp: [], hook: [] };
  const own = plugin.location;
  for (const item of inv.items) {
    const loc = item.location;
    if (item.kind === "plugin" || loc.scope !== "plugin" || loc.tool !== own.tool || loc.plugin !== own.plugin)
      continue;
    // One install of the plugin: the same project (or none), files inside its install path.
    const sameProject = own.project === undefined ? loc.project === undefined : samePath(loc.project, own.project);
    if (sameProject && isWithin(loc.file, own.file)) contents[item.kind].push(item);
  }
  return contents;
}
