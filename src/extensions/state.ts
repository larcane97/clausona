import path from "node:path";

import {
  type EffectiveState,
  type Extension,
  type Inventory,
  type SettingsLayer,
  SKILL_VISIBILITY,
  type SkillVisibility,
} from "./model.js";
import { isWithin, pathKey, samePath } from "./read.js";

/**
 * The `setBy.key` of a stashed item's state: off everywhere, its entry out of the tool's file and
 * in the stash file `setBy.file` names.
 */
export const STASH_KEY = "stash";

/** Claude Code reads settings in this order; the first that sets a key wins. */
const PRECEDENCE: readonly SettingsLayer[] = ["managed", "local", "project", "user"];

function isVisibility(value: unknown): value is SkillVisibility {
  return typeof value === "string" && (SKILL_VISIBILITY as readonly string[]).includes(value);
}

/** User and managed settings apply everywhere; project and local ones in their own project only. */
function applies(entry: { layer: SettingsLayer; project?: string }, project: string | undefined): boolean {
  return (
    entry.layer === "user" || entry.layer === "managed" || (project !== undefined && samePath(entry.project, project))
  );
}

/**
 * A server from a `.mcp.json`. Claude Code 2.1.294 reads that file in every session started in
 * the dir that holds it or in any dir below: from the start dir and each parent up to the
 * filesystem root, the nearest file winning a name. Its `location.project` is that dir, which
 * is a project, or a parent dir of one read for its `.mcp.json` alone (see readClaudeMcp).
 */
export function isMcpjsonServer(item: Extension): boolean {
  return item.kind === "mcp" && item.location.tool === "claude" && item.location.scope === "project";
}

/**
 * Whether `item` can load in `project` at all: anything no project owns, that project's own,
 * and a `.mcp.json` server of the project's dir or of a dir above it.
 */
export function relevantIn(item: Extension, project: string | undefined): boolean {
  if (item.location.project === undefined) return true;
  if (project === undefined) return false;
  return isMcpjsonServer(item) ? isWithin(project, item.location.project) : samePath(item.location.project, project);
}

/**
 * The copies of a Claude MCP server name that `profile` sees in `project`, as Claude Code ranks
 * them - "local-scoped servers first, followed by project-scoped servers, and finally
 * user-scoped servers": the account's local server for the project, then the `.mcp.json` ones,
 * the nearest file first, then the account's user server. With no account named, no account's
 * own server. A plugin's servers go by names of their own (`plugin:<plugin>:<name>`).
 */
function rankedMcp(inv: Inventory, name: string, project: string, profile: string | undefined): Extension[] {
  // A stashed copy is out of its file: Claude Code does not see it, so it wins over nothing.
  const named = inv.items.filter(
    (i) => i.kind === "mcp" && i.location.tool === "claude" && i.name === name && !i.stashed,
  );
  const own = (i: Extension) => profile !== undefined && i.location.profile === profile;
  const local = named.filter((i) => own(i) && i.location.scope === "local" && samePath(i.location.project, project));
  const mcpjson = named
    .filter((i) => isMcpjsonServer(i) && isWithin(project, i.location.project))
    .sort((a, b) => pathKey(b.location.project ?? "").length - pathKey(a.location.project ?? "").length);
  const user = named.filter((i) => own(i) && i.location.scope === "account");
  return [...local, ...mcpjson, ...user];
}

/**
 * Of `ranked`, the copy Claude Code takes: the first, once the `.mcp.json` ones not approved for
 * the account are left out, as Claude Code leaves them out before it picks one per name. With
 * nothing else to take, the nearest `.mcp.json` one, which waits for approval.
 */
function taken(inv: Inventory, ranked: Extension[], project: string, profile: string | undefined) {
  const starts = (copy: Extension) =>
    !isMcpjsonServer(copy) || mcpjsonApproval(inv, copy, project, profile).value === "on";
  return ranked.find(starts) ?? ranked[0];
}

/**
 * The Claude MCP server Claude Code takes for `name` in `project`, in account `profile`: the
 * one copy of the name that no other hides there (see `mcpWinner`) and that starts if any does.
 */
export function claudeMcpTaken(inv: Inventory, name: string, project: string, profile: string): Extension | undefined {
  return taken(inv, rankedMcp(inv, name, project, profile), project, profile);
}

/**
 * The same-name copy that wins over Claude MCP server `item` in `project`, for `profile`: the
 * first ranked copy above it. A user server loses only to a copy Claude Code takes, so a
 * pending or denied `.mcp.json` copy leaves it loading.
 */
