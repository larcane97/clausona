import path from "node:path";

import { CLEANUP_GRACE_DAYS, CLEANUP_UNUSED_DAYS, folderKey, marksOf, usageOf } from "./inventory.js";
import type { EffectiveState, Extension, Inventory, StateValue } from "./model.js";
import {
  type AccountState,
  accountStates,
  projectName,
  shortProfile,
  stateHere,
  tilde,
  tildeIn,
  viewFrom,
} from "./present.js";
import { isWithin, pathKey, samePath } from "./read.js";
import {
  homeScope,
  type ItemKind,
  isAccountCopy,
  isAccountServer,
  pluginContents,
  rowKey,
  SCOPE_LABEL,
  type ScopeId,
  type ScopeRow,
  stateLoads,
  type ToolName,
} from "./scopes.js";
import { relevantIn } from "./state.js";

/**
 * The words the Extensions screen and the CLI say about a row: its tags, a hook's event in plain
 * words, how long ago, the details view's lines and the JSON v1 item. Pure, like scopes.ts: it
 * reads the inventory, and what it shows of an MCP server or a hook is the redacted summary.
 */

/** One of the verbatim tags: off, off here, off in N of M accounts, unused, broken link, pending approval, hidden by … copy. */
export type Tag = string;

export type DetailLine = { label?: string; text: string; tone?: "muted" | "warning" | "error" | "healthy" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TOOL_WORD: Record<ToolName, string> = { claude: "Claude", codex: "Codex" };
const TOOL_NAME: Record<ToolName, string> = { claude: "Claude Code", codex: "Codex" };
/** A kind's items in a word, as the headers say them. */
export const NOUN: Record<ItemKind, string> = { skill: "skills", mcp: "MCP servers", hook: "hooks" };

/** "38m ago", "5h ago", "13d ago", "3mo ago", "2y ago"; "never" for undefined. */
export function agoWords(then: number | undefined, now: number): string {
  if (then === undefined) return "never";
  const ms = Math.max(0, now - then);
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 60 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo ago`;
  return `${Math.floor(ms / (365 * DAY))}y ago`;
}

/** The events whose matcher names a tool. Maps, so an event named like an object's own key is unknown. */
const TOOL_EVENTS = new Map<string, (tool: string) => string>([
  ["PreToolUse", (tool) => `Before ${tool} runs`],
  ["PostToolUse", (tool) => `After ${tool} runs`],
  ["PostToolUseFailure", (tool) => `After ${tool} fails`],
]);

/** The other events, in words that name the hook's own tool where they name one: "Claude", "Codex". */
const EVENTS = new Map<string, (who: string) => string>([
  ["UserPromptSubmit", () => "When you send a message"],
  ["Notification", (who) => `When ${who} sends a notification`],
  ["Stop", (who) => `When ${who} finishes replying`],
  ["SubagentStop", () => "When a subagent finishes"],
  ["SessionStart", () => "When a session starts"],
  ["SessionEnd", () => "When a session ends"],
  ["PreCompact", () => "Before the conversation is compacted"],
  ["PermissionRequest", (who) => `When ${who} asks for permission`],
  ["Interrupt", () => "When you interrupt"],
  ["StopFailure", () => "When replying fails"],
]);

/** A hook in plain words: "Before Bash runs", "When Claude finishes replying", "When Codex finishes replying". */
export function hookWhen(item: Extension): string {
  // The sources name a hook "<Event> <matcher>", or "<Event>" when it has no matcher.
  const space = item.name.indexOf(" ");
  const event = space < 0 ? item.name : item.name.slice(0, space);
  const matcher = space < 0 ? undefined : item.name.slice(space + 1);
  const tool = TOOL_EVENTS.get(event);
  if (tool) return tool(matcher === undefined || matcher === "*" ? "any tool" : matcher);
  const words = EVENTS.get(event)?.(TOOL_WORD[item.location.tool]) ?? event;
  return matcher === undefined ? words : `${words} (${matcher})`;
}

/** A plugin's name without its marketplace: `superpowers@official` is `superpowers`. */
function pluginName(item: Extension): string {
  const id = item.location.plugin ?? item.name;
  return id.split("@")[0] ?? id;
}

/**
 * Where a row in Loaded comes from: "Project", "Global", "Cloud", the `.mcp.json` of a
 * parent folder ("~/.mcp.json", "~/repos/.mcp.json"), the plugin's name, "Built-in", "Managed".
 */
export function fromLabel(item: Extension, inv: Inventory, project: string | undefined): string {
  const scope = homeScope(item, project);
  if (scope === "plugins" || (scope === "other" && item.location.scope === "plugin")) return pluginName(item);
  if (scope === "parents") return tilde(item.location.file, inv.homeDir);
  if (scope === "other") return projectName(item.location.project ?? "", inv);
  if (scope === "builtin") return "Built-in";
  return SCOPE_LABEL[scope](item.location.tool);
}

/**
 * Where a row is, as a WHERE column says it: FROM's words, "Project" for this project's own and
 * "Global" for the user's, and for another project's own, that project's name - a plugin
 * installed for it too.
 */
export function whereLabel(item: Extension, inv: Inventory, project: string | undefined): string {
  return homeScope(item, project) === "other"
    ? projectName(item.location.project ?? "", inv)
    : fromLabel(item, inv, project);
}

/**
 * The state of each account that has a row of copies - a Claude MCP server several accounts'
 * .claude.json define, a Cloud skill, a plugin's installs and what they bring - each read in its
 * own copy, primary first; or of a `.mcp.json` or plugin server every account sees
 * (`accountStates`). Undefined for every other row, which has one state.
 */
export function statesByAccount(
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
): AccountState[] | undefined {
  const first = firstOf(row);
  if (!isAccountCopy(first)) return accountStates(inv, first, project);
  const states = new Map<string, EffectiveState>();
  for (const copy of row.items) {
    const loc = copy.location;
    // One account's own copy, or an install every account that has it reads alike - a plugin's
    // server per account, as its switch is.
    const own =
      loc.profile !== undefined
        ? [{ profile: loc.profile, state: stateHere(inv, copy, project) }]
        : (accountStates(inv, copy, project) ??
          (loc.accounts ?? []).map((profile) => ({ profile, state: stateHere(inv, copy, project) })));
    for (const { profile, state } of own) if (!states.has(profile)) states.set(profile, state);
  }
  if (states.size === 0) return undefined;
  const rank = (profile: string) => {
    const at = inv.claudeProfiles.indexOf(profile);
    return at < 0 ? inv.claudeProfiles.length : at;
  };
  return [...states].map(([profile, state]) => ({ profile, state })).sort((a, b) => rank(a.profile) - rank(b.profile));
}

/** A row's first item: its only one, or the primary-most account's copy. Rows are never empty. */
function firstOf(row: ScopeRow): Extension {
  const first = row.items[0];
  if (!first) throw new Error(`Row ${row.key} has no items.`);
  return first;
}

/**
 * The same-name copy that wins over a row here in every account that has it, each read on its
 * own (`statesByAccount`): undefined when the row loads, or is hidden, in some accounts only.
 * Of copies that win in different accounts, the primary-most account's names it.
 */
function winnerOf(inv: Inventory, row: ScopeRow, project: string | undefined): Extension | undefined {
  const states = statesByAccount(inv, row, project)?.map((a) => a.state) ?? [stateHere(inv, firstOf(row), project)];
  const id = states.length > 0 && states.every((s) => s.shadowedBy) ? states[0]?.shadowedBy : undefined;
  return id === undefined ? undefined : inv.items.find((i) => i.id === id);
}

/**
 * Whether a row is a copy that a same-name copy wins over here, in every account. Claude Code
 * records a skill's use by name, under the copy that wins, and a hidden copy never loads: the
 * table's USES and LAST USED read "—" for it, and its details say where its use is counted.
 */
export function hiddenHere(inv: Inventory, row: ScopeRow, project: string | undefined): boolean {
  return winnerOf(inv, row, project) !== undefined;
}

/**
 * Whether a row loads here for one of `profiles`, as Loaded reads it, account by account:
 * relevant here, not a broken link, and that account's state loads (`stateLoads`). A row read in
 * one state for every account loads for each account that has it.
 */
export function loadsFor(inv: Inventory, row: ScopeRow, project: string | undefined, profiles: string[]): boolean {
  const item = firstOf(row);
  if (!relevantIn(item, project) || item.link?.broken === true) return false;
  const perAccount = statesByAccount(inv, row, project);
  if (perAccount) return perAccount.some((a) => profiles.includes(a.profile) && stateLoads(a.state));
  const who = rowAccounts(inv, row);
  return (who === undefined || who.some((p) => profiles.includes(p))) && stateLoads(stateHere(inv, item, project));
}

/**
 * A row's USES and LAST USED, the same in `ls` and on the screen: the total across accounts, and
 * how long ago it was last used, "never" when it never was (the spec's Tables). Both "—" where
 * there is no use to count: a Codex skill (Codex keeps no record), a plugin (its use is its
 * skills'), a hidden copy (its use is counted under the copy that wins: a count on both rows
 * would read twice).
 */
export function usageCells(
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
  now: number,
): [uses: string, lastUsed: string] {
  const item = firstOf(row);
  if (item.kind !== "skill" || item.location.tool !== "claude" || hiddenHere(inv, row, project)) return ["—", "—"];
  const usage = usageOf(inv, row.items);
  return [String(usage?.total ?? 0), agoWords(usage?.lastUsedAt, now)];
}

/**
 * Whether a setting was read from a project's own place: its `.claude/settings*.json`, an
 * account's `.claude.json` entry for it, or its `.codex/config.toml`. Told from the facts the
 * sources recorded with a project, not from where the file is: in the home dir every file is
 * under the project, `~/.claude/settings.json` too, and that one is the user's.
 */
function isProjectSetting(inv: Inventory, file: string): boolean {
  const facts = inv.facts;
  const key = pathKey(file);
  const at = (entry: { file: string; project?: string }) => entry.project !== undefined && pathKey(entry.file) === key;
  return (
    facts.claudeSkillOverrides.some(at) ||
    facts.claudeEnabledPlugins.some(at) ||
    facts.claudeMcpDisabled.some(at) ||
    facts.claudeMcpjson.some(at) ||
    facts.codexMcpEnabled.some(at)
  );
}

function scopeLabel(item: Extension, project: string | undefined): string {
  return SCOPE_LABEL[homeScope(item, project)](item.location.tool);
}

/** Every tag that applies, most important first: broken link > off > off here > off in N of M accounts > pending approval > hidden by … > unused. */
export function tagsOf(inv: Inventory, row: ScopeRow, project: string | undefined, now: number): Tag[] {
  const item = firstOf(row);
  const tags: Tag[] = [];
  const broken = item.link?.broken === true;
  if (broken) tags.push("broken link");
  const perAccount = statesByAccount(inv, row, project);
  const states = perAccount?.map((a) => a.state) ?? [stateHere(inv, item, project)];
  const off = states.filter((s) => s.value === "off");
  if (states.length > 0 && off.length === states.length) {
    const here = off.every((s) => s.setBy !== undefined && isProjectSetting(inv, s.setBy.file));
    tags.push(here ? "off here" : "off");
  } else if (perAccount && off.length > 0) {
    tags.push(`off in ${off.length} of ${states.length} accounts`);
  }
  if (states.length > 0 && states.every((s) => s.value === "pending-approval")) tags.push("pending approval");
  // Hidden in every account: hidden in some only, the row still loads here.
  const winner = winnerOf(inv, row, project);
  if (winner) tags.push(`hidden by ${scopeLabel(winner, project)} copy`);
  if (!broken && marksOf(inv, item, now).includes("cleanup")) tags.push("unused");
  return tags;
}

/** What a skill's, a server's or a hook's global row is in, as the header names it. */
function globalPlace(item: Extension): string {
  if (item.kind !== "skill") return item.location.file;
  const file = item.location.file;
  // A legacy command is a file in commands/, or in one folder below it.
  if (item.summary?.type === "command")
    return item.summary.namespace ? path.dirname(path.dirname(file)) : path.dirname(file);
  return path.dirname(file);
}

/** What a project's own files are, per tool and kind, for the project at `here`. */
const PROJECT_FILES: Record<ToolName, Record<ItemKind, (here: string) => string>> = {
  claude: {
    skill: (here) => `.claude/skills and .claude/commands in ${here}`,
    mcp: (here) => `.mcp.json in ${here}, and each account's entry for it in .claude.json`,
    hook: (here) => `.claude/settings.json and .claude/settings.local.json in ${here}`,
  },
  codex: {
    skill: (here) => `.agents/skills in ${here}`,
    mcp: (here) => `.codex/config.toml in ${here}`,
    hook: (here) => `.codex/hooks.json in ${here}`,
  },
};

