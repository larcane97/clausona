import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { isRecord } from "./read.js";

/** An option whose name says its value is a secret: `--api-key`, `--token`, `-p`assword... */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|passwd|auth|credential)[\w-]*$/i;

/**
 * A command line as the inventory shows it: a key-shaped word hidden, the value of an option
 * named for a secret hidden (`--api-key VALUE`, `--token=VALUE`), and a URL's userinfo and
 * query hidden. The words are rejoined with single spaces - this is for reading, not running.
 */
export function redactCommand(words: string[]): string {
  const shown: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const equals = word.indexOf("=");
    if (equals > 0 && SECRET_FLAG.test(word.slice(0, equals))) {
      shown.push(`${word.slice(0, equals)}=${HIDDEN}`);
      continue;
    }
    if (carriesCredentialToken(word)) {
      shown.push(HIDDEN);
      continue;
    }
    shown.push(redactUrlsIn(word));
    if (SECRET_FLAG.test(word) && i + 1 < words.length) {
      shown.push(HIDDEN);
      i++;
    }
  }
  return shown.join(" ");
}

/** The keys of an object as shown: a key-shaped one hidden too. */
function names(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).map((key) => (carriesCredentialToken(key) ? HIDDEN : key)) : [];
}

/**
 * What the inventory says about an MCP server: its transport, its command or URL, and only the
 * names of its env and headers. The values are never copied out of the config, so nothing
 * downstream - the TUI, `--json`, a log - can print them.
 */
export function mcpSummary(config: unknown): Record<string, string> {
  if (!isRecord(config)) return { transport: "unknown" };
  const url = typeof config.url === "string" ? config.url : undefined;
  const out: Record<string, string> = {
    transport: typeof config.type === "string" ? config.type : url ? "http" : "stdio",
  };
  if (url) out.url = redactBaseUrl(url);
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === "string") : [];
    out.command = redactCommand([config.command, ...args]);
  }
  const env = names(config.env);
  if (env.length > 0) out.env = env.join(", ");
  const headers = [...names(config.headers), ...names(config.http_headers), ...names(config.env_http_headers)];
  if (headers.length > 0) out.headers = headers.join(", ");
  return out;
}

/** What the inventory says about one hook command. */
export function hookSummary(event: string, matcher: string | undefined, hook: unknown): Record<string, string> {
  const out: Record<string, string> = { event };
  if (matcher) out.matcher = matcher;
  if (isRecord(hook)) {
    if (typeof hook.type === "string") out.type = hook.type;
    if (typeof hook.command === "string") out.command = redactCommand(hook.command.split(/\s+/).filter(Boolean));
    if (typeof hook.prompt === "string") out.prompt = redactCommand(hook.prompt.split(/\s+/).filter(Boolean));
  }
  return out;
}