function mcpWinner(
  inv: Inventory,
  item: Extension,
  project: string,
  profile: string | undefined,
): Extension | undefined {
  const ranked = rankedMcp(inv, item.name, project, profile);
  if (!ranked.includes(item)) return undefined;
  const winner = item.location.scope === "account" ? taken(inv, ranked, project, profile) : ranked[0];
  return winner === item ? undefined : winner;
}

/** A plugin is on only where some settings file enables it; installed and named nowhere is off. */
export function pluginState(inv: Inventory, pluginId: string, project?: string): EffectiveState {
  for (const layer of PRECEDENCE) {
    for (const entry of inv.facts.claudeEnabledPlugins) {
      if (entry.layer !== layer || !applies(entry, project)) continue;
      const value = entry.map[pluginId];
      if (typeof value === "boolean") {
        return { value: value ? "on" : "off", setBy: { file: entry.file, key: `enabledPlugins.${pluginId}` } };
      }
    }
  }
  return { value: "off" };
}

/**
 * The `skillOverrides` value Claude Code takes for `name` in `project`, and where it is set;
 * undefined when no settings file sets one. `skip` leaves those layers out, for "what is left
 * below the one I am about to change".
 */
export function claudeSkillOverride(
  inv: Inventory,
  name: string,
  project: string | undefined,
  skip: readonly SettingsLayer[] = [],
): EffectiveState | undefined {
  for (const layer of PRECEDENCE) {
    if (skip.includes(layer)) continue;
    for (const entry of inv.facts.claudeSkillOverrides) {
      if (entry.layer !== layer || !applies(entry, project)) continue;
      const value = entry.map[name];
      if (isVisibility(value)) return { value, setBy: { file: entry.file, key: `skillOverrides.${name}` } };
    }
  }
  return undefined;
}

function claudeSkillState(
  inv: Inventory,
  item: Extension,
  project: string | undefined,
  profile: string | undefined,
): EffectiveState {
  // Plugin skills ignore skillOverrides (Claude Code 2.1.294): only the plugin's switch applies.
  if (item.location.scope === "plugin" && item.location.plugin) return pluginState(inv, item.location.plugin, project);
  const state = claudeSkillOverride(inv, item.name, project) ?? { value: "on" };
  if (item.location.scope !== "project") return state;
  // A personal skill wins over a project skill of the same name (Claude Code docs): a Global one
  // in every account, and one in an account's own skills folder in that account only.
  const personal = (other: Extension, scope: "global" | "account") =>
    other.kind === "skill" &&
    other.location.tool === "claude" &&
    other.name === item.name &&
    other.location.scope === scope &&
    (scope === "global" || (profile !== undefined && other.location.profile === profile));
  const winner =
    inv.items.find((other) => personal(other, "account")) ?? inv.items.find((other) => personal(other, "global"));
  return winner ? { ...state, shadowedBy: winner.id } : state;
}

function claudeMcpState(
  inv: Inventory,
  item: Extension,
  project: string | undefined,
  profile: string | undefined,
): EffectiveState {
  if (item.location.scope === "plugin" && item.location.plugin) {
    const plugin = pluginState(inv, item.location.plugin, project);
    if (plugin.value === "off") return plugin;
  }
  // Claude Code has no global off for an MCP server: with no project it is on.
  if (project === undefined) return { value: "on" };
  // Approved by name in the project it is read in, whichever dir's .mcp.json defines it.
  if (isMcpjsonServer(item))
    return withWinner(mcpjsonApproval(inv, item, project, profile), inv, item, project, profile);
  const owner = profile ?? item.location.profile;
  const off = inv.facts.claudeMcpDisabled.find(
    (d) => d.profile === owner && samePath(d.project, project) && d.names.includes(item.name),
  );
  const state: EffectiveState = off
    ? { value: "off", setBy: { file: off.file, key: "disabledMcpServers" } }
    : { value: "on" };
  return withWinner(state, inv, item, project, owner);
}

/** `state`, with the copy that wins over `item` for `profile` when one does. */
function withWinner(
  state: EffectiveState,
  inv: Inventory,
  item: Extension,
  project: string,
  profile: string | undefined,
): EffectiveState {
  const winner = mcpWinner(inv, item, project, profile);
  return winner ? { ...state, shadowedBy: winner.id } : state;
}