const GLOBAL_FALLBACK: Record<ToolName, Record<ItemKind, string>> = {
  claude: { skill: "your skills folder", mcp: "each account's .claude.json", hook: "your user settings" },
  codex: {
    skill: "~/.agents/skills and Codex's skills folder",
    mcp: "Codex's config.toml",
    hook: "Codex's hooks.json",
  },
};

/** The items of a tool and kind whose home is `scope`, seen from `project`. */
function inScope(
  inv: Inventory,
  tool: ToolName,
  kind: ItemKind,
  scope: ScopeId,
  project: string | undefined,
): Extension[] {
  return inv.items.filter((i) => i.kind === kind && i.location.tool === tool && homeScope(i, project) === scope);
}

/** A list of places that stays one line: two, then how many more. */
function fewPlaces(places: string[]): string {
  return places.length <= 2 ? places.join(", ") : `${places.slice(0, 2).join(", ")} and ${places.length - 2} more`;
}

function sentence(scope: ScopeId, tool: ToolName, kind: ItemKind, inv: Inventory, project: string | undefined): string {
  const here = project === undefined ? undefined : tilde(project, inv.homeDir);
  const loads = kind === "hook" ? "runs" : "loads";
  switch (scope) {
    case "loaded":
      if (here === undefined) return `what ${TOOL_NAME[tool]} ${loads} with no project`;
      return `what ${TOOL_NAME[tool]} ${loads} in ${here}${tool === "claude" ? ", in at least one account" : ""}`;
    case "project":
      return here === undefined ? "no project · pick one with p" : PROJECT_FILES[tool][kind](here);
    case "parents": {
      // Nearest first, as Claude Code lets the nearest file win a name.
      const dirs = [...new Set(inScope(inv, tool, kind, "parents", project).map((i) => i.location.project ?? ""))]
        .sort((a, b) => b.length - a.length)
        .map((dir) => tilde(dir, inv.homeDir));
      return dirs.length === 0
        ? ".mcp.json files in folders above this project · load here too"
        : `.mcp.json in ${fewPlaces(dirs)} · loads here too`;
    }
    case "global": {
      if (tool === "claude" && kind === "mcp")
        return `user servers in each account's .claude.json · ${loads} in every project`;
      const places = [
        ...new Set(inScope(inv, tool, kind, "global", project).map((item) => tilde(globalPlace(item), inv.homeDir))),
      ];
      return `${places.length === 0 ? GLOBAL_FALLBACK[tool][kind] : fewPlaces(places)} · ${loads} in every project`;
    }
    case "cloud":
      return "skills on your claude.ai accounts, different per account";
    case "plugins":
      return `plugins that bring ${NOUN[kind]}, installed for you or for this project`;
    case "builtin":
      return tool === "claude"
        ? "skills that come with Claude Code · only the ones your settings name"
        : "skills that come with Codex · in its skills/.system folder";
    case "managed":
      return "your organization's managed settings · apply in every project";
    case "other":
      return `projects with ${NOUN[kind]} of their own · they load there, not here`;
    case "unused":
      return `not used in ${CLEANUP_UNUSED_DAYS} days in any account, or never used and older than ${CLEANUP_GRACE_DAYS} days`;
  }
}

