import path from "node:path";
import { type McpRule, type McpTarget, ruleMatches } from "./mcp-policy.js";
import {
  type ClaudeFlag,
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

/** The `setBy.key` of a server managed-mcp.json keeps from starting: the file's name, as no key holds it. */
export const MANAGED_MCP_KEY = "managed-mcp.json";

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
  // A stashed copy is out of its file, and one the lists block is left out before Claude Code
  // picks: neither wins over anything.
  const named = inv.items.filter(
    (i) =>
      i.kind === "mcp" && i.location.tool === "claude" && i.name === name && !i.stashed && !mcpBlocked(inv, i, project),
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

/**
 * The value of `key` Claude Code takes in `project`, and the file and layer that set it: the
 * first layer that sets it to true or false, as for any setting of one value. Undefined when none
 * does.
 */
export function claudeFlag(
  inv: Inventory,
  key: ClaudeFlag,
  project: string | undefined,
): { value: boolean; file: string; layer: SettingsLayer } | undefined {
  for (const layer of PRECEDENCE) {
    const entry = inv.facts.claudeFlags.find((f) => f.key === key && f.layer === layer && applies(f, project));
    if (entry) return entry;
  }
  return undefined;
}

/**
 * The off that `disableAllHooks` puts Claude hook `item` in, in `project`; undefined where hooks
 * run. Claude Code 2.1.296 reads the value left after settings precedence. Set in managed
 * settings, it turns every hook off. Set anywhere else, it leaves the managed hooks running, and
 * a plugin's while managed settings turn the plugin on.
 */
export function allHooksOff(inv: Inventory, item: Extension, project: string | undefined): EffectiveState | undefined {
  if (item.kind !== "hook" || item.location.tool !== "claude") return undefined;
  const flag = claudeFlag(inv, "disableAllHooks", project);
  if (flag?.value !== true) return undefined;
  const off: EffectiveState = { value: "off", setBy: { file: flag.file, key: "disableAllHooks" } };
  if (flag.layer === "managed") return off;
  if (item.location.scope === "managed") return undefined;
  const plugin = item.location.scope === "plugin" ? item.location.plugin : undefined;
  if (plugin !== undefined) {
    const switched = pluginState(inv, plugin, project);
    if (switched.value === "on" && switched.setBy && isManagedSetting(inv, switched.setBy.file)) return undefined;
  }
  return off;
}

/** The settings whose MCP lists apply in `project`, managed first, as the layers rank. */
function mcpPolicies(inv: Inventory, project: string | undefined) {
  return PRECEDENCE.flatMap((layer) =>
    inv.facts.claudeMcpPolicy.filter((p) => p.layer === layer && applies(p, project)),
  );
}

/**
 * Whether an allowlist admits a server: a stdio one by a serverCommand entry once the list has
 * one, a remote one by a serverUrl entry likewise, and otherwise by its name.
 */
function admits(rules: McpRule[], name: string, target: McpTarget | undefined): boolean {
  const kind = target?.command !== undefined ? "serverCommand" : target?.url !== undefined ? "serverUrl" : undefined;
  const by = kind !== undefined && rules.some((rule) => kind in rule) ? kind : "serverName";
  return rules.some((rule) => by in rule && ruleMatches(rule, name, target));
}

/**
 * The off that Claude Code's MCP policy puts Claude MCP server `item` in, in `project`; undefined
 * where it lets the server start. As Claude Code 2.1.296 checks a server before it starts one:
 * - while managed-mcp.json is there, it starts that file's servers and no other;
 * - a server that an entry of any denylist that applies matches does not start;
 * - with an allowlist anywhere, a server must be on it (`admits`), the lists of every file
 *   merged, or the managed ones alone when managed settings set allowManagedMcpServersOnly.
 *   A managed-mcp.json server that reads no variable of the user's needs no entry.
 */
export function mcpBlocked(inv: Inventory, item: Extension, project: string | undefined): EffectiveState | undefined {
  if (item.kind !== "mcp" || item.location.tool !== "claude") return undefined;
  const managed = item.location.scope === "managed";
  const exclusive = inv.facts.claudeManagedMcp;
  if (exclusive !== undefined && !managed) return { value: "off", setBy: { file: exclusive, key: MANAGED_MCP_KEY } };
  const target = inv.facts.mcpTargets[item.id];
  const policies = mcpPolicies(inv, project);
  const denied = policies.find((p) => p.denied?.some((rule) => ruleMatches(rule, item.name, target)));
  if (denied) return { value: "off", setBy: { file: denied.file, key: "deniedMcpServers" } };
  if (managed && target?.vars !== true) return undefined;
  const lock = policies.some((p) => p.managedOnly);
  const lists = policies.filter((p) => p.allowed !== undefined && (!lock || p.layer === "managed"));
  const first = lists[0];
  const rules = lists.flatMap((p) => p.allowed ?? []);
  if (first === undefined || admits(rules, item.name, target)) return undefined;
  return { value: "off", setBy: { file: first.file, key: "allowedMcpServers" } };
}

/**
 * A Claude plugin is on only where some settings file enables it; installed and named nowhere is
 * off. A Codex plugin's is `codexPluginState`: an id can be both tools'.
 */
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
  // disableBundledSkills takes the skills that come with Claude Code out, whatever skillOverrides says.
  if (item.location.scope === "builtin") {
    const bundled = claudeFlag(inv, "disableBundledSkills", project);
    if (bundled?.value === true) return { value: "off", setBy: { file: bundled.file, key: "disableBundledSkills" } };
  }
  const state = claudeSkillOverride(inv, item.name, project) ?? { value: "on" };
  if (item.location.scope !== "project") return state;
  // A personal skill wins over a project skill of the same name (Claude Code docs): a Global one
  // in every account that loads the primary's skills, and one in an account's own skills folder
  // in that account only.
  const personal = (other: Extension, scope: "global" | "account") =>
    other.kind === "skill" &&
    other.location.tool === "claude" &&
    other.name === item.name &&
    other.location.scope === scope &&
    (scope === "global"
      ? profile === undefined || other.location.accounts === undefined || other.location.accounts.includes(profile)
      : profile !== undefined && other.location.profile === profile);
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
  const blocked = mcpBlocked(inv, item, project);
  if (blocked) return blocked;
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

/** A plugin's skill, server or hook is off while the plugin is: Codex does not load it. */
function codexPluginOff(inv: Inventory, item: Extension, project: string | undefined): EffectiveState | undefined {
  if (item.location.scope !== "plugin" || item.location.plugin === undefined) return undefined;
  const plugin = codexPluginState(inv, item.location.plugin, project);
  return plugin.value === "off" ? plugin : undefined;
}

/**
 * By name - a plugin's skill by its full `<plugin>:<name>` - or by path, the path winning. A path
 * names the skill through a link or not, as Codex reads it: the path or its real one, against
 * the skill's own path or its real one.
 */
function codexSkillState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  const off = codexPluginOff(inv, item, project);
  if (off) return off;
  const skillFiles = [item.location.file, item.realFolder]
    .filter((folder): folder is string => folder !== undefined)
    .map((folder) => path.join(folder, "SKILL.md"));
  const names = (entry: (typeof inv.facts.codexSkillConfig)[number]) =>
    [entry.path, entry.realPath].some((p) => skillFiles.some((file) => samePath(p, file)));
  let byPath: (typeof inv.facts.codexSkillConfig)[number] | undefined;
  let byName: (typeof inv.facts.codexSkillConfig)[number] | undefined;
  for (const entry of inv.facts.codexSkillConfig) {
    if (entry.path !== undefined && names(entry)) byPath = entry;
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
  return (
    inv.facts.claudeSkillOverrides.some(managed) ||
    inv.facts.claudeEnabledPlugins.some(managed) ||
    inv.facts.claudeFlags.some(managed) ||
    inv.facts.claudeMcpPolicy.some(managed) ||
    samePath(inv.facts.claudeManagedMcp, file)
  );
}

/**
 * Whether Codex trusts `project`: a [projects."<key>"] table with trust_level = "trusted" whose
 * key samePaths it. Codex 0.159.3 ignores the `.codex/` folder of any other project, one it has
 * no record of too.
 */
export function codexTrusted(inv: Inventory, project: string | undefined): boolean {
  return project !== undefined && inv.facts.codexTrust.some((t) => t.trusted && samePath(t.project, project));
}

/**
 * The user's `mcp_servers.<name>.enabled`, or the project's when Codex trusts the project; for a
 * plugin's server, its plugin's state, then `plugins."<id>".mcp_servers.<name>.enabled`.
 */
function codexMcpState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  const plugin = item.location.scope === "plugin" ? item.location.plugin : undefined;
  if (plugin !== undefined) {
    // A plugin's server is switched under the plugin's table, never by a user server's name.
    const off = codexPluginOff(inv, item, project);
    if (off) return off;
    const entries = inv.facts.codexPluginServers.filter((e) => e.plugin === plugin && e.name === item.name);
    const hit = codexLayered(
      inv,
      entries.filter((e) => !e.default),
      project,
    );
    if (hit) {
      const key = `plugins.${plugin}.mcp_servers.${item.name}.enabled`;
      return { value: hit.enabled ? "on" : "off", setBy: { file: hit.file, key } };
    }
    // Else what the plugin's own file says, or on.
    const own = entries.find((e) => e.default);
    const key = `mcpServers.${item.name}.enabled`;
    return own ? { value: own.enabled ? "on" : "off", setBy: { file: own.file, key } } : { value: "on" };
  }
  const hit = codexLayered(
    inv,
    inv.facts.codexMcpEnabled.filter((e) => e.name === item.name),
    project,
  );
  if (!hit) return { value: "on" };
  return { value: hit.enabled ? "on" : "off", setBy: { file: hit.file, key: `mcp_servers.${item.name}.enabled` } };
}

/** Of one switch's entries, the one Codex takes in `project`: that project's where it trusts it, else the user's. */
function codexLayered<T extends { project?: string }>(
  inv: Inventory,
  entries: T[],
  project: string | undefined,
): T | undefined {
  const here =
    project === undefined
      ? undefined
      : entries.find((e) => e.project !== undefined && samePath(e.project, project) && codexTrusted(inv, e.project));
  return here ?? entries.find((e) => e.project === undefined);
}

/**
 * A Codex plugin's state in `project`: on where a `[plugins."<id>"]` table names it, unless the
 * table sets `enabled = false`; the project's table over the user's where Codex trusts the
 * project, an `enabled` there over the user's, as Codex merges the two. A plugin no table names
 * is off: Codex loads only what its config names (Codex 0.159.3).
 */
export function codexPluginState(inv: Inventory, plugin: string, project: string | undefined): EffectiveState {
  const tables = inv.facts.codexPlugins.filter((t) => t.plugin === plugin);
  const set = codexLayered(
    inv,
    tables.filter((t) => t.enabled !== undefined),
    project,
  );
  if (set) return { value: set.enabled ? "on" : "off", setBy: { file: set.file, key: `plugins.${plugin}.enabled` } };
  return codexLayered(inv, tables, project) ? { value: "on" } : { value: "off" };
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
        : codexSkillState(inv, item, project);
    case "mcp":
      return item.location.tool === "claude"
        ? claudeMcpState(inv, item, project, profile)
        : codexMcpState(inv, item, project);
    case "plugin":
      return item.location.tool === "codex"
        ? codexPluginState(inv, item.location.plugin ?? item.name, project)
        : pluginState(inv, item.location.plugin ?? item.name, project);
    case "hook":
      // Codex keeps its own trust for each hook; disableAllHooks is Claude Code's.
      if (item.location.tool === "codex") return codexHookState(inv, item, project);
      return (
        allHooksOff(inv, item, project) ??
        (item.location.scope === "plugin" && item.location.plugin
          ? pluginState(inv, item.location.plugin, project)
          : { value: "on" })
      );
  }
}

