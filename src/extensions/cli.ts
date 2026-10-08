import path from "node:path";

import { truncate } from "../lib/cli-style.js";
import type { Registry, ToolName } from "../types.js";
import { duplicateGroups, loadInventory, marksOf, usageOf } from "./inventory.js";
import type { Extension, Inventory, Kind } from "./model.js";
import { samePath } from "./read.js";
import { relevantIn, stateOf } from "./state.js";

export type ExtensionsCommand = "skills" | "mcp" | "hooks";

const KIND: Record<ExtensionsCommand, Kind> = { skills: "skill", mcp: "mcp", hooks: "hook" };
export const EXTENSIONS_VALUE_FLAGS = ["--project", "--tool", "--filter"];
export const EXTENSIONS_FLAGS = ["--json", "--all-projects", ...EXTENSIONS_VALUE_FLAGS];
const FILTERS = ["cleanup", "duplicates", "off"] as const;
type ListFilter = (typeof FILTERS)[number];

export function usageLine(command: ExtensionsCommand): string {
  return `clausona ${command} ls [--json] [--project <path> | --all-projects] [--tool claude|codex] [--filter cleanup|duplicates|off]`;
}

type ListOptions = { json: boolean; allProjects: boolean; project?: string; tool?: ToolName; filter?: ListFilter };

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
    return value;
  }
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function parseListArgs(args: string[], cwd: string): ListOptions {
  const project = flagValue(args, "--project");
  const tool = flagValue(args, "--tool");
  const filter = flagValue(args, "--filter");
  const allProjects = args.includes("--all-projects");
  if (tool !== undefined && tool !== "claude" && tool !== "codex") throw new Error("--tool takes claude or codex.");
  if (filter !== undefined && !(FILTERS as readonly string[]).includes(filter)) {
    throw new Error("--filter takes cleanup, duplicates or off.");
  }
  if (allProjects && project !== undefined) throw new Error("Give either --project or --all-projects, not both.");
  return {
    json: args.includes("--json"),
    allProjects,
    ...(project !== undefined ? { project: path.resolve(cwd, project) } : {}),
    ...(tool !== undefined ? { tool: tool as ToolName } : {}),
    ...(filter !== undefined ? { filter: filter as ListFilter } : {}),
  };
}

const SCOPE_WORD = {
  global: "global",
  account: "account",
  project: "project",
  local: "local",
  plugin: "plugin",
  synced: "claude.ai",
  builtin: "built-in",
  managed: "managed",
} as const;

/** A profile id without its tool: `claude:work` is `work`. */
export function shortProfile(id: string): string {
  return id.replace(/^(claude|codex):/, "");
}

/** `~` for the home dir, only where a path starts with it. */
function tilde(p: string, homeDir: string): string {
  if (p === homeDir) return "~";
  return p.startsWith(homeDir + path.sep) ? `~${p.slice(homeDir.length)}` : p;
}

/** Where an item is defined, in a few words: `project app`, `local work · app`, `plugin superpowers`. */
export function whereLabel(item: Extension): string {
  const loc = item.location;
  const parts: string[] = [SCOPE_WORD[loc.scope]];
  if (loc.scope === "plugin" && loc.plugin) parts.push(loc.plugin.split("@")[0] ?? loc.plugin);
  else if (loc.profile) parts.push(shortProfile(loc.profile));
  if (loc.project && loc.scope !== "plugin") parts.push(`${loc.profile ? "· " : ""}${path.basename(loc.project)}`);
  return parts.join(" ");
}

/**
 * A Claude MCP server that every account opening the project sees (.mcp.json, plugin) is read
 * per account. Only the accounts that can load it count: Claude accounts, and for a plugin's
 * server the ones with the plugin installed. Codex records projects too, but never loads a
 * Claude server.
 */
function stateWord(inv: Inventory, item: Extension, project: string | undefined): string {
  if (item.kind === "mcp" && item.location.tool === "claude" && item.location.profile === undefined && project) {
    const accounts =
      item.location.scope === "plugin" && item.location.accounts ? item.location.accounts : inv.claudeProfiles;
    const profiles = (inv.projects.find((p) => samePath(p.path, project))?.profiles ?? []).filter((profile) =>
      accounts.includes(profile),
    );
    const values = profiles.map((profile) => stateOf(inv, item, project, profile).value);
    const unique = [...new Set(values)];
    if (unique.length > 1) return `${values.filter((v) => v === "on").length}/${values.length} on`;
    if (unique[0]) return unique[0];
  }
  const state = stateOf(inv, item, project);
  return state.shadowedBy ? "shadowed" : state.value;
}

