import type { ToolName } from "../types.js";
import type { McpRule, McpTarget } from "./mcp-policy.js";

/**
 * The extensions inventory: every skill, MCP server, hook and plugin that the Claude Code and
 * Codex profiles clausona manages can load, where each is defined, and the native switches
 * that turn it off. Data only: `sources/` fill it, `state.ts` reads it.
 */

export type Kind = "skill" | "mcp" | "hook" | "plugin";

export type Scope = "global" | "account" | "project" | "local" | "plugin" | "synced" | "builtin" | "managed";

export type Location = {
  tool: ToolName;
  scope: Scope;
  /** The file or folder that defines it. */
  file: string;
  /** The profile id, for what one account holds: Claude user and local MCP, synced and own skills. */
  profile?: string;
  /** The project dir, for project and local scope, and for a plugin installed for one project. */
  project?: string;
  /** `<plugin>@<marketplace>`, for what a plugin brings. */
  plugin?: string;
  /**
   * For what a plugin brings: the Claude accounts that have the plugin installed. For a Global
   * Claude skill that not every account loads: the accounts whose skills (or commands) folder
   * is the primary's. For a Codex row a parent folder's `.codex` holds, where that folder is a
   * Codex profile's home: the other profiles, which read it (Codex leaves its own home out).
   */
  accounts?: string[];
  /**
   * For a plugin install and what it brings: the scope it is installed at, as
   * `installed_plugins.json` records it (an install for the home dir reads as `user`).
   */
  installScope?: "user" | "project" | "local";
  /**
   * For a Codex project's row a parent folder's `.codex` holds: that folder. Codex reads the
   * `.codex` of each folder from the project's root down to the project, and each one's trust is
   * its own (sources/codex-trust.ts).
   */
  layer?: string;
};

/** Where a hook command sits in its file: hooks[event][group].hooks[index], under "hooks" or at the root. */
export type HookPlace = { base: "hooks" | "root"; event: string; matcher?: string; group: number; index: number };

/** The files and folders a write can touch that the inventory knows by account, not by item. */
export type Places = {
  /** The primary's settings.json, which every Claude profile links to; undefined without Claude accounts. */
  claudeUserSettings?: string;
  /** Each Claude profile id's .claude.json (claudeJsonPathForConfigDir). */
  claudeJson: Record<string, string>;
  /** The primary Codex home's config.toml and hooks.json; undefined without Codex. */
  codexConfig?: string;
  codexHooks?: string;
  /** <home>/.clausona/extensions/stash */
  stashDir: string;
};

export type Extension = {
  /** Stable across reads: kind:tool:scope:owner:name. */
  id: string;
  kind: Kind;
  name: string;
  description?: string;
  location: Location;
  /** Set when the folder is a symlink or junction. */
  link?: { target: string; broken: boolean };
  /**
   * Skills: the folder's real path, through every link on the way - its own, or a whole skills
   * dir's - so two entries that lead to one folder are one copy. Absent for a broken link.
   */
  realFolder?: string;
  /**
   * Codex skills: the skills folder the walk that found it started from, which a skill can sit
   * folders below. A Claude skill's is the folder its own is in.
   */
  skillsDir?: string;
  /** Skills: when the folder appeared (birthtime, else mtime), for the cleanup grace period. */
  createdAt?: number;
  /** Skills: the keys Claude Code may record its use under in `skillUsage`. */
  usageKeys?: string[];
  /**
   * Claude skills: set when the SKILL.md has no front matter. Claude Code loads it under its
   * folder's name, with no description of when to use it.
   */
  noFrontMatter?: true;
  /**
   * Why Codex does not load this, in its tag's words: a skill whose SKILL.md has `no front
   * matter` (no block delimited by `---`), `invalid front matter` (not YAML Codex reads), whose
   * `name too long` (over 64 characters) or with `no description`, a hook in an `invalid hooks
   * file` (more than `hooks` and `description` at its top), and one Codex does not run at all,
   * `not supported` (a prompt or agent hook, an MCP tool hook when a session ends), with an
   * `empty command`, an MCP tool hook with an `empty tool` (or server), a hook on an
   * `unknown event`, one of none of Codex's twelve, or in a group with an `invalid matcher`, a
   * pattern Codex cannot compile. A hook in a linked
   * worktree's own `.codex` folder is `main checkout's runs`: Codex runs the main checkout's
   * hooks there in its place. Unlike Claude Code, Codex lists no skill without front matter, or
   * without a description, so it does not load.
   */
  codexError?:
    | "no front matter"
    | "invalid front matter"
    | "name too long"
    | "no description"
    | "main checkout's runs"
    | "invalid hooks file"
    | "not supported"
    | "empty command"
    | "empty tool"
    | "unknown event"
    | "invalid matcher";
  /** What is shown about it, already redacted. */
  summary?: Record<string, string>;
  /** Hooks: where the command sits in its file. */
  hook?: HookPlace;
  /**
   * What clausona took out of its file to turn it off everywhere: the stash file and its id,
   * when (ms), and `gone` once the file it came from no longer exists.
   */
  stashed?: { file: string; id: string; at: number; gone?: true };
};

