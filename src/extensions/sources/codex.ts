import path from "node:path";

import { parse } from "smol-toml";

import type { Registry } from "../../types.js";
import type { Collector, Location, Project, Warning } from "../model.js";
import { isHomeProject, type ProjectRecord, recordedPaths } from "../projects.js";
import { isRecord, readJsonObject, readText, realPath, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import { addHooks } from "./claude-hooks.js";
import { readSkillFolders, type SkillLocation } from "./skill-dirs.js";

export type CodexHome = { id: string; dir: string; isPrimary: boolean };

export type CodexContext = {
  homeDir: string;
  primary: CodexHome;
  homes: CodexHome[];
  configFile: string;
  config?: Record<string, unknown>;
};

/**
 * Why a file is not valid TOML, keeping only where. smol-toml's message carries a code block
 * of the text around the error, and in a config.toml that text can be an API key or a token,
 * while a warning reaches the TUI and `--json`.
 */
function invalidToml(error: unknown): string {
  return isRecord(error) && typeof error.line === "number" && typeof error.column === "number"
    ? `is not valid TOML at line ${error.line}, column ${error.column}`
    : "is not valid TOML";
}

/** A TOML file as an object, or undefined when missing; one that does not parse is a warning. */
export async function readTomlObject(file: string, warnings: Warning[]): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file, warnings);
  if (text === undefined) return undefined;
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    warnings.push({ file, message: invalidToml(error) });
    return undefined;
  }
}

/**
 * The Codex homes and the primary's config.toml. Every Codex profile links config.toml,
 * hooks.json and skills/ to the primary's, so the primary's are every account's; a profile
 * whose skills/ is its own is read on its own.
 */
export async function loadCodexContext(
  registry: Registry,
  homeDir: string,
  warnings: Warning[],
): Promise<CodexContext | undefined> {
  const primaryDir = registry.primarySources.codex;
  const homes = Object.entries(registry.profiles)
    .filter(([, profile]) => profile.tool === "codex")
    .map(([id, profile]) => ({
      id,
      dir: profile.configDir,
      isPrimary: profile.isPrimary === true || (primaryDir !== undefined && samePath(profile.configDir, primaryDir)),
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const primary = homes[0];
  if (!primary) return undefined;
  const configFile = path.join(primary.dir, "config.toml");
  const config = await readTomlObject(configFile, warnings);
  return { homeDir, primary, homes, configFile, ...(config ? { config } : {}) };
}

/** The projects Codex has recorded trust for, as one record under the primary. */
export function codexProjectRecords(ctx: CodexContext): ProjectRecord[] {
  return [{ tool: "codex", profile: ctx.primary.id, paths: recordedPaths(ctx.config?.projects) }];
}

/**
 * Codex's skills, MCP servers and hooks, and the switches for them: `[[skills.config]]` in the
 * user config.toml (by name, or by the SKILL.md path - the only per-project skill switch, since
 * Codex ignores `[[skills.config]]` in a project's config; spec, Spike 1), and
 * `mcp_servers.<name>.enabled` in the user and project config.toml. Codex keeps no skill usage
 * on disk that we found, so its skills carry no usage keys.
 */
export async function readCodex(ctx: CodexContext, projects: Project[], out: Collector): Promise<void> {
  const noUsage = { usageKeys: () => [] };
  const global: SkillLocation = { tool: "codex", scope: "global" };
  const jobs: Promise<void>[] = [
    readSkillFolders(path.join(ctx.homeDir, ".agents", "skills"), global, "agents", out, noUsage),
    readSkillFolders(path.join(ctx.primary.dir, "skills"), global, "home", out, noUsage),
    readSkillFolders(
      path.join(ctx.primary.dir, "skills", ".system"),
      { tool: "codex", scope: "builtin" },
      "system",
      out,
      noUsage,
    ),
  ];
  for (const home of ctx.homes) {
    if (home.isPrimary) continue;
    jobs.push(
      (async () => {
        const [mine, primary] = await Promise.all([
          realPath(path.join(home.dir, "skills")).catch(() => undefined),
          realPath(path.join(ctx.primary.dir, "skills")).catch(() => undefined),
        ]);
        if (mine === undefined || samePath(mine, primary)) return;
        await readSkillFolders(
          path.join(home.dir, "skills"),
          { tool: "codex", scope: "account", profile: home.id },
          home.id,
          out,
          noUsage,
        );
      })(),
    );
  }
  for (const project of projects) {
    // The home dir's .agents/skills and .codex/ are the user's own, read above.
    if (isHomeProject(project, ctx.homeDir)) continue;
    const here: SkillLocation = { tool: "codex", scope: "project", project: project.path };
    jobs.push(readSkillFolders(path.join(project.path, ".agents", "skills"), here, project.path, out, noUsage));
    jobs.push(
      (async () => {
        const file = path.join(project.path, ".codex", "config.toml");
        const config = await readTomlObject(file, out.warnings);
        if (config) addServers(config, { ...here, file }, project.path, out);
        const hooksFile = path.join(project.path, ".codex", "hooks.json");
        const hooks = await readJsonObject(hooksFile, out.warnings);
        if (hooks)
          addHooks(isRecord(hooks.hooks) ? hooks.hooks : hooks, { ...here, file: hooksFile }, project.path, out);
      })(),
    );
  }
  jobs.push(
    (async () => {
      const file = path.join(ctx.primary.dir, "hooks.json");
      const hooks = await readJsonObject(file, out.warnings);
      if (hooks) addHooks(isRecord(hooks.hooks) ? hooks.hooks : hooks, { ...global, file }, "-", out);
    })(),
  );
  if (ctx.config) {
    addServers(ctx.config, { ...global, file: ctx.configFile }, "-", out);
    const skills = isRecord(ctx.config.skills) ? ctx.config.skills : undefined;
    for (const entry of Array.isArray(skills?.config) ? skills.config : []) {
      if (!isRecord(entry) || typeof entry.enabled !== "boolean") continue;
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const skillPath = typeof entry.path === "string" ? entry.path : undefined;
      // Codex ignores an entry with neither selector or with both.
      if ((name === undefined) === (skillPath === undefined)) continue;
      out.facts.codexSkillConfig.push({
        file: ctx.configFile,
        ...(name ? { name } : {}),
        ...(skillPath ? { path: skillPath } : {}),
        enabled: entry.enabled,
      });
    }
  }
  await Promise.all(jobs);
}

/**
 * Each `[mcp_servers.<name>]` table: a server when it says how to start one, by `command` or
 * `url`. A table that only sets `enabled` - as a project's config.toml switches a user server
 * off - is that switch alone, for the server of that name, and not a second server.
 */
function addServers(config: Record<string, unknown>, location: Location, owner: string, out: Collector): void {
  for (const [name, server] of Object.entries(isRecord(config.mcp_servers) ? config.mcp_servers : {})) {
    if (!isRecord(server)) continue;
    if (server.command !== undefined || server.url !== undefined) {
      out.items.push({
        id: `mcp:codex:${location.scope}:${owner}:${name}`,
        kind: "mcp",
        name,
        location,
        summary: mcpSummary(server),
      });
    }
    if (typeof server.enabled === "boolean") {
      out.facts.codexMcpEnabled.push({
        file: location.file,
        ...(location.project ? { project: location.project } : {}),
        name,
        enabled: server.enabled,
      });
    }
  }
}
