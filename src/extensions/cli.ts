import path from "node:path";

import { accent, bold, dim, helpUsage, truncate } from "../lib/cli-style.js";
import type { Registry, ToolName } from "../types.js";
import { agoWords, type DetailLine, detailsOf, fromLabel, hookWhen, jsonItem, tagsOf } from "./describe.js";
import { ExitError } from "./exit-error.js";
import { CLEANUP_UNUSED_DAYS, loadInventory, usageOf } from "./inventory.js";
import type { Extension, Inventory } from "./model.js";
import { projectName, shortProfile, tilde, tildeIn } from "./present.js";
import { entryInfo } from "./read.js";
import {
  homeScope,
  type ItemKind,
  isAccountCopy,
  isAccountServer,
  otherProjects,
  rowKey,
  rowsIn,
  SCOPE_LABEL,
  type ScopeId,
  type ScopeRow,
} from "./scopes.js";

/**
 * `clausona skills|mcp|hooks ls|show`: the rows of one scope as a table or JSON v1, and one row's
 * details. Read-only, like the screen: it reads the inventory and prints what describe.ts says.
 */

export type ExtensionsCommand = "skills" | "mcp" | "hooks";

const KIND: Record<ExtensionsCommand, ItemKind> = { skills: "skill", mcp: "mcp", hooks: "hook" };
const TOOLS: readonly ToolName[] = ["claude", "codex"];
const TOOL_NAME: Record<ToolName, string> = { claude: "Claude Code", codex: "Codex" };

export const EXTENSIONS_VALUE_FLAGS = ["--scope", "--tool", "--project", "--id", "--account"];
export const EXTENSIONS_FLAGS = ["--json", "--help", ...EXTENSIONS_VALUE_FLAGS];

type Scope = ScopeId | "all";

const EVERY_SCOPE: readonly Scope[] = [
  "loaded",
  "project",
  "parents",
  "global",
  "cloud",
  "plugins",
  "builtin",
  "managed",
  "other",
  "unused",
  "all",
];

/** The scopes each command has in either tool, in the order the help lists them. */
const SCOPES: Record<ExtensionsCommand, readonly Scope[]> = {
  skills: ["loaded", "project", "global", "cloud", "plugins", "builtin", "other", "unused", "all"],
  mcp: ["loaded", "project", "parents", "global", "plugins", "managed", "other", "all"],
  hooks: ["loaded", "project", "global", "plugins", "managed", "other", "all"],
};

/** The places an item lives in: every scope but the derived ones, which `all` is made of. */
function placesOf(command: ExtensionsCommand): ScopeId[] {
  return SCOPES[command].filter((s): s is ScopeId => s !== "loaded" && s !== "unused" && s !== "all");
}

const NOUN: Record<ExtensionsCommand, { one: string; many: string }> = {
  skills: { one: "skill", many: "skills" },
  mcp: { one: "MCP server", many: "MCP servers" },
  hooks: { one: "hook", many: "hooks" },
};

/** "a, b or c". */
function either(values: readonly string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function badUsage(message: string): ExitError {
  return new ExitError(message, 2);
}

// ─── Arguments ──────────────────────────────────────────────────────

type Options = {
  sub: "ls" | "show";
  json: boolean;
  /** Absent: ls lists Loaded here, show looks everywhere. */
  scope?: Scope;
  tools: ToolName[];
  project?: string;
  name?: string;
  id?: string;
  accounts: string[];
};

function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith("-")) throw badUsage(`${flag} needs a value.`);
    return value;
  }
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

/** Every value of a flag that can be given more than once. */
function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, at) => {
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)];
    if (arg !== flag) return [];
    const value = args[at + 1];
    if (value === undefined || value.startsWith("-")) throw badUsage(`${flag} needs a value.`);
    return [value];
  });
}

