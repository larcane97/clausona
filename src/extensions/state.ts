import path from "node:path";

import {
  type EffectiveState,
  type Extension,
  type Inventory,
  type SettingsLayer,
  SKILL_VISIBILITY,
  type SkillVisibility,
} from "./model.js";
import { samePath } from "./read.js";

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

/** Whether `item` can load in `project` at all: anything no project owns, or that project's own. */
export function relevantIn(item: Extension, project: string | undefined): boolean {
  if (item.location.project === undefined) return true;
  return project !== undefined && samePath(item.location.project, project);
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

function claudeSkillOverride(inv: Inventory, name: string, project: string | undefined): EffectiveState | undefined {
  for (const layer of PRECEDENCE) {
    for (const entry of inv.facts.claudeSkillOverrides) {
      if (entry.layer !== layer || !applies(entry, project)) continue;
      const value = entry.map[name];
      if (isVisibility(value)) return { value, setBy: { file: entry.file, key: `skillOverrides.${name}` } };
    }
  }
  return undefined;
}

function claudeSkillState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  // Plugin skills ignore skillOverrides (Claude Code 2.1.294): only the plugin's switch applies.
  if (item.location.scope === "plugin" && item.location.plugin) return pluginState(inv, item.location.plugin, project);
  const state = claudeSkillOverride(inv, item.name, project) ?? { value: "on" };
  if (item.location.scope !== "project") return state;
  // A personal skill wins over a project skill of the same name (Claude Code docs).
  const winner = inv.items.find(
    (other) =>
      other.kind === "skill" &&
      other.location.tool === "claude" &&
      other.name === item.name &&
      (other.location.scope === "global" || other.location.scope === "account"),
  );
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
  if (item.location.scope === "project") {
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
  const owner = profile ?? item.location.profile;
  const off = inv.facts.claudeMcpDisabled.find(
    (d) => d.profile === owner && samePath(d.project, project) && d.names.includes(item.name),
  );
  return off ? { value: "off", setBy: { file: off.file, key: "disabledMcpServers" } } : { value: "on" };
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

function codexMcpState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  const entries = inv.facts.codexMcpEnabled.filter((e) => e.name === item.name);
  const here = project === undefined ? undefined : entries.find((e) => samePath(e.project, project));
  const hit = here ?? entries.find((e) => e.project === undefined);
  if (!hit) return { value: "on" };
  return { value: hit.enabled ? "on" : "off", setBy: { file: hit.file, key: `mcp_servers.${item.name}.enabled` } };
}

/**
 * What `item` is in `project` (undefined: with no project, where only user and managed
 * settings apply), for `profile` when the switch is an account's (Claude MCP). For a Claude MCP
 * server that any account can see (a `.mcp.json` or plugin server), callers pass `profile`:
 * without one, every account's approvals are merged and no account's `disabledMcpServers` entry
 * applies.
 */
export function stateOf(inv: Inventory, item: Extension, project?: string, profile?: string): EffectiveState {
  switch (item.kind) {
    case "skill":
      return item.location.tool === "claude" ? claudeSkillState(inv, item, project) : codexSkillState(inv, item);
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
