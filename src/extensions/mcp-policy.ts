import { valueHash } from "./hash.js";
import { isRecord } from "./read.js";

/**
 * Claude Code's `allowedMcpServers` and `deniedMcpServers` entries, and how one matches a
 * server, as Claude Code 2.1.296 matches them. Pure.
 *
 * An entry has one key: `serverName`, the server's name, matched exactly; `serverCommand`, the
 * command and its arguments, every one in order; or `serverUrl`, a URL pattern with `*`
 * wildcards. Claude Code expands `${VAR}` in a command or URL on both sides before it compares
 * them, from the environment it runs in; clausona expands them (`expandVars`) from the one it
 * runs in, with the settings files' `env` over it as Claude Code lays them (claude-context.ts
 * `mcpEnvs`).
 */

/** The environment `${VAR}` expands from. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * One entry. A command is kept as the hash of its words, as a server's is: nothing to print.
 * `reads` names the variables a command or URL expanded, `wildcard` says one of their values
 * brought a `*` into a URL, which an allowlist then never takes.
 */
export type McpRule =
  | { serverName: string }
  | { serverCommand: string; reads?: string[] }
  | { serverUrl: string; reads?: string[]; wildcard?: true };

/**
 * What a server starts, to match an entry against, never printed: a stdio server's command and
 * arguments, hashed; a remote server's URL; both once `${VAR}` in them is expanded, `reads`
 * naming the variables that were. `vars` when its config uses `${VAR}` anywhere, which keeps a
 * managed-mcp.json server on the allowlist check.
 */
export type McpTarget = { command?: string; url?: string; vars: boolean; reads?: string[] };

/** `${NAME}` and `${NAME:-default}`, as Claude Code finds a reference. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Whether a value brings a `*` in, written out or escaped, as Claude Code checks one. */
function bringsWildcard(value: string): boolean {
  if (value.normalize("NFKC").includes("*") || /%2a/i.test(value)) return true;
  if (!value.includes("%")) return false;
  try {
    return decodeURIComponent(value).normalize("NFKC").includes("*");
  } catch {
    return false;
  }
}

/**
 * `text` with each `${NAME}` and `${NAME:-default}` expanded from `env`, as Claude Code 2.1.296
 * expands a server's config and a list entry: a variable that is set gives its value, an empty
 * one too; one that is not gives the default after `:-`, then what `fallback` sets it to, and
 * with neither it stays as written. `$NAME` with no braces is no reference. `reads` names each
 * variable met, set or not, once; `wildcard` says a value brought a `*` in.
 */
export function expandVars(
  text: string,
  env: Env,
  fallback: Env = {},
): { text: string; reads: string[]; wildcard: boolean } {
  const reads: string[] = [];
  let wildcard = false;
  const expanded = text.replace(REFERENCE, (whole, name: string, preset: string | undefined) => {
    if (!reads.includes(name)) reads.push(name);
    const value: unknown = env[name];
    const later: unknown = fallback[name];
    const found =
      typeof value === "string" ? value : preset === undefined && typeof later === "string" ? later : undefined;
    if (found === undefined) return preset ?? whole;
    if (bringsWildcard(found)) wildcard = true;
    return found;
  });
  return { text: expanded, reads, wildcard };
}

/** Each of `words` expanded, and the variables they read, each once. */
function expandAll(words: string[], env: Env, fallback: Env = {}): { words: string[]; reads: string[] } {
  const reads: string[] = [];
  const out = words.map((word) => {
    const expanded = expandVars(word, env, fallback);
    for (const name of expanded.reads) if (!reads.includes(name)) reads.push(name);
    return expanded.text;
  });
  return { words: out, reads };
}

/**
 * A list of entries as read from a settings file: undefined when it is no list, each entry kept
 * that is one, its command or URL expanded from `env`, then `fallback` (see expandVars).
 */