/**
 * The table's header line: the scope's name in caps, a dash, and one plain sentence saying what
 * the scope is - "GLOBAL — ~/.claude/skills · loads in every project".
 */
export function scopeSentence(
  scope: ScopeId,
  tool: ToolName,
  kind: ItemKind,
  inv: Inventory,
  project: string | undefined,
): string {
  return `${SCOPE_LABEL[scope](tool).toUpperCase()} — ${sentence(scope, tool, kind, inv, project)}`;
}

/**
 * Where a setting is, in words: "this project's .claude/settings.local.json", "this project's
 * entry in ~/.claude-work/.claude.json", or the file's path for one of the user's.
 */
function settingPlace(inv: Inventory, item: Extension, project: string | undefined, file: string): string {
  if (!isProjectSetting(inv, file)) return tilde(file, inv.homeDir);
  const here = viewFrom(item, project);
  const whose = here === undefined || samePath(here, project) ? "this project's" : `${projectName(here, inv)}'s`;
  // An account's .claude.json holds an entry per project, wherever the file is.
  const inside = here !== undefined && path.basename(file) !== ".claude.json" && isWithin(file, here);
  return `${whose} ${inside ? path.relative(here, file) : `entry in ${tilde(file, inv.homeDir)}`}`;
}

/** A state in words, and where it is set when that matters: off, and where it is turned off. */
function stateParts(
  inv: Inventory,
  item: Extension,
  project: string | undefined,
  state: EffectiveState,
): { word: string; because?: string } {
  if (state.shadowedBy) {
    const winner = inv.items.find((i) => i.id === state.shadowedBy);
    return { word: winner ? `hidden by the ${scopeLabel(winner, project)} copy` : "hidden by another copy" };
  }
  if (state.value === "pending-approval") return { word: "pending approval" };
  if (state.value !== "off") return { word: "on" };
  return state.setBy ? { word: "off", because: settingPlace(inv, item, project, state.setBy.file) } : { word: "off" };
}

