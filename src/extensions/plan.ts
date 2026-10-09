import path from "node:path";

import type { ToolName } from "../types.js";
import {
  type Action,
  codexMcpEntry,
  codexSkillEntry,
  type ExtensionsCommand,
  hasOpened,
  layerMap,
  mcpDisabled,
  NEXT_VISIBILITY,
  ownValue,
  type Reach,
  type Refusal,
  type RefusalCode,
  type RefusalFill,
  refusal,
  refusalText,
  toggleVerb,
  type Verb,
} from "./actions.js";
import { valueHash } from "./hash.js";
import { folderKey } from "./inventory.js";
import type { Extension, HookPlace, Inventory, SkillVisibility } from "./model.js";
import { codexProjectConfig, isClaudeJson, localSettingsFile } from "./places.js";
import { accountStates, projectName, shortProfile, stateHere, tilde, viewFrom } from "./present.js";
import { isWithin, pathKey, samePath } from "./read.js";
import { homeScope, isAccountServer, rowKey, SCOPE_LABEL, type ScopeRow } from "./scopes.js";
import { type StashMeta, stashFileName, stashIdFor } from "./stash.js";
import { claudeSkillOverride, codexTrusted, isManagedSetting, isMcpjsonServer, pluginState, stateOf } from "./state.js";
import type { JsonEdit, JsonPath } from "./writers/json.js";
import type { SkillSelector, TomlEdit } from "./writers/toml.js";

/**
 * The writes, planned: for an action on some rows, every file change it makes, what is already
 * as asked, and what cannot change and why. Pure - it reads the inventory and nothing else -
 * and exactly what the confirm dialog and `--dry-run` show; apply.ts carries it out. It names
 * keys and server names, never a value of a server's or a hook's entry: those it only checks
 * by fingerprint.
 */

export type PlanLine = {
  /** Absolute. */
  file: string;
  change: "edit" | "create" | "delete" | "unlink";
  /** What changes in it, in words, never a value of a server or hook entry. */
  what: string;
  /** Profile id. */
  account?: string;
  /** "link only, target kept", "changes the repo". */
  note?: string;
  tracked: boolean;
  /** Row keys. */
  rows: string[];
};

export type Expect =
  /** valueHash at path; null = absent. */
  | { type: "value"; path: JsonPath; hash: string | null }
  /** The same over the parsed TOML. */
  | { type: "toml"; path: (string | number)[]; hash: string | null }
  /** That [[skills.config]] entry's enabled; null = no entry. */
  | { type: "skill-config"; selector: SkillSelector; enabled: boolean | null }
  | { type: "entry"; kind: "dir" | "file" | "link"; realPath?: string; target?: string };

export type FileChange =
  | {
      kind: "json";
      file: string;
      edits: JsonEdit[];
      expect: Expect[];
      create: boolean;
      lock: boolean;
      /** Take the entry a delete/hook-remove edit removes into this stash file (written before the source). */
      stash?: { file: string; meta: StashMeta };
      /** restore/hook-restore take their entry from this stash file, which then goes into the backup. */
      fromStash?: string;
      lines: PlanLine[];
    }
  | { kind: "toml"; file: string; edits: TomlEdit[]; expect: Expect[]; create: boolean; lines: PlanLine[] }
  | { kind: "remove"; file: string; what: "folder" | "file" | "link"; expect: Expect[]; lines: PlanLine[] };

export type Plan = {
  command: ExtensionsCommand;
  verb: Verb;
  reach: Reach;
  level?: SkillVisibility;
  /** "Delete 3 skills?" */
  question: string;
  /** "Deleted 3 skills": the status line, the CLI's ✔ line and the manifest's summary. */
  done: string;
  changes: FileChange[];
  unchanged: { rowKey: string; name: string; why: string }[];
  refused: Refusal[];
  notes: string[];
  /** Claude MCP: the accounts with a change to pick from, and whether each is chosen. Absent otherwise. */
  accounts?: { profile: string; chosen: boolean }[];
  project: string | null;
};

export type PlanContext = {
  inv: Inventory;
  /** The project everything is seen from (the TUI's picked one, the CLI's --project or cwd). */
  project: string | undefined;
  now: number;
  /** pathKeys of files and folders git tracks (trackedPaths); empty for a first plan. */
  tracked: ReadonlySet<string>;
  /** Where stash files go: inv.places.stashDir in the app. */
  stashDir: string;
};

export type KeyName = "space" | "g" | "d" | "v";
export type KeyChoice = { key: KeyName; label: string; action: Action } | { key: KeyName; refused: string };

// ─── Words ──────────────────────────────────────────────────────────

const NOUNS: Record<ExtensionsCommand, string> = { skills: "skills", mcp: "MCP servers", hooks: "hooks" };
const TOOL_WORD: Record<ToolName, string> = { claude: "Claude", codex: "Codex" };

/** How a visibility short of off reads in a question, a done line and an unchanged one. */
const SHOWS: Record<Exclude<SkillVisibility, "off">, string> = {
  on: "as the full skill",
  "name-only": "as name only",
  "user-invocable-only": "only when you call it",
};

/** What `v` would set, as its key label says it. */
const LEVEL_LABEL: Record<SkillVisibility, string> = {
  on: "full skill",
  "name-only": "name only",
  "user-invocable-only": "only when you call it",
  off: "off",
};

/** "in every project", "in this project", or "in <project>" for another project's item. */
function whereFor(ctx: PlanContext, reach: Reach, project: string | undefined): string {
  if (reach === "everywhere") return "in every project";
  return project === undefined || samePath(project, ctx.project)
    ? "in this project"
    : `in ${projectName(project, ctx.inv)}`;
}

// ─── One row ────────────────────────────────────────────────────────

type Unchanged = Plan["unchanged"][number];

/**
 * What one row comes to. A refused row brings no change, but for a copy refused on its own
 * (a server whose file is gone) beside copies that can change. `project` is where it changes,
 * for the question's words.
 */
type Outcome = { changes: FileChange[]; unchanged: Unchanged[]; refused: Refusal[]; notes: string[]; project?: string };

type Run = {
  ctx: PlanContext;
  inv: Inventory;
  command: ExtensionsCommand;
  action: Action;
  /** The ids of every item the action's rows hold, for the one-folder rule. */
  inAction: ReadonlySet<string>;
};

function firstOf(row: ScopeRow): Extension {
  const first = row.items[0];
  if (!first) throw new Error(`Row ${row.key} has no items.`);
  return first;
}

function outcome(project?: string): Outcome {
  return { changes: [], unchanged: [], refused: [], notes: [], ...(project !== undefined ? { project } : {}) };
}