export function mcpRules(value: unknown, env: Env = {}, fallback: Env = {}): McpRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): McpRule[] => {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) return [];
    if (typeof entry.serverName === "string") return [{ serverName: entry.serverName }];
    if (Array.isArray(entry.serverCommand) && entry.serverCommand.every((word) => typeof word === "string")) {
      const { words, reads } = expandAll(entry.serverCommand, env, fallback);
      return [{ serverCommand: valueHash(words), ...(reads.length > 0 ? { reads } : {}) }];
    }
    if (typeof entry.serverUrl === "string") {
      const { text, reads, wildcard } = expandVars(entry.serverUrl, env, fallback);
      return [{ serverUrl: text, ...(reads.length > 0 ? { reads } : {}), ...(wildcard ? { wildcard: true } : {}) }];
    }
    return [];
  });
}

/**
 * What `config` starts: a stdio server is one of no type or `stdio`, a remote one has a `url`.
 * Its command, arguments and URL are expanded from `env`, a plugin's server reading its own
 * folder, `pluginRoot`, as `${CLAUDE_PLUGIN_ROOT}` first, as Claude Code does.
 */
export function mcpTarget(config: Record<string, unknown>, env: Env = {}, pluginRoot?: string): McpTarget {
  const vars = JSON.stringify(config).includes("${");
  const own = (text: string) =>
    pluginRoot === undefined ? text : text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => pluginRoot);
  const stdio = config.type === undefined || config.type === "stdio";
  if (stdio && typeof config.command === "string") {
    const words: unknown[] = [config.command, ...(Array.isArray(config.args) ? config.args : [])];
    // Claude Code starts no server with an argument that is no string: hashed as it is, it matches nothing.
    if (!words.every((word) => typeof word === "string")) return { command: valueHash(words), vars };
    const expanded = expandAll(words.map(own), env);
    const reads = expanded.reads;
    return { command: valueHash(expanded.words), vars, ...(reads.length > 0 ? { reads } : {}) };
  }
  if (typeof config.url === "string") {
    const { text, reads } = expandVars(own(config.url), env);
    return { url: text, vars, ...(reads.length > 0 ? { reads } : {}) };
  }
  return { vars };
}

export function ruleMatches(rule: McpRule, name: string, target: McpTarget | undefined): boolean {
  if ("serverName" in rule) return rule.serverName === name;
  if ("serverCommand" in rule) return target?.command !== undefined && target.command === rule.serverCommand;
  return target?.url !== undefined && urlMatches(target.url, rule.serverUrl);
}

/** What stands for a `*` while a pattern is read as a URL: letters a host or a path takes as they are. */
const STAR = "clausonastar0";

/** `text` against `pattern`, where `*` is any run of characters, `/` included. */
function glob(pattern: string, text: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(text);
}

/**
 * Whether `url` matches `pattern`. The scheme must match, or be `*`. The host matches in any
 * case and without a trailing dot. With no port, a host written out in full means the scheme's
 * default port only, and a host with a `*` in it any port; `:*` is any port. A pattern with no
 * path matches every path; a path matches in its own case.
 */
export function urlMatches(url: string, pattern: string): boolean {
  if (pattern === "*") return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const marked = pattern.replaceAll("*", STAR);
  let anyPort = false;
  let wanted: URL | undefined;
  try {
    wanted = new URL(marked);
  } catch {
    const zeroPort = marked.replace(new RegExp(`:${STAR}(?=[/?#]|$)`), ":0");
    if (zeroPort !== marked) {
      try {
        wanted = new URL(zeroPort);
        anyPort = true;
      } catch {
        wanted = undefined;
      }
    }
  }
  if (wanted === undefined)
    return glob(pattern, `${target.protocol}//${target.host}${target.pathname}${target.search}`);
  if (wanted.protocol !== `${STAR}:` && wanted.protocol !== target.protocol) return false;
  const host = target.hostname.replace(/\.$/, "").toLowerCase();
  const wantedHost = wanted.hostname.replace(/\.$/, "").toLowerCase().replaceAll(STAR, "*");
  if (!glob(wantedHost, host)) return false;
  if (wanted.port === "" && wanted.hostname.includes(STAR)) anyPort = true;
  if (!anyPort && wanted.port !== target.port) return false;
  if ((wanted.pathname === "/" || wanted.pathname === "") && wanted.search === "" && !marked.endsWith("/")) return true;
  return glob(`${wanted.pathname}${wanted.search}`.replaceAll(STAR, "*"), `${target.pathname}${target.search}`);
}