/** A state as one account line says it: "on", "off (this project's …)", "pending approval". */
function stateWords(inv: Inventory, item: Extension, project: string | undefined, state: EffectiveState): string {
  const { word, because } = stateParts(inv, item, project, state);
  return because === undefined ? word : `${word} (${because})`;
}

/**
 * Which accounts have a row, primary first, or undefined when every account of its tool has it.
 * A copy is its own account's, or its install's accounts'; a copy with neither - a `.mcp.json` or
 * managed server, a Codex item - is every account's. Never an empty list.
 */
export function rowAccounts(inv: Inventory, row: ScopeRow): string[] | undefined {
  const lists = row.items.map((copy) =>
    copy.location.profile !== undefined ? [copy.location.profile] : copy.location.accounts,
  );
  if (lists.some((list) => list === undefined || list.length === 0)) return undefined;
  const who = [...new Set(lists.flat() as string[])];
  if (firstOf(row).location.tool === "claude" && inv.claudeProfiles.every((p) => who.includes(p))) return undefined;
  const rank = (profile: string) => {
    const at = inv.claudeProfiles.indexOf(profile);
    return at < 0 ? inv.claudeProfiles.length : at;
  };
  return who.sort((a, b) => rank(a) - rank(b));
}

/** A Claude row's ACCOUNTS cell: "all", "2 of 3", or the one account's short name; "—" for Codex. */
export function accountsWord(inv: Inventory, row: ScopeRow): string {
  if (firstOf(row).location.tool !== "claude") return "—";
  const who = rowAccounts(inv, row);
  if (who === undefined) return "all";
  return who.length === 1 ? shortProfile(who[0] ?? "") : `${who.length} of ${inv.claudeProfiles.length}`;
}

