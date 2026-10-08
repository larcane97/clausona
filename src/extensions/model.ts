import type { ToolName } from "../types.js";

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
  /** For what a plugin brings: the Claude accounts that have the plugin installed. */
  accounts?: string[];
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
  /** Skills: when the folder appeared (birthtime, else mtime), for the cleanup grace period. */
  createdAt?: number;
  /** Skills: the keys Claude Code may record its use under in `skillUsage`. */
  usageKeys?: string[];
  /** What is shown about it, already redacted. */
  summary?: Record<string, string>;
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

export type StateFacts = {
  claudeSkillOverrides: SettingsMap[];
  claudeEnabledPlugins: SettingsMap[];
  /** `.claude.json` → projects[P].disabledMcpServers, per account. */
  claudeMcpDisabled: { file: string; profile: string; project: string; names: string[] }[];
  /** `.mcp.json` approvals, from settings and from an account's project entry. */
  claudeMcpjson: {
    file: string;
    project: string;
    profile?: string;
    enabled: string[];
    disabled: string[];
    enableAll: boolean;
  }[];
  codexSkillConfig: { file: string; name?: string; path?: string; enabled: boolean }[];
  codexMcpEnabled: { file: string; project?: string; name: string; enabled: boolean }[];
};

export function emptyFacts(): StateFacts {
  return {
    claudeSkillOverrides: [],
    claudeEnabledPlugins: [],
    claudeMcpDisabled: [],
    claudeMcpjson: [],
    codexSkillConfig: [],
    codexMcpEnabled: [],
  };
}

/** What every source writes into. */
export type Collector = { items: Extension[]; facts: StateFacts; warnings: Warning[] };

export type Inventory = {
  items: Extension[];
  projects: Project[];
  /** The git root holding cwd, or cwd; absent in the home dir. */
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
};