/** The arguments that are neither a flag nor a flag's value. */
function positionals(args: string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (EXTENSIONS_VALUE_FLAGS.includes(arg)) at++;
    else if (!arg.startsWith("-")) found.push(arg);
  }
  return found;
}

/**
 * The options after the subcommand. A value is never echoed back, as no option's is elsewhere:
 * only a scope that exists, which is no secret, is named in a message.
 */
async function parseOptions(command: ExtensionsCommand, sub: "ls" | "show", args: string[], cwd: string) {
  const scope = flagValue(args, "--scope");
  if (scope !== undefined) {
    if (!(EVERY_SCOPE as readonly string[]).includes(scope)) {
      throw badUsage(`--scope takes ${either(SCOPES[command])}.`);
    }
    if (!(SCOPES[command] as readonly string[]).includes(scope)) {
      throw badUsage(`--scope ${scope} does not apply to ${command}.`);
    }
  }
  const tool = flagValue(args, "--tool");
  if (tool !== undefined && tool !== "claude" && tool !== "codex") throw badUsage("--tool takes claude or codex.");
  const accounts = flagValues(args, "--account");
  if (accounts.length > 0 && command !== "mcp") throw badUsage("--account is for mcp only.");
  if (accounts.length > 0 && tool === "codex")
    throw badUsage("--account names a Claude account: leave out --tool codex.");
  const id = flagValue(args, "--id");
  if (id !== undefined && sub !== "show") throw badUsage(`--id is for show: clausona ${command} show --id <id>.`);
  const names = positionals(args);
  if (sub === "ls" && names.length > 0) {
    throw badUsage(`ls takes no name. To see one ${NOUN[command].one}, run clausona ${command} show <name>.`);
  }
  if (sub === "show" && names.length > 1) throw badUsage("show takes one name.");
  if (sub === "show" && names.length === 0 && id === undefined) {
    throw badUsage(`show needs a name or --id <id>. Run clausona ${command} show --help.`);
  }
  const given = flagValue(args, "--project");
  const project = given === undefined ? undefined : path.resolve(cwd, given);
  // Without the check, a mistyped path would quietly become the project the list is seen from.
  if (project !== undefined && (await entryInfo(project)).kind !== "dir") {
    throw badUsage("--project: no such directory.");
  }
  // --account names a Claude account, so it lists Claude's servers alone.
  const tools: ToolName[] = tool !== undefined ? [tool] : accounts.length > 0 ? ["claude"] : [...TOOLS];
  const options: Options = {
    sub,
    json: args.includes("--json"),
    ...(scope !== undefined ? { scope: scope as Scope } : {}),
    tools,
    ...(project !== undefined ? { project } : {}),
    ...(names[0] !== undefined ? { name: names[0] } : {}),
    ...(id !== undefined ? { id } : {}),
    accounts,
  };
  return options;
}

// ─── Rows ───────────────────────────────────────────────────────────

function firstOf(row: ScopeRow): Extension {
  const first = row.items[0];
  if (!first) throw new Error(`Row ${row.key} has no items.`);
  return first;
}