/**
 * Where a row loads, in words: a skill, a hook, a plugin. Accounts in different states say each
 * ("on in share, dalsoo · off in work (…)"); else the one state, and which accounts have it when
 * not every Claude account does.
 */
function loadedLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  const item = firstOf(row);
  // A link to nothing has no SKILL.md to read, whatever the settings say.
  if (item.link?.broken) return [{ label: "Loaded", text: "no, its link leads nowhere", tone: "error" }];
  const perAccount = statesByAccount(inv, row, project);
  const parts = perAccount?.map((a) => ({ name: shortProfile(a.profile), ...stateParts(inv, item, project, a.state) }));
  const groups = new Map<string, { word: string; because?: string; names: string[] }>();
  for (const part of parts ?? []) {
    const key = `${part.word}\0${part.because ?? ""}`;
    const group = groups.get(key) ?? { word: part.word, ...(part.because ? { because: part.because } : {}), names: [] };
    group.names.push(part.name);
    groups.set(key, group);
  }
  if (groups.size > 1) {
    const text = [...groups.values()]
      .map((g) => `${g.word} in ${g.names.join(", ")}${g.because === undefined ? "" : ` (${g.because})`}`)
      .join(" · ");
    return [{ label: "Loaded", text }];
  }
  const state = perAccount?.[0]?.state ?? stateHere(inv, item, project);
  if (state.shadowedBy) {
    const winner = inv.items.find((i) => i.id === state.shadowedBy);
    const text = winner
      ? `no, the ${scopeLabel(winner, project)} copy wins (${tilde(winner.location.file, inv.homeDir)})`
      : "no, another copy wins";
    return [{ label: "Loaded", text, tone: "muted" }];
  }
  if (state.value === "off") {
    if (!state.setBy) return [{ label: "Loaded", text: "off: no settings file turns it on", tone: "warning" }];
    const place = settingPlace(inv, item, project, state.setBy.file);
    const here = isProjectSetting(inv, state.setBy.file);
    return [{ label: "Loaded", text: `${here ? "off here" : "off everywhere"} (${place})`, tone: "warning" }];
  }
  if (state.value === "pending-approval") return [{ label: "Loaded", text: "pending approval here", tone: "warning" }];
  const own = item.location.project;
  const where = own === undefined ? "every project" : samePath(own, project) ? "this project" : projectName(own, inv);
  // Codex profiles share one configuration: no account to name, but a profile's own skills folder.
  if (item.location.tool === "codex") {
    const profile = item.location.profile;
    return [{ label: "Loaded", text: `on in ${where}${profile ? `, for profile ${shortProfile(profile)}` : ""}` }];
  }
  const who = perAccount?.map((a) => a.profile) ?? rowAccounts(inv, row);
  if (who === undefined || inv.claudeProfiles.every((p) => who.includes(p))) {
    return [{ label: "Loaded", text: `on in every account, ${where}` }];
  }
  if (who.length === 1) return [{ label: "Loaded", text: `on in ${shortProfile(who[0] ?? "")}, ${where}` }];
  return [
    { label: "Loaded", text: `on in ${who.length} accounts, ${where}` },
    { label: "", text: who.map(shortProfile).join(", ") },
  ];
}

/** Each account's state of an MCP server, one line each, and "on in every account" when that says it all. */
function accountLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  const item = firstOf(row);
  const perAccount = statesByAccount(inv, row, project);
  if (!perAccount) {
    const words = stateWords(inv, item, project, stateHere(inv, item, project));
    return [{ label: "Accounts", text: `${words} in every account` }];
  }
  const words = perAccount.map((a) => ({
    name: shortProfile(a.profile),
    words: stateWords(inv, item, project, a.state),
  }));
  const every = inv.claudeProfiles.every((p) => perAccount.some((a) => a.profile === p));
  if (every && new Set(words.map((w) => w.words)).size === 1) {
    return [{ label: "Accounts", text: `${words[0]?.words} in every account` }];
  }
  // A server in accounts' own .claude.json is not in the others; a shared one is in each that opened the project.
  const others = isAccountServer(item) && !every;
  const rows = [...words, ...(others ? [{ name: "others", words: "not added" }] : [])];
  const width = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r, i) => ({ label: i === 0 ? "Accounts" : "", text: `${r.name.padEnd(width)}  ${r.words}` }));
}

