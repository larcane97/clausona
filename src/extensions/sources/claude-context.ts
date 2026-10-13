import path from "node:path";

import { claudeJsonPathForConfigDir } from "../../core/paths.js";
import { inspectSharedLink } from "../../core/shared-links.js";
import type { Registry } from "../../types.js";
import { type Env, mcpRules } from "../mcp-policy.js";
import type { ClaudeFlag, Collector, Location, Project, SettingsLayer, Warning } from "../model.js";
import { localSettingsFile, projectSettingsFile } from "../places.js";
import { isHomeProject } from "../projects.js";
import {
  entryInfo,
  IO_LIMIT,
  isRecord,
  isWithin,
  listNames,
  mapLimit,
  pathKey,
  readJsonObject,
  realPath,
  samePath,
} from "../read.js";

export type ClaudeAccount = {
  id: string;
  configDir: string;
  jsonPath: string;
  json?: Record<string, unknown>;
  isPrimary: boolean;
};

export type SettingsFile = { file: string; layer: SettingsLayer; project?: string; data: Record<string, unknown> };

export type PluginInstall = {
  id: string;
  name: string;
  /** The recorded install path resolved through links, or as recorded when it does not resolve. */
  installPath: string;
  scope: "user" | "project" | "local";
  /** Set exactly when the scope is project or local. */
  project?: string;
  /** The Claude accounts that list this install, primary first. */
  profiles: string[];
};

/**
 * A plugin install record as an id owner: unique per record, so items from two installs of one
 * plugin never share an id.
 */
export function pluginOwner(plugin: PluginInstall): string {
  return `${plugin.id}|${plugin.scope}|${plugin.project ?? "-"}|${pathKey(plugin.installPath)}`;
}

/**
 * Where a plugin install and what it brings are, but the file: the plugin, the project it is
 * installed for, the accounts that have it and its install scope, which a row of its installs
 * across accounts is keyed by.
 */
export function pluginLocation(plugin: PluginInstall): Omit<Location, "file"> {
  return {
    tool: "claude",
    scope: "plugin",
    plugin: plugin.id,
    ...(plugin.project ? { project: plugin.project } : {}),
    accounts: plugin.profiles,
    installScope: plugin.scope,
  };
}

/** A plugin's manifest, `.claude-plugin/plugin.json` in its install folder. */
export function pluginManifestFile(plugin: PluginInstall): string {
  return path.join(plugin.installPath, ".claude-plugin", "plugin.json");
}

/**
 * What a plugin's manifest declares under `key` - `mcpServers` or `hooks` - as a list: the
 * manifest takes one path, one inline object, or a list of either.
 */