function select(
  inv: Inventory,
  command: ExtensionsCommand,
  options: ListOptions,
  project: string | undefined,
  now: number,
) {
  const kind = KIND[command];
  const duplicates = new Set(
    duplicateGroups(inv.items)
      .flat()
      .map((i) => i.id),
  );
  return inv.items.filter((item) => {
    if (item.kind !== kind) return false;
    if (options.tool && item.location.tool !== options.tool) return false;
    if (!options.allProjects && !relevantIn(item, project)) return false;
    if (options.filter === "cleanup") return marksOf(inv, item, now).includes("cleanup");
    if (options.filter === "duplicates") return duplicates.has(item.id);
    if (options.filter === "off") return stateOf(inv, item, project).value === "off";
    return true;
  });
}

/** `clausona skills|mcp|hooks ls`: the inventory, filtered, as a table or JSON. */
export async function runExtensionsCommand(
  command: ExtensionsCommand,
  args: string[],
  deps: { homeDir: string; cwd: string; registry: Registry; now?: number; columns?: number },
): Promise<string> {
  const [sub, ...rest] = args[0] !== undefined && !args[0].startsWith("-") ? args : ["ls", ...args];
  if (sub !== "ls") throw new Error(`Unknown subcommand '${sub}'. Usage: ${usageLine(command)}`);
  const options = parseListArgs(rest, deps.cwd);
  const inv = await loadInventory({ homeDir: deps.homeDir, registry: deps.registry, cwd: options.project ?? deps.cwd });
  const project = inv.currentProject;
  const now = deps.now ?? Date.now();
  const items = select(inv, command, options, project, now);

  if (options.json) {
    return JSON.stringify(
      {
        kind: KIND[command],
        currentProject: project ?? null,
        projects: inv.projects,
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          tool: item.location.tool,
          name: item.name,
          scope: item.location.scope,
          file: item.location.file,
          ...(item.location.profile ? { profile: item.location.profile } : {}),
          ...(item.location.project ? { project: item.location.project } : {}),
          ...(item.location.plugin ? { plugin: item.location.plugin } : {}),
          ...(item.location.accounts ? { accounts: item.location.accounts } : {}),
          ...(item.description ? { description: item.description } : {}),
          ...(item.link ? { link: item.link } : {}),
          ...(item.summary ? { summary: item.summary } : {}),
          state: stateOf(inv, item, project),
          usage: usageOf(inv, [item]) ?? null,
          marks: marksOf(inv, item, now),
        })),
        warnings: inv.warnings,
      },
      null,
      2,
    );
  }

  const header = ["NAME", "TOOL", "WHERE", "STATE", ...(command === "skills" ? ["USED"] : []), "NOTES"];
  const rows = items.map((item) => {
    const usage = usageOf(inv, [item]);
    return [
      item.name,
      item.location.tool,
      whereLabel(item),
      stateWord(inv, item, project),
      ...(command === "skills" ? [item.location.tool === "claude" ? String(usage?.total ?? 0) : "—"] : []),
      marksOf(inv, item, now).join(", "),
    ];
  });
  const width = deps.columns ?? process.stdout.columns ?? 120;
  const title = `${items.length} ${command === "skills" ? "skills" : command === "mcp" ? "MCP servers" : "hooks"} · ${
    options.allProjects ? "all projects" : project ? `project ${tilde(project, deps.homeDir)}` : "no project"
  }`;
  const lines = [title, "", ...table([header, ...rows], width)];
  if (inv.warnings.length > 0)
    lines.push("", `${inv.warnings.length} file(s) could not be read — see --json for which.`);
  return lines.join("\n");
}

/** Columns padded to their widest cell; NAME and WHERE give way first when the terminal is narrow. */
function table(rows: string[][], width: number): string[] {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const gap = 2;
  let total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  for (const column of [0, 2]) {
    if (total <= width) break;
    const cut = Math.min(total - width, Math.max(0, (widths[column] ?? 0) - 12));
    widths[column] = (widths[column] ?? 0) - cut;
    total -= cut;
  }
  return rows.map((row) =>
    row
      .map((cell, c) => truncate(cell, widths[c] ?? cell.length).padEnd(widths[c] ?? 0))
      .join(" ".repeat(gap))
      .trimEnd(),
  );
}
