import path from "node:path";

import { valueHash } from "../hash.js";
import type { Collector, Location, Project } from "../model.js";
import { isRecord, isWithin, pathKey, readJsonObject, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import { type ClaudeContext, pluginOwner } from "./claude-context.js";

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Every MCP server Claude Code can start: each account's user-scope servers and its local ones
 * for each project that still exists (both in that account's `.claude.json`), the `.mcp.json`
 * of each project and of each dir above it (see `mcpjsonDirs`), and each plugin's. Alongside, the switches: `disabledMcpServers` per account and
 * project (what `/mcp disable` writes), and the `.mcp.json` approvals from settings - a
 * project's, or the user's and managed ones for every project - and from the account's project
 * entry. A server id is kept once, the first definition winning.
 */
export async function readClaudeMcp(ctx: ClaudeContext, projects: Project[], out: Collector): Promise<void> {
  const existing = new Map(projects.map((p) => [pathKey(p.path), p.path]));
  const ids = new Set<string>();
  for (const account of ctx.accounts) {
    const json = account.json;
    if (!json) continue;
    addServers(
      json.mcpServers,
      { tool: "claude", scope: "account", profile: account.id, file: account.jsonPath },
      account.id,
      out,
      ids,
    );
    for (const [project, entry] of projectEntries(json.projects, existing)) {
      addServers(
        entry.mcpServers,
        { tool: "claude", scope: "local", profile: account.id, project, file: account.jsonPath },
        `${account.id}@${project}`,
        out,
        ids,
      );
      const disabled = stringList(entry.disabledMcpServers);
      if (disabled.length > 0) {
        out.facts.claudeMcpDisabled.push({ file: account.jsonPath, profile: account.id, project, names: disabled });
      }
      pushApprovals(entry, account.jsonPath, project, account.id, out);
    }
  }
  await Promise.all(
    mcpjsonDirs(projects, ctx.homeDir).map(async (dir) => {
      const file = path.join(dir, ".mcp.json");
      const json = await readJsonObject(file, out.warnings);
      if (json) addServers(json.mcpServers, { tool: "claude", scope: "project", project: dir, file }, dir, out, ids);
    }),
  );
  for (const settings of ctx.settings) {
    if (settings.project && (settings.layer === "project" || settings.layer === "local")) {
      pushApprovals(settings.data, settings.file, settings.project, undefined, out);
    } else if (settings.layer === "user" || settings.layer === "managed") {
      pushApprovals(settings.data, settings.file, undefined, undefined, out);
    }
  }
  await Promise.all(
    ctx.plugins.map(async (plugin) => {
      const from = {
        tool: "claude" as const,
        scope: "plugin" as const,
        plugin: plugin.id,
        ...(plugin.project ? { project: plugin.project } : {}),
        accounts: plugin.profiles,
      };
      // Named as `disabledMcpServers` records a plugin's server, so the switch finds it.
      const prefix = `plugin:${plugin.name}:`;
      const owner = pluginOwner(plugin);
      const mcpFile = path.join(plugin.installPath, ".mcp.json");
      const mcp = await readJsonObject(mcpFile, out.warnings);
      // The manifest is read second, so a server it defines again keeps the .mcp.json one.
      if (mcp)
        addServers(
          isRecord(mcp.mcpServers) ? mcp.mcpServers : mcp,
          { ...from, file: mcpFile },
          owner,
          out,
          ids,
          prefix,
        );
      const manifestFile = path.join(plugin.installPath, ".claude-plugin", "plugin.json");
      const manifest = await readJsonObject(manifestFile, out.warnings);
      if (manifest) addServers(manifest.mcpServers, { ...from, file: manifestFile }, owner, out, ids, prefix);
    }),
  );
}

/**
 * The dirs whose `.mcp.json` a project's sessions read, each once: Claude Code 2.1.294 reads the
 * file in the dir it starts in and in each parent dir up to the filesystem root, the nearest
 * winning a name. For a project inside the home dir the walk here stops at the home dir: a
 * .mcp.json above it - in /Users or C:\Users, shared by every user - is not read, which also
 * keeps a test home in the temp dir, under the real home on Windows, from reading the real one.
 */
function mcpjsonDirs(projects: Project[], homeDir: string): string[] {
  const dirs = new Map<string, string>();
  for (const project of projects) {
    const inHome = isWithin(project.path, homeDir);
    for (let dir = path.resolve(project.path); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (!dirs.has(pathKey(dir))) dirs.set(pathKey(dir), dir === path.resolve(project.path) ? project.path : dir);
      if (inHome && samePath(dir, homeDir)) break;
    }
  }
  return [...dirs.values()];
}

/**
 * An account's `projects` entries for the projects that still exist, each project once. The map
 * can hold one project under two keys - one with a trailing slash, or, on Windows, in another
 * case - and then the key that is the project's path as known wins, else the first.
 */
function projectEntries(projects: unknown, existing: Map<string, string>): [string, Record<string, unknown>][] {
  const byProject = new Map<string, Record<string, unknown>>();
  for (const [recorded, entry] of Object.entries(isRecord(projects) ? projects : {})) {
    const project = existing.get(pathKey(recorded));
    if (!project || !isRecord(entry)) continue;
    if (!byProject.has(project) || recorded === project) byProject.set(project, entry);
  }
  return [...byProject];
}

function addServers(
  servers: unknown,
  location: Location,
  owner: string,
  out: Collector,
  ids: Set<string>,
  prefix = "",
): void {
  if (!isRecord(servers)) return;
  for (const [name, config] of Object.entries(servers)) {
    if (!isRecord(config)) continue;
    const full = `${prefix}${name}`;
    const id = `mcp:claude:${location.scope}:${owner}:${full}`;
    if (ids.has(id)) continue;
    ids.add(id);
    out.items.push({ id, kind: "mcp", name: full, location, summary: mcpSummary(config) });
    out.facts.fingerprints[id] = valueHash(config);
  }
}

/** One file's `.mcp.json` approvals; `project` absent for user and managed settings, which apply to every project. */
function pushApprovals(
  entry: Record<string, unknown>,
  file: string,
  project: string | undefined,
  profile: string | undefined,
  out: Collector,
): void {
  const enabled = stringList(entry.enabledMcpjsonServers);
  const disabled = stringList(entry.disabledMcpjsonServers);
  const enableAll = entry.enableAllProjectMcpServers === true;
  if (enabled.length === 0 && disabled.length === 0 && !enableAll) return;
  const known = out.facts.claudeMcpjson.some(
    (a) => a.file === file && (a.project === undefined ? project === undefined : samePath(a.project, project)),
  );
  if (known) return;
  out.facts.claudeMcpjson.push({
    file,
    ...(project ? { project } : {}),
    ...(profile ? { profile } : {}),
    enabled,
    disabled,
    enableAll,
  });
}