function refused(run: Run, row: ScopeRow, code: RefusalCode, fill: RefusalFill = {}): Outcome {
  const out = outcome();
  out.refused.push(refusal(code, row, firstOf(row).location.tool, { command: run.command, ...fill }));
  return out;
}

function unchanged(out: Outcome, row: ScopeRow, why: string): Outcome {
  out.unchanged.push({ rowKey: row.key, name: row.name, why });
  return out;
}

function note(out: Outcome, text: string): void {
  if (!out.notes.includes(text)) out.notes.push(text);
}

function adding(out: Outcome, change: FileChange): Outcome {
  out.changes.push(change);
  return out;
}

function chosenIn(run: Run, profile: string | undefined): boolean {
  return run.action.accounts === undefined || profile === undefined || run.action.accounts.includes(profile);
}

const knownFiles = new WeakMap<Inventory, Set<string>>();

/**
 * Whether the inventory read something from `file`, so it is there. plan() cannot look: a file
 * that exists but holds nothing the inventory lists - a settings.local.json with permissions
 * only - reads as new here. Apply finds out, and edits it.
 */
function known(inv: Inventory, file: string): boolean {
  let keys = knownFiles.get(inv);
  if (!keys) {
    const facts = inv.facts;
    const files = [
      ...inv.items.filter((item) => !item.stashed?.gone).map((item) => item.location.file),
      ...[
        ...facts.claudeSkillOverrides,
        ...facts.claudeEnabledPlugins,
        ...facts.claudeMcpDisabled,
        ...facts.claudeMcpjson,
        ...facts.codexSkillConfig,
        ...facts.codexMcpEnabled,
        ...inv.warnings,
      ].map((entry) => entry.file),
      ...(facts.codexTrust.length > 0 && inv.places.codexConfig ? [inv.places.codexConfig] : []),
    ];
    keys = new Set(files.map(pathKey));
    knownFiles.set(inv, keys);
  }
  return keys.has(pathKey(file));
}

function lineFor(
  run: Run,
  row: ScopeRow,
  file: string,
  what: string,
  more: { change?: PlanLine["change"]; account?: string | undefined; note?: string | undefined } = {},
): PlanLine {
  return {
    file,
    change: more.change ?? (known(run.inv, file) ? "edit" : "create"),
    what,
    ...(more.account !== undefined ? { account: more.account } : {}),
    ...(more.note !== undefined ? { note: more.note } : {}),
    tracked: false,
    rows: [row.key],
  };
}

type JsonMore = {
  create?: boolean;
  account?: string | undefined;
  stash?: { file: string; meta: StashMeta };
  fromStash?: string;
};

function jsonChange(
  run: Run,
  row: ScopeRow,
  file: string,
  edits: JsonEdit[],
  expect: Expect[],
  what: string,
  more: JsonMore = {},
): FileChange {
  return {
    kind: "json",
    file,
    edits,
    expect,
    create: more.create === true,
    lock: isClaudeJson(file),
    ...(more.stash ? { stash: more.stash } : {}),
    ...(more.fromStash !== undefined ? { fromStash: more.fromStash } : {}),
    lines: [lineFor(run, row, file, what, { account: more.account })],
  };
}

function tomlChange(
  run: Run,
  row: ScopeRow,
  file: string,
  edits: TomlEdit[],
  expect: Expect[],
  what: string,
  create: boolean,
): FileChange {
  return { kind: "toml", file, edits, expect, create, lines: [lineFor(run, row, file, what)] };
}

function removal(file: string, what: "folder" | "file" | "link", expect: Expect[], line: PlanLine): FileChange {
  return { kind: "remove", file, what, expect, lines: [line] };
}

/** The fingerprint of an item's raw entry as read, at `at`. */
function fingerprint(inv: Inventory, item: Extension, at: JsonPath): Expect {
  return { type: "value", path: at, hash: inv.facts.fingerprints[item.id] ?? null };
}

/** Where clausona keeps an entry it takes out, and what it records of it. */
function stashFor(run: Run, item: Extension, at: JsonPath): { file: string; meta: StashMeta } {
  const id = stashIdFor(item.id, run.ctx.now);
  const loc = item.location;
  const meta: StashMeta = {
    id,
    kind: item.kind === "hook" ? "hook" : "mcp",
    tool: loc.tool,
    name: item.name,
    file: loc.file,
    path: at,
    scope: loc.scope,
    ...(loc.profile !== undefined ? { profile: loc.profile } : {}),
    ...(loc.project !== undefined ? { project: loc.project } : {}),
    ...(item.hook ? { hook: { ...item.hook } } : {}),
  };
  return { file: path.join(run.ctx.stashDir, stashFileName(id)), meta };
}

/** Deleting what clausona kept of an item: its stash file. */
function stashRemoval(run: Run, row: ScopeRow, item: Extension, file: string): FileChange {
  return removal(
    file,
    "file",
    [{ type: "entry", kind: "file" }],
    lineFor(run, row, file, "", { change: "delete", account: item.location.profile }),
  );
}

/** Whether a managed settings file decides this skill's or plugin's state, which clausona never writes. */
function setByPolicy(run: Run, item: Extension): boolean {
  const state =
    item.kind === "skill" && item.location.tool === "claude"
      ? stateHere(run.inv, item, run.ctx.project)
      : item.kind === "plugin"
        ? pluginState(run.inv, item.location.plugin ?? item.name, viewFrom(item, run.ctx.project))
        : undefined;
  return state?.setBy !== undefined && isManagedSetting(run.inv, state.setBy.file);
}

function planRow(run: Run, row: ScopeRow): Outcome {
  const item = firstOf(row);
  const loc = item.location;
  const { verb, reach } = run.action;
  const claudeSkill = item.kind === "skill" && loc.tool === "claude";
  if (verb === "visibility" && !claudeSkill) return refused(run, row, "no-visibility");
  // A plugin's server has a switch of its own in each account's project entry: space only.
  const serverHere = item.kind === "mcp" && loc.tool === "claude" && reach === "here" && verb !== "rm";
  if (loc.scope === "plugin" && item.kind !== "plugin" && !serverHere) {
    return refused(run, row, "plugin-item", { plugin: loc.plugin ?? "" });
  }
  if (loc.scope === "managed" || (verb !== "rm" && setByPolicy(run, item))) return refused(run, row, "managed");
  switch (item.kind) {
    case "skill":
      return claudeSkill ? planClaudeSkill(run, row) : planCodexSkill(run, row);
    case "mcp":
      return loc.tool === "claude" ? planClaudeMcp(run, row) : planCodexMcp(run, row);
    case "hook":
      return planHook(run, row);
    case "plugin":
      return planPlugin(run, row);
  }
}

