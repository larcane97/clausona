import path from "node:path";

import type { Collector, Location, Project } from "../model.js";
import { isRecord, pathKey, readJsonObject, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import { type ClaudeContext, pluginOwner } from "./claude-context.js";

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Every MCP server Claude Code can start: each account's user-scope servers and its local ones
 * for each project that still exists (both in that account's `.claude.json`), each project's
 * `.mcp.json`, and each plugin's. Alongside, the switches: `disabledMcpServers` per account and
 * project (what `/mcp disable` writes), and the `.mcp.json` approvals from settings and from
 * the account's project entry.
 */
export async function readClaudeMcp(ctx: ClaudeContext, projects: Project[], out: Collector): Promise<void> {
  const existing = new Map(projects.map((p) => [pathKey(p.path), p.path]));
  for (const account of ctx.accounts) {
    const json = account.json;
    if (!json) continue;
    addServers(
      json.mcpServers,
      { tool: "claude", scope: "account", profile: account.id, file: account.jsonPath },
      account.id,
      out,
    );
    for (const [recorded, entry] of Object.entries(isRecord(json.projects) ? json.projects : {})) {
      const project = existing.get(pathKey(recorded));
      if (!project || !isRecord(entry)) continue;
      addServers(
        entry.mcpServers,
        { tool: "claude", scope: "local", profile: account.id, project, file: account.jsonPath },
        `${account.id}@${project}`,
        out,
      );
      const disabled = stringList(entry.disabledMcpServers);
      if (disabled.length > 0) {
        out.facts.claudeMcpDisabled.push({ file: account.jsonPath, profile: account.id, project, names: disabled });
      }
      pushApprovals(entry, account.jsonPath, project, account.id, out);
    }
  }
  await Promise.all(
    projects.map(async (project) => {
      const file = path.join(project.path, ".mcp.json");
      const json = await readJsonObject(file, out.warnings);
      if (json)
        addServers(
          json.mcpServers,
          { tool: "claude", scope: "project", project: project.path, file },
          project.path,
          out,
        );
    }),
  );
  for (const settings of ctx.settings) {
    if (settings.project && (settings.layer === "project" || settings.layer === "local")) {
      pushApprovals(settings.data, settings.file, settings.project, undefined, out);
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
      if (mcp)
        addServers(isRecord(mcp.mcpServers) ? mcp.mcpServers : mcp, { ...from, file: mcpFile }, owner, out, prefix);
      const manifestFile = path.join(plugin.installPath, ".claude-plugin", "plugin.json");
      const manifest = await readJsonObject(manifestFile, out.warnings);
      if (manifest) addServers(manifest.mcpServers, { ...from, file: manifestFile }, owner, out, prefix);
    }),
  );
}

function addServers(servers: unknown, location: Location, owner: string, out: Collector, prefix = ""): void {
  if (!isRecord(servers)) return;
  for (const [name, config] of Object.entries(servers)) {
    if (!isRecord(config)) continue;
    const full = `${prefix}${name}`;
    out.items.push({
      id: `mcp:claude:${location.scope}:${owner}:${full}`,
      kind: "mcp",
      name: full,
      location,
      summary: mcpSummary(config),
    });
  }
}

function pushApprovals(
  entry: Record<string, unknown>,
  file: string,
  project: string,
  profile: string | undefined,
  out: Collector,
): void {
  const enabled = stringList(entry.enabledMcpjsonServers);
  const disabled = stringList(entry.disabledMcpjsonServers);
  const enableAll = entry.enableAllProjectMcpServers === true;
  if (enabled.length === 0 && disabled.length === 0 && !enableAll) return;
  const existing = out.facts.claudeMcpjson.find((a) => a.file === file && samePath(a.project, project));
  if (existing) return;
  out.facts.claudeMcpjson.push({ file, project, ...(profile ? { profile } : {}), enabled, disabled, enableAll });
}
