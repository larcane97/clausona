import type { ToolName } from "../types.js";
import { statesByAccount } from "./describe.js";
import type { Extension, Inventory, SettingsLayer, SkillVisibility, StateFacts } from "./model.js";
import { isClaudeJson } from "./places.js";
import { stateHere, tilde, viewFrom } from "./present.js";
import { samePath } from "./read.js";
import { type ItemKind, isAccountServer, type ScopeRow } from "./scopes.js";
import { pluginState, stateOf } from "./state.js";
import type { SkillSelector } from "./writers/toml.js";

/**
 * What a write is asked to do - an action on some rows - and the words around it: why a row
 * cannot change, in the TUI's voice (keys) and the CLI's (flags); why an apply stopped; and
 * which way a toggle key goes. Pure: it reads the inventory and nothing else.
 */

export type ExtensionsCommand = "skills" | "mcp" | "hooks";

export const COMMAND_OF: Record<ItemKind, ExtensionsCommand> = { skill: "skills", mcp: "mcp", hook: "hooks" };

export type Verb = "off" | "on" | "visibility" | "rm";
export type Reach = "here" | "everywhere";

export type Action = {
  verb: Verb;
  /** here: space, v, and CLI off/on/visibility without --everywhere. everywhere: g and --everywhere. rm ignores it. */
  reach: Reach;
  rows: readonly ScopeRow[];
  /** visibility only. */
  level?: SkillVisibility;
  /** Claude MCP only: the profile ids to change; undefined = every account the rows have. */
  accounts?: readonly string[];
  /** Allow changes to what git tracks (CLI --tracked; the TUI's consent). */
  tracked?: boolean;
};