// ─── Skills ─────────────────────────────────────────────────────────

/** skillOverrides.<name> in this project's local settings (here) or in user settings (everywhere). */
function planClaudeSkill(run: Run, row: ScopeRow): Outcome {
  const item = firstOf(row);
  const { verb, reach } = run.action;
  if (verb === "rm") return planSkillRemoval(run, row);
  if (item.link?.broken) return refused(run, row, "broken-link");
  const inv = run.inv;
  const here = reach === "here";
  const seen = viewFrom(item, run.ctx.project);
  if (here && seen === undefined) return refused(run, row, "no-project");
  const file = here && seen !== undefined ? localSettingsFile(seen) : inv.places.claudeUserSettings;
  if (file === undefined) return refused(run, row, "no-account");
  const name = item.name;
  const at: JsonPath = ["skillOverrides", name];
  // What the layer this changes holds, and here what applies once every layer is read.
  const current = ownValue(layerMap(inv.facts.claudeSkillOverrides, here ? "local" : "user", seen), name);
  const effective = here ? stateHere(inv, item, run.ctx.project).value : current;
  const where = whereFor(run.ctx, reach, seen);
  const out = outcome(seen);
  const expect: Expect[] = [{ type: "value", path: at, hash: current === undefined ? null : valueHash(current) }];
  const write = (value: SkillVisibility | null): Outcome =>
    adding(
      out,
      jsonChange(
        run,
        row,
        file,
        [value === null ? { op: "delete", path: at } : { op: "set", path: at, value }],
        expect,
        value === null ? `skillOverrides.${name} removed` : `skillOverrides.${name} → ${value}`,
        { create: true },
      ),
    );
  const target: SkillVisibility = verb === "visibility" ? (run.action.level ?? "on") : verb === "off" ? "off" : "on";
  if (target === "off") return effective === "off" ? unchanged(out, row, `already off ${where}`) : write("off");
  if (target !== "on") {
    return current === target ? unchanged(out, row, `already shows ${SHOWS[target]} ${where}`) : write(target);
  }
  // A toggle takes any level but off as on; visibility on is the full skill.
  const toggle = verb === "on";
  const isOn = (value: unknown) => (toggle ? value !== "off" : value === "on" || (!here && value === undefined));
  if (isOn(effective)) {
    const why = toggle
      ? here
        ? `already on ${where}`
        : "not off in your user settings"
      : `already shows as the full skill ${where}`;
    return unchanged(out, row, why);
  }
  // Removing this layer's value leaves the one below: only where that is on (or not off) does it go.
  const below = here ? claudeSkillOverride(inv, name, seen, ["local"])?.value : undefined;
  const removable = current !== undefined && (toggle ? below !== "off" : below === undefined || below === "on");
  write(removable ? null : "on");
  if (!here) {
    const above = claudeSkillOverride(inv, name, seen, ["user"]);
    if (above?.value === "off" && above.setBy) note(out, `Still off in ${tilde(above.setBy.file, inv.homeDir)}`);
  }
  return out;
}

/** `[[skills.config]]` in Codex's user config.toml: by path for a project skill here, by name everywhere. */
function planCodexSkill(run: Run, row: ScopeRow): Outcome {
  const item = firstOf(row);
  const { verb, reach } = run.action;
  if (verb === "rm")
    return item.location.scope === "builtin" ? refused(run, row, "builtin-delete") : planSkillRemoval(run, row);
  if (item.link?.broken) return refused(run, row, "broken-link");
  const inv = run.inv;
  const here = reach === "here";
  if (here && item.location.scope !== "project") return refused(run, row, "codex-user-here");
  const file = inv.places.codexConfig;
  if (file === undefined) return refused(run, row, "no-account");
  const seen = here ? item.location.project : undefined;
  const selector: SkillSelector = here ? { path: path.join(item.location.file, "SKILL.md") } : { name: item.name };
  const entry = codexSkillEntry(inv, selector);
  const byName = here ? codexSkillEntry(inv, { name: item.name }) : entry;
  const where = whereFor(run.ctx, reach, seen);
  const out = outcome(seen);
  const label = "name" in selector ? selector.name : tilde(selector.path, inv.homeDir);
  const write = (enabled: boolean | null): Outcome =>
    adding(
      out,
      tomlChange(
        run,
        row,
        file,
        [{ op: "skill-config", selector, enabled }],
        [{ type: "skill-config", selector, enabled: entry?.enabled ?? null }],
        enabled === null ? `skills.config ${label} removed` : `skills.config ${label} → ${enabled ? "on" : "off"}`,
        true,
      ),
    );
  if (verb === "off") {
    return entry?.enabled === false
      ? unchanged(out, row, here ? `already off ${where}` : "already off in every project")
      : write(false);
  }
  if (!here) return byName?.enabled === false ? write(null) : unchanged(out, row, "not off in Codex's config.toml");
  if (stateHere(inv, item, run.ctx.project).value !== "off") return unchanged(out, row, `already on ${where}`);
  // A path entry wins over a name one: it goes, unless the name entry would then turn it off.
  return write(entry !== undefined && byName?.enabled !== false ? null : true);
}

/** The other skill that is the folder this copy is, through a link, and is not in the action. */
function sameFolder(run: Run, copy: Extension): Extension | undefined {
  const key = folderKey(copy);
  const real = copy.realFolder ?? copy.location.file;
  return run.inv.items.find(
    (other) =>
      other.kind === "skill" &&
      other.id !== copy.id &&
      !other.link?.broken &&
      !run.inAction.has(other.id) &&
      (folderKey(other) === key || samePath(other.link?.target, real)),
  );
}

/**
 * "the folder at …" when a folder's real path is somewhere else than where it is listed, through
 * a link on the way - a skills dir that links to another. A link above the home dir or the
 * project (macOS's /var, a projects folder kept on another disk) moves every path alike, so it
 * says nothing.
 */
function folderNote(inv: Inventory, copy: Extension, real: string): string | undefined {
  const listed = copy.location.file;
  if (samePath(listed, real)) return undefined;
  const ours = pathKey(listed).split(path.sep);
  const theirs = pathKey(real).split(path.sep);
  while (ours.length > 0 && theirs.length > 0 && ours.at(-1) === theirs.at(-1)) {
    ours.pop();
    theirs.pop();
  }
  const linked = ours.join(path.sep) || path.sep;
  if (isWithin(copy.location.project ?? inv.homeDir, linked)) return undefined;
  return `the folder at ${tilde(real, inv.homeDir)}`;
}