export function declared(manifest: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = manifest?.[key];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/**
 * A path a plugin's manifest names, as Claude Code 2.1.296 resolves one: from the plugin's
 * install folder, and only while it stays in it - not up through `..`, not an absolute path
 * elsewhere, not through a link that leads out. Undefined for one that leaves it, which Claude
 * Code does not load either.
 */
export async function insidePlugin(plugin: PluginInstall, named: string): Promise<string | undefined> {
  const root = plugin.installPath;
  const file = path.resolve(root, named);
  if (!isWithin(file, root)) return undefined;
  // A file that is not there has nothing to read; one that is must lead into the plugin too.
  const [real, realRoot] = await Promise.all([realPath(file).catch(() => undefined), realPath(root).catch(() => root)]);
  return real === undefined || isWithin(real, realRoot) ? file : undefined;
}

export type ClaudeContext = {
  homeDir: string;
  /** The last dir the parent `.mcp.json` walk reads; undefined walks to the filesystem root. */
  mcpjsonStop?: string;
  primaryDir: string;
  accounts: ClaudeAccount[];
  settings: SettingsFile[];
  plugins: PluginInstall[];
  /** managed-mcp.json beside the managed settings, when it is there; `json` when it reads as JSON. */
  managedMcp?: { file: string; json?: Record<string, unknown> };
  /** See LoadOptions.env. */
  env: Env;
};

/** Where Claude Code reads organisation policy on each platform. */
export function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** Every Claude profile with its account file read, the primary first and the rest in registry order. */
export async function loadClaudeAccounts(
  registry: Registry,
  homeDir: string,
  warnings: Warning[],
): Promise<ClaudeAccount[]> {
  const primaryDir = registry.primarySources.claude;
  const accounts = await Promise.all(
    Object.entries(registry.profiles)
      .filter(([, profile]) => profile.tool === "claude")
      .map(async ([id, profile]) => {
        const jsonPath = claudeJsonPathForConfigDir({ homeDir, configDir: profile.configDir });
        const json = await readJsonObject(jsonPath, warnings);
        return {
          id,
          configDir: profile.configDir,
          jsonPath,
          ...(json ? { json } : {}),
          isPrimary:
            profile.isPrimary === true || (primaryDir !== undefined && samePath(profile.configDir, primaryDir)),
        };
      }),
  );
  return accounts.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * registry.primarySources.claude, else the primary account's configDir, else <home>/.claude -
 * what loadClaudeContext uses.
 */
export function claudePrimaryDir(registry: Registry, accounts: ClaudeAccount[], homeDir: string): string {
  return (
    registry.primarySources.claude ?? accounts.find((a) => a.isPrimary)?.configDir ?? path.join(homeDir, ".claude")
  );
}

/**
 * The settings files Claude Code reads and every account's plugin installs. One user
 * `settings.json` stands for every account: clausona links each profile's to the primary's.
 */
export async function loadClaudeContext(options: {
  accounts: ClaudeAccount[];
  registry: Registry;
  homeDir: string;
  projects: Project[];
  managedSettings: string;
  /** See LoadOptions.mcpjsonStop. */
  mcpjsonStop?: string;
  /** See LoadOptions.env; default none, so every variable stays as written. */
  env?: Env;
  warnings: Warning[];
}): Promise<ClaudeContext> {
  const { accounts, registry, homeDir, projects, warnings } = options;
  const primaryDir = claudePrimaryDir(registry, accounts, homeDir);
  const wanted: Omit<SettingsFile, "data">[] = [
    ...(await managedDropIns(options.managedSettings, warnings)).map((file) => ({ file, layer: "managed" as const })),
    { file: options.managedSettings, layer: "managed" },
    { file: path.join(primaryDir, "settings.json"), layer: "user" },
    ...projects.flatMap((project) => [
      // In the home dir, Claude Code's project settings are the user settings; it skips them there.
      ...(isHomeProject(project, homeDir)
        ? []
        : [{ file: projectSettingsFile(project.path), layer: "project" as const, project: project.path }]),
      { file: localSettingsFile(project.path), layer: "local" as const, project: project.path },
    ]),
  ];
  const managedMcpFile = path.join(path.dirname(options.managedSettings), "managed-mcp.json");
  const [read, plugins, managedMcp] = await Promise.all([
    Promise.all(
      wanted.map(async (entry) => {
        const data = await readJsonObject(entry.file, warnings);
        return data ? { ...entry, data } : undefined;
      }),
    ),
    readPluginInstalls(accounts, homeDir, warnings),
    readManagedMcp(managedMcpFile, warnings),
  ]);
  return {
    homeDir,
    ...(options.mcpjsonStop !== undefined ? { mcpjsonStop: options.mcpjsonStop } : {}),
    primaryDir,
    accounts,
    settings: read.filter((s): s is SettingsFile => s !== undefined),
    plugins,
    ...(managedMcp ? { managedMcp } : {}),
    env: options.env ?? {},
  };
}

/**
 * managed-mcp.json, while it is there. Claude Code 2.1.296 gives it control of the MCP servers
 * as long as the file exists, one it cannot read or parse too: then no server starts.
 */
async function readManagedMcp(
  file: string,
  warnings: Warning[],
): Promise<{ file: string; json?: Record<string, unknown> } | undefined> {
  if ((await entryInfo(file)).kind === "missing") return undefined;
  const json = await readJsonObject(file, warnings);
  return { file, ...(json ? { json } : {}) };
}

/**
 * The `*.json` files in `managed-settings.d/` beside the managed file, highest precedence
 * first. The order is systemd-style - files merge in name order, so a later name overrides
 * an earlier one and the base file - and is not verified against Claude Code.
 */
async function managedDropIns(managedSettings: string, warnings: Warning[]): Promise<string[]> {
  const dir = path.join(path.dirname(managedSettings), "managed-settings.d");
  return (await listNames(dir, warnings))
    .filter((name) => name.endsWith(".json"))
    .reverse()
    .map((name) => path.join(dir, name));
}

function pluginScope(entry: Record<string, unknown>, homeDir: string): Pick<PluginInstall, "scope" | "project"> {
  const scope = entry.scope === "project" || entry.scope === "local" ? entry.scope : "user";
  // A plugin installed for the home dir is listed as the user's own: in the home dir Claude
  // Code's project settings are the user settings, and a local install's switch is in
  // ~/.claude/settings.local.json, which is read as the home project's local settings.
  if (scope === "user" || typeof entry.projectPath !== "string" || samePath(entry.projectPath, homeDir)) {
    return { scope: "user" };
  }
  return { scope, project: entry.projectPath };
}

/**
 * Every account's `plugins/installed_plugins.json`. These differ by account: clausona seeds a
 * profile's copy from the primary's once, and installs after that land in one account only.
 * A profile records install paths under its own dir, which link into the primary's cache, so
 * an install is the same in two accounts when its path resolves to the same folder.
 */
async function readPluginInstalls(
  accounts: ClaudeAccount[],
  homeDir: string,
  warnings: Warning[],
): Promise<PluginInstall[]> {
  const files = await Promise.all(
    accounts.map((account) =>
      readJsonObject(path.join(account.configDir, "plugins", "installed_plugins.json"), warnings),
    ),
  );
  const records: { account: ClaudeAccount; id: string; entry: Record<string, unknown>; recorded: string }[] = [];
  for (const [index, account] of accounts.entries()) {
    const json = files[index];
    const plugins = isRecord(json?.plugins) ? json.plugins : {};
    for (const [id, entries] of Object.entries(plugins)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
        records.push({ account, id, entry, recorded: entry.installPath });
      }
    }
  }
  // Every account lists most installs, so there are hundreds of paths to resolve: in parallel,
  // then merged in the accounts' order as before.
  const resolved = await mapLimit(records, IO_LIMIT, ({ recorded }) => realPath(recorded).catch(() => recorded));
  const byKey = new Map<string, PluginInstall>();
  for (const [index, { account, id, entry, recorded }] of records.entries()) {
    const installPath = resolved[index] ?? recorded;
    const where = pluginScope(entry, homeDir);
    const key = [id, pathKey(installPath), where.scope, where.project ? pathKey(where.project) : ""].join("\0");
    const known = byKey.get(key);
    if (known) {
      if (!known.profiles.includes(account.id)) known.profiles.push(account.id);
      continue;
    }
    byKey.set(key, { id, name: id.split("@")[0] ?? id, installPath, ...where, profiles: [account.id] });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope) || (a.project ?? "").localeCompare(b.project ?? ""),
  );
}

