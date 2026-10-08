import { realpath } from "node:fs/promises";
import path from "node:path";

import { claudeJsonPathForConfigDir } from "../../core/paths.js";
import type { Registry } from "../../types.js";
import type { Collector, Project, SettingsLayer, Warning } from "../model.js";
import { isRecord, readJsonObject, samePath } from "../read.js";

export type ClaudeAccount = {
  id: string;
  configDir: string;
  jsonPath: string;
  json?: Record<string, unknown>;
  isPrimary: boolean;
};

export type SettingsFile = { file: string; layer: SettingsLayer; project?: string; data: Record<string, unknown> };

export type PluginInstall = { id: string; name: string; installPath: string; project?: string };

export type ClaudeContext = {
  homeDir: string;
  primaryDir: string;
  accounts: ClaudeAccount[];
  settings: SettingsFile[];
  plugins: PluginInstall[];
};

/** Where Claude Code reads organisation policy on each platform. */
export function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
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
 * The settings files Claude Code reads and the plugins installed into the primary. One user
 * `settings.json` stands for every account: clausona links each profile's to the primary's.
 */
export async function loadClaudeContext(options: {
  accounts: ClaudeAccount[];
  registry: Registry;
  homeDir: string;
  projects: Project[];
  managedSettings: string;
  warnings: Warning[];
}): Promise<ClaudeContext> {
  const { accounts, registry, homeDir, projects, warnings } = options;
  const primaryDir =
    registry.primarySources.claude ?? accounts.find((a) => a.isPrimary)?.configDir ?? path.join(homeDir, ".claude");
  const wanted: Omit<SettingsFile, "data">[] = [
    { file: options.managedSettings, layer: "managed" },
    { file: path.join(primaryDir, "settings.json"), layer: "user" },
    ...projects.flatMap((project) => [
      { file: path.join(project.path, ".claude", "settings.json"), layer: "project" as const, project: project.path },
      {
        file: path.join(project.path, ".claude", "settings.local.json"),
        layer: "local" as const,
        project: project.path,
      },
    ]),
  ];
  const read = await Promise.all(
    wanted.map(async (entry) => {
      const data = await readJsonObject(entry.file, warnings);
      return data ? { ...entry, data } : undefined;
    }),
  );
  return {
    homeDir,
    primaryDir,
    accounts,
    settings: read.filter((s): s is SettingsFile => s !== undefined),
    plugins: await readPluginInstalls(primaryDir, homeDir, warnings),
  };
}

/**
 * The primary's `plugins/installed_plugins.json`. clausona keeps every profile's copy in step
 * with it, so the primary's list is every account's. A plugin installed for the home dir as a
 * "project" is the user's own: the home dir is not a project here.
 */
async function readPluginInstalls(primaryDir: string, homeDir: string, warnings: Warning[]): Promise<PluginInstall[]> {
  const json = await readJsonObject(path.join(primaryDir, "plugins", "installed_plugins.json"), warnings);
  const plugins = isRecord(json?.plugins) ? json.plugins : {};
  const out: PluginInstall[] = [];
  for (const [id, entries] of Object.entries(plugins)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
      const project =
        entry.scope === "project" && typeof entry.projectPath === "string" && !samePath(entry.projectPath, homeDir)
          ? entry.projectPath
          : undefined;
      out.push({ id, name: id.split("@")[0] ?? id, installPath: entry.installPath, ...(project ? { project } : {}) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Each settings file's `skillOverrides` and `enabledPlugins`, for `state.ts`. */
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
  }
}

/** Whether a profile's entry `name` is the primary's own, through clausona's shared link. */
export async function sharesPrimaryEntry(account: ClaudeAccount, primaryDir: string, name: string): Promise<boolean> {
  if (samePath(account.configDir, primaryDir)) return true;
  const [mine, primary] = await Promise.all([
    realpath(path.join(account.configDir, name)).catch(() => undefined),
    realpath(path.join(primaryDir, name)).catch(() => undefined),
  ]);
  return mine !== undefined && samePath(mine, primary);
}