/** Each copy's folder by its real path, a link unlinked, a command's file; never what a link leads to. */
function planSkillRemoval(run: Run, row: ScopeRow): Outcome {
  for (const copy of row.items) {
    if (copy.location.scope === "synced") return refused(run, row, "cloud-delete");
    if (copy.location.scope === "builtin") return refused(run, row, "builtin-delete");
  }
  const out = outcome();
  for (const copy of row.items) {
    const listed = copy.location.file;
    if (copy.link) {
      const line = lineFor(run, row, listed, "", { change: "unlink", note: "link only, target kept" });
      out.changes.push(removal(listed, "link", [{ type: "entry", kind: "link", target: copy.link.target }], line));
      continue;
    }
    if (copy.summary?.type === "command") {
      const line = lineFor(run, row, listed, "", { change: "delete" });
      out.changes.push(removal(listed, "file", [{ type: "entry", kind: "file" }], line));
      continue;
    }
    const other = sameFolder(run, copy);
    if (other) {
      return refused(run, row, "one-folder", {
        Tool: TOOL_WORD[other.location.tool],
        "Scope label": SCOPE_LABEL[homeScope(other, run.ctx.project)](other.location.tool),
        name: other.name,
        a: row.key,
        b: rowKey(other),
      });
    }
    const real = copy.realFolder ?? listed;
    const line = lineFor(run, row, listed, "", { change: "delete", note: folderNote(run.inv, copy, real) });
    out.changes.push(removal(real, "folder", [{ type: "entry", kind: "dir", realPath: real }], line));
  }
  return out;
}

// ─── Claude MCP servers ─────────────────────────────────────────────

function planClaudeMcp(run: Run, row: ScopeRow): Outcome {
  const item = firstOf(row);
  if (isMcpjsonServer(item)) return planMcpjson(run, row);
  if (item.location.scope === "plugin") return planPluginServer(run, row);
  if (isAccountServer(item)) return planAccountServer(run, row);
  return refused(run, row, "managed");
}

/** Where an account's server sits in its `.claude.json`: a user one at the top, a local one in its project's entry. */
function serverPath(copy: Extension): JsonPath {
  const project = copy.location.project;
  return copy.location.scope === "local" && project !== undefined
    ? ["projects", { projectKey: project }, "mcpServers", copy.name]
    : ["mcpServers", copy.name];
}

/** The switch `/mcp disable` writes: `projects[P].disabledMcpServers` in one account's `.claude.json`. */
function switchHere(
  run: Run,
  row: ScopeRow,
  out: Outcome,
  account: string,
  file: string,
  project: string,
  name: string,
  isOff: boolean,
): void {
  const short = shortProfile(account);
  const list: JsonPath = ["projects", { projectKey: project }, "disabledMcpServers"];
  if (run.action.verb === "off") {
    if (isOff) unchanged(out, row, `already off in ${short}`);
    else
      out.changes.push(
        jsonChange(run, row, file, [{ op: "list-add", path: list, value: name }], [], `disabledMcpServers + ${name}`, {
          account,
        }),
      );
  } else if (!mcpDisabled(run.inv, account, project, name)) {
    unchanged(out, row, `already on in ${short}`);
  } else {
    out.changes.push(
      jsonChange(run, row, file, [{ op: "list-remove", path: list, value: name }], [], `disabledMcpServers - ${name}`, {
        account,
      }),
    );
  }
}

/** An account's own server, each chosen account's copy: here its project switch, everywhere out of its file. */
function planAccountServer(run: Run, row: ScopeRow): Outcome {
  const { verb, reach } = run.action;
  const inv = run.inv;
  const copies = row.items.filter((copy) => chosenIn(run, copy.location.profile));
  const out = outcome();
  const short = (copy: Extension) => shortProfile(copy.location.profile ?? "");
  if (verb === "rm" || reach === "everywhere") {
    for (const copy of copies) {
      const at = serverPath(copy);
      const file = copy.location.file;
      const account = copy.location.profile;
      const name = copy.name;
      if (verb === "rm") {
        out.changes.push(
          copy.stashed
            ? stashRemoval(run, row, copy, copy.stashed.file)
            : jsonChange(
                run,
                row,
                file,
                [{ op: "delete", path: at }],
                [fingerprint(inv, copy, at)],
                `mcpServers.${name} deleted`,
                {
                  account,
                },
              ),
        );
      } else if (verb === "off") {
        if (copy.stashed) unchanged(out, row, `already off everywhere in ${short(copy)}`);
        else
          out.changes.push(
            jsonChange(
              run,
              row,
              file,
              [{ op: "delete", path: at }],
              [fingerprint(inv, copy, at)],
              `mcpServers.${name} taken out, kept by clausona`,
              { account, stash: stashFor(run, copy, at) },
            ),
          );
      } else if (!copy.stashed) {
        unchanged(out, row, `not off everywhere in ${short(copy)}`);
      } else if (copy.stashed.gone) {
        out.refused.push(
          refusal("stash-gone", row, "claude", {
            command: run.command,
            "~file": tilde(file, inv.homeDir),
            id: copy.id,
          }),
        );
      } else {
        out.changes.push(
          jsonChange(
            run,
            row,
            file,
            [{ op: "restore", path: at }],
            [{ type: "value", path: at, hash: null }],
            `mcpServers.${name} put back`,
            { account, fromStash: copy.stashed.file },
          ),
        );
      }
    }
    return out;
  }
  let opened = 0;
  const kept = copies.filter((copy) => copy.stashed);
  for (const copy of copies) {
    const account = copy.location.profile ?? "";
    const seen = viewFrom(copy, run.ctx.project);
    if (seen === undefined) return refused(run, row, "no-project");
    if (copy.stashed) {
      if (verb === "off") unchanged(out, row, `already off in ${short(copy)}`);
      continue;
    }
    // Rule E: no project entry is ever made for an account that has not opened the project.
    if (!hasOpened(inv, seen, account)) {
      note(out, `${short(copy)} has not opened this project`);
      continue;
    }
    opened += 1;
    out.project ??= seen;
    switchHere(run, row, out, account, copy.location.file, seen, copy.name, mcpDisabled(inv, account, seen, copy.name));
  }
  if (verb === "on" && kept.length > 0) {
    if (kept.length === copies.length) return refused(run, row, "stashed-here");
    for (const copy of kept) note(out, `${short(copy)}: off everywhere, g turns it back on`);
  }
  if (opened === 0 && kept.length === 0) return refused(run, row, "no-account");
  return out;
}

