import { isRecord } from "../read.js";
import { codexReadsHookEvents, codexReadsHookStates, SerdeNumber } from "./codex-hooks.js";

/**
 * Whether Codex 0.159.3 reads a config.toml's typed config, in the sections clausona reads:
 * `mcp_servers`, `skills.config`, `hooks` and `hooks.state`, `plugins` and `projects`. One value
 * there of the wrong type makes Codex refuse the whole config - config/read and skills/list
 * fail with "invalid configuration" - as config/read showed for each kind checked here. The
 * sections clausona does not read are not checked: a wrong type in one of them, Codex refuses as
 * well, and this says nothing of it.
 *
 * `config` is the file read as `exactToml` reads it, so that a check tells `30` from `30.0`. Codex
 * checks a project's config.toml merged over the user's (mergeCodexConfig): a project table that
 * only switches a server the user defines is no server of its own.
 */

/** What in a config Codex cannot read, in words for a warning, or undefined where it reads all of it. */
export function codexConfigProblem(config: Record<string, unknown>): string | undefined {
  const { mcp_servers: servers, skills, hooks, plugins, projects } = config;
  if (!defaulted(servers, (s) => isTable(s) && Object.values(s).every(readsServer))) return "an MCP server";
  if (!defaulted(skills, (s) => isTable(s) && defaulted(s.config, (c) => isList(c) && c.every(readsSkillEntry)))) {
    return "a skills.config entry";
  }
  if (!defaulted(hooks, (h) => isTable(h) && codexReadsHookEvents(h) && codexReadsHookStates(h.state))) return "a hook";
  if (!defaulted(plugins, (p) => isTable(p) && Object.values(p).every(readsPlugin))) return "a plugin";
  if (!defaulted(projects, (p) => isTable(p) && Object.values(p).every(readsProject))) return "a projects entry";
  return undefined;
}

/**
 * A project's config.toml over the user's, as Codex merges its layers (`merge_toml_values`): a
 * table key by key, at every depth, and any other value - a list too - the project's in place.
 */
export function mergeCodexConfig(base: unknown, overlay: unknown): unknown {
  if (!isTable(base) || !isTable(overlay)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    merged[key] = Object.hasOwn(base, key) ? mergeCodexConfig(base[key], value) : value;
  }
  return merged;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !(value instanceof SerdeNumber) && !(value instanceof Date);
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const isString = (value: unknown) => typeof value === "string";
const isBool = (value: unknown) => typeof value === "boolean";
/** A field serde reads absent or of its type; TOML has no null. */
const defaulted = (value: unknown, is: (v: unknown) => boolean) => value === undefined || is(value);
const strings = (value: unknown) => isList(value) && value.every(isString);
const stringMap = (value: unknown) => isTable(value) && Object.values(value).every(isString);
/** A u64: a TOML integer, not below 0. */
const isU64 = (value: unknown) => value instanceof SerdeNumber && /^\d+$/.test(value.text);
/** A number of seconds Codex makes a Duration of: an integer or a float, not below 0 - `-0.0` is not. */
const isSeconds = (value: unknown) => value instanceof SerdeNumber && !(Number(value.text) < 0);

/** What a server takes, by Codex's `RawMcpServerConfig`, for the fields of simple types. */
const SERVER_FIELDS: Readonly<Record<string, (v: unknown) => boolean>> = {
  command: isString,
  args: strings,
  env: stringMap,
  env_vars: isList,
  cwd: isString,
  http_headers: stringMap,
  env_http_headers: stringMap,
  url: isString,
  bearer_token: isString,
  bearer_token_env_var: isString,
  http_headers_helper: isString,
  environment_id: isString,
  startup_timeout_sec: isSeconds,
  startup_timeout_ms: isU64,
  tool_timeout_sec: isSeconds,
  enabled: isBool,
  required: isBool,
  supports_parallel_tool_calls: isBool,
  enabled_tools: strings,
  disabled_tools: strings,
  scopes: strings,
  oauth_resource: isString,
};

/** What a stdio server, and a streamable HTTP one, must not set (`TryFrom<RawMcpServerConfig>`). */
const NOT_FOR_STDIO = [
  "url",
  "bearer_token_env_var",
  "bearer_token",
  "http_headers_helper",
  "http_headers",
  "env_http_headers",
  "oauth",
  "oauth_resource",
  "auth",
];
const NOT_FOR_HTTP = ["args", "env", "env_vars", "cwd", "bearer_token"];

/**
 * A server table as Codex reads one: each field of a simple type as `RawMcpServerConfig` has it,
 * a key it does not know left alone, and a transport - a `command`, with none of what only HTTP
 * takes, or else a `url`, with none of what only stdio takes, and a helper that is not blank.
 */
function readsServer(server: unknown): boolean {
  if (!isTable(server)) return false;
  for (const [field, is] of Object.entries(SERVER_FIELDS)) if (!defaulted(server[field], is)) return false;
  if (server.command !== undefined) return NOT_FOR_STDIO.every((field) => server[field] === undefined);
  if (server.url === undefined) return false;
  const helper = server.http_headers_helper;
  return NOT_FOR_HTTP.every((field) => server[field] === undefined) && !(isString(helper) && helper.trim() === "");
}

/** A `[[skills.config]]` entry: `enabled` a boolean, and a string `name` or `path` where given. */
function readsSkillEntry(entry: unknown): boolean {
  return isTable(entry) && isBool(entry.enabled) && defaulted(entry.name, isString) && defaulted(entry.path, isString);
}

/** A `[plugins."<id>"]` table: `enabled` a boolean, its servers' tables `enabled` booleans. */
function readsPlugin(plugin: unknown): boolean {
  if (!isTable(plugin) || !defaulted(plugin.enabled, isBool)) return false;
  return defaulted(
    plugin.mcp_servers,
    (servers) => isTable(servers) && Object.values(servers).every((s) => isTable(s) && defaulted(s.enabled, isBool)),
  );
}

/** A `[projects."<path>"]` table: `trust_level`, where given, `trusted` or `untrusted` as written. */
function readsProject(project: unknown): boolean {
  return isTable(project) && defaulted(project.trust_level, (t) => t === "trusted" || t === "untrusted");
}