/** Same-name skills elsewhere, a row's worth at a time: every account's Cloud copy is one. */
type Copy = { item: Extension; items: Extension[]; sameFolder: boolean; sameContent: boolean | undefined };

/** The same-name skills outside the row: either tool, any scope, Claude's first. */
function copiesOf(inv: Inventory, row: ScopeRow, project: string | undefined): Copy[] {
  const item = firstOf(row);
  if (item.kind !== "skill") return [];
  const members = new Set(row.items.map((i) => i.id));
  const groups = new Map<string, Extension[]>();
  for (const other of inv.items) {
    if (other.kind !== "skill" || members.has(other.id) || other.name !== item.name) continue;
    const key = rowKey(other);
    groups.set(key, [...(groups.get(key) ?? []), other]);
  }
  const order: string[] = ["project", "parents", "global", "cloud", "plugins", "builtin", "managed", "other"];
  return [...groups.values()]
    .map((items) => {
      const verdicts = items.map((other) => {
        const sameFolder = !item.link?.broken && !other.link?.broken && folderKey(item) === folderKey(other);
        const [mine, theirs] = [inv.hashes[item.id], inv.hashes[other.id]];
        return {
          sameFolder,
          sameContent: sameFolder || (mine !== undefined && theirs !== undefined ? mine === theirs : undefined),
        };
      });
      const contents = new Set(verdicts.map((v) => v.sameContent));
      return {
        item: items[0] as Extension,
        items,
        sameFolder: verdicts.every((v) => v.sameFolder),
        // Said only when every copy in the group agrees.
        sameContent: contents.size === 1 ? verdicts[0]?.sameContent : undefined,
      };
    })
    .sort(
      (a, b) =>
        Number(a.item.location.tool !== "claude") - Number(b.item.location.tool !== "claude") ||
        order.indexOf(homeScope(a.item, project)) - order.indexOf(homeScope(b.item, project)) ||
        (a.item.location.project ?? "").localeCompare(b.item.location.project ?? ""),
    );
}

function alsoInLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  return copiesOf(inv, row, project).map((copy, i) => {
    const loc = copy.item.location;
    const scope = homeScope(copy.item, project);
    const place = scope === "other" ? projectName(loc.project ?? "", inv) : scopeLabel(copy.item, project);
    const owners = copy.items.flatMap((c) => (c.location.profile ? [shortProfile(c.location.profile)] : []));
    const account = owners.length === 1 ? ` · ${owners[0]}` : owners.length > 1 ? ` · ${owners.length} accounts` : "";
    const note = copy.sameFolder
      ? " (same folder)"
      : copy.sameContent === undefined
        ? ""
        : copy.sameContent
          ? " (same content)"
          : " (different content)";
    return { label: i === 0 ? "Also in" : "", text: `${TOOL_WORD[loc.tool]} › ${place}${account}${note}` };
  });
}

/** How Claude Code shows a skill at a visibility short of the full skill. */
const SHOWS_AS: Partial<Record<StateValue, string>> = {
  "name-only": "name only",
  "user-invocable-only": "only when you call it",
};

function skillLines(inv: Inventory, row: ScopeRow, project: string | undefined, now: number): DetailLine[] {
  const item = firstOf(row);
  const loc = item.location;
  const lines: DetailLine[] = [];
  if (item.description) lines.push({ text: item.description });
  // A Claude built-in skill has no folder: its file is the settings file that names it.
  if (!(loc.tool === "claude" && loc.scope === "builtin")) {
    const folder = item.summary?.type === "command" || item.link?.broken;
    lines.push({ label: "File", text: tilde(folder ? loc.file : path.join(loc.file, "SKILL.md"), inv.homeDir) });
    // Each account's copy is a folder of its own; the first stands for them.
    const more = row.items.length - 1;
    if (more > 0) lines.push({ label: "", text: `and ${more} more ${more === 1 ? "copy" : "copies"}`, tone: "muted" });
  }
  if (item.link) {
    const broken = item.link.broken;
    lines.push({
      label: "Link to",
      text: `${tilde(item.link.target, inv.homeDir)}${broken ? " (missing)" : ""}`,
      tone: broken ? "error" : "muted",
    });
  }
  lines.push(...loadedLines(inv, row, project));
  const state = stateHere(inv, item, project);
  if (loc.tool === "claude") lines.push(...usedLines(inv, row, project, now));
  lines.push(...alsoInLines(inv, row, project));
  const shows = SHOWS_AS[state.value];
  if (shows !== undefined) {
    const from = state.setBy ? ` (${settingPlace(inv, item, project, state.setBy.file)})` : "";
    lines.push({ label: "Shows as", text: `${shows}${from}` });
  }
  return lines;
}

