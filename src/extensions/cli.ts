import path from "node:path";

import { accent, bold, dim, helpUsage, success, truncate } from "../lib/cli-style.js";
import type { Registry, ToolName } from "../types.js";
import {
  type Action,
  type ExtensionsCommand,
  type Refusal,
  refusalText,
  type StopReason,
  stopText,
} from "./actions.js";
import {
  type ApplyResult,
  apply,
  lastOperation,
  type UndoPreview,
  type UndoSkip,
  undo,
  type WriteEnv,
  writeEnvFor,
} from "./apply.js";
import {
  accountsWord,
  containsWords,
  type DetailLine,
  detailsOf,
  hookWhen,
  jsonItem,
  loadsFor,
  rowAccounts,
  tagsOf,
  usageCells,
  whereLabel,
} from "./describe.js";
import { type ErrorKind, ExitError } from "./exit-error.js";
import { planChecked } from "./git-tracked.js";
import { CLEANUP_UNUSED_DAYS, loadInventory } from "./inventory.js";
import { type Extension, type Inventory, SKILL_VISIBILITY, type SkillVisibility } from "./model.js";
import { type Plan, type PlanLine, rowForId } from "./plan.js";
import { shortProfile, tilde, tildeIn } from "./present.js";
import { entryInfo, isWithin } from "./read.js";
import {
  homeScope,
  type ItemKind,
  isAccountServer,
  otherProjects,
  pluginContents,
  rowKey,
  rowsIn,
  SCOPE_LABEL,
  type ScopeId,
  type ScopeRow,
} from "./scopes.js";

/**
 * `clausona skills|mcp|hooks`: `ls` and `show` read - the rows of one scope as a table or JSON
 * v1, and one row's details, as describe.ts says them. `off`, `on`, `visibility` and `rm` plan a
 * change (planChecked), show it, ask, and apply it behind a backup (apply.ts); `undo` puts back
 * the newest one. With `--json` every answer is one object, an error too (withJsonErrors).
 */

export type { ExtensionsCommand } from "./actions.js";

export type Sub = "ls" | "show" | "off" | "on" | "visibility" | "rm" | "undo";

/** What each command takes, in the order its help lists them: visibility is a Claude skill's alone. */
export const SUBS: Record<ExtensionsCommand, readonly Sub[]> = {
  skills: ["ls", "show", "off", "on", "visibility", "rm", "undo"],
  mcp: ["ls", "show", "off", "on", "rm", "undo"],
  hooks: ["ls", "show", "off", "on", "rm", "undo"],
};

/** The subcommands that change files. */
const WRITES: readonly Sub[] = ["off", "on", "visibility", "rm", "undo"];

const KIND: Record<ExtensionsCommand, ItemKind> = { skills: "skill", mcp: "mcp", hooks: "hook" };
const TOOLS: readonly ToolName[] = ["claude", "codex"];
const TOOL_NAME: Record<ToolName, string> = { claude: "Claude Code", codex: "Codex" };

export const EXTENSIONS_VALUE_FLAGS = ["--scope", "--tool", "--project", "--id", "--account"];
export const EXTENSIONS_FLAGS = [
  "--json",
  "--help",
  "--everywhere",
  "--dry-run",
  "--yes",
  "-y",
  "--tracked",
  ...EXTENSIONS_VALUE_FLAGS,
];

/** The keys of each JSON object a change prints, in their order; an absent one is left out. */
export const PLAN_JSON_KEYS: readonly string[] = [
  "version",
  "command",
  "verb",
  "everywhere",
  "level",
  "dryRun",
  "applied",
  "question",
  "changes",
  "unchanged",
  "refused",
  "notes",
  "accounts",
  "backupRoot",
  "operation",
];
export const CHANGE_JSON_KEYS: readonly string[] = ["file", "change", "what", "account", "note", "tracked", "rows"];
export const REFUSED_JSON_KEYS: readonly string[] = ["id", "name", "code", "reason"];
export const UNCHANGED_JSON_KEYS: readonly string[] = ["id", "name", "why"];
export const UNDO_JSON_KEYS: readonly string[] = [
  "version",
  "command",
  "verb",
  "dryRun",
  "operation",
  "files",
  "restored",
  "skipped",
];

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