/**
 * A Codex hook's state, as Codex 0.159.3 runs it: off with its plugin; else on where, in at least
 * one Codex profile, the hook as it is now is the one trusted under its key and the key does not
 * turn it off (`[hooks.state."<key>"]`) - a bundled plugin's cleanup hook always, and one with
 * no trust identity as before; off where every profile's key turns it off; else pending
 * approval, Codex waiting for the user to review it with /hooks - `setBy` naming the trust that
 * no longer matches when the hook changed since.
 */
function codexHookState(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  const off = codexPluginOff(inv, item, project);
  if (off) return off;
  const trust = inv.facts.codexHookTrust.find((t) => t.id === item.id);
  if (!trust || trust.builtin) return { value: "on" };
  const keyed = trust.keys.map((key) => ({ key, state: inv.facts.codexHookStates.find((s) => s.key === key) }));
  if (keyed.some(({ state }) => state?.enabled !== false && state?.trustedHash === trust.hash)) return { value: "on" };
  const first = keyed[0];
  if (first?.state && keyed.every(({ state }) => state?.enabled === false)) {
    return { value: "off", setBy: { file: first.state.file, key: `hooks.state."${first.key}".enabled` } };
  }
  const stale = keyed.find(({ state }) => state?.trustedHash !== undefined);
  if (!stale?.state) return { value: "pending-approval" };
  return {
    value: "pending-approval",
    setBy: { file: stale.state.file, key: `hooks.state."${stale.key}".trusted_hash` },
  };
}
