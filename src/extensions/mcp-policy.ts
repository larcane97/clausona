import { valueHash } from "./hash.js";
import { isRecord } from "./read.js";

/**
 * Claude Code's `allowedMcpServers` and `deniedMcpServers` entries, and how one matches a
 * server, as Claude Code 2.1.296 matches them. Pure.
 *
 * An entry has one key: `serverName`, the server's name, matched exactly; `serverCommand`, the
 * command and its arguments, every one in order; or `serverUrl`, a URL pattern with `*`
 * wildcards. Claude Code expands `${VAR}` in a command or URL on both sides before it compares
 * them; clausona compares them as written.
 */

/** One entry. A command is kept as the hash of its words, as a server's is: nothing to print. */
export type McpRule = { serverName: string } | { serverCommand: string } | { serverUrl: string };

/**
 * What a server starts, to match an entry against, never printed: a stdio server's command and
 * arguments, hashed; a remote server's URL. `vars` when its config uses `${VAR}` anywhere, which
 * keeps a managed-mcp.json server on the allowlist check.
 */
export type McpTarget = { command?: string; url?: string; vars: boolean };

/** A list of entries as read from a settings file: undefined when it is no list, each entry kept that is one. */
export function mcpRules(value: unknown): McpRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry): McpRule[] => {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) return [];
    if (typeof entry.serverName === "string") return [{ serverName: entry.serverName }];
    if (Array.isArray(entry.serverCommand) && entry.serverCommand.every((word) => typeof word === "string")) {
      return [{ serverCommand: valueHash(entry.serverCommand) }];
    }
    if (typeof entry.serverUrl === "string") return [{ serverUrl: entry.serverUrl }];
    return [];
  });
}

/** What `config` starts: a stdio server is one of no type or `stdio`, a remote one has a `url`. */
export function mcpTarget(config: Record<string, unknown>): McpTarget {
  const vars = JSON.stringify(config).includes("${");
  const stdio = config.type === undefined || config.type === "stdio";
  if (stdio && typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args : [];
    return { command: valueHash([config.command, ...args]), vars };
  }
  if (typeof config.url === "string") return { url: config.url, vars };
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
