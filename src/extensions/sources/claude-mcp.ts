import path from "node:path";

import { valueHash } from "../hash.js";
import { mcpTarget } from "../mcp-policy.js";
import type { Collector, Location, Project } from "../model.js";
import { isRecord, pathKey, readJsonObject, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import {
  type ClaudeContext,
  declared,
  insidePlugin,
  type McpEnvs,
  pluginLocation,
  pluginManifestFile,
  pluginOwner,
} from "./claude-context.js";

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Every MCP server Claude Code can start: each account's user-scope servers and its local ones
 * for each project that still exists (both in that account's `.claude.json`), the `.mcp.json`
 * of each project and of each dir above it (see `mcpjsonDirs`), managed-mcp.json's, the
 * `managedMcpServers` of managed settings, and each plugin's. Alongside, the switches:
 * `disabledMcpServers` per account and
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
      ctx.mcpEnv,
    );
    for (const [project, entry] of projectEntries(json.projects, existing)) {
      addServers(
        entry.mcpServers,
        { tool: "claude", scope: "local", profile: account.id, project, file: account.jsonPath },
        `${account.id}@${project}`,
        out,
        ids,
        ctx.mcpEnv,
      );
      const disabled = stringList(entry.disabledMcpServers);
      if (disabled.length > 0) {
        out.facts.claudeMcpDisabled.push({ file: account.jsonPath, profile: account.id, project, names: disabled });
      }
      pushApprovals(entry, account.jsonPath, project, account.id, out);
    }
  }
  await Promise.all(
    mcpjsonDirs(projects, ctx.mcpjsonStop).map(async (dir) => {
      const file = path.join(dir, ".mcp.json");
      const json = await readJsonObject(file, out.warnings);
      if (json) {
        addServers(
          json.mcpServers,
          { tool: "claude", scope: "project", project: dir, file },
          dir,
          out,
          ids,
          ctx.mcpEnv,
        );
      }
    }),
  );
  // managed-mcp.json takes the same shape as a project's .mcp.json.
  if (ctx.managedMcp) {
    const { file, json } = ctx.managedMcp;
    out.facts.claudeManagedMcp = file;
    if (json) addServers(json.mcpServers, { tool: "claude", scope: "managed", file }, "-", out, ids, ctx.mcpEnv);
  }
  // Managed settings come highest first, so the first file to name a server is the one whose
  // entry Claude Code takes, whole.
  for (const settings of ctx.settings) {
    if (settings.layer !== "managed" || !isRecord(settings.data.managedMcpServers)) continue;
    const delivered = Object.entries(settings.data.managedMcpServers).filter(([name, config]) =>
      deliverable(name, config),
    );
    addServers(
      Object.fromEntries(delivered),
      { tool: "claude", scope: "managed", file: settings.file },
      "settings",
      out,
      ids,
      ctx.mcpEnv,
    );
  }
  for (const settings of ctx.settings) {
    if (settings.project && (settings.layer === "project" || settings.layer === "local")) {
      pushApprovals(settings.data, settings.file, settings.project, undefined, out);
    } else if (settings.layer === "user" || settings.layer === "managed") {
      pushApprovals(settings.data, settings.file, undefined, undefined, out);
    }
  }
  await Promise.all(
    ctx.plugins.map(async (plugin) => {
      const from = pluginLocation(plugin);
      // Named as `disabledMcpServers` records a plugin's server, so the switch finds it.
      const prefix = `plugin:${plugin.name}:`;
      const owner = pluginOwner(plugin);
      // Claude Code 2.1.296 reads the plugin's .mcp.json, then what the manifest declares, in its
      // order - inline servers, and the .json files of servers it names - and a server name
      // declared later replaces an earlier one.
      const declarations: { servers: unknown; file: string }[] = [];
      const mcpFile = path.join(plugin.installPath, ".mcp.json");
      const mcp = await readJsonObject(mcpFile, out.warnings);
      if (mcp) declarations.push({ servers: serversIn(mcp), file: mcpFile });
      const manifestFile = pluginManifestFile(plugin);
      const manifest = await readJsonObject(manifestFile, out.warnings);
      for (const entry of declared(manifest, "mcpServers")) {
        if (typeof entry !== "string") {
          declarations.push({ servers: entry, file: manifestFile });
          continue;
        }
        // An MCP bundle (.mcpb, .dxt) or its URL is unpacked by Claude Code: nothing to read here.
        if (!entry.toLowerCase().endsWith(".json") || /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) continue;
        const file = await insidePlugin(plugin, entry);
        const json = file === undefined ? undefined : await readJsonObject(file, out.warnings);
        if (file !== undefined && json) declarations.push({ servers: serversIn(json), file });
      }
      const last = new Map<string, { config: unknown; file: string }>();
      for (const { servers, file } of declarations) {
        if (!isRecord(servers)) continue;
        for (const [name, config] of Object.entries(servers)) {
          if (isRecord(config)) last.set(name, { config, file });
        }
      }
      for (const [name, { config, file }] of last) {
        addServers({ [name]: config }, { ...from, file }, owner, out, ids, ctx.mcpEnv, {
          prefix,
          root: plugin.installPath,
        });
      }
    }),
  );
}

