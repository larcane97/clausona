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
   * is the primary's.
   */
  accounts?: string[];
  /**
   * For a plugin install and what it brings: the scope it is installed at, as
   * `installed_plugins.json` records it (an install for the home dir reads as `user`).
   */
  installScope?: "user" | "project" | "local";
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
   * `empty command`, or an MCP tool hook with an `empty tool` (or server). Unlike Claude Code,
   * Codex lists no skill without front matter, or without a description, so it does not load.
   */
  codexError?:
    | "no front matter"
    | "invalid front matter"
    | "name too long"
    | "no description"
    | "invalid hooks file"
    | "not supported"
    | "empty command"
    | "empty tool";
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
  /** Where the value comes from; absent for a default. */
  setBy?: { file: string; key: string };
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
  codexMcpEnabled: { file: string; project?: string; name: string; enabled: boolean }[];
  /**
   * Item id -> valueHash of its raw entry, for MCP servers and hooks: a write checks the entry is
   * still the one read. Never printed.
   */
  fingerprints: Record<string, string>;
  /**
   * Each `[projects."<P>"]` table in the user config.toml, in key order: Codex reads a project's
   * .codex folder only when it trusts the project.
   */
  codexTrust: { project: string; trusted: boolean }[];
  /**
   * Each `[plugins."<plugin>@<marketplace>"]` table in the user config.toml and in a project's:
   * Codex loads a plugin only where a table names it. `enabled` is absent when the table does not
   * set it, which leaves the plugin on.
   */
  codexPlugins: { file: string; project?: string; plugin: string; enabled?: boolean }[];
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
};

export function emptyFacts(): StateFacts {
  return {
    claudeSkillOverrides: [],
    claudeEnabledPlugins: [],
    claudeFlags: [],
    claudeMcpPolicy: [],
    mcpTargets: {},
    claudeMcpDisabled: [],
    claudeMcpjson: [],
    codexSkillConfig: [],
    codexMcpEnabled: [],
    fingerprints: {},
    codexTrust: [],
    codexPlugins: [],
    codexPluginServers: [],
    codexHookTrust: [],
    codexHookStates: [],
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