/** A plugin's server, here only: each chosen account that has the plugin and has opened the project. */
function planPluginServer(run: Run, row: ScopeRow): Outcome {
  const inv = run.inv;
  const item = firstOf(row);
  const plugin = item.location.plugin ?? "";
  const seen = viewFrom(item, run.ctx.project);
  if (seen === undefined) return refused(run, row, "no-project");
  // The plugin's own switch is above the server's: with the plugin off, nothing here turns it on.
  if (run.action.verb === "on" && pluginState(inv, plugin, seen).value === "off") {
    return refused(run, row, "plugin-item", { plugin });
  }
  const out = outcome(seen);
  const rank = (profile: string) => {
    const at = inv.claudeProfiles.indexOf(profile);
    return at < 0 ? inv.claudeProfiles.length : at;
  };
  const accounts = [...new Set(row.items.flatMap((copy) => copy.location.accounts ?? []))]
    .filter((account) => chosenIn(run, account))
    .sort((a, b) => rank(a) - rank(b));
  let opened = 0;
  for (const account of accounts) {
    const file = inv.places.claudeJson[account];
    if (file === undefined || !hasOpened(inv, seen, account)) {
      note(out, `${shortProfile(account)} has not opened this project`);
      continue;
    }
    opened += 1;
    const copy = row.items.find((c) => c.location.accounts?.includes(account)) ?? item;
    switchHere(run, row, out, account, file, seen, item.name, stateOf(inv, copy, seen, account).value === "off");
  }
  if (opened === 0) return refused(run, row, "no-account");
  return out;
}

/**
 * A `.mcp.json` server: approved or denied per project in its local settings, and on also
 * clears a denial from each chosen account's project entry. A denial in a file every account
 * shares that is not this project's local one - user, shared project or managed settings -
 * keeps it off whatever is written here.
 */
function planMcpjson(run: Run, row: ScopeRow): Outcome {
  const inv = run.inv;
  const item = firstOf(row);
  const name = item.name;
  const { verb, reach } = run.action;
  if (verb === "rm") {
    const at: JsonPath = ["mcpServers", name];
    return adding(
      outcome(),
      jsonChange(
        run,
        row,
        item.location.file,
        [{ op: "delete", path: at }],
        [fingerprint(inv, item, at)],
        `mcpServers.${name} deleted`,
      ),
    );
  }
  if (reach === "everywhere") return refused(run, row, "mcpjson-everywhere");
  const seen = viewFrom(item, run.ctx.project) ?? item.location.project ?? inv.homeDir;
  const local = localSettingsFile(seen);
  const out = outcome(seen);
  const where = whereFor(run.ctx, reach, seen);
  const states = accountStates(inv, item, run.ctx.project)
    ?.filter((a) => chosenIn(run, a.profile))
    .map((a) => a.state) ?? [stateHere(inv, item, run.ctx.project)];
  const every = (value: string) => states.length > 0 && states.every((s) => s.value === value);
  const lists = inv.facts.claudeMcpjson.find((a) => samePath(a.file, local));
  const denied = lists?.disabled.includes(name) === true;
  const approved = lists?.enabled.includes(name) === true;
  if (verb === "off") {
    if (every("off")) return unchanged(out, row, `already off ${where}`);
    const what = [`disabledMcpjsonServers + ${name}`, ...(approved ? [`enabledMcpjsonServers - ${name}`] : [])];
    return adding(
      out,
      jsonChange(
        run,
        row,
        local,
        [
          { op: "list-add", path: ["disabledMcpjsonServers"], value: name },
          { op: "list-remove", path: ["enabledMcpjsonServers"], value: name },
        ],
        [],
        what.join(", "),
        { create: true },
      ),
    );
  }
  if (every("on")) return unchanged(out, row, `already on ${where}`);
  const accountChanges: FileChange[] = [];
  for (const denial of inv.facts.claudeMcpjson) {
    if (!denial.disabled.includes(name) || samePath(denial.file, local)) continue;
    if (denial.project !== undefined && !samePath(denial.project, seen)) continue;
    if (denial.profile !== undefined) {
      if (chosenIn(run, denial.profile)) {
        accountChanges.push(
          jsonChange(
            run,
            row,
            denial.file,
            [{ op: "list-remove", path: ["projects", { projectKey: seen }, "disabledMcpjsonServers"], value: name }],
            [],
            `disabledMcpjsonServers - ${name}`,
            { account: denial.profile },
          ),
        );
      }
      continue;
    }
    // Settings with no project apply everywhere: the user's, or else a managed file.
    if (denial.project === undefined && !samePath(denial.file, inv.places.claudeUserSettings)) {
      return refused(run, row, "managed");
    }
    return refused(run, row, "elsewhere", { "~file": tilde(denial.file, inv.homeDir) });
  }
  // Its local lists already as asked: only the accounts' denials are left to clear.
  if (denied || !approved) {
    const what = [
      ...(denied ? [`disabledMcpjsonServers - ${name}`] : []),
      ...(approved ? [] : [`enabledMcpjsonServers + ${name}`]),
    ];
    out.changes.push(
      jsonChange(
        run,
        row,
        local,
        [
          { op: "list-remove", path: ["disabledMcpjsonServers"], value: name },
          { op: "list-add", path: ["enabledMcpjsonServers"], value: name },
        ],
        [],
        what.join(", "),
        { create: true },
      ),
    );
  }
  out.changes.push(...accountChanges);
  return out;
}

// ─── Codex MCP servers ──────────────────────────────────────────────