const FLAGS: readonly ClaudeFlag[] = ["disableAllHooks", "disableBundledSkills"];

/**
 * Each settings file's `skillOverrides` and `enabledPlugins`, its `disableAllHooks` and
 * `disableBundledSkills` where one is true or false, and its `allowedMcpServers` and
 * `deniedMcpServers`, for `state.ts`.
 */
export function collectClaudeSettingsFacts(ctx: ClaudeContext, out: Collector): void {
  for (const settings of ctx.settings) {
    const where = {
      file: settings.file,
      layer: settings.layer,
      ...(settings.project ? { project: settings.project } : {}),
    };
    if (isRecord(settings.data.skillOverrides)) {
      out.facts.claudeSkillOverrides.push({ ...where, map: settings.data.skillOverrides });
    }
    if (isRecord(settings.data.enabledPlugins)) {
      out.facts.claudeEnabledPlugins.push({ ...where, map: settings.data.enabledPlugins });
    }
    for (const key of FLAGS) {
      const value = settings.data[key];
      if (typeof value === "boolean") out.facts.claudeFlags.push({ ...where, key, value });
    }
    const allowed = mcpRules(settings.data.allowedMcpServers, ctx.env);
    const denied = mcpRules(settings.data.deniedMcpServers, ctx.env);
    // The lock is a managed setting's alone; anywhere else Claude Code ignores it.
    const managedOnly = settings.layer === "managed" && settings.data.allowManagedMcpServersOnly === true;
    if (allowed || denied || managedOnly) {
      out.facts.claudeMcpPolicy.push({
        ...where,
        ...(allowed ? { allowed } : {}),
        ...(denied ? { denied } : {}),
        ...(managedOnly ? { managedOnly: true as const } : {}),
      });
    }
  }
}

/**
 * Whether a profile's entry `name` is the primary's own: the profile is on the primary's dir, or
 * the entry is clausona's shared link to the primary's, read as doctor reads it
 * (`inspectSharedLink`: a link or junction that resolves where the primary's entry does). An
 * entry of the profile's own, or none, is not: Claude Code started with that profile reads its
 * own folder, or nothing, and never the primary's.
 */
export async function sharesPrimaryEntry(account: ClaudeAccount, primaryDir: string, name: string): Promise<boolean> {
  if (account.isPrimary || samePath(account.configDir, primaryDir)) return true;
  const [mine, primary] = await Promise.all([
    realPath(account.configDir).catch(() => undefined),
    realPath(primaryDir).catch(() => undefined),
  ]);
  // A profile dir that is itself a link to the primary's holds the primary's entries.
  if (mine !== undefined && samePath(mine, primary)) return true;
  return (await inspectSharedLink(path.join(account.configDir, name), path.join(primaryDir, name))).pointsToSource;
}