/** A `.mcp.json` server's approval in `project`, for `profile` or every account merged. */
function mcpjsonApproval(
  inv: Inventory,
  item: Extension,
  project: string,
  profile: string | undefined,
): EffectiveState {
  // An approval with no project comes from user or managed settings and applies in every project.
  const approvals = inv.facts.claudeMcpjson.filter(
    (a) =>
      (a.project === undefined || samePath(a.project, project)) &&
      (a.profile === undefined || profile === undefined || a.profile === profile),
  );
  const denied = approvals.find((a) => a.disabled.includes(item.name));
  if (denied) return { value: "off", setBy: { file: denied.file, key: "disabledMcpjsonServers" } };
  const allowed = approvals.find((a) => a.enableAll || a.enabled.includes(item.name));
  if (allowed) {
    return {
      value: "on",
      setBy: { file: allowed.file, key: allowed.enableAll ? "enableAllProjectMcpServers" : "enabledMcpjsonServers" },
    };
  }
  return { value: "pending-approval" };
}

function codexSkillState(inv: Inventory, item: Extension): EffectiveState {
  const skillFile = path.join(item.location.file, "SKILL.md");
  let byPath: (typeof inv.facts.codexSkillConfig)[number] | undefined;
  let byName: (typeof inv.facts.codexSkillConfig)[number] | undefined;
  for (const entry of inv.facts.codexSkillConfig) {
    if (entry.path !== undefined && samePath(entry.path, skillFile)) byPath = entry;
    else if (entry.name === item.name) byName = entry;
  }
  const hit = byPath ?? byName;
  if (!hit) return { value: "on" };
  const key = hit.path !== undefined ? `skills.config (path ${hit.path})` : `skills.config (name ${item.name})`;
  return { value: hit.enabled ? "on" : "off", setBy: { file: hit.file, key } };
}

/**
 * Whether `file` is a managed settings layer the inventory read: organisation policy, which
 * clausona never writes.
 */
export function isManagedSetting(inv: Inventory, file: string): boolean {
  const managed = (entry: { file: string; layer: SettingsLayer }) =>
    entry.layer === "managed" && samePath(entry.file, file);
  return inv.facts.claudeSkillOverrides.some(managed) || inv.facts.claudeEnabledPlugins.some(managed);
}

/**
 * Whether Codex trusts `project`: a [projects."<key>"] table with trust_level = "trusted" whose
 * key samePaths it. Codex 0.159.3 ignores the `.codex/` folder of any other project, one it has
 * no record of too.
 */
export function codexTrusted(inv: Inventory, project: string | undefined): boolean {
  return project !== undefined && inv.facts.codexTrust.some((t) => t.trusted && samePath(t.project, project));
}

/** The user's `mcp_servers.<name>.enabled`, or the project's when Codex trusts the project. */
function codexMcpState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  const entries = inv.facts.codexMcpEnabled.filter(
    (e) => e.name === item.name && (e.project === undefined || codexTrusted(inv, e.project)),
  );
  const here = project === undefined ? undefined : entries.find((e) => samePath(e.project, project));
  const hit = here ?? entries.find((e) => e.project === undefined);
  if (!hit) return { value: "on" };
  return { value: hit.enabled ? "on" : "off", setBy: { file: hit.file, key: `mcp_servers.${item.name}.enabled` } };
}

/**
 * What `item` is in `project` (undefined: with no project, where only user and managed
 * settings apply), for account `profile`. A switch or a winning copy can be one account's: a
 * Claude MCP server's (`disabledMcpServers`, an approval, a local server), and a Claude project
 * skill's (an account's own same-name skill). For what any account can see (a `.mcp.json` or
 * plugin server, a project skill), callers pass `profile`: without one, every account's
 * approvals are merged and no account's own switch or copy applies. A stashed item is off
 * everywhere, whatever the switches say.
 */
export function stateOf(inv: Inventory, item: Extension, project?: string, profile?: string): EffectiveState {
  if (item.stashed) return { value: "off", setBy: { file: item.stashed.file, key: STASH_KEY } };
  switch (item.kind) {
    case "skill":
      return item.location.tool === "claude"
        ? claudeSkillState(inv, item, project, profile)
        : codexSkillState(inv, item);
    case "mcp":
      return item.location.tool === "claude"
        ? claudeMcpState(inv, item, project, profile)
        : codexMcpState(inv, item, project);
    case "plugin":
      return pluginState(inv, item.location.plugin ?? item.name, project);
    case "hook":
      return item.location.scope === "plugin" && item.location.plugin
        ? pluginState(inv, item.location.plugin, project)
        : { value: "on" };
  }
}