/** `mcp_servers.<name>.enabled` in a config.toml: the user's everywhere, a trusted project's here. */
function planCodexMcp(run: Run, row: ScopeRow): Outcome {
  const inv = run.inv;
  const item = firstOf(row);
  const name = item.name;
  const { verb, reach } = run.action;
  const own = item.location.file;
  const deleteServer = () =>
    adding(
      outcome(),
      tomlChange(
        run,
        row,
        own,
        [{ op: "mcp-delete", server: name }],
        [{ type: "toml", path: ["mcp_servers", name], hash: inv.facts.fingerprints[item.id] ?? null }],
        `[mcp_servers.${name}] deleted`,
        false,
      ),
    );
  const write = (out: Outcome, file: string, enabled: boolean | null, create: boolean): Outcome => {
    const read = codexMcpEntry(inv, file, name);
    return adding(
      out,
      tomlChange(
        run,
        row,
        file,
        [{ op: "mcp-enabled", server: name, enabled }],
        [
          {
            type: "toml",
            path: ["mcp_servers", name, "enabled"],
            hash: read === undefined ? null : valueHash(read.enabled),
          },
        ],
        enabled === null ? `mcp_servers.${name}.enabled removed` : `mcp_servers.${name}.enabled → ${enabled}`,
        create,
      ),
    );
  };
  /** In a project's config.toml. On: true over the user config's off, else this file's off removed. */
  const inProject = (file: string, project: string, create: boolean): Outcome => {
    const out = outcome(project);
    const where = whereFor(run.ctx, "here", project);
    const off = stateOf(inv, item, project).value === "off";
    if (verb === "off") return off ? unchanged(out, row, `already off ${where}`) : write(out, file, false, create);
    if (!off) return unchanged(out, row, `already on ${where}`);
    const userOff = codexMcpEntry(inv, inv.places.codexConfig, name)?.enabled === false;
    return write(out, file, userOff ? true : null, create);
  };
  if (item.location.scope === "project") {
    const project = item.location.project;
    if (project === undefined || !codexTrusted(inv, project)) return refused(run, row, "codex-untrusted");
    if (verb === "rm") return deleteServer();
    if (reach === "everywhere") return refused(run, row, "codex-project-everywhere");
    return inProject(own, project, false);
  }
  if (verb === "rm") return deleteServer();
  if (reach === "everywhere") {
    const out = outcome();
    const off = codexMcpEntry(inv, own, name)?.enabled === false;
    if (verb === "off") return off ? unchanged(out, row, "already off in every project") : write(out, own, false, true);
    return off ? write(out, own, null, true) : unchanged(out, row, "not off in Codex's config.toml");
  }
  const project = run.ctx.project;
  if (project === undefined) return refused(run, row, "no-project");
  if (samePath(project, inv.homeDir)) return refused(run, row, "codex-home-here");
  if (!codexTrusted(inv, project)) return refused(run, row, "codex-untrusted");
  return inProject(codexProjectConfig(project), project, true);
}

// ─── Hooks and plugins ──────────────────────────────────────────────

/** The path of a hook's event array, which its stash records. */
function eventPath(place: HookPlace): JsonPath {
  return place.base === "hooks" ? ["hooks", place.event] : [place.event];
}

/** A hook: off everywhere takes it out of its file into the stash, on puts it back. Neither tool switches one per project. */
function planHook(run: Run, row: ScopeRow): Outcome {
  const inv = run.inv;
  const item = firstOf(row);
  const { verb, reach } = run.action;
  if (verb !== "rm" && reach === "here") return refused(run, row, "hook-here");
  const loc = item.location;
  const untrusted = loc.tool === "codex" && loc.scope === "project" && !codexTrusted(inv, loc.project);
  // Deleting what clausona kept writes nothing under the project's .codex folder.
  if (untrusted && !(verb === "rm" && item.stashed)) return refused(run, row, "codex-untrusted");
  const place = item.hook;
  if (!place) return refused(run, row, "unreadable", { "~file": tilde(loc.file, inv.homeDir) });
  const at: JsonPath = [...eventPath(place), place.group, "hooks", place.index];
  const event = place.event;
  const out = outcome();
  if (verb === "rm") {
    if (item.stashed) return adding(out, stashRemoval(run, row, item, item.stashed.file));
    return adding(
      out,
      jsonChange(
        run,
        row,
        loc.file,
        [{ op: "hook-remove", place }],
        [fingerprint(inv, item, at)],
        `${event} hook deleted`,
      ),
    );
  }
  if (verb === "off") {
    if (item.stashed) return unchanged(out, row, "already off in every project");
    return adding(
      out,
      jsonChange(
        run,
        row,
        loc.file,
        [{ op: "hook-remove", place }],
        [fingerprint(inv, item, at)],
        `${event} hook taken out, kept by clausona`,
        { stash: stashFor(run, item, eventPath(place)) },
      ),
    );
  }
  if (!item.stashed) return unchanged(out, row, "already on in every project");
  if (item.stashed.gone) {
    return refused(run, row, "stash-gone", { "~file": tilde(loc.file, inv.homeDir), id: item.id });
  }
  return adding(
    out,
    jsonChange(run, row, loc.file, [{ op: "hook-restore", place }], [], `${event} hook put back`, {
      fromStash: item.stashed.file,
    }),
  );
}

/** enabledPlugins.<id>, written as true or false at the layer the reach names. */
function planPlugin(run: Run, row: ScopeRow): Outcome {
  const inv = run.inv;
  const item = firstOf(row);
  const id = item.location.plugin ?? item.name;
  const { verb, reach } = run.action;
  if (verb === "rm") return refused(run, row, "plugin-delete");
  const here = reach === "here";
  const seen = viewFrom(item, run.ctx.project);
  if (here && seen === undefined) return refused(run, row, "no-project");
  if (!here && item.location.project !== undefined) return refused(run, row, "plugin-project-everywhere");
  const file = here && seen !== undefined ? localSettingsFile(seen) : inv.places.claudeUserSettings;
  if (file === undefined) return refused(run, row, "no-account");
  const value = verb === "on";
  const out = outcome(seen);
  if (pluginState(inv, id, here ? seen : undefined).value === verb) {
    return unchanged(out, row, `already ${verb} ${whereFor(run.ctx, reach, seen)}`);
  }
  const current = ownValue(layerMap(inv.facts.claudeEnabledPlugins, here ? "local" : "user", seen), id);
  const at: JsonPath = ["enabledPlugins", id];
  adding(
    out,
    jsonChange(
      run,
      row,
      file,
      [{ op: "set", path: at, value }],
      [{ type: "value", path: at, hash: current === undefined ? null : valueHash(current) }],
      `enabledPlugins.${id} → ${value}`,
      { create: true },
    ),
  );
  if (!here && value) {
    // A project's own false still wins over the user's true.
    const above = (["local", "project"] as const)
      .map((layer) => inv.facts.claudeEnabledPlugins.find((e) => e.layer === layer && samePath(e.project, seen)))
      .find((entry) => entry !== undefined && ownValue(entry.map, id) === false);
    if (above) note(out, `Still off in ${tilde(above.file, inv.homeDir)}`);
  }
  return out;
}

// ─── After every row: what can't be read, what git tracks ───────────

function unreadableIn(run: Run, row: ScopeRow, out: Outcome): Outcome {
  for (const change of out.changes) {
    if (run.inv.warnings.some((warning) => samePath(warning.file, change.file))) {
      return refused(run, row, "unreadable", { "~file": tilde(change.file, run.inv.homeDir) });
    }
  }
  return out;
}