/** The keys of a server that runs a program, which managed settings may not deliver. */
const RUNS_A_PROGRAM = ["command", "args", "env", "headersHelper"];
const REMOTE_TYPES: ReadonlySet<unknown> = new Set(["http", "streamable-http", "sse"]);
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;

/** Each string in `value` with whether it is a key, to a depth of four, as Claude Code walks an entry. */
function strings(value: unknown, depth = 0): { text: string; key: boolean }[] {
  if (typeof value === "string") return [{ text: value, key: false }];
  if (depth > 4 || value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [{ text: key, key: true }, ...strings(inner, depth + 1)]);
}

/**
 * Whether Claude Code 2.1.296 starts a server of managed settings' `managedMcpServers`: a name of
 * letters, digits, `-` and `_` (and not `__proto__`, `constructor` or `prototype`), and a remote
 * server only - an `http`, `streamable-http` or `sse` type on an `https://` URL, nothing that runs
 * a program, no `${VAR}` in a value and no control character anywhere. It drops any other entry.
 */
function deliverable(name: string, config: unknown): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return false;
  if (!isRecord(config) || RUNS_A_PROGRAM.some((key) => Object.hasOwn(config, key))) return false;
  if (!REMOTE_TYPES.has(config.type) || typeof config.url !== "string") return false;
  try {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.hostname === "") return false;
  } catch {
    return false;
  }
  if (config.headers !== undefined && !(isRecord(config.headers) && Object.values(config.headers).every(isString)))
    return false;
  return strings(config).every(({ text, key }) => !CONTROL.test(text) && (key || !VARIABLE.test(text)));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** A plugin's file of servers: an `mcpServers` map, as `.mcp.json` has, or the map itself. */
function serversIn(json: Record<string, unknown>): unknown {
  return isRecord(json.mcpServers) ? json.mcpServers : json;
}

/**
 * The dirs whose `.mcp.json` a project's sessions read, each once: Claude Code 2.1.296 reads the
 * file in the dir it starts in and in each parent dir up to the filesystem root, the root left
 * out, the nearest winning a name. So a `.mcp.json` in /Users or C:\Users, above the home dir,
 * counts too. `stop`, which only tests set, ends the walk at their home.
 */
function mcpjsonDirs(projects: Project[], stop: string | undefined): string[] {
  const dirs = new Map<string, string>();
  for (const project of projects) {
    for (let dir = path.resolve(project.path); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (!dirs.has(pathKey(dir))) dirs.set(pathKey(dir), dir === path.resolve(project.path) ? project.path : dir);
      if (samePath(dir, stop)) break;
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

/**
 * Each server of `servers`, as one item, unless its id is in `ids` already: with its fingerprint,
 * and what it starts expanded from `envs.servers` (mcpTarget), and in each project with an `env`
 * of its own, where that differs. A plugin's server goes by `plugin.prefix` and its name, and
 * reads the plugin's folder, `plugin.root`.
 */
function addServers(
  servers: unknown,
  location: Location,
  owner: string,
  out: Collector,
  ids: Set<string>,
  envs: McpEnvs,
  plugin?: { prefix: string; root: string },
): void {
  if (!isRecord(servers)) return;
  for (const [name, config] of Object.entries(servers)) {
    if (!isRecord(config)) continue;
    const full = `${plugin?.prefix ?? ""}${name}`;
    const id = `mcp:claude:${location.scope}:${owner}:${full}`;
    if (ids.has(id)) continue;
    ids.add(id);
    out.items.push({ id, kind: "mcp", name: full, location, summary: mcpSummary(config) });
    out.facts.fingerprints[id] = valueHash(config);
    const target = mcpTarget(config, envs.servers, plugin?.root);
    out.facts.mcpTargets[id] = target;
    for (const { project, env } of envs.projects) {
      const there = mcpTarget(config, env, plugin?.root);
      if (JSON.stringify(there) === JSON.stringify(target)) continue;
      const key = pathKey(project);
      out.facts.mcpTargetsIn[key] = { ...out.facts.mcpTargetsIn[key], [id]: there };
    }
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
