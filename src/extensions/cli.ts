import path from "node:path";

import { truncate } from "../lib/cli-style.js";
import type { Registry, ToolName } from "../types.js";
import { duplicateGroups, loadInventory, marksOf, usageOf } from "./inventory.js";
import type { Extension, Inventory, Kind } from "./model.js";
import { accountStates, stateHere, tilde, tildeIn, whereLabel } from "./present.js";
import { entryInfo } from "./read.js";
import { relevantIn } from "./state.js";

export type ExtensionsCommand = "skills" | "mcp" | "hooks";

const KIND: Record<ExtensionsCommand, Kind> = { skills: "skill", mcp: "mcp", hooks: "hook" };
export const EXTENSIONS_VALUE_FLAGS = ["--project", "--tool", "--filter"];
export const EXTENSIONS_FLAGS = ["--json", "--all-projects", ...EXTENSIONS_VALUE_FLAGS];
const FILTERS = ["cleanup", "duplicates", "off"] as const;
type ListFilter = (typeof FILTERS)[number];

/** The usage in two parts, so help can put the second under the first in 100 columns. */
export function usageParts(command: ExtensionsCommand): [string, string] {
  return [
    `clausona ${command} ls [--json] [--project <path> | --all-projects]`,
    "[--tool claude|codex] [--filter cleanup|duplicates|off]",
  ];
}

export function usageLine(command: ExtensionsCommand): string {
  return usageParts(command).join(" ");
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

function stateWord(inv: Inventory, item: Extension, project: string | undefined): string {
  const byAccount = accountStates(inv, item, project);
  if (byAccount) {
    const first = byAccount[0]?.state.value;
    if (first !== undefined && byAccount.every((a) => a.state.value === first)) return first;
    return `${byAccount.filter((a) => a.state.value === "on").length}/${byAccount.length} on`;
  }
  // The value as the settings have it, even for a shadowed copy: NOTES says it is shadowed.
  return stateHere(inv, item, project).value;
}

/** Off in at least one account, for a server read per account - as the dashboard's Off filter has it. */
function isOff(inv: Inventory, item: Extension, project: string | undefined): boolean {
  const byAccount = accountStates(inv, item, project);
  return byAccount ? byAccount.some((a) => a.state.value === "off") : stateHere(inv, item, project).value === "off";
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
    if (options.filter === "off") return isOff(inv, item, project);
    return true;
  });
}

const NOUN: Record<ExtensionsCommand, { one: string; many: string }> = {
  skills: { one: "skill", many: "skills" },
  mcp: { one: "MCP server", many: "MCP servers" },
  hooks: { one: "hook", many: "hooks" },
};

function seenFrom(options: ListOptions, project: string | undefined, homeDir: string): string {
  if (options.allProjects) return "all projects";
  return project ? `project ${tilde(project, homeDir)}` : "no project";
}

function nothingToList(command: ExtensionsCommand, options: ListOptions): string {
  if (options.filter) return `Nothing matches --filter ${options.filter} here.`;
  if (options.allProjects) return "Nothing found in any project.";
  // Pointing at --all-projects would mislead when it is the tool that left nothing.
  if (options.tool) return `No ${options.tool} ${NOUN[command].many} here.`;
  return "Nothing loads here. Add --all-projects to include every project's own.";
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
  // Without the check, a mistyped path would quietly become the project the list is seen from.
  // The path is not echoed back, as no option's value is.
  if (options.project !== undefined && (await entryInfo(options.project)).kind !== "dir") {
    throw new Error("--project: no such directory.");
  }
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
        items: items.map((item) => {
          const byAccount = accountStates(inv, item, project);
          return {
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
            state: stateHere(inv, item, project),
            ...(byAccount
              ? {
                  stateByAccount: byAccount.map(({ profile, state }) => ({
                    profile,
                    value: state.value,
                    ...(state.setBy ? { setBy: state.setBy } : {}),
                  })),
                }
              : {}),
            usage: usageOf(inv, [item]) ?? null,
            marks: marksOf(inv, item, now, project),
          };
        }),
        warnings: inv.warnings,
      },
      null,
      2,
    );
  }

  const noun = items.length === 1 ? NOUN[command].one : NOUN[command].many;
  const lines = [`${items.length} ${noun} · ${seenFrom(options, project, deps.homeDir)}`, ""];
  if (items.length === 0) {
    lines.push(nothingToList(command, options));
  } else {
    const hooks = command === "hooks";
    const skills = command === "skills";
    const header = [
      "NAME",
      "TOOL",
      "WHERE",
      ...(hooks ? ["COMMAND"] : []),
      "STATE",
      ...(skills ? ["USED"] : []),
      "NOTES",
    ];
    const rows = items.map((item) => {
      const usage = usageOf(inv, [item]);
      return [
        item.name,
        item.location.tool,
        whereLabel(item, inv),
        // Already redacted when read: a hook's summary passes its command line through redactCommand.
        ...(hooks ? [tildeIn(item.summary?.command ?? item.summary?.prompt ?? "", inv.homeDir)] : []),
        stateWord(inv, item, project),
        ...(skills ? [item.location.tool === "claude" ? String(usage?.total ?? 0) : "—"] : []),
        marksOf(inv, item, now, project).join(", "),
      ];
    });
    // A hook's name is short and its matcher is what tells it apart; its command line is the
    // long cell, so it gives way first.
    const giveWay = hooks ? [3, 0, 2] : [0, 2];
    lines.push(...table([header, ...rows], deps.columns ?? process.stdout.columns ?? 120, giveWay));
  }
  if (inv.warnings.length > 0) {
    // A warning's message is a fixed phrase plus a position, never the file's contents.
    lines.push(
      "",
      "Could not read every file:",
      ...inv.warnings.map((w) => `  ${tilde(w.file, deps.homeDir)}: ${w.message}`),
    );
  }
  return lines.join("\n");
}

/**
 * Columns padded to their widest cell. When the terminal is narrow, the `giveWay` columns are
 * cut in turn, each to no less than 12 characters, until the row fits.
 */
function table(rows: string[][], width: number, giveWay: number[]): string[] {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const gap = 2;
  let total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  for (const column of giveWay) {
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