/** "a, b and c". */
function all(values: readonly string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function badUsage(message: string): ExitError {
  return new ExitError(message, 2, undefined, "usage");
}

function isSub(command: ExtensionsCommand, word: string | undefined): word is Sub {
  return word !== undefined && (SUBS[command] as readonly string[]).includes(word);
}

// ─── Arguments ──────────────────────────────────────────────────────

/** The parsed options: today's Options, exported, with names and ids as lists (show reads names[0] / ids[0]). */
export type Options = {
  sub: Sub;
  json: boolean;
  /** Absent: ls lists Loaded, show and the writes look in the tiers. */
  scope?: ScopeId | "all";
  tools: ToolName[];
  project?: string;
  /** The positional names (visibility: without the level). show takes one. */
  names: string[];
  /** Every --id. show and visibility take one. */
  ids: string[];
  accounts: string[];
  everywhere: boolean;
  dryRun: boolean;
  yes: boolean;
  tracked: boolean;
  /** visibility only. */
  level?: SkillVisibility;
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

/** Whether the flag is given, as `--flag` or `--flag=…`. */
function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
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

/** `~` and `~/…` as the home dir, as a shell would, so a quoted path works too. */
function expandHome(given: string, homeDir: string): string {
  if (given === "~") return homeDir;
  // Windows takes either separator after it; elsewhere a backslash is part of a name.
  const sep = process.platform === "win32" ? /^~[\\/]/ : /^~\//;
  return sep.test(given) ? path.join(homeDir, given.slice(2)) : given;
}

/** Bad usage when `flag` is given to a subcommand outside `subs`, naming the ones it is for. */
function onlyFor(command: ExtensionsCommand, sub: Sub, flag: string, isGiven: boolean, subs: readonly Sub[]): void {
  if (isGiven && !subs.includes(sub)) {
    throw badUsage(`${flag} is for ${all(SUBS[command].filter((s) => subs.includes(s)))}.`);
  }
}

/** The level visibility takes as its last word, and the names before it. */
function visibilityWords(words: string[]): { level: SkillVisibility; names: string[] } {
  const level = words.at(-1);
  if (!(SKILL_VISIBILITY as readonly string[]).includes(level ?? "")) {
    throw badUsage(`visibility takes ${either(SKILL_VISIBILITY)}.`);
  }
  return { level: level as SkillVisibility, names: words.slice(0, -1) };
}

/**
 * The options after the subcommand. A value is never echoed back, as no option's is elsewhere:
 * only a scope that exists, which is no secret, is named in a message.
 */
async function parseOptions(command: ExtensionsCommand, sub: Sub, args: string[], cwd: string, homeDir: string) {
  const words = positionals(args);
  if (
    sub === "undo" &&
    (words.length > 0 || ["--id", "--scope", "--tool", "--project", "--account"].some((flag) => hasFlag(args, flag)))
  ) {
    throw badUsage(
      `undo takes no name, --id, --scope, --tool, --project or --account: it puts back the newest ${command} change.`,
    );
  }
  const everywhere = args.includes("--everywhere");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const tracked = args.includes("--tracked");
  if (everywhere && sub === "rm") throw badUsage("rm deletes the thing itself: leave out --everywhere.");
  onlyFor(command, sub, "--everywhere", everywhere, ["off", "on", "visibility"]);
  onlyFor(command, sub, "--dry-run", dryRun, WRITES);
  onlyFor(command, sub, args.includes("--yes") ? "--yes" : "-y", yes, WRITES);
  onlyFor(command, sub, "--tracked", tracked, ["off", "on", "visibility", "rm"]);
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
  const ids = flagValues(args, "--id");
  onlyFor(command, sub, "--id", ids.length > 0, ["show", "off", "on", "visibility", "rm"]);
  if (sub === "show" && ids.length > 1) throw badUsage("show takes one --id.");
  const { level, names } = sub === "visibility" ? visibilityWords(words) : { level: undefined, names: words };
  if (sub === "ls" && names.length > 0) {
    throw badUsage(`ls takes no name. To see one ${NOUN[command].one}, run clausona ${command} show <name>.`);
  }
  if (sub === "show" && names.length > 1) throw badUsage("show takes one name.");
  if (sub !== "ls" && sub !== "undo" && names.length === 0 && ids.length === 0) {
    throw badUsage(`${sub} needs a name or --id <id>. Run clausona ${command} ${sub} --help.`);
  }
  if (sub === "visibility" && names.length + ids.length > 1) throw badUsage("visibility takes one name or one --id.");
  const at = flagValue(args, "--project");
  const project = at === undefined ? undefined : path.resolve(cwd, expandHome(at, homeDir));
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
    names,
    ids,
    accounts,
    everywhere,
    dryRun,
    yes,
    tracked,
    ...(level !== undefined ? { level } : {}),
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

/**
 * What `--scope` lists for one tool: `other` and `all` flatten every other project's rows in.
 * `all` lists things of the kind alone: in place of each plugin, what it brings, as rows of their
 * own keys - the plugins themselves are `--scope plugins`.
 */
function rowsFor(
  inv: Inventory,
  command: ExtensionsCommand,
  tool: ToolName,
  scope: Scope,
  project: string | undefined,
  now: number,
): ScopeRow[] {
  const kind = KIND[command];
  if (scope === "all") {
    return unique(
      placesOf(command).flatMap((place) =>
        place === "plugins"
          ? rowsFor(inv, command, tool, place, project, now).flatMap((plugin) => pluginContents(inv, plugin)[kind])
          : rowsFor(inv, command, tool, place, project, now),
      ),
    );
  }
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
  // `all` lists what plugins bring; the plugins, which show takes too, are Plugins' rows.
  const rows = unique([
    ...rowsFor(inv, command, tool, "all", project, now),
    ...rowsFor(inv, command, tool, "plugins", project, now),
  ]);
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

/**
 * Whether --account keeps the row: in Loaded, when it loads for one of `accounts`
 * (`loadsFor`); in any other scope, when one of them has it. --account lists Claude rows alone,
 * so no Codex row is asked.
 */
function heldBy(
  inv: Inventory,
  row: ScopeRow,
  accounts: string[],
  project: string | undefined,
  loaded: boolean,
): boolean {
  if (accounts.length === 0) return true;
  if (loaded) return loadsFor(inv, row, project, accounts);
  const who = rowAccounts(inv, row);
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
  const place = whereLabel(item, inv, project);
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

const KIND_COLUMNS: Record<ExtensionsCommand, string[]> = {
  skills: ["USES", "LAST USED"],
  mcp: ["ACCOUNTS"],
  hooks: ["WHEN", "RUNS"],
};

function kindCells(
  command: ExtensionsCommand,
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
  now: number,
): string[] {
  const item = firstOf(row);
  switch (command) {
    case "skills":
      return usageCells(inv, row, project, now);
    case "mcp":
      return [accountsWord(inv, row)];
    case "hooks": {
      if (item.kind !== "hook") return ["—", "—"];
      // Already redacted when read: a hook's summary passes its command line through redactCommand.
      return [hookWhen(item), tildeIn(item.summary?.command ?? item.summary?.prompt ?? "", inv.homeDir)];
    }
  }
}

/** The files that could not be read, after a list (`what` "this list") or the details ("this"). */
function warningLines(inv: Inventory, what: string): string[] {
  if (inv.warnings.length === 0) return [];
  // A warning's message is a fixed phrase plus a position, never the file's contents.
  return [
    "",
    `Could not read every file, so ${what} may miss what they hold:`,
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
    // The TOOL column only says something when both tools are listed. Plugins lists plugins,
    // whatever the kind: what each brings, as the screen's Plugins table has it.
    const both = options.tools.length > 1;
    const plugins = scope === "plugins";
    const middle = plugins ? ["CONTAINS"] : ["WHERE", ...KIND_COLUMNS[command]];
    const header = ["NAME", ...(both ? ["TOOL"] : []), ...middle, "NOTE"];
    const body = rows.map((row) => {
      const item = firstOf(row);
      return [
        row.name,
        ...(both ? [item.location.tool] : []),
        ...(plugins
          ? [containsWords(inv, row)]
          : [whereCell(inv, row, project), ...kindCells(command, inv, row, project, now)]),
        tagsOf(inv, row, project, now)[0] ?? "",
      ];
    });
    // WHEN says a hook's NAME again in plain words, so it gives way first; then what it runs,
    // the long cell. NAME is what show takes, and goes last. A plugin's CONTAINS goes before it.
    const order = plugins
      ? ["CONTAINS", "NAME"]
      : command === "hooks"
        ? ["WHEN", "RUNS", "NAME", "WHERE"]
        : ["NAME", "WHERE"];
    const giveWay = order.map((title) => header.indexOf(title)).filter((column) => column >= 0);
    lines.push(...table([header, ...body], columns, giveWay));
  }
  lines.push(...warningLines(inv, "this list"));
  return lines.join("\n");
}

// ─── show, and the rows a change is for ─────────────────────────────

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

/** Several rows for one name or id: exit 2, the candidates listed; with --json their object, with the name given. */
function ambiguous(
  command: ExtensionsCommand,
  options: Options,
  name: string | undefined,
  rows: ScopeRow[],
  project: string | undefined,
  homeDir: string,
) {
  const candidates = rows.map((row) => candidateOf(row, project));
  const what =
    name === undefined
      ? `${rows.length} ${NOUN[command].many} match:`
      : `${rows.length} ${NOUN[command].many} are named '${name}':`;
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
  const body = { version: 1, error: "ambiguous", message, ...(name !== undefined ? { name } : {}), candidates };
  const stdout = options.json ? JSON.stringify(body, null, 2) : undefined;
  return new ExitError(message, 2, stdout, "ambiguous");
}

/** Rows named twice, or two copies of one row named by their ids, as one row each, in the order first met. */
function folded(rows: ScopeRow[]): ScopeRow[] {
  const byKey = new Map<string, ScopeRow>();
  for (const row of rows) {
    const known = byKey.get(row.key);
    const ids = new Set(known?.items.map((item) => item.id));
    byKey.set(row.key, known ? { ...known, items: [...known.items, ...row.items.filter((i) => !ids.has(i.id))] } : row);
  }
  return [...byKey.values()];
}

/** A plugin goes by its name before the `@` too: `superpowers` for `superpowers@official`. */
function isName(row: ScopeRow, name: string): boolean {
  return row.name === name || (firstOf(row).kind === "plugin" && row.name.split("@")[0] === name);
}

function isId(row: ScopeRow, id: string): boolean {
  return row.key === id || row.items.some((item) => item.id === id);
}

/**
 * The rows one name, one id, or (show) both pick: with --scope that scope's rows and the rows
 * whose place it is, such as a plugin's skill under plugins; without, in tiers, and the first
 * tier with a match is where the name is looked up (rule Q).
 */
function rowsPicked(
  inv: Inventory,
  command: ExtensionsCommand,
  options: Options,
  project: string | undefined,
  now: number,
  accounts: string[],
  pick: { name: string | undefined; id: string | undefined },
): ScopeRow[] {
  // In Loaded, --account keeps the rows that load for the account, as ls does.
  const matches = (row: ScopeRow, loaded: boolean) =>
    // A name can be an id too, so an id from ls --json works as it is given.
    (pick.name === undefined || isName(row, pick.name) || isId(row, pick.name)) &&
    (pick.id === undefined || isId(row, pick.id)) &&
    heldBy(inv, row, accounts, project, loaded);
  const scope = options.scope;
  const everyByTool = options.tools.map((tool) => ({ tool, every: everyRow(inv, command, tool, project, now) }));
  const pools: { rows: ScopeRow[]; loaded: boolean }[] =
    scope !== undefined
      ? [
          {
            rows: everyByTool.flatMap(({ tool, every }) =>
              unique([
                ...rowsFor(inv, command, tool, scope, project, now),
                ...every.filter((row) => homeScope(firstOf(row), project) === scope),
              ]),
            ),
            loaded: scope === "loaded",
          },
        ]
      : [
          { rows: options.tools.flatMap((tool) => rowsFor(inv, command, tool, "loaded", project, now)), loaded: true },
          ...SHOW_TIERS.map((inTier) => ({
            rows: everyByTool.flatMap(({ every }) => every.filter((row) => inTier(homeScope(firstOf(row), project)))),
            loaded: false,
          })),
        ];
  return (
    pools.map(({ rows, loaded }) => rows.filter((row) => matches(row, loaded))).find((rows) => rows.length > 0) ?? []
  );
}

/**
 * show's lookup, shared by the writes: the one row each name or id picks; ExitError not-found (1)
 * or ambiguous (2) as show throws today. For a change, an id - given with --id, or as the name -
 * that is one copy's picks that copy alone (rowForId), so `rm --id <a kept copy>` deletes it and
 * no other account's; show shows the whole row. Rows picked twice fold into one.
 */
export function matchRows(
  inv: Inventory,
  command: ExtensionsCommand,
  options: Options,
  project: string | undefined,
  now: number,
): ScopeRow[] {
  const accounts = accountIds(inv, options.accounts);
  const picks =
    options.sub === "show"
      ? [{ name: options.names[0], id: options.ids[0] }]
      : [
          ...options.names.map((name) => ({ name, id: undefined })),
          ...options.ids.map((id) => ({ name: undefined, id })),
        ];
  const noun = NOUN[command].one;
  return folded(
    picks.map((pick) => {
      const found = rowsPicked(inv, command, options, project, now, accounts, pick);
      if (found.length === 0) {
        const narrowed =
          options.scope !== undefined || options.tools.length < TOOLS.length || options.accounts.length > 0
            ? " Leave out --tool, --scope or --account to look further."
            : "";
        const what = pick.name === undefined ? `No ${noun} has that id.` : `No ${noun} named '${pick.name}'.`;
        throw new ExitError(`${what}${narrowed}`, 1, undefined, "not-found");
      }
      const [row, ...more] = found;
      if (row === undefined || more.length > 0) {
        throw ambiguous(command, options, pick.name, found, project, inv.homeDir);
      }
      if (options.sub === "show") return row;
      const exact = pick.id ?? (pick.name !== undefined && !isName(row, pick.name) ? pick.name : undefined);
      return exact === undefined ? row : (rowForId(row, exact) ?? row);
    }),
  );
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
  const [row] = matchRows(inv, command, options, project, now);
  if (row === undefined) throw new Error("show matched no row.");
  const details = detailsOf(inv, row, project, now);
  if (options.json) return JSON.stringify({ version: 1, ...jsonItem(inv, row, project, now), details }, null, 2);
  return [...detailText(details), ...warningLines(inv, "this")].join("\n");
}

// ─── Changes ────────────────────────────────────────────────────────

const PROMPT = "  Apply? (y/N) ";
const CANCELLED = "  Cancelled. Nothing changed.";
const NO_TERMINAL =
  "This changes files, and there is no terminal to confirm on. Add --yes to go ahead, or --dry-run to see the plan.";

/** What a refused row could not be, in "Nothing changed: 1 of 2 can't be deleted." */
const CANT: Record<Plan["verb"], string> = { off: "turned off", on: "turned on", visibility: "changed", rm: "deleted" };

/** Why undo left a file alone, after its path. */
const LEFT_ALONE: Record<UndoSkip["reason"], string> = {
  changed: "changed since",
  occupied: "something is there again",
  locked: "Claude Code is saving it",
  missing: "is gone",
  failed: "could not be put back",
};

/** What an apply that stopped is called in --json's `error`. */
const STOPPED: Record<StopReason, ErrorKind> = {
  changed: "changed",
  locked: "locked",
  conflict: "conflict",
  failed: "failed",
};

/** A change under way: what was asked, where its words go, and whether it can ask first. */
type Talk = {
  command: ExtensionsCommand;
  options: Options;
  homeDir: string;
  env: WriteEnv;
  columns: number;
  /** Where the plan goes before the question. */
  print: (text: string) => void;
  /** Undefined when there is no terminal to ask on. */
  confirm: ((question: string) => Promise<boolean>) | undefined;
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The lines of a text without the blank ones at its end. */
function trimmed(lines: string[]): string[] {
  const out = [...lines];
  while (out.at(-1) === "") out.pop();
  return out;
}

function lineJson(line: PlanLine) {
  return {
    file: line.file,
    change: line.change,
    what: line.what,
    account: line.account ?? null,
    note: line.note ?? null,
    tracked: line.tracked,
    rows: [...line.rows],
  };
}

function refusedJson(refusal: Refusal) {
  return { id: refusal.rowKey, name: refusal.name, code: refusal.code, reason: refusalText(refusal, "flags") };
}

/** A plan as JSON v1, in PLAN_JSON_KEYS order: what it names, never a fingerprint or a value of an entry. */
function planJson(
  plan: Plan,
  talk: Talk,
  state: { dryRun: boolean; applied?: boolean; operation?: { id: string; backup: string } },
) {
  return {
    version: 1,
    command: plan.command,
    verb: plan.verb,
    everywhere: plan.verb !== "rm" && plan.reach === "everywhere",
    ...(plan.level !== undefined ? { level: plan.level } : {}),
    dryRun: state.dryRun,
    ...(state.applied !== undefined ? { applied: state.applied } : {}),
    question: plan.question,
    changes: plan.changes.flatMap((change) => change.lines.map(lineJson)),
    unchanged: plan.unchanged.map((u) => ({ id: u.rowKey, name: u.name, why: u.why })),
    refused: plan.refused.map(refusedJson),
    notes: [...plan.notes],
    ...(plan.accounts ? { accounts: plan.accounts.map((a) => ({ profile: a.profile, chosen: a.chosen })) } : {}),
    backupRoot: talk.env.backupRoot,
    ...(state.operation ? { operation: state.operation } : {}),
  };
}

/** A path, dim, keeping its padding outside the style. */
function dimPath(cell: string): string {
  const text = cell.trimEnd();
  return `${dim(text)}${cell.slice(text.length)}`;
}

/** One line per file line: `{~file}  {what}  {account}  {note}`, a column nobody fills left out, cut to fit. */
function changeLines(lines: PlanLine[], talk: Talk): string[] {
  const cells = lines.map((line) => [
    tilde(line.file, talk.homeDir),
    line.what,
    line.account === undefined ? "" : shortProfile(line.account),
    line.note ?? "",
  ]);
  const used = [0, 1, 2, 3].filter((c) => c === 0 || cells.some((row) => row[c] !== ""));
  // What changes gives way first, then the note, then the path.
  const giveWay = [1, 3, 0].map((c) => used.indexOf(c)).filter((c) => c >= 0);
  return fitted(
    cells.map((row) => used.map((c) => row[c] ?? "")),
    talk.columns - 6,
    giveWay,
  ).map(([file = "", ...rest]) => `      ${[dimPath(file), ...rest].join(" ".repeat(GAP))}`.trimEnd());
}

/** `{name}  {why}` for each row already as asked, dim, at `indent`. */
function unchangedLines(plan: Plan, talk: Talk, indent: number): string[] {
  const rows = plan.unchanged.map((u) => [u.name, u.why]);
  return table(rows, talk.columns - indent, [1, 0]).map((line) => `${" ".repeat(indent)}${dim(line)}`);
}

/** `{name}  {reason and what to do}`, whole: the hint is a command to run. */
function refusalLines(refused: Refusal[], indent: number): string[] {
  const rows = refused.map((r) => [r.name, refusalText(r, "flags")]);
  return table(rows, Number.POSITIVE_INFINITY, []).map((line) => `${" ".repeat(indent)}${line}`);
}

function notesLines(plan: Plan): string[] {
  return plan.notes.length === 0 ? [] : ["  Note:", ...plan.notes.map((note) => `      ${note}`), ""];
}

/** The plan as the prompt and --dry-run show it: the question, the files, what is already so, the backup. */
function planText(plan: Plan, talk: Talk, dryRun: boolean): string {
  const lines = plan.changes.flatMap((change) => change.lines);
  const out = [`  ${bold(plan.question)}`, ""];
  if (lines.length > 0) out.push(...changeLines(lines, talk), "");
  if (plan.unchanged.length > 0) out.push("  Already as asked:", ...unchangedLines(plan, talk, 6), "");
  if (plan.refused.length > 0) out.push(`  Can't be ${CANT[plan.verb]}:`, ...refusalLines(plan.refused, 6), "");
  out.push(...notesLines(plan));
  if (lines.length > 0) {
    const them = new Set(lines.flatMap((line) => line.rows)).size > 1 ? "them" : "it";
    out.push(
      `  Backup: ${dim(`${tilde(talk.env.backupRoot, talk.homeDir)}${path.sep}`)}`,
      `  Run ${accent(`clausona ${talk.command} undo`)} afterwards to put ${them} back.`,
      "",
    );
  }
  if (dryRun) {
    // A change with a refused row changes nothing at all (rule C), so --yes alone would not do.
    out.push(
      plan.refused.length > 0
        ? `  Dry run: nothing changed. Leave out what can't be ${CANT[plan.verb]}, then run it again with --yes.`
        : "  Dry run: nothing changed. Run it again with --yes to apply.",
    );
  }
  return trimmed(out).join("\n");
}

function nothingText(plan: Plan, talk: Talk): string {
  return trimmed(["  Nothing to do.", ...unchangedLines(plan, talk, 4), "", ...notesLines(plan)]).join("\n");
}

/** Rule C: any refused row, and nothing is applied; every reason is listed. */
function refusedError(plan: Plan, asked: number): ExitError {
  const rows = new Set(plan.refused.map((r) => r.rowKey)).size;
  const message = [
    `Nothing changed: ${rows} of ${asked} can't be ${CANT[plan.verb]}.`,
    ...refusalLines(plan.refused, 4),
  ];
  return new ExitError(message.join("\n"), 1, undefined, "refused", { refused: plan.refused.map(refusedJson) });
}

/** An apply that stopped at a change: why, and how many were made before it, which undo puts back. */
function stoppedError(result: Extract<ApplyResult, { status: "stopped" }>, talk: Talk): ExitError {
  const { operation, done, total, stop } = result;
  const made = done > 0 ? ` ${done} of ${total} changes were made; clausona ${talk.command} undo puts them back.` : "";
  return new ExitError(
    `${stopText(stop, "flags", talk.homeDir, talk.command)}${made}`,
    1,
    undefined,
    STOPPED[stop.reason],
    {
      operation: { id: operation.id, backup: operation.dir },
      done,
      total,
      file: stop.file,
    },
  );
}

/** Rule M: --yes goes ahead; a terminal shows `text` and asks, no by default; without one it is bad usage. */
async function agreed(talk: Talk, text: string): Promise<boolean> {
  if (talk.options.yes) return true;
  if (!talk.confirm) throw badUsage(NO_TERMINAL);
  talk.print(text);
  return talk.confirm(PROMPT);
}

/** off, on, visibility or rm: the plan, then a dry run, a refusal, nothing to do, or - once agreed - the apply. */
async function change(inv: Inventory, talk: Talk, now: number, git: string | undefined): Promise<string> {
  const { command, options } = talk;
  const project = inv.currentProject;
  const rows = matchRows(inv, command, options, project, now);
  const verb = options.sub as Action["verb"];
  const action: Action = {
    verb,
    // Neither tool has a per-project switch for hooks (rule O); rm has no reach.
    reach: verb !== "rm" && (options.everywhere || command === "hooks") ? "everywhere" : "here",
    rows,
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(options.accounts.length > 0 ? { accounts: accountIds(inv, options.accounts) } : {}),
    ...(options.tracked ? { tracked: true } : {}),
  };
  const ctx = { inv, project, now, stashDir: inv.places.stashDir };
  const { plan } = await planChecked(ctx, command, action, git !== undefined ? { git } : {});
  const nothing = plan.changes.length === 0 && plan.refused.length === 0;
  if (options.dryRun) {
    if (options.json) return pretty(planJson(plan, talk, { dryRun: true }));
    return nothing ? nothingText(plan, talk) : planText(plan, talk, true);
  }
  if (plan.refused.length > 0) throw refusedError(plan, rows.length);
  if (nothing)
    return options.json ? pretty(planJson(plan, talk, { dryRun: false, applied: false })) : nothingText(plan, talk);
  if (!(await agreed(talk, planText(plan, talk, false)))) return CANCELLED;
  const result = await apply(plan, talk.env);
  if (result.status === "stopped") throw stoppedError(result, talk);
  if (result.status === "nothing") {
    return options.json ? pretty(planJson(plan, talk, { dryRun: false, applied: false })) : nothingText(plan, talk);
  }
  const operation = { id: result.operation.id, backup: result.operation.dir };
  if (options.json) return pretty(planJson(plan, talk, { dryRun: false, applied: true, operation }));
  return [
    success(plan.done),
    `    Backup: ${dim(tilde(operation.backup, talk.homeDir))}`,
    `    Undo: ${accent(`clausona ${command} undo`)}`,
  ].join("\n");
}

function nothingToUndo(command: ExtensionsCommand): ExitError {
  return new ExitError(`Nothing to undo for ${command}.`, 1, undefined, "nothing-to-undo");
}

function undoJson(
  talk: Talk,
  operation: UndoPreview["operation"],
  dryRun: boolean,
  outcome: { files?: UndoPreview["files"]; restored?: string[]; skipped?: UndoSkip[] },
) {
  return {
    version: 1,
    command: talk.command,
    verb: "undo",
    dryRun,
    operation: { id: operation.id, summary: operation.summary, createdAt: operation.createdAt },
    ...(outcome.files ? { files: outcome.files.map((f) => ({ path: f.path, action: f.action })) } : {}),
    ...(outcome.restored ? { restored: outcome.restored } : {}),
    ...(outcome.skipped ? { skipped: outcome.skipped.map((s) => ({ file: s.file, reason: s.reason })) } : {}),
  };
}

/** `{~path}  {words}` per path, the path dim, cut to fit. */
function pathLines(rows: [string, string][], talk: Talk, indent: number): string[] {
  const cells = rows.map(([file, words]) => [tilde(file, talk.homeDir), words]);
  return fitted(cells, talk.columns - indent, [0]).map(
    ([file = "", words = ""]) => `${" ".repeat(indent)}${dimPath(file)}${" ".repeat(GAP)}${words}`,
  );
}

function previewText(summary: string, files: UndoPreview["files"], talk: Talk, dryRun: boolean): string {
  return trimmed([
    `  ${bold(`Undo: ${summary}?`)}`,
    "",
    ...pathLines(
      files.map((f) => [f.path, f.action]),
      talk,
      6,
    ),
    ...(files.length > 0 ? [""] : []),
    "  Puts back what the change changed, unless it changed since.",
    ...(dryRun ? ["", "  Dry run: nothing changed. Run it again with --yes to undo it."] : []),
  ]).join("\n");
}

/**
 * undo: the newest change of this command not undone yet (rule F), previewed, agreed to, and put
 * back. Paths in clausona's own folder of kept entries are left out of what it says; the
 * manifest keeps them.
 */
async function undoLast(talk: Talk): Promise<string> {
  const { command, options, env } = talk;
  const own = (file: string) => isWithin(file, env.stashDir);
  const preview = await lastOperation(env, command);
  if (!preview) throw nothingToUndo(command);
  const files = preview.files.filter((f) => !own(f.path));
  const { summary } = preview.operation;
  if (options.dryRun) {
    return options.json
      ? pretty(undoJson(talk, preview.operation, true, { files }))
      : previewText(summary, files, talk, true);
  }
  if (!(await agreed(talk, previewText(summary, files, talk, false)))) return CANCELLED;
  const result = await undo(env, command);
  if (!result) throw nothingToUndo(command);
  const restored = result.restored.filter((file) => !own(file));
  const back = restored.map((file): [string, string] => [file, "put back"]);
  if (result.skipped.length > 0) {
    // Only Claude Code saving a file: the operation stays the next undo's, for what is left.
    const locked = result.skipped.every((skip) => skip.reason === "locked");
    const message = [
      restored.length > 0
        ? `Undid part of it: ${result.operation.summary}`
        : `Could not undo: ${result.operation.summary}`,
      ...pathLines(
        [...back, ...result.skipped.map((skip): [string, string] => [skip.file, LEFT_ALONE[skip.reason]])],
        talk,
        4,
      ),
      ...(result.skipped.some((skip) => skip.reason === "locked") ? ["    Try again in a moment."] : []),
    ];
    throw new ExitError(message.join("\n"), 1, undefined, locked ? "locked" : "changed", {
      restored,
      skipped: result.skipped.map((s) => ({ file: s.file, reason: s.reason })),
    });
  }
  if (options.json) return pretty(undoJson(talk, result.operation, false, { restored, skipped: [] }));
  return [success(`Undid: ${result.operation.summary}`), ...pathLines(back, talk, 4)].join("\n");
}

// ─── The command ────────────────────────────────────────────────────

/**
 * With --json, an ExitError without stdout and any other error become one JSON object on stdout:
 * `{ version: 1, error: <kind>, message, …extra }`, the exit code kept. An ExitError that has its
 * own stdout - the ambiguous object - goes as it is.
 */
export async function withJsonErrors(args: string[], run: () => Promise<string>): Promise<string> {
  if (!args.includes("--json")) return run();
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExitError) {
      if (error.stdout !== undefined) throw error;
      const kind: ErrorKind = error.kind ?? (error.code === 2 ? "usage" : "not-found");
      const body = { version: 1, error: kind, message: error.message, ...error.extra };
      throw new ExitError(error.message, error.code, pretty(body), error.kind, error.extra);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ExitError(message, 1, pretty({ version: 1, error: "failed", message }), "failed");
  }
}

/**
 * `clausona skills|mcp|hooks <sub>`. Bad usage, an ambiguous name and a change with no terminal
 * and no --yes throw ExitError code 2; not found, refused, changed, locked, conflict, failed and
 * nothing to undo code 1.
 */
export async function runExtensionsCommand(
  command: ExtensionsCommand,
  args: string[],
  deps: {
    homeDir: string;
    cwd: string;
    registry: Registry;
    now?: number;
    columns?: number;
    /** Where to look for Claude Code's managed settings; tests point it at a file of their own. */
    managedSettings?: string;
    /** stdin and stdout are both TTYs; default false. */
    interactive?: boolean;
    /** Asks the question and resolves to the answer; required when interactive. */
    confirm?: (question: string) => Promise<boolean>;
    /** Default writeEnvFor(homeDir). */
    writeEnv?: WriteEnv;
    /** The git binary, for tests. */
    git?: string;
    /** Where a change's plan goes before the question; default stdout. */
    print?: (text: string) => void;
  },
): Promise<string> {
  const word = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : undefined;
  if (args.includes("--help") || args.includes("-h")) {
    return extensionsHelp(command, isSub(command, word) ? word : undefined);
  }
  const sub = word ?? "ls";
  if (!isSub(command, sub)) {
    throw badUsage(
      `Unknown subcommand '${sub}'. clausona ${command} takes ${either(SUBS[command])}. Run clausona ${command} --help.`,
    );
  }
  const options = await parseOptions(command, sub, word === undefined ? args : args.slice(1), deps.cwd, deps.homeDir);
  const columns = deps.columns ?? process.stdout.columns ?? 120;
  const talk: Talk = {
    command,
    options,
    homeDir: deps.homeDir,
    env: deps.writeEnv ?? writeEnvFor(deps.homeDir),
    columns,
    print:
      deps.print ??
      ((text) => {
        process.stdout.write(`${text}\n`);
      }),
    confirm: deps.interactive === true ? deps.confirm : undefined,
  };
  if (options.sub === "undo") return undoLast(talk);
  const inv = await loadInventory({
    homeDir: deps.homeDir,
    registry: deps.registry,
    cwd: options.project ?? deps.cwd,
    ...(deps.managedSettings !== undefined ? { managedSettings: deps.managedSettings } : {}),
  });
  const project = inv.currentProject;
  const now = deps.now ?? Date.now();
  if (options.sub === "show") return show(inv, command, options, project, now);
  if (options.sub !== "ls") return change(inv, talk, now, deps.git);

  const accounts = accountIds(inv, options.accounts);
  const scope = options.scope ?? "loaded";
  const rows = byName(
    options.tools
      .flatMap((tool) => rowsFor(inv, command, tool, scope, project, now))
      .filter((row) => heldBy(inv, row, accounts, project, scope === "loaded")),
  );
  if (options.json) {
    return pretty({
      version: 1,
      command,
      project: project ?? null,
      scope,
      tools: options.tools,
      items: rows.map((row) => jsonItem(inv, row, project, now)),
      warnings: inv.warnings,
    });
  }
  return listText(inv, command, options, rows, project, now, columns);
}

const GAP = 2;

/**
 * Cells padded to their column's widest, the last left as it is. When the terminal is narrow,
 * the `giveWay` columns are cut in turn, each to no less than 12 characters, until the row fits.
 */
function fitted(rows: string[][], width: number, giveWay: number[]): string[][] {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  let total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  for (const column of giveWay) {
    if (total <= width) break;
    const cut = Math.min(total - width, Math.max(0, (widths[column] ?? 0) - 12));
    widths[column] = (widths[column] ?? 0) - cut;
    total -= cut;
  }
  return rows.map((row) =>
    row.map((cell, c) => {
      const fit = truncate(cell, widths[c] ?? cell.length);
      return c === row.length - 1 ? fit : fit.padEnd(widths[c] ?? 0);
    }),
  );
}

/** `fitted`'s rows joined into lines. */
function table(rows: string[][], width: number, giveWay: number[]): string[] {
  return fitted(rows, width, giveWay).map((row) => row.join(" ".repeat(GAP)).trimEnd());
}

// ─── Help ───────────────────────────────────────────────────────────

/** docs/extensions.md, online, for a reader who has the help and not the repo. */
const DOCS_URL = "https://github.com/larcane97/clausona/blob/main/docs/extensions.md";

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

/** A page's examples, the descriptions in one column: 51, or past the longest described command. */
function examples(list: Example[]): string[] {
  const column = Math.max(
    EXAMPLE_COLUMN,
    ...list.map(([command, says]) => (says === undefined ? 0 : command.length + 2)),
  );
  return list.map(([command, says]) =>
    says === undefined ? `    ${command}` : `    ${command.padEnd(column)}${dim(says)}`,
  );
}

function section(title: string, lines: string[]): string[] {
  return [`  ${bold(title)}`, ...lines, ""];
}

/** `text` in lines of at most `width`: whole sentences while they fit, a longer one cut at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const add = (piece: string) => {
    const next = line === "" ? piece : `${line} ${piece}`;
    if (line !== "" && next.length > width) {
      lines.push(line);
      line = piece;
    } else {
      line = next;
    }
  };
  for (const sentence of text.split(/(?<=\.) /)) {
    if ((line === "" ? sentence : `${line} ${sentence}`).length <= width) add(sentence);
    else for (const word of sentence.split(" ")) add(word);
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Where the text after `EXIT CODES` starts, and how wide it may run. */
const EXIT_COLUMN = 15;
const PAGE_WIDTH = 100;

function exitCodes(text: string): string[] {
  const [first = "", ...rest] = wrap(text, PAGE_WIDTH - EXIT_COLUMN);
  return [`  ${bold("EXIT CODES")}   ${dim(first)}`, ...rest.map((line) => `${" ".repeat(EXIT_COLUMN)}${dim(line)}`)];
}

/** Where ids come from, and the docs' section on how they are made. */
const IDS = section("IDS", [
  `    ${dim('An id is the "id" field of ls --json. Pass it back as it is, to show --id or as the name.')}`,
  `    ${dim(`${DOCS_URL}#ids-and-row-keys`)}`,
]);

type WriteSub = Exclude<Sub, "ls" | "show">;

/** A change's page, after the title line and the sentence on what it does. */
type WritePage = {
  title: string;
  about: string;
  usage?: string;
  /** The page's own options, before the shared ones. */
  options: string[];
  /** Which shared options it leaves out or words its own way. */
  shared: { tool?: false; repeatable?: false; rm?: true; only?: readonly string[] };
  examples: Example[];
  exit: string;
};

const WRITE_EXIT =
  "0 done, or nothing to do · 1 refused, changed meanwhile or failed · 2 bad usage, several matches, or no terminal without --yes";
const UNDO_EXIT = "0 put back · 1 nothing to undo, or a file changed since · 2 bad usage or no terminal without --yes";

/** The options every change page shares, from --tool to --json. */
function sharedOptions(command: ExtensionsCommand, shared: WritePage["shared"]): string[] {
  const kind = command === "mcp" ? "server" : NOUN[command].one;
  const lines: [flag: string, lines: string[]][] = [
    ["--tool", [option("--tool <tool>", `claude | codex, when both have a ${kind} by this name`)]],
    [
      "--scope",
      [
        option("--scope <scope>", "Look in this scope only, to pick one copy:"),
        ...scopeList([...SCOPES[command]]).map(optionMore),
      ],
    ],
    [
      "--id",
      [
        option(
          "--id <id>",
          `An exact id, the "id" field of ls --json, instead of a name${shared.repeatable === false ? "" : " (repeatable)"}`,
        ),
      ],
    ],
    ["--project", [option("--project <path>", "The project to change it in, instead of the current dir (~ works)")]],
    [
      "--tracked",
      [
        shared.rm
          ? option("--tracked", "Delete it even if git tracks it, which changes the repo")
          : option("--tracked", "Allow a change to a file git tracks, which changes the repo"),
      ],
    ],
    ["--dry-run", [option("--dry-run", "Print what would change, and change nothing")]],
    ["--yes", [option("--yes, -y", "Do not ask first. Needed when there is no terminal")]],
    [
      "--json",
      [
        option("--json", "JSON output (version 1): the plan, or what changed. Its fields:"),
        optionMore(`${DOCS_URL}#json`),
      ],
    ],
  ];
  return lines
    .filter(([flag]) => (shared.only ? shared.only.includes(flag) : !(flag === "--tool" && shared.tool === false)))
    .flatMap(([, made]) => made);
}

const MCP_ACCOUNT = option("--account <name>", "Only this Claude account (repeatable)");

function undoPage(command: ExtensionsCommand): WritePage {
  return {
    title: `Put back what the last ${command} change changed`,
    about: `Takes the newest ${command} change not undone yet and puts back each file it changed, unless something else changed it since. Run it again to go one change further back.`,
    options: [],
    shared: { only: ["--dry-run", "--yes", "--json"] },
    examples: [
      [`clausona ${command} undo --dry-run`, "What the last change was"],
      [`clausona ${command} undo --yes`, "Put it back without asking"],
      [`clausona ${command} undo --json --yes`, "What was put back, as JSON"],
    ],
    exit: UNDO_EXIT,
  };
}

/** Each change's page per command; off and on share one. */
const WRITE_HELP: Record<ExtensionsCommand, Partial<Record<WriteSub, WritePage>>> = {
  skills: {
    off: {
      title: "Turn skills off or on",
      about: "In this project, for every account, unless --everywhere. Shows what will change and asks first.",
      options: [option("--everywhere", "In every project: your user settings (Codex: its config.toml)")],
      shared: {},
      examples: [
        ["clausona skills off eli5 --dry-run", "What turning eli5 off here would change"],
        ["clausona skills off old-one --everywhere --yes", "Off in every project, without asking"],
        ["clausona skills on eli5", "Back on in this project"],
      ],
      exit: WRITE_EXIT,
    },
    visibility: {
      title: "How much of a Claude skill Claude Code sees",
      about:
        "Sets it in this project, unless --everywhere: on (the full skill), name-only, user-invocable-only (only when you call it) or off.",
      usage: "clausona skills visibility <name> <on|name-only|user-invocable-only|off> [options]",
      options: [option("--everywhere", "In every project: your user settings")],
      // One skill at a time, and only Claude's has the levels.
      shared: { tool: false, repeatable: false },
      examples: [
        ["clausona skills visibility eli5 name-only --dry-run", "What it would change"],
        ["clausona skills visibility eli5 user-invocable-only", "Only when you call it, here"],
        ["clausona skills visibility eli5 on --everywhere", "The full skill everywhere"],
      ],
      exit: WRITE_EXIT,
    },
    rm: {
      title: "Delete skills",
      about:
        "Moves each folder into a backup first; a link is removed and its target kept. Shows what will change and asks first. clausona skills undo puts it back.",
      options: [],
      shared: { rm: true },
      examples: [
        ["clausona skills ls --scope unused --tool claude --json", "Find what has not been used"],
        ["clausona skills rm old-one --dry-run", "What deleting it would change"],
        ["clausona skills rm --id '<id>' --id '<id>' --yes", "Delete two exact rows without asking"],
      ],
      exit: WRITE_EXIT,
    },
    undo: undoPage("skills"),
  },
  mcp: {
    off: {
      title: "Turn MCP servers off or on",
      about:
        "In this project, for each Claude account that has opened it, unless --everywhere or --account. Shows what will change and asks first.",
      options: [
        option("--everywhere", "Claude: take it out of each account's .claude.json, kept by clausona to"),
        optionMore("put back with on --everywhere. Codex: enabled = false in its config.toml"),
        MCP_ACCOUNT,
      ],
      shared: {},
      examples: [
        ["clausona mcp off github --dry-run", "What turning github off here would change"],
        ["clausona mcp off github --account work --yes", "Off here for the work account only"],
        ["clausona mcp on github --everywhere", "Put it back in every account it was in"],
      ],
      exit: WRITE_EXIT,
    },
    rm: {
      title: "Delete MCP servers",
      about:
        "Deletes it from each account's .claude.json, its .mcp.json, or Codex's config.toml, backed up first. Shows what will change and asks first.",
      options: [MCP_ACCOUNT],
      shared: { rm: true },
      examples: [
        ["clausona mcp rm github --account work --dry-run", "What deleting it from work would change"],
        ["clausona mcp rm github --yes", "From every account that has it"],
        ["clausona mcp undo --yes", "Put it back"],
      ],
      exit: WRITE_EXIT,
    },
    undo: undoPage("mcp"),
  },
  hooks: {
    off: {
      title: "Turn hooks off or on, in every project",
      about:
        "Neither tool has a per-project switch for hooks: off takes the hook out of its settings file and clausona keeps it, so on can put it back.",
      options: [],
      shared: {},
      examples: [
        ["clausona hooks ls --json", "Find the hook's id"],
        ["clausona hooks off --id '<id>' --dry-run", "What turning it off would change"],
        ["clausona hooks on --id '<id>' --yes", "Put it back"],
      ],
      exit: WRITE_EXIT,
    },
    rm: {
      title: "Delete hooks",
      about: "Deletes it from its settings file, backed up first. Shows what will change and asks first.",
      options: [],
      shared: { rm: true },
      examples: [
        ["clausona hooks ls --scope global --json"],
        ["clausona hooks rm --id '<id>' --dry-run"],
        ["clausona hooks rm --id '<id>' --yes"],
      ],
      exit: WRITE_EXIT,
    },
    undo: undoPage("hooks"),
  },
};

/** A change's page: title, what it does, options, ids, examples, exit codes and the docs on changes. */
function writeHelp(command: ExtensionsCommand, sub: WriteSub): string {
  const name = sub === "on" ? "off" : sub;
  const page = WRITE_HELP[command][name];
  if (!page) return extensionsHelp(command);
  const words = name === "off" ? "off | on" : name;
  return [
    "",
    `  ${accent(`clausona ${command} ${words}`)} ${dim(`— ${page.title}`)}`,
    "",
    ...wrap(page.about, PAGE_WIDTH - 4).map((line) => `  ${dim(line)}`),
    "",
    ...(page.usage ? section("USAGE", [helpUsage(page.usage)]) : []),
    ...section("OPTIONS", [...page.options, ...sharedOptions(command, page.shared)]),
    // undo takes no id.
    ...(name === "undo" ? [] : IDS),
    ...section("EXAMPLES", examples(page.examples)),
    ...exitCodes(page.exit),
    "",
    `  ${dim("Backups, undo and why a change is refused:")}`,
    `  ${dim(`${DOCS_URL}#changing-things`)}`,
    "",
  ].join("\n");
}

/** `clausona <command> --help`, or a subcommand's page. Every line fits in 100 columns. */
export function extensionsHelp(command: ExtensionsCommand, sub?: Sub): string {
  if (sub !== undefined && sub !== "ls" && sub !== "show") return writeHelp(command, sub);
  const page = HELP[command];
  const { one, many } = NOUN[command];
  const mcp = command === "mcp";
  // ls lists Loaded by default, and show looks there first: what loads for the account.
  const account = mcp
    ? [
        option("--account <name>", "Only this Claude account (repeatable): in Loaded, the rows that"),
        optionMore("load for it; in any other scope, the rows it has"),
      ]
    : [];
  const project = option("--project <path>", "Look from another project instead of the current dir (~ works)");
  const json = [option("--json", "JSON output (version 1). Its fields:"), optionMore(`${DOCS_URL}#json`)];
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
        ...json,
      ]),
      ...IDS,
      ...section("EXAMPLES", examples(page.lsExamples)),
      `  ${bold("EXIT CODES")}   ${dim("0 ok · 1 error · 2 bad usage")}`,
      "",
    ].join("\n");
  }
  if (sub === "show") {
    const kind = command === "mcp" ? "server" : one;
    // Every value ls takes: one scope's rows, in place of the tiers below.
    const scopes = scopeList([...SCOPES[command]]).map(optionMore);
    return [
      "",
      `  ${accent(`clausona ${command} show`)} ${dim(`— Everything about one ${one}`)}`,
      "",
      ...page.showAbout.map((line) => `  ${dim(line)}`),
      "",
      ...section("OPTIONS", [
        option("--tool <tool>", `claude | codex, when both have a ${kind} by this name`),
        option("--scope <scope>", "Look in this scope only, to pick one copy:"),
        ...scopes,
        option("--id <id>", 'An exact id, the "id" field of ls --json, instead of a name'),
        ...account,
        project,
        ...json,
      ]),
      ...IDS,
      ...section("EXAMPLES", examples(page.showExamples)),
      `  ${bold("EXIT CODES")}   ${dim("0 ok · 1 not found or error · 2 bad usage or several matches")}`,
      "",
    ].join("\n");
  }
  const accountUsage = mcp ? " [--account <name>]" : "";
  // A hook goes by its id as often as by its name.
  const names = command === "hooks" ? "<id|name>…" : "<name>…";
  const subcommand = (name: string, text: string) => `    ${accent(name.padEnd(12))}${dim(text)}`;
  return [
    "",
    `  ${accent(`clausona ${command}`)} ${dim(`— ${page.about}`)}`,
    "",
    ...section("USAGE", [
      helpUsage(`clausona ${command} ls   [--scope <scope>] [--tool claude|codex] [--project <path>] [--json]`),
      helpUsage(`clausona ${command} show ${page.showArg} [--tool …] [--scope …] [--id <id>]${accountUsage} [--json]`),
      helpUsage(
        `clausona ${command} off|on ${names} [--everywhere]${mcp ? " [--account <name>]…" : ""} [--dry-run] [--yes] [--json]`,
      ),
      ...(command === "skills"
        ? [helpUsage("clausona skills visibility <name> <on|name-only|user-invocable-only|off> [--everywhere]")]
        : []),
      helpUsage(`clausona ${command} rm ${names} [--tracked] [--dry-run] [--yes] [--json]`),
      helpUsage(`clausona ${command} undo [--dry-run] [--yes] [--json]`),
    ]),
    ...section("SUBCOMMANDS", [
      subcommand("ls", `List ${many} ${page.lsSummary}`),
      subcommand("show", page.showSummary),
      subcommand(
        "off, on",
        command === "hooks"
          ? "Turn hooks off or on, in every project"
          : `Turn ${many} off or on, in this project or everywhere`,
      ),
      ...(command === "skills"
        ? [subcommand("visibility", "How much of a skill Claude sees: on, name-only, user-invocable-only, off")]
        : []),
      subcommand("rm", `Delete ${many}, backed up first`),
      subcommand("undo", `Put back what the last ${command} change changed`),
    ]),
    `  ${dim("Run")} ${accent(`clausona ${command} <subcommand> --help`)} ${dim("for options and examples.")}`,
    `  ${dim("Reference: docs/extensions.md (scopes, tags, ids, JSON fields), also at")}`,
    `  ${dim(DOCS_URL)}`,
    "",
  ].join("\n");
}