export const REFUSAL_CODES = [
  "plugin-item",
  "cloud-delete",
  "builtin-delete",
  "plugin-delete",
  "plugin-project-everywhere",
  "hook-here",
  "managed",
  "codex-user-here",
  "codex-untrusted",
  "codex-project-everywhere",
  "codex-home-here",
  "mcpjson-everywhere",
  "broken-link",
  "no-visibility",
  "no-project",
  "stashed-here",
  "stash-gone",
  "unreadable",
  "one-folder",
  "tracked",
  "no-account",
  "elsewhere",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** keys: what the TUI adds after the reason; flags: what the CLI adds. Either may be absent. */
export type Refusal = {
  rowKey: string;
  name: string;
  code: RefusalCode;
  reason: string;
  keys?: string;
  flags?: string;
};

/** One text, or one per tool where the tools differ. */
type Words = string | Readonly<Record<ToolName, string>>;

/**
 * Every refusal's words, verbatim. `{x}` is filled in by `refusal()`: `{Claude Code|Codex}` with
 * the row's tool, the rest from what the caller knows.
 */
export const REFUSALS: Readonly<Record<RefusalCode, { reason: Words; keys?: Words; flags?: Words }>> = {
  "plugin-item": {
    reason: "It comes with the plugin {plugin}.",
    keys: "Turn the plugin on or off in Plugins.",
    flags: "Turn the plugin on or off: clausona {command} off {plugin} --scope plugins.",
  },
  "cloud-delete": {
    reason: "It comes back from claude.ai.",
    keys: "Press space to turn it off instead.",
    flags: "Turn it off instead: clausona skills off {name}.",
  },
  "builtin-delete": {
    reason: "It comes with {Claude Code|Codex}.",
    keys: { claude: "Press space to turn it off instead.", codex: "Press g to turn it off instead." },
    flags: {
      claude: "Turn it off instead: clausona skills off {name}.",
      codex: "Turn it off instead: clausona skills off {name} --everywhere.",
    },
  },
  "plugin-delete": { reason: "Use /plugin in Claude Code to uninstall a plugin." },
  "plugin-project-everywhere": {
    reason: "It is installed for this project only.",
    keys: "Press space.",
    flags: "Leave out --everywhere.",
  },
  "hook-here": {
    reason: "{Claude Code|Codex} has no per-project switch for hooks.",
    keys: "Press g to turn it off everywhere.",
  },
  managed: { reason: "It is set by your organization's policy." },
  "codex-user-here": {
    reason: "Codex turns a user skill off everywhere or nowhere.",
    keys: "Press g.",
    flags: "Add --everywhere.",
  },
  "codex-untrusted": {
    reason: "Codex does not trust this project, so it ignores its .codex folder.",
    keys: "Trust the project in Codex first.",
    flags: "Trust the project in Codex first.",
  },
  "codex-project-everywhere": {
    reason: "It is defined in this project only.",
    keys: "Press space.",
    flags: "Leave out --everywhere.",
  },
  "codex-home-here": {
    reason: "In your home folder, Codex's project config is your user config.",
    keys: "Press g.",
    flags: "Add --everywhere.",
  },
  "mcpjson-everywhere": {
    reason: "Claude Code turns a .mcp.json server on or off per project.",
    keys: "Press space.",
    flags: "Leave out --everywhere.",
  },
  "broken-link": {
    reason: "Its link leads nowhere.",
    keys: "Press d to remove the link.",
    flags: "Remove the link: clausona skills rm {name}.",
  },
  "no-visibility": { reason: "Only a Claude skill has visibility levels." },
  "no-project": {
    reason: "There is no project to change it in.",
    keys: "Pick one with p.",
    flags: "Run it in a project, or pass --project <path>.",
  },
  "stashed-here": {
    reason: "It is off everywhere.",
    keys: "Press g to turn it back on.",
    flags: "Turn it back on with --everywhere.",
  },
  "stash-gone": {
    reason: "{~file}, where it came from, is gone.",
    keys: "Press d to delete the copy clausona kept.",
    flags: "Delete the copy clausona kept: clausona {command} rm --id {id}.",
  },
  unreadable: {
    reason: "{~file} could not be read.",
    keys: "Fix it, then try again.",
    flags: "Fix it, then try again.",
  },
  "one-folder": {
    reason: "It is the same folder as {Tool} › {Scope label} {name}, through a link.",
    keys: "Mark both with x and delete them together.",
    flags: "Delete both together: clausona skills rm --id {a} --id {b}.",
  },
  tracked: {
    reason: "Git tracks it in {project name}, so this changes the repo.",
    keys: "Press o to turn it off here instead, or y to go ahead.",
    flags: "Add --tracked to go ahead, or turn it off: clausona {command} off {name}.",
  },
  "no-account": { reason: "No account that has it has opened this project." },
  elsewhere: {
    reason: "It is turned off in {~file}, which applies here.",
    keys: "Change it there.",
    flags: "Change it there.",
  },
};

const TOOL_NAME: Record<ToolName, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * What a refusal's words name. `name` is the row's unless given (one-folder names the other
 * row's item); `~file` is already tilded; `a` and `b` are row ids.
 */
export type RefusalFill = Partial<
  Record<
    "name" | "plugin" | "command" | "~file" | "id" | "Tool" | "Scope label" | "a" | "b" | "project name" | "short",
    string
  >
>;

function filled(words: Words | undefined, tool: ToolName, values: Record<string, string>): string | undefined {
  if (words === undefined) return undefined;
  const text = typeof words === "string" ? words : words[tool];
  return text.replace(/\{([^{}]+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * What the TUI says instead of "Press d to delete the copy clausona kept." for one account's copy
 * of a server whose row holds other accounts' copies too: d on the row would delete theirs as well.
 */
export const ONE_ACCOUNT_KEYS = "Press d and choose only {short} in the dialog.";

/** The refusal `code` for a row of `tool`, its words filled in; `keysInstead` stands in for the table's keys words. */
export function refusal(
  code: RefusalCode,
  row: { key: string; name: string },
  tool: ToolName,
  fill: RefusalFill,
  keysInstead?: string,
) {
  const spec = REFUSALS[code];
  const values: Record<string, string> = { name: row.name, ...fill, "Claude Code|Codex": TOOL_NAME[tool] };
  const keys = filled(keysInstead ?? spec.keys, tool, values);
  const flags = filled(spec.flags, tool, values);
  const made: Refusal = {
    rowKey: row.key,
    name: row.name,
    code,
    reason: filled(spec.reason, tool, values) ?? "",
    ...(keys !== undefined ? { keys } : {}),
    ...(flags !== undefined ? { flags } : {}),
  };
  return made;
}

/** The reason, a space, then the keys or the flags when there are any. */
export function refusalText(refusal: Refusal, voice: "keys" | "flags"): string {
  const more = voice === "keys" ? refusal.keys : refusal.flags;
  return more ? `${refusal.reason} ${more}` : refusal.reason;
}

export type StopReason = "changed" | "locked" | "conflict" | "failed";
export type Stop = {
  file: string;
  reason: StopReason;
  detail?: string;
  name?: string;
  /**
   * For `conflict`: the stashed copy's item id (apply fills it from the change it stopped at),
   * which `rm --id` narrows the row to (`rowForId`), so the hint deletes that copy alone.
   */
  rowKey?: string;
};

/** Why an apply stopped, in words: the file from the home dir, then what to do in that voice. */
export function stopText(stop: Stop, voice: "keys" | "flags", homeDir: string, command: ExtensionsCommand): string {
  const file = tilde(stop.file, homeDir);
  switch (stop.reason) {
    case "changed":
      return `${file} changed since it was read. ${voice === "keys" ? "Press r and try again." : "Run the command again."}`;
    case "locked":
      return `Claude Code is saving ${file}. Try again in a moment.`;
    case "conflict": {
      const byId = `Delete the copy clausona kept: clausona ${command} rm --id ${stop.rowKey ?? "'<id>'"}.`;
      // A server back in an account's .claude.json is in the same row as the copy clausona kept,
      // in the same account: d there, whichever accounts are chosen, would delete it too.
      const next = voice === "flags" || isClaudeJson(stop.file) ? byId : "Press d to delete the copy clausona kept.";
      return `${stop.name ?? "It"} is back in ${file} already. ${next}`;
    }
    case "failed":
      return `Could not change ${file}: ${stop.detail ?? "unexpected error"}.`;
  }
}

/** The visibility `v` goes to next: on → name-only → user-invocable-only → off → on. */
export const NEXT_VISIBILITY: Record<SkillVisibility, SkillVisibility> = {
  on: "name-only",
  "name-only": "user-invocable-only",
  "user-invocable-only": "off",
  off: "on",
};

// ─── What the facts say, for the toggles here and for plan.ts ───────

/** A key of a settings map that is the map's own, so `constructor` or `toString` is no key. */
export function ownValue(map: Record<string, unknown> | undefined, key: string): unknown {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The map one settings layer holds: the user's, or a project's local or shared one. */
export function layerMap(
  entries: StateFacts["claudeSkillOverrides"],
  layer: Exclude<SettingsLayer, "managed">,
  project?: string,
): Record<string, unknown> | undefined {
  return entries.find((e) => e.layer === layer && (layer === "user" || samePath(e.project, project)))?.map;
}

/**
 * The `[[skills.config]]` entry `selector` names, as writers/toml.ts finds it: by name an entry
 * with no path, by path (samePath) one with no name - the inventory reads no entry with both,
 * as Codex ignores those. The last of several, as state.ts reads them.
 */
export function codexSkillEntry(inv: Inventory, selector: SkillSelector): { enabled: boolean } | undefined {
  let found: { enabled: boolean } | undefined;
  for (const entry of inv.facts.codexSkillConfig) {
    const named =
      "name" in selector
        ? entry.path === undefined && entry.name === selector.name
        : entry.name === undefined && entry.path !== undefined && samePath(entry.path, selector.path);
    if (named) found = entry;
  }
  return found;
}

/** `mcp_servers.<name>.enabled` as read in one config.toml. */
export function codexMcpEntry(
  inv: Inventory,
  file: string | undefined,
  name: string,
): { enabled: boolean } | undefined {
  return inv.facts.codexMcpEnabled.find((entry) => entry.name === name && samePath(entry.file, file));
}

/** Whether `profile`'s `.claude.json` has an entry for `project`: Claude Code made one when the account opened it. */
export function hasOpened(inv: Inventory, project: string | undefined, profile: string): boolean {
  return inv.projects.find((p) => samePath(p.path, project))?.profiles.includes(profile) === true;
}

/** Whether `profile`'s `.claude.json → projects[project].disabledMcpServers` names `name`. */
export function mcpDisabled(inv: Inventory, profile: string, project: string | undefined, name: string): boolean {
  return inv.facts.claudeMcpDisabled.some(
    (d) => d.profile === profile && samePath(d.project, project) && d.names.includes(name),
  );
}

/** Whether an action's accounts take `profile`: all of them when it names none, and what is no account's. */
export function chosenAccount(accounts: readonly string[] | undefined, profile: string | undefined): boolean {
  return accounts === undefined || profile === undefined || accounts.includes(profile);
}

/** Whether a row is off at that reach, as plan() reads "already off". */
function offAt(
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
  reach: Reach,
  accounts: readonly string[] | undefined,
): boolean {
  const first = row.items[0];
  if (!first) return false;
  const here = reach === "here";
  const isOff = (states: { value: string }[]) => states.length > 0 && states.every((s) => s.value === "off");
  switch (first.kind) {
    case "hook":
      return first.stashed !== undefined;
    case "plugin":
      return (
        pluginState(inv, first.location.plugin ?? first.name, here ? viewFrom(first, project) : undefined).value ===
        "off"
      );
    case "skill":
      if (here) return stateHere(inv, first, project).value === "off";
      return first.location.tool === "claude"
        ? ownValue(layerMap(inv.facts.claudeSkillOverrides, "user"), first.name) === "off"
        : codexSkillEntry(inv, { name: first.name })?.enabled === false;
    case "mcp": {
      if (first.location.tool === "codex") {
        return here
          ? stateHere(inv, first, project).value === "off"
          : codexMcpEntry(inv, inv.places.codexConfig, first.name)?.enabled === false;
      }
      if (!isAccountServer(first)) {
        const states = statesByAccount(inv, row, project)
          ?.filter((a) => chosenAccount(accounts, a.profile))
          .map((a) => a.state);
        return isOff(states ?? [stateHere(inv, first, project)]);
      }
      const copies = row.items.filter((copy) => chosenAccount(accounts, copy.location.profile));
      if (!here) return copies.length > 0 && copies.every((copy) => copy.stashed);
      // Here: what each account that has opened the project reads; a server kept by clausona is off.
      const states = copies.flatMap((copy: Extension) => {
        const profile = copy.location.profile ?? "";
        const seen = viewFrom(copy, project);
        if (copy.stashed) return [{ value: "off" }];
        return hasOpened(inv, seen, profile) ? [stateOf(inv, copy, seen, profile)] : [];
      });
      return isOff(states);
    }
  }
}

/** The verb a toggle key means for this row: "on" when it is off at that reach, else "off". */
export function toggleVerb(
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
  reach: Reach,
  accounts?: readonly string[],
): "off" | "on" {
  return offAt(inv, row, project, reach, accounts) ? "on" : "off";
}