function unique(rows: ScopeRow[]): ScopeRow[] {
  const byKey = new Map<string, ScopeRow>();
  for (const row of rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
  return [...byKey.values()];
}

/** What `--scope` lists for one tool: `other` and `all` flatten every other project's rows in. */
function rowsFor(
  inv: Inventory,
  command: ExtensionsCommand,
  tool: ToolName,
  scope: Scope,
  project: string | undefined,
  now: number,
): ScopeRow[] {
  const kind = KIND[command];
  if (scope === "all") return unique(placesOf(command).flatMap((s) => rowsFor(inv, command, tool, s, project, now)));
  if (scope === "other") {
    return unique(
      otherProjects(inv, tool, kind, project).flatMap((other) =>
        rowsIn(inv, tool, kind, "other", project, now, other.path),
      ),
    );
  }
  return rowsIn(inv, tool, kind, scope, project, now);
}

/**
 * Every row `show` can pick from: each place's, and what no place lists - a skill of a plugin
 * that is off - grouped by its row key, as rowsIn groups every account's copy of one thing.
 */
function everyRow(
  inv: Inventory,
  command: ExtensionsCommand,
  tool: ToolName,
  project: string | undefined,
  now: number,
): ScopeRow[] {
  const kind = KIND[command];
  const rows = rowsFor(inv, command, tool, "all", project, now);
  const listed = new Set(rows.flatMap((row) => row.items.map((item) => item.id)));
  const rest = new Map<string, ScopeRow>();
  for (const item of inv.items) {
    if (item.kind !== kind || item.location.tool !== tool || listed.has(item.id)) continue;
    const key = rowKey(item);
    const row = rest.get(key) ?? { key, name: item.name, items: [] };
    row.items.push(item);
    rest.set(key, row);
  }
  return unique([...rows, ...rest.values()]);
}

/**
 * Where `show` looks with no --scope, in turn; the first that has the name decides: what loads
 * here, then this project's places and everyone's, then every other project.
 */
const SHOW_TIERS: readonly ((scope: Exclude<ScopeId, "loaded" | "unused">) => boolean)[] = [
  (scope) => scope !== "other",
  (scope) => scope === "other",
];

/** The Claude accounts that have a row; undefined for one every account sees, [] for Codex. */
function holders(row: ScopeRow): string[] | undefined {
  const first = firstOf(row);
  const loc = first.location;
  if (loc.tool !== "claude") return [];
  // A row of copies is every account's that has one: its own copy, or an install's accounts.
  if (isAccountCopy(first)) {
    return [
      ...new Set(
        row.items.flatMap((copy) =>
          copy.location.profile !== undefined ? [copy.location.profile] : (copy.location.accounts ?? []),
        ),
      ),
    ];
  }
  return loc.profile !== undefined ? [loc.profile] : loc.accounts;
}

function heldBy(row: ScopeRow, accounts: string[]): boolean {
  if (accounts.length === 0) return true;
  const who = holders(row);
  return who === undefined || who.some((p) => accounts.includes(p));
}

/** `--account work` or `--account claude:work`, as the profile ids the inventory has. */
function accountIds(inv: Inventory, given: string[]): string[] {
  return given.map((name) => {
    const id = inv.claudeProfiles.find((p) => p === name || shortProfile(p) === name);
    if (id === undefined) throw badUsage("--account: no Claude account has that name.");
    return id;
  });
}

/** By name, Claude's before Codex's; one name's rows keep their order, as a hook's group does. */
function byName(rows: ScopeRow[]): ScopeRow[] {
  const toolAt = (row: ScopeRow) => TOOLS.indexOf(firstOf(row).location.tool);
  return [...rows].sort((a, b) => a.name.localeCompare(b.name) || toolAt(a) - toolAt(b));
}

// ─── ls ─────────────────────────────────────────────────────────────

function scopeLabel(scope: Scope, tools: ToolName[]): string {
  if (scope === "all") return "All scopes";
  return [...new Set(tools.map((tool) => SCOPE_LABEL[scope](tool)))].join(" / ");
}

function nothingToList(command: ExtensionsCommand, scope: Scope, tools: ToolName[], project: string | undefined) {
  const noun = NOUN[command].many;
  switch (scope) {
    case "loaded":
      return "Nothing is loaded here.";
    case "project":
      return project === undefined
        ? "No project — pick one with --project <path>."
        : "Nothing in this project's own files.";
    case "parents":
      return "No .mcp.json in the folders above this project.";
    case "plugins":
      return `No plugin brings ${noun}.`;
    case "builtin":
      return `No ${noun} built into ${tools.map((tool) => TOOL_NAME[tool]).join(" or ")}.`;
    case "other":
      return `No other project has ${noun} of its own.`;
    case "unused":
      return `No ${noun} unused for ${CLEANUP_UNUSED_DAYS} days.`;
    case "all":
      return `No ${noun} anywhere.`;
    default:
      return `No ${scopeLabel(scope, tools)} ${noun}.`;
  }
}

/** Where a row is: where it comes from, and for another project's own, that project. */
function whereCell(inv: Inventory, row: ScopeRow, project: string | undefined): string {
  const item = firstOf(row);
  const loc = item.location;
  const place =
    homeScope(item, project) === "other" ? projectName(loc.project ?? "", inv) : fromLabel(item, inv, project);
  // Whose a skill is - an account's own folder, or Cloud's copies, one row for every account -
  // and whether it is a legacy command, or two rows read as one twice. A server's row has ACCOUNTS.
  const owners = row.items.flatMap((copy) =>
    copy.location.profile !== undefined && !isAccountServer(copy) ? [copy.location.profile] : [],
  );
  const whose =
    owners.length === 1
      ? ` · ${shortProfile(owners[0] ?? "")}`
      : owners.length > 1
        ? ` · ${owners.length} accounts`
        : "";
  const command = item.kind === "skill" && item.summary?.type === "command" ? " · command" : "";
  return `${place}${whose}${command}`;
}

/** "all", "2 of 3" or the one account's name, for a Claude server; "—" for Codex's. */
function accountsCell(inv: Inventory, row: ScopeRow): string {
  if (firstOf(row).location.tool !== "claude") return "—";
  const who = holders(row);
  if (who === undefined || inv.claudeProfiles.every((p) => who.includes(p))) return "all";
  if (who.length === 1) return shortProfile(who[0] ?? "");
  return `${who.length} of ${inv.claudeProfiles.length}`;
}

const KIND_COLUMNS: Record<ExtensionsCommand, string[]> = {
  skills: ["USES", "LAST USED"],
  mcp: ["ACCOUNTS"],
  hooks: ["WHEN", "RUNS"],
};

function kindCells(command: ExtensionsCommand, inv: Inventory, row: ScopeRow, now: number): string[] {
  const item = firstOf(row);
  switch (command) {
    case "skills": {
      // Codex keeps no usage record, and a plugin's use is its skills'.
      if (item.kind !== "skill" || item.location.tool !== "claude") return ["—", "—"];
      const usage = usageOf(inv, row.items);
      return [String(usage?.total ?? 0), agoWords(usage?.lastUsedAt, now)];
    }
    case "mcp":
      return [accountsCell(inv, row)];
    case "hooks": {
      if (item.kind !== "hook") return ["—", "—"];
      // Already redacted when read: a hook's summary passes its command line through redactCommand.
      return [hookWhen(item), tildeIn(item.summary?.command ?? item.summary?.prompt ?? "", inv.homeDir)];
    }
  }
}

function warningLines(inv: Inventory): string[] {
  if (inv.warnings.length === 0) return [];
  // A warning's message is a fixed phrase plus a position, never the file's contents.
  return [
    "",
    "Could not read every file:",
    ...inv.warnings.map((w) => `  ${tilde(w.file, inv.homeDir)}: ${w.message}`),
  ];
}

function listText(
  inv: Inventory,
  command: ExtensionsCommand,
  options: Options,
  rows: ScopeRow[],
  project: string | undefined,
  now: number,
  columns: number,
): string {
  const scope = options.scope ?? "loaded";
  // Plugins lists the plugins that bring the kind, so it counts plugins.
  const nouns = scope === "plugins" ? { one: "plugin", many: "plugins" } : NOUN[command];
  const noun = rows.length === 1 ? nouns.one : nouns.many;
  const where = project === undefined ? "no project" : `project ${tilde(project, inv.homeDir)}`;
  const lines = [`${rows.length} ${noun} · ${scopeLabel(scope, options.tools)} · ${where}`, ""];
  if (rows.length === 0) {
    lines.push(nothingToList(command, scope, options.tools, project));
  } else {
    // The TOOL column only says something when both tools are listed.
    const both = options.tools.length > 1;
    const header = ["NAME", ...(both ? ["TOOL"] : []), "WHERE", ...KIND_COLUMNS[command], "NOTE"];
    const body = rows.map((row) => {
      const item = firstOf(row);
      return [
        row.name,
        ...(both ? [item.location.tool] : []),
        whereCell(inv, row, project),
        ...kindCells(command, inv, row, now),
        tagsOf(inv, row, project, now)[0] ?? "",
      ];
    });
    // WHEN says a hook's NAME again in plain words, so it gives way first; then what it runs,
    // the long cell. NAME is what show takes, and goes last.
    const giveWay = (command === "hooks" ? ["WHEN", "RUNS", "NAME", "WHERE"] : ["NAME", "WHERE"]).map((title) =>
      header.indexOf(title),
    );
    lines.push(...table([header, ...body], columns, giveWay));
  }
  lines.push(...warningLines(inv));
  return lines.join("\n");
}

// ─── show ───────────────────────────────────────────────────────────

/** How `show` names a candidate, in the ambiguity error. */
function candidateOf(row: ScopeRow, project: string | undefined) {
  const first = firstOf(row);
  return {
    // A row's key is its JSON id: an account server row's own, every other row's item's id.
    id: row.key,
    tool: first.location.tool,
    scope: homeScope(first, project),
    project: first.location.project ?? null,
    account: row.items.length === 1 ? (first.location.profile ?? null) : null,
  };
}

function ambiguous(
  command: ExtensionsCommand,
  options: Options,
  rows: ScopeRow[],
  project: string | undefined,
  homeDir: string,
) {
  const candidates = rows.map((row) => candidateOf(row, project));
  const what =
    options.name === undefined
      ? `${rows.length} ${NOUN[command].many} match:`
      : `${rows.length} ${NOUN[command].many} are named '${options.name}':`;
  const cells = candidates.map((c) => [
    c.tool,
    c.scope,
    c.project === null ? "—" : tilde(c.project, homeDir),
    c.account === null ? "—" : shortProfile(c.account),
    `--id '${c.id}'`,
  ]);
  const message = [
    what,
    ...table(cells, Number.POSITIVE_INFINITY, []).map((line) => `    ${line}`),
    "    Pick one with --tool, --scope or --id <id>.",
  ].join("\n");
  const stdout = options.json ? JSON.stringify({ error: "ambiguous", candidates }, null, 2) : undefined;
  return new ExitError(message, 2, stdout);
}

/** The details view as text: the title, then each line with its label in a column of 10. */
function detailText(lines: DetailLine[]): string[] {
  const out: string[] = [];
  lines.forEach((line, at) => {
    const next = lines[at + 1];
    if (at === 0) {
      out.push(line.text, "");
    } else if (line.label === undefined) {
      // A line of its own, such as the description, stands apart from the labelled ones.
      out.push(line.text, ...(next?.label !== undefined ? [""] : []));
    } else {
      out.push(`${line.label.padEnd(10)}${line.text}`.trimEnd());
    }
  });
  return out;
}

function show(
  inv: Inventory,
  command: ExtensionsCommand,
  options: Options,
  project: string | undefined,
  now: number,
): string {
  const accounts = accountIds(inv, options.accounts);
  const isId = (row: ScopeRow, id: string) => row.key === id || row.items.some((item) => item.id === id);
  const matches = (row: ScopeRow) =>
    // A name can be an id too, so an id from ls --json works as it is given.
    (options.name === undefined || row.name === options.name || isId(row, options.name)) &&
    (options.id === undefined || isId(row, options.id)) &&
    heldBy(row, accounts);
  const scope = options.scope;
  const everyByTool = options.tools.map((tool) => ({ tool, every: everyRow(inv, command, tool, project, now) }));
  // With --scope, that scope's rows and the rows whose place it is, such as a plugin's skill
  // under plugins. Without, in tiers: the first one with a match is where the name is looked up.
  const pools: ScopeRow[][] =
    scope !== undefined
      ? [
          everyByTool.flatMap(({ tool, every }) =>
            unique([
              ...rowsFor(inv, command, tool, scope, project, now),
              ...every.filter((row) => homeScope(firstOf(row), project) === scope),
            ]),
          ),
        ]
      : [
          options.tools.flatMap((tool) => rowsFor(inv, command, tool, "loaded", project, now)),
          ...SHOW_TIERS.map((inTier) =>
            everyByTool.flatMap(({ every }) => every.filter((row) => inTier(homeScope(firstOf(row), project)))),
          ),
        ];
  const found = pools.map((pool) => pool.filter(matches)).find((rows) => rows.length > 0) ?? [];
  const noun = NOUN[command].one;
  if (found.length === 0) {
    const narrowed =
      options.scope !== undefined || options.tools.length < TOOLS.length || options.accounts.length > 0
        ? " Leave out --tool, --scope or --account to look further."
        : "";
    const what = options.name === undefined ? `No ${noun} has that id.` : `No ${noun} named '${options.name}'.`;
    throw new ExitError(`${what}${narrowed}`, 1);
  }
  const [row, ...more] = found;
  if (row === undefined || more.length > 0) throw ambiguous(command, options, found, project, inv.homeDir);
  const details = detailsOf(inv, row, project, now);
  if (options.json) return JSON.stringify({ ...jsonItem(inv, row, project, now), details }, null, 2);
  return [...detailText(details), ...warningLines(inv)].join("\n");
}

// ─── The command ────────────────────────────────────────────────────

/** `clausona skills|mcp|hooks ls|show`. Bad usage and an ambiguous name throw ExitError code 2, not found code 1. */
export async function runExtensionsCommand(
  command: ExtensionsCommand,
  args: string[],
  deps: { homeDir: string; cwd: string; registry: Registry; now?: number; columns?: number },
): Promise<string> {
  const given = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : undefined;
  if (args.includes("--help") || args.includes("-h")) {
    return extensionsHelp(command, given === "ls" || given === "show" ? given : undefined);
  }
  const sub = given ?? "ls";
  if (sub !== "ls" && sub !== "show") throw badUsage(`Unknown subcommand '${sub}'. Run clausona ${command} --help.`);
  const options = await parseOptions(command, sub, given === undefined ? args : args.slice(1), deps.cwd);
  const inv = await loadInventory({ homeDir: deps.homeDir, registry: deps.registry, cwd: options.project ?? deps.cwd });
  const project = inv.currentProject;
  const now = deps.now ?? Date.now();
  if (options.sub === "show") return show(inv, command, options, project, now);

  const accounts = accountIds(inv, options.accounts);
  const scope = options.scope ?? "loaded";
  const rows = byName(
    options.tools
      .flatMap((tool) => rowsFor(inv, command, tool, scope, project, now))
      .filter((row) => heldBy(row, accounts)),
  );
  if (options.json) {
    return JSON.stringify(
      {
        version: 1,
        command,
        project: project ?? null,
        scope,
        tools: options.tools,
        items: rows.map((row) => jsonItem(inv, row, project, now)),
        warnings: inv.warnings,
      },
      null,
      2,
    );
  }
  return listText(inv, command, options, rows, project, now, deps.columns ?? process.stdout.columns ?? 120);
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

// ─── Help ───────────────────────────────────────────────────────────

/** Where an option's text starts, and an example's description. */
const OPTION_COLUMN = 18;
const EXAMPLE_COLUMN = 51;
/** The widest a scope list's line gets past the option column, so a page stays in 100 columns. */
const SCOPE_LIST_WIDTH = 72;

type Example = [command: string, says?: string];

type HelpPage = {
  /** The overview's title, after the dash. */
  about: string;
  /** What `show` takes. */
  showArg: string;
  /** The overview's line for show. */
  showSummary: string;
  /** What ls lists by default, as one sentence. */
  lsDefault: string;
  /** ls's line in the overview, after the noun. */
  lsSummary: string;
  /** What show prints, one or two lines. */
  showAbout: string[];
  lsExamples: Example[];
  showExamples: Example[];
};

const HELP: Record<ExtensionsCommand, HelpPage> = {
  skills: {
    about: "Skills Claude Code and Codex load, by where they come from",
    showArg: "<name>",
    showSummary: "Everything about one skill: files, state per account, use",
    lsDefault: "By default, every skill Claude Code and Codex load in this project.",
    lsSummary: "in one scope (default: everything loaded in this project)",
    showAbout: [
      "Files, where it loads and for which accounts, how often it is used, and other copies.",
      "Looks in what loads here first, then this project and global, then other projects.",
    ],
    lsExamples: [
      ["clausona skills ls --scope project", "Skills this project defines"],
      ["clausona skills ls --scope unused --tool claude", "Claude skills not used in 90 days"],
      ["clausona skills ls --project ~/repos/app --json", "Everything loaded in ~/repos/app"],
    ],
    showExamples: [
      ["clausona skills show eli5", "One skill, as text"],
      ["clausona skills show eli5 --tool codex --json", "The Codex copy, as JSON"],
      ["clausona skills show --id 'skill:claude:global:-:eli5'"],
    ],
  },
  mcp: {
    about: "MCP servers Claude Code and Codex load, by where they come from",
    showArg: "<name>",
    showSummary: "Everything about one MCP server: what it runs, state per account",
    lsDefault: "By default, every MCP server Claude Code and Codex load in this project.",
    lsSummary: "in one scope (default: everything loaded in this project)",
    showAbout: [
      "What it runs, which accounts have it and whether it is on here. Secret values are never shown.",
      "Looks in what loads here first, then this project and global, then other projects.",
    ],
    lsExamples: [
      ["clausona mcp ls --scope global --tool claude", "Servers every project gets"],
      ["clausona mcp ls --json", "Servers loaded here, per account"],
      ["clausona mcp ls --scope other", "Servers other projects define"],
    ],
    showExamples: [
      ["clausona mcp show github", "Which accounts have it, on or off here"],
      ["clausona mcp show github --json"],
      ["clausona mcp show github --account work"],
    ],
  },
  hooks: {
    about: "Hooks Claude Code and Codex run, by where they come from",
    showArg: "<id|name>",
    showSummary: "Everything about one hook: when it runs, what it runs, its file",
    lsDefault: "By default, every hook Claude Code and Codex run in this project.",
    lsSummary: "in one scope (default: everything that runs in this project)",
    showAbout: [
      'When it runs, what it runs and which file it is in. Takes a name such as "Stop", or an id.',
      "Looks in what runs here first, then this project and global, then other projects.",
    ],
    lsExamples: [
      ["clausona hooks ls", "Hooks that run in this project"],
      ["clausona hooks ls --scope global", "Hooks from your user settings"],
      ["clausona hooks ls --json"],
    ],
    showExamples: [
      ["clausona hooks show Stop"],
      ["clausona hooks show --id '<id>' --json"],
      ['clausona hooks show "PreToolUse Bash" --tool claude'],
    ],
  },
};

function option(flag: string, text: string): string {
  return `    ${accent(flag.padEnd(OPTION_COLUMN))}${dim(text)}`;
}

function optionMore(text: string): string {
  return `    ${" ".repeat(OPTION_COLUMN)}${dim(text)}`;
}

/** `a | b | c`, cut into lines that fit, each further line starting with `| `. */
function scopeList(values: string[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const value of values) {
    const next = line === "" ? value : `${line} | ${value}`;
    if (line !== "" && next.length > SCOPE_LIST_WIDTH) {
      lines.push(line);
      line = `| ${value}`;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function example([command, says]: Example): string {
  if (says === undefined) return `    ${command}`;
  const padded = command.length + 2 > EXAMPLE_COLUMN ? `${command}  ` : command.padEnd(EXAMPLE_COLUMN);
  return `    ${padded}${dim(says)}`;
}

function section(title: string, lines: string[]): string[] {
  return [`  ${bold(title)}`, ...lines, ""];
}

/** `clausona <command> --help`, or the page of `ls` or `show`. Every line fits in 100 columns. */
export function extensionsHelp(command: ExtensionsCommand, sub?: "ls" | "show"): string {
  const page = HELP[command];
  const { one, many } = NOUN[command];
  const mcp = command === "mcp";
  const account = mcp ? [option("--account <name>", "Only this Claude account (repeatable)")] : [];
  const project = option("--project <path>", "Look from another project instead of the current dir");
  const json = option("--json", "JSON output (version 1), described in docs/extensions.md#json");
  if (sub === "ls") {
    const [first = "", ...rest] = scopeList(SCOPES[command].map((s) => (s === "loaded" ? "loaded (default)" : s)));
    return [
      "",
      `  ${accent(`clausona ${command} ls`)} ${dim(`— List ${many}`)}`,
      "",
      `  ${dim(page.lsDefault)}`,
      "",
      ...section("OPTIONS", [
        option("--scope <scope>", first),
        ...rest.map(optionMore),
        option("--tool <tool>", "claude | codex (default: both)"),
        ...account,
        project,
        json,
      ]),
      ...section("EXAMPLES", page.lsExamples.map(example)),
      `  ${bold("EXIT CODES")}   ${dim("0 ok · 1 error · 2 bad usage")}`,
      "",
    ].join("\n");
  }
  if (sub === "show") {
    const kind = command === "mcp" ? "server" : one;
    return [
      "",
      `  ${accent(`clausona ${command} show`)} ${dim(`— Everything about one ${one}`)}`,
      "",
      ...page.showAbout.map((line) => `  ${dim(line)}`),
      "",
      ...section("OPTIONS", [
        option("--tool <tool>", `claude | codex, when both have a ${kind} by this name`),
        option("--scope <scope>", `${placesOf(command).join(" | ")}, to pick one copy`),
        option("--id <id>", "An exact id from ls --json, instead of a name"),
        ...account,
        project,
        json,
      ]),
      ...section("EXAMPLES", page.showExamples.map(example)),
      `  ${bold("EXIT CODES")}   ${dim("0 ok · 1 not found or error · 2 bad usage or several matches")}`,
      "",
    ].join("\n");
  }
  const accountUsage = mcp ? " [--account <name>]" : "";
  return [
    "",
    `  ${accent(`clausona ${command}`)} ${dim(`— ${page.about}`)}`,
    "",
    ...section("USAGE", [
      helpUsage(`clausona ${command} ls   [--scope <scope>] [--tool claude|codex] [--project <path>] [--json]`),
      helpUsage(`clausona ${command} show ${page.showArg} [--tool …] [--scope …] [--id <id>]${accountUsage} [--json]`),
    ]),
    ...section("SUBCOMMANDS", [
      `    ${accent("ls".padEnd(8))}${dim(`List ${many} ${page.lsSummary}`)}`,
      `    ${accent("show".padEnd(8))}${dim(page.showSummary)}`,
    ]),
    `  ${dim("Run")} ${accent(`clausona ${command} ls --help`)} ${dim("or")} ${accent(`clausona ${command} show --help`)} ${dim("for options and examples.")}`,
    `  ${dim("Reference: docs/extensions.md (scopes, tags, JSON fields).")}`,
    "",
  ].join("\n");
}