function usedLines(inv: Inventory, row: ScopeRow, project: string | undefined, now: number): DetailLine[] {
  if (hiddenHere(inv, row, project))
    return [{ label: "Used", text: "counted under the copy that wins", tone: "muted" }];
  const usage = usageOf(inv, row.items);
  if (!usage || (usage.total === 0 && usage.lastUsedAt === undefined)) {
    // The time the not-used rule reads (birth time, else mtime), so its 14 days' grace shows.
    const born = row.items.flatMap((copy) => (copy.createdAt === undefined ? [] : [copy.createdAt]));
    const added = born.length === 0 ? "" : ` · added ${agoWords(Math.min(...born), now)}`;
    return [{ label: "Used", text: `never, in any account${added}`, tone: "muted" }];
  }
  const last = usage.lastUsedAt === undefined ? "" : ` · last ${agoWords(usage.lastUsedAt, now)}`;
  const lines: DetailLine[] = [
    { label: "Used", text: `${usage.total} ${usage.total === 1 ? "time" : "times"}${last}` },
  ];
  const byAccount = Object.entries(usage.byProfile)
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([profile, count]) => `${shortProfile(profile)} ${count}`);
  if (byAccount.length > 0) lines.push({ label: "", text: byAccount.join(" · ") });
  return lines;
}

/** Names of a server's env vars and headers: the summary holds no values. */
function secretNames(summary: Record<string, string> | undefined): string[] {
  return [summary?.env, summary?.headers].flatMap((list) => (list ? list.split(", ").filter(Boolean) : []));
}

function mcpLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  const lines: DetailLine[] = [];
  // Each account's copy can run another command: then each line says whose it is.
  const runs = row.items.flatMap((copy) => {
    const text = copy.summary?.command ?? copy.summary?.url;
    return text ? [{ text: tildeIn(text, inv.homeDir), who: shortProfile(copy.location.profile ?? "") }] : [];
  });
  const commands = [...new Set(runs.map((r) => r.text))];
  commands.forEach((text, i) => {
    const who = runs.filter((r) => r.text === text).map((r) => r.who);
    lines.push({ label: i === 0 ? "Runs" : "", text: commands.length === 1 ? text : `${text} (in ${who.join(", ")})` });
  });
  const secrets = [...new Set(row.items.flatMap((copy) => secretNames(copy.summary)))];
  if (secrets.length > 0) {
    lines.push({
      label: "Secrets",
      text: `${secrets.join(", ")} (${secrets.length === 1 ? "value" : "values"} hidden)`,
    });
  }
  // Codex has no accounts here: its server has one state, said as a skill's is.
  lines.push(
    ...(firstOf(row).location.tool === "codex" ? loadedLines(inv, row, project) : accountLines(inv, row, project)),
  );
  row.items.forEach((copy, i) => {
    const loc = copy.location;
    const entry =
      loc.scope === "local" && loc.project !== undefined
        ? ` (${samePath(loc.project, project) ? "this project's" : `${projectName(loc.project, inv)}'s`} entry)`
        : "";
    lines.push({ label: i === 0 ? "File" : "", text: `${tilde(loc.file, inv.homeDir)}${entry}` });
  });
  return lines;
}

function hookLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  const item = firstOf(row);
  const lines: DetailLine[] = [{ label: "When", text: hookWhen(item).replace(/^When /, "") }];
  const runs = item.summary?.command ?? item.summary?.prompt;
  if (runs) lines.push({ label: "Runs", text: tildeIn(runs, inv.homeDir) });
  lines.push({ label: "File", text: tilde(item.location.file, inv.homeDir) });
  // A plugin's hook is off with its plugin: say where, as for any item that is off.
  if (stateHere(inv, item, project).value !== "on") lines.push(...loadedLines(inv, row, project));
  return lines;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What a plugin row brings, the kinds it has, for a CONTAINS cell: "14 skills · 1 hook", or "—". */