export const SKILL_VISIBILITY = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITY)[number];

export type StateValue = SkillVisibility | "pending-approval";

export type EffectiveState = {
  value: StateValue;
  /**
   * Where the value comes from; absent for a default. `reads`, for an MCP list's match: the
   * variables the entry and the server's config were expanded with (mcp-policy.ts).
   */
  setBy?: { file: string; key: string; reads?: string[] };
  /** The id of a same-name item that wins over this one. */
  shadowedBy?: string;
};

export type Usage = { total: number; lastUsedAt?: number; byProfile: Record<string, number> };

export type Warning = { file: string; message: string };

export type Project = { path: string; tools: ToolName[]; profiles: string[] };

export type Mark = "cleanup" | "shadowed" | "broken-link" | "differs";

/** Claude Code's settings files, highest precedence first: managed, local, project, user. */
export type SettingsLayer = "managed" | "local" | "project" | "user";

type SettingsMap = { file: string; layer: SettingsLayer; project?: string; map: Record<string, unknown> };

/** A Claude Code setting that turns a whole kind off: every hook, or the skills that come with it. */
export type ClaudeFlag = "disableAllHooks" | "disableBundledSkills";

export type StateFacts = {
  claudeSkillOverrides: SettingsMap[];
  claudeEnabledPlugins: SettingsMap[];
  /** Each settings file's `disableAllHooks` and `disableBundledSkills`, where it sets one to true or false. */
  claudeFlags: { file: string; layer: SettingsLayer; project?: string; key: ClaudeFlag; value: boolean }[];
  /**
   * Each settings file's `allowedMcpServers` and `deniedMcpServers` where it has a list, and
   * `managedOnly` where a managed one sets `allowManagedMcpServersOnly`.
   */
  claudeMcpPolicy: {
    file: string;
    layer: SettingsLayer;
    project?: string;
    allowed?: McpRule[];
    denied?: McpRule[];
    managedOnly?: true;
  }[];
  /** managed-mcp.json, while it is there: Claude Code then starts its servers and no other. */
  claudeManagedMcp?: string;
  /** Claude MCP server id -> what it starts, which the lists match. Never printed. */
  mcpTargets: Record<string, McpTarget>;
  /**
   * pathKey of a project whose own settings set `env` -> server id -> what the server starts
   * there, where that differs from `mcpTargets`. Never printed.
   */
  mcpTargetsIn: Record<string, Record<string, McpTarget>>;
  /** `.claude.json` → projects[P].disabledMcpServers, per account. */
  claudeMcpDisabled: { file: string; profile: string; project: string; names: string[] }[];
  /** `.mcp.json` approvals, from settings and from an account's project entry. */
  claudeMcpjson: {
    file: string;
    /** Absent for user and managed settings, whose approvals apply to every project. */
    project?: string;
    profile?: string;
    enabled: string[];
    disabled: string[];
    enableAll: boolean;
  }[];
  /**
   * `[[skills.config]]` in the user config.toml. `realPath` is `path` with its folder resolved
   * through every link, when that folder exists: Codex takes the link's path and the real one
   * alike.
   */
  codexSkillConfig: { file: string; name?: string; path?: string; realPath?: string; enabled: boolean }[];
  /**
   * `mcp_servers.<name>.enabled`, in the user config.toml and a project's. `layer`, for a parent
   * folder's `.codex` read for the project: how many folders up it is, the nearest winning, and the
   * project's own over every parent's. A parent's is read only where Codex trusts that folder.
   */
  codexMcpEnabled: { file: string; project?: string; name: string; enabled: boolean; layer?: number }[];
  /**
   * Item id -> valueHash of its raw entry, for MCP servers and hooks: a write checks the entry is
   * still the one read. Never printed.
   */
  fingerprints: Record<string, string>;
  /**
   * Each `[projects."<P>"]` table in the user config.toml, in key order: Codex reads a project's
   * .codex folder only when it trusts the project. `trusted` is absent when the table sets no
   * `trust_level`, which decides nothing: Codex then looks at the next folder (codexTrustFolders).
   */
  codexTrust: { project: string; trusted?: boolean }[];
  /**
   * By pathKey of each project read, the folders whose trust Codex takes for it, in the order
   * it looks (sources/codex-trust.ts): the project's own, its project root, its repository's -
   * a linked worktree's main checkout. So for each parent folder whose `.codex` Codex would read
   * for a project, by its own trust (`Location.layer`). A project not here is looked up by its
   * own path alone.
   */
  codexTrustFolders: Record<string, string[]>;
  /**
   * The primary Codex profile's id. The states are its reading: a row only other profiles read
   * (`Location.accounts` without it - a parent folder's `.codex` that is the primary's home)
   * hides no row of its.
   */
  codexPrimary?: string;
  /**
   * By pathKey of each project read that is in a linked git worktree and has a `.codex` folder,
   * and of each parent folder whose `.codex` is read for one (`Location.layer`): the main
   * checkout, and the `.codex` folder at that place in it. Codex 0.159.3 runs
   * that folder's hooks there - its hooks.json and its config.toml's `[hooks]` - in place of the
   * project's own; the rest of the project's config is its own (sources/codex-trust.ts).
   */
  codexWorktrees: Record<string, { main: string; hooks: string }>;
  /**
   * Each `[plugins."<plugin>@<marketplace>"]` table in the user config.toml and in a project's:
   * Codex loads a plugin only where a table names it. `enabled` is absent when the table does not
   * set it, which leaves the plugin on.
   */
  codexPlugins: { file: string; project?: string; plugin: string; enabled?: boolean; layer?: number }[];
  /**
   * `plugins."<id>".mcp_servers.<name>.enabled`: a plugin's server switch, in the same files.
   * With `default`, the server's own `enabled` in the plugin's file, which Codex starts from
   * and a switch in config.toml overrides.
   */
  codexPluginServers: {
    file: string;
    project?: string;
    plugin: string;
    name: string;
    enabled: boolean;
    default?: true;
    layer?: number;
  }[];
  /**
   * Each Codex hook's trust identity, by item id: the keys Codex records its trust under -
   * for the user's hooks.json, one per Codex profile, whose path is in the key - and the hash
   * of its definition that a trust must match. `builtin` for a bundled plugin's cleanup hook,
   * which Codex runs without a review. A hook Codex never runs, such as a prompt hook, has none.
   */
  codexHookTrust: { id: string; keys: string[]; hash: string; builtin?: true }[];
  /** `[hooks.state."<key>"]` in the user config.toml: one hook's `enabled`, and the hash it was trusted at. */
  codexHookStates: { file: string; key: string; enabled?: boolean; trustedHash?: string }[];
  /**
   * Each config.toml Codex refuses whole - one it cannot parse, or with a value of the wrong type
   * in a section clausona reads: then Codex loads no config at all, and so no skill, server or
   * hook. The user config.toml has no `project`, and its refusal holds in every project; a trusted
   * project's holds in that project, where Codex checks it merged over the user's. `readable`
   * where clausona reads the file all the same - a value of the wrong type, an integer past 64
   * bits - so it lists what the file holds, and can change it.
   */
  codexConfigRefused: { file: string; project?: string; readable?: true }[];
};

