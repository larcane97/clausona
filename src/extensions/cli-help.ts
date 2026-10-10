import { accent, bold, dim, helpUsage } from "../lib/cli-style.js";
import type { ExtensionsCommand } from "./actions.js";
import type { ScopeId } from "./scopes.js";

/**
 * The words of `clausona skills|mcp|hooks`: what each command takes - its subcommands and its
 * scopes - what it calls its things, and every --help page. cli.ts parses and runs; this says.
 */

export type Sub = "ls" | "show" | "off" | "on" | "visibility" | "rm" | "undo";

/** What each command takes, in the order its help lists them: visibility is a Claude skill's alone. */
export const SUBS: Record<ExtensionsCommand, readonly Sub[]> = {
  skills: ["ls", "show", "off", "on", "visibility", "rm", "undo"],
  mcp: ["ls", "show", "off", "on", "rm", "undo"],
  hooks: ["ls", "show", "off", "on", "rm", "undo"],
};

export type Scope = ScopeId | "all";

/** The scopes each command has in either tool, in the order the help lists them. */
export const SCOPES: Record<ExtensionsCommand, readonly Scope[]> = {
  skills: ["loaded", "project", "global", "cloud", "plugins", "builtin", "other", "unused", "all"],
  mcp: ["loaded", "project", "parents", "global", "plugins", "managed", "other", "all"],
  hooks: ["loaded", "project", "global", "plugins", "managed", "other", "all"],
};

export const NOUN: Record<ExtensionsCommand, { one: string; many: string }> = {
  skills: { one: "skill", many: "skills" },
  mcp: { one: "MCP server", many: "MCP servers" },
  hooks: { one: "hook", many: "hooks" },
};

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

/** Where ids come from, where they go, and the docs' section on how they are made. */
function ids(where: string): string[] {
  return section("IDS", [
    `    ${dim(`An id is the "id" field of ls --json. Pass it back as it is, to ${where} or as the name.`)}`,
    `    ${dim(`${DOCS_URL}#ids-and-row-keys`)}`,
  ]);
}

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
    ...(name === "undo" ? [] : ids("--id here")),
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
      ...ids("show --id"),
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
      ...ids("show --id"),
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
        // Hooks are off or on everywhere: --everywhere changes nothing for them.
        `clausona ${command} off|on ${names}${command === "hooks" ? "" : " [--everywhere]"}${mcp ? " [--account <name>]…" : ""} [--dry-run] [--yes] [--json]`,
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