export function containsWords(inv: Inventory, row: ScopeRow): string {
  const contents = pluginContents(inv, row);
  const parts = [
    contents.skill.length > 0 ? count(contents.skill.length, "skill") : "",
    contents.mcp.length > 0 ? count(contents.mcp.length, "MCP server") : "",
    contents.hook.length > 0 ? count(contents.hook.length, "hook") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function pluginLines(inv: Inventory, row: ScopeRow, project: string | undefined): DetailLine[] {
  const item = firstOf(row);
  const loc = item.location;
  const lines: DetailLine[] = [];
  if (item.description) lines.push({ text: item.description });
  const installed =
    loc.project === undefined
      ? "for you (every project)"
      : samePath(loc.project, project)
        ? "for this project"
        : `for ${projectName(loc.project, inv)}`;
  lines.push({ label: "Installed", text: installed });
  lines.push(...loadedLines(inv, row, project));
  // Every install's, one row per thing across them.
  const contents = pluginContents(inv, row);
  lines.push({
    label: "Contains",
    text: [
      count(contents.skill.length, "skill"),
      count(contents.mcp.length, "MCP server"),
      count(contents.hook.length, "hook"),
    ].join(" · "),
  });
  // What a plugin brings is named `<plugin>:<name>`, its servers `plugin:<plugin>:<name>`.
  const name = pluginName(item);
  const names = [
    ...contents.skill.map((r) => r.name.replace(`${name}:`, "")),
    ...contents.mcp.map((r) => r.name.replace(`plugin:${name}:`, "")),
    ...contents.hook.map((r) => r.name),
  ];
  if (names.length > 0) lines.push({ label: "", text: names.join(", ") });
  return lines;
}

/** The details view: title line first ("GLOBAL › eli5"), then the lines of the spec's Details section that apply. */
export function detailsOf(inv: Inventory, row: ScopeRow, project: string | undefined, now: number): DetailLine[] {
  const item = firstOf(row);
  const title = `${scopeLabel(item, project).toUpperCase()} › ${item.kind === "plugin" ? pluginName(item) : row.name}`;
  const lines: DetailLine[] = [{ text: title }];
  switch (item.kind) {
    case "skill":
      return [...lines, ...skillLines(inv, row, project, now)];
    case "mcp":
      return [...lines, ...mcpLines(inv, row, project)];
    case "hook":
      return [...lines, ...hookLines(inv, row, project)];
    case "plugin":
      return [...lines, ...pluginLines(inv, row, project)];
  }
}

/** What a plugin row brings, by kind: each thing's row name, sorted - a name twice for two hooks on one event. */
function containsOf(inv: Inventory, row: ScopeRow): Record<ItemKind, string[]> {
  const contents = pluginContents(inv, row);
  const names = (rows: ScopeRow[]) => rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
  return { skill: names(contents.skill), mcp: names(contents.mcp), hook: names(contents.hook) };
}

/**
 * The JSON v1 item. A row of copies is one item: its id is the row key, `copies` lists each copy
 * - with its account, or a plugin install's accounts - and `file`, `project` and `summary` are
 * the first copy's. A plugin row says what it brings in `contains`.
 */
export function jsonItem(
  inv: Inventory,
  row: ScopeRow,
  project: string | undefined,
  now: number,
): Record<string, unknown> {
  const item = firstOf(row);
  const loc = item.location;
  const merged = isAccountCopy(item);
  const perAccount = statesByAccount(inv, row, project);
  const accounts =
    perAccount?.map((a) => a.profile) ?? (loc.profile ? [loc.profile] : loc.accounts && [...loc.accounts]);
  const values = [...new Set((perAccount?.map((a) => a.state) ?? [stateHere(inv, item, project)]).map((s) => s.value))];
  // Only Claude records how often a skill is used.
  const counted = item.kind === "skill" && loc.tool === "claude";
  const usage = counted ? usageOf(inv, row.items) : undefined;
  return {
    id: merged ? row.key : item.id,
    kind: item.kind,
    tool: loc.tool,
    name: row.name,
    scope: homeScope(item, project),
    from: fromLabel(item, inv, project),
    project: loc.project ?? null,
    ...(loc.plugin ? { plugin: loc.plugin } : {}),
    ...(accounts ? { accounts } : {}),
    state: values.length === 1 ? values[0] : "mixed",
    ...(perAccount ? { stateByAccount: Object.fromEntries(perAccount.map((a) => [a.profile, a.state.value])) } : {}),
    usage: counted
      ? {
          total: usage?.total ?? 0,
          lastUsedAt: usage?.lastUsedAt === undefined ? null : new Date(usage.lastUsedAt).toISOString(),
          byAccount: { ...usage?.byProfile },
        }
      : null,
    tags: tagsOf(inv, row, project, now),
    file: loc.file,
    ...(merged
      ? {
          copies: row.items.map((copy) => ({
            id: copy.id,
            ...(copy.location.profile !== undefined
              ? { account: copy.location.profile }
              : { accounts: [...(copy.location.accounts ?? [])] }),
            file: copy.location.file,
          })),
        }
      : {}),
    description: item.description ?? null,
    alsoIn: copiesOf(inv, row, project).map((copy) => ({
      tool: copy.item.location.tool,
      scope: homeScope(copy.item, project),
      project: copy.item.location.project ?? null,
      sameContent: copy.sameContent ?? null,
    })),
    ...(item.link ? { link: { target: item.link.target, broken: item.link.broken } } : {}),
    // Already redacted: commands and URLs with secrets hidden, env and header names only.
    ...(item.kind === "mcp" || item.kind === "hook" ? { summary: { ...item.summary } } : {}),
    ...(item.kind === "plugin" ? { contains: containsOf(inv, row) } : {}),
  };
}