export function emptyFacts(): StateFacts {
  return {
    claudeSkillOverrides: [],
    claudeEnabledPlugins: [],
    claudeFlags: [],
    claudeMcpPolicy: [],
    mcpTargets: {},
    mcpTargetsIn: {},
    claudeMcpDisabled: [],
    claudeMcpjson: [],
    codexSkillConfig: [],
    codexMcpEnabled: [],
    fingerprints: {},
    codexTrust: [],
    codexTrustFolders: {},
    codexWorktrees: {},
    codexPlugins: [],
    codexPluginServers: [],
    codexHookTrust: [],
    codexHookStates: [],
    codexConfigRefused: [],
  };
}

/** What every source writes into. */
export type Collector = { items: Extension[]; facts: StateFacts; warnings: Warning[] };

export type Inventory = {
  items: Extension[];
  projects: Project[];
  /** The git root holding cwd, or cwd - the home dir too; absent only at the filesystem root. */
  currentProject?: string;
  homeDir: string;
  /** Claude profile ids, primary first: the MCP matrix's columns. */
  claudeProfiles: string[];
  facts: StateFacts;
  /** Summed over every Claude account's skillUsage, by usage key. */
  usage: Record<string, Usage>;
  /** Skill folder hashes by item id, for names defined in more than one place. */
  hashes: Record<string, string>;
  warnings: Warning[];
  places: Places;
};