/** The innermost project, not the home dir, that holds `file`. */
function projectOf(inv: Inventory, file: string): string {
  const holding = inv.projects
    .map((p) => p.path)
    .filter((dir) => !samePath(dir, inv.homeDir) && isWithin(file, dir))
    .sort((a, b) => pathKey(b).length - pathKey(a).length);
  return holding[0] ?? path.dirname(file);
}

function isTracked(run: Run, change: FileChange): boolean {
  return [change.file, ...change.lines.map((line) => line.file)].some((file) => run.ctx.tracked.has(pathKey(file)));
}

/** Rule A: a change to what git tracks needs the action's consent; with it, the line says so. */
function trackedIn(run: Run, row: ScopeRow, out: Outcome): Outcome {
  const hit = out.changes.find((change) => isTracked(run, change));
  if (!hit) return out;
  if (run.action.tracked !== true) {
    const file = hit.lines[0]?.file ?? hit.file;
    return refused(run, row, "tracked", { "project name": projectName(projectOf(run.inv, file), run.inv) });
  }
  for (const change of out.changes) {
    if (!isTracked(run, change)) continue;
    for (const line of change.lines) {
      line.tracked = true;
      line.note = line.note === undefined ? "changes the repo" : `${line.note}, changes the repo`;
    }
  }
  return out;
}

// ─── The plan ───────────────────────────────────────────────────────

/** Whether two changes go into one: one file, and no stash of their own (one stash file per change). */
function joins(a: FileChange, b: FileChange): boolean {
  if (a.kind !== b.kind || !samePath(a.file, b.file)) return false;
  if (a.kind === "json" && b.kind === "json") return !a.stash && !a.fromStash && !b.stash && !b.fromStash;
  return true;
}

function merge(changes: readonly FileChange[]): FileChange[] {
  const out: FileChange[] = [];
  for (const change of changes) {
    const into = out.find((made) => joins(made, change));
    if (!into) {
      out.push(change);
      continue;
    }
    if (into.kind === "remove") {
      // One folder two rows lead to: one line that names both.
      const line = into.lines[0];
      for (const key of change.lines.flatMap((l) => l.rows)) if (line && !line.rows.includes(key)) line.rows.push(key);
      continue;
    }
    if (into.kind === "json" && change.kind === "json") {
      into.edits.push(...change.edits);
      into.lock ||= change.lock;
    } else if (into.kind === "toml" && change.kind === "toml") {
      into.edits.push(...change.edits);
    } else {
      continue;
    }
    into.expect.push(...change.expect);
    into.create ||= change.create;
    into.lines.push(...change.lines);
  }
  return ordered(out);
}

function placeOf(edit: JsonEdit): HookPlace | undefined {
  return edit.op === "hook-remove" || edit.op === "hook-restore" ? edit.place : undefined;
}

/**
 * Taking a hook out moves the ones after it in its group (and the groups after an emptied one)
 * a place up; putting one back moves them down. So in one file, removals go last place first and
 * restores first place first, and every place a later edit names still holds its hook.
 */
function byPlace(op: JsonEdit["op"]): (a: HookPlace, b: HookPlace) => number {
  const sign = op === "hook-remove" ? -1 : 1;
  return (a, b) => a.event.localeCompare(b.event) || sign * (a.group - b.group) || sign * (a.index - b.index);
}

/** `items` with those `pick` takes sorted among the places they hold, the rest where they were. */
function sortInPlace<T>(items: readonly T[], pick: (item: T) => boolean, compare: (a: T, b: T) => number): T[] {
  const slots = items.flatMap((item, at) => (pick(item) ? [at] : []));
  const sorted = slots.map((at) => items[at] as T).sort(compare);
  const out = [...items];
  slots.forEach((slot, n) => {
    out[slot] = sorted[n] as T;
  });
  return out;
}

/** The one hook edit a change with its own stash makes. */
function hookEditOf(change: FileChange): (JsonEdit & { place: HookPlace }) | undefined {
  if (change.kind !== "json" || change.edits.length !== 1) return undefined;
  const edit = change.edits[0];
  return edit && placeOf(edit) ? (edit as JsonEdit & { place: HookPlace }) : undefined;
}

function ordered(changes: FileChange[]): FileChange[] {
  for (const change of changes) {
    if (change.kind !== "json") continue;
    for (const op of ["hook-remove", "hook-restore"] as const) {
      change.edits = sortInPlace(
        change.edits,
        (edit) => edit.op === op,
        (a, b) => byPlace(op)(placeOf(a) as HookPlace, placeOf(b) as HookPlace),
      );
    }
  }
  let out = changes;
  const files = [...new Set(changes.filter((c) => hookEditOf(c)).map((c) => pathKey(c.file)))];
  for (const key of files) {
    out = sortInPlace(
      out,
      (change) => hookEditOf(change) !== undefined && pathKey(change.file) === key,
      (a, b) => {
        const [x, y] = [hookEditOf(a), hookEditOf(b)];
        return x && y ? byPlace(x.op)(x.place, y.place) : 0;
      },
    );
  }
  return out;
}

type Planned = {
  changes: FileChange[];
  unchanged: Unchanged[];
  refused: Refusal[];
  notes: string[];
  /** The rows the words are about: those with a change, else every row. */
  rows: ScopeRow[];
  project?: string;
};

function planned(ctx: PlanContext, command: ExtensionsCommand, action: Action): Planned {
  const rows = [...new Map(action.rows.map((row) => [row.key, row])).values()];
  const run: Run = {
    ctx,
    inv: ctx.inv,
    command,
    action,
    inAction: new Set(rows.flatMap((row) => row.items.map((item) => item.id))),
  };
  const outcomes = rows.map((row) => ({ row, out: trackedIn(run, row, unreadableIn(run, row, planRow(run, row))) }));
  const changed = outcomes.filter((o) => o.out.changes.length > 0);
  const told = changed.length > 0 ? changed : outcomes;
  const project = told.find((o) => o.out.project !== undefined)?.out.project;
  return {
    changes: merge(outcomes.flatMap((o) => o.out.changes)),
    unchanged: outcomes.flatMap((o) => o.out.unchanged),
    refused: outcomes.flatMap((o) => o.out.refused),
    notes: [...new Set(outcomes.flatMap((o) => o.out.notes))],
    rows: told.map((o) => o.row),
    ...(project !== undefined ? { project } : {}),
  };
}

function rankOf(inv: Inventory): (profile: string) => number {
  return (profile) => {
    const at = inv.claudeProfiles.indexOf(profile);
    return at < 0 ? inv.claudeProfiles.length : at;
  };
}

function accountsOf(inv: Inventory, made: Planned): string[] {
  const rank = rankOf(inv);
  const profiles = made.changes.flatMap((c) => c.lines.flatMap((line) => (line.account ? [line.account] : [])));
  return [...new Set(profiles)].sort((a, b) => rank(a) - rank(b));
}

/** "{n} skills", or one row's name: a plugin's before the @, "the Stop hook". */
function subjectOf(command: ExtensionsCommand, rows: readonly ScopeRow[]): string {
  const [only] = rows;
  if (only && rows.length === 1) {
    const item = firstOf(only);
    if (item.kind === "plugin") return (item.location.plugin ?? item.name).split("@")[0] ?? item.name;
    return item.kind === "hook" ? `the ${only.name} hook` : only.name;
  }
  const plugins = rows.length > 0 && rows.every((row) => firstOf(row).kind === "plugin");
  return `${rows.length} ${plugins ? "plugins" : NOUNS[command]}`;
}

/** "for work", "for personal and work", "for 3 accounts": when only some of the row's accounts change, or several do. */
function forWhom(inv: Inventory, made: Planned): string | undefined {
  const lines = made.changes.flatMap((c) => c.lines);
  if (lines.length === 0 || lines.some((line) => line.account === undefined)) return undefined;
  const chosen = accountsOf(inv, made);
  const has = new Set(
    made.rows.flatMap((row) =>
      row.items.flatMap((item) =>
        item.location.profile !== undefined ? [item.location.profile] : (item.location.accounts ?? []),
      ),
    ),
  );
  if (chosen.length >= has.size && chosen.length <= 1) return undefined;
  const names = chosen.map(shortProfile);
  if (names.length === 1) return `for ${names[0]}`;
  if (names.length === 2) return `for ${names[0]} and ${names[1]}`;
  return `for ${names.length} accounts`;
}

function wordsFor(ctx: PlanContext, command: ExtensionsCommand, action: Action, made: Planned) {
  const subject = subjectOf(command, made.rows);
  if (action.verb === "rm") return { question: `Delete ${subject}?`, done: `Deleted ${subject}` };
  const who = forWhom(ctx.inv, made);
  const tail = `${whereFor(ctx, action.reach, made.project)}${who ? `, ${who}` : ""}`;
  const level = action.verb === "visibility" ? (action.level ?? "on") : undefined;
  if (level !== undefined && level !== "off") {
    const shows = made.rows.length > 1 ? "show" : "shows";
    return {
      question: `Show ${subject} ${SHOWS[level]} ${tail}?`,
      done: `${subject} ${shows} ${SHOWS[level]} ${tail}`,
    };
  }
  const way = action.verb === "on" ? "on" : "off";
  return { question: `Turn ${way} ${subject} ${tail}?`, done: `Turned ${way} ${subject} ${tail}` };
}

/** Claude MCP: the accounts a change is planned in with every account chosen, and which the action chose. */
function accountChoices(ctx: PlanContext, command: ExtensionsCommand, action: Action, made: Planned): Plan["accounts"] {
  const claudeMcp = action.rows.some((row) => {
    const item = row.items[0];
    return item?.kind === "mcp" && item.location.tool === "claude";
  });
  if (!claudeMcp) return undefined;
  const { accounts, ...every } = action;
  const profiles = accountsOf(ctx.inv, accounts === undefined ? made : planned(ctx, command, every));
  if (profiles.length === 0) return undefined;
  return profiles.map((profile) => ({ profile, chosen: accounts === undefined || accounts.includes(profile) }));
}

/** Every file change `action` makes, what is already as asked, and what is refused and why. */
export function plan(ctx: PlanContext, command: ExtensionsCommand, action: Action): Plan {
  const made = planned(ctx, command, action);
  const accounts = accountChoices(ctx, command, action, made);
  const { question, done } = wordsFor(ctx, command, action, made);
  return {
    command,
    verb: action.verb,
    reach: action.reach,
    ...(action.verb === "visibility" ? { level: action.level ?? "on" } : {}),
    question,
    done,
    changes: made.changes,
    unchanged: made.unchanged,
    refused: made.refused,
    notes: made.notes,
    ...(accounts ? { accounts } : {}),
    project: ctx.project ?? null,
  };
}

/** The files and folders the plan touches that lie inside a project that is not the home dir: what trackedPaths needs. */
export function trackCandidates(plan: Plan, inv: Inventory): string[] {
  const projects = inv.projects.map((p) => p.path).filter((dir) => !samePath(dir, inv.homeDir));
  const found = new Map<string, string>();
  for (const change of plan.changes) {
    for (const file of [change.file, ...change.lines.map((line) => line.file)]) {
      if (!found.has(pathKey(file)) && projects.some((dir) => isWithin(file, dir))) found.set(pathKey(file), file);
    }
  }
  return [...found.values()];
}

/** For space, g, d and v in that order: the toggle's action and label, or the refusal text (keys voice). */
export function keysFor(ctx: PlanContext, command: ExtensionsCommand, row: ScopeRow): KeyChoice[] {
  const item = firstOf(row);
  const choose = (key: KeyName, label: string, action: Action): KeyChoice => {
    const p = plan(ctx, command, action);
    const first = p.refused[0];
    return p.changes.length === 0 && first ? { key, refused: refusalText(first, "keys") } : { key, label, action };
  };
  const here = toggleVerb(ctx.inv, row, ctx.project, "here");
  const everywhere = toggleVerb(ctx.inv, row, ctx.project, "everywhere");
  const choices = [
    choose("space", `${here} here`, { verb: here, reach: "here", rows: [row] }),
    choose("g", `${everywhere} everywhere`, { verb: everywhere, reach: "everywhere", rows: [row] }),
    choose("d", "delete", { verb: "rm", reach: "here", rows: [row] }),
  ];
  if (item.kind === "skill" && item.location.tool === "claude") {
    const current = stateHere(ctx.inv, item, ctx.project).value;
    const level = NEXT_VISIBILITY[current === "pending-approval" ? "on" : current];
    choices.push(choose("v", LEVEL_LABEL[level], { verb: "visibility", reach: "here", rows: [row], level }));
  } else {
    choices.push({ key: "v", refused: refusalText(refusal("no-visibility", row, item.location.tool, {}), "keys") });
  }
  return choices;
}

/** "space off here · g off everywhere · d delete · v name only" - the allowed keys only. */
export function actionsLine(choices: readonly KeyChoice[]): string {
  return choices.flatMap((choice) => ("label" in choice ? [`${choice.key} ${choice.label}`] : [])).join(" · ");
}
