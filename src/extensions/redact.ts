import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { isRecord } from "./read.js";

/** An option whose name says its value is a secret: `--api-key`, `--token`, `-p`assword... */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|passwd|auth|credential)[\w-]*$/i;

/**
 * The name of an assignment whose value is a secret, dash or not: `--token=`, and the
 * environment forms `GITHUB_TOKEN=` (docker `-e`, `env`) and `API_KEY=x cmd` (a hook's prefix).
 * No `/` or `:` in it, so a URL's query is left to the URL rule.
 */
const SECRET_NAME = /^[\w.-]*(key|token|secret|password|passwd|auth|credential)[\w.-]*$/i;

/** A header whose value is a credential: the name, then what follows its colon, if one does. */
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)\s*(?::([\s\S]*))?$/i;

/** An auth scheme: the word after it is the credential, whatever its shape. */
const AUTH_SCHEME = /^(bearer|basic)$/i;

/** The same scheme inside one argument that holds spaces, as an args entry can. */
const INLINE_SCHEME = /\b(bearer|basic)(\s+)[^\s"']+/gi;

/** curl's option for `user:password`. Only these: `-k` takes no value, and the next word is the URL. */
const USER_FLAG = /^(-u|--user)$/;

/**
 * A command line as the inventory shows it: a key-shaped word hidden, the value of an option or
 * an assignment named for a secret hidden (`--api-key VALUE`, `--token=VALUE`, `API_KEY=VALUE`),
 * a secret header's value hidden (`Authorization: ...`, `Cookie: ...`), the word after `Bearer`
 * or `Basic` hidden, the password of a `-u user:password` hidden, and a URL's userinfo and
 * query hidden. The name rules are what catch a token that is not key-shaped - a gateway's hex
 * token, say - which the shape check misses. The words are rejoined with single spaces - this
 * is for reading, not running.
 *
 * The words come either from an MCP server's args, one argument each, or from a hook command
 * split at whitespace, where a quoted argument arrives as several words with the quotes still
 * on its first and last. So a value that opens a quote runs on through the word that closes it,
 * the way the shell would read it, and the quotes are kept around what stands in for it.
 */
export function redactCommand(words: string[]): string {
  const shown: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const quote = leadingQuote(word);
    const body = word.slice(quote.length);
    const equals = body.indexOf("=");
    const name = equals > 0 ? body.slice(0, equals) : "";
    if (SECRET_NAME.test(name)) {
      const value = body.slice(equals + 1);
      const valueQuote = quote === "" ? leadingQuote(value) : "";
      const rest = quote === "" ? value.slice(valueQuote.length) : value;
      i = hideValue(words, i, `${quote}${name}=${valueQuote}`, quote || valueQuote, rest, shown);
      continue;
    }
    const after = equals > 0 && quote === "" ? body.slice(equals + 1) : undefined;
    const end =
      hideHeader(words, i, "", word, shown) ??
      (after === undefined ? undefined : hideHeader(words, i, `${name}=`, after, shown)) ??
      (after !== undefined && USER_FLAG.test(name) ? hideUserinfo(words, i, `${name}=`, after, shown) : undefined);
    if (end !== undefined) {
      i = end;
      continue;
    }
    if (carriesCredentialToken(word)) {
      shown.push(HIDDEN);
      continue;
    }
    shown.push(redactUrlsIn(word).replace(INLINE_SCHEME, `$1$2${HIDDEN}`));
    if (i + 1 >= words.length) continue;
    if (SECRET_FLAG.test(body) || AUTH_SCHEME.test(body)) {
      i = hideWord(words, i + 1, shown);
    } else if (USER_FLAG.test(body)) {
      i = hideUserinfo(words, i + 1, "", words[i + 1] ?? "", shown) ?? i;
    }
  }
  return shown.join(" ");
}

function leadingQuote(text: string): string {
  return text.startsWith('"') || text.startsWith("'") ? (text[0] ?? "") : "";
}

function trailingQuote(text: string): string {
  return text.endsWith('"') || text.endsWith("'") ? (text[text.length - 1] ?? "") : "";
}

/**
 * Shows `prefix` and HIDDEN in place of a value that starts in `words[at]`, and returns the
 * index of the value's last word. `rest` is the value's text in that word after `quote`, the
 * quote it is in, if any: one it does not close there runs on through the word that closes it,
 * or to the end. A closing quote is shown, so the line still reads as typed.
 */
function hideValue(words: string[], at: number, prefix: string, quote: string, rest: string, shown: string[]): number {
  let last = at;
  if (quote !== "" && !rest.endsWith(quote)) {
    while (last + 1 < words.length) {
      last++;
      if ((words[last] ?? "").endsWith(quote)) break;
    }
  }
  shown.push(`${prefix}${HIDDEN}${quote || trailingQuote(words[last] ?? "")}`);
  return last;
}

/**
 * When `text` - all of `words[at]`, or what follows `prefix` in it - is `user:password`, shows
 * the user and hides the rest, and returns the index of its last word. A bare user is left to
 * the other rules: curl asks for the password then.
 */
function hideUserinfo(words: string[], at: number, prefix: string, text: string, shown: string[]): number | undefined {
  const quote = leadingQuote(text);
  const body = text.slice(quote.length);
  const colon = body.indexOf(":");
  if (colon < 0) return undefined;
  return hideValue(words, at, `${prefix}${quote}${body.slice(0, colon + 1)}`, quote, body.slice(colon + 1), shown);
}

/** The secret in `words[at]`: what follows `--api-key` or `Bearer`. */
function hideWord(words: string[], at: number, shown: string[]): number {
  const word = words[at] ?? "";
  const quote = leadingQuote(word);
  return hideValue(words, at, quote, quote, word.slice(quote.length), shown);
}

/**
 * When `text` - all of `words[i]`, or what follows `prefix` in it - is a secret header, shows it
 * with its value hidden and returns the index of the value's last word. The value is what
 * follows the colon in the same word (`Authorization: Bearer X` as one argument), or the quote
 * the word opens (`"Authorization:` `Bearer` `X"`). A bare name, or one followed only by its
 * scheme, takes its value from the words after it: through a quote they open, else up to the
 * next option or the end.
 */
function hideHeader(words: string[], i: number, prefix: string, text: string, shown: string[]): number | undefined {
  const quote = leadingQuote(text);
  const body = text.slice(quote.length);
  const closed = quote !== "" && body.endsWith(quote);
  const header = SECRET_HEADER.exec(closed ? body.slice(0, -1) : body);
  if (!header) return undefined;
  const value = (header[2] ?? "").trim();
  if ((quote !== "" && !closed) || (value !== "" && !AUTH_SCHEME.test(value))) {
    return hideValue(words, i, `${prefix}${quote}${header[1]}: `, quote, body, shown);
  }
  shown.push(words[i] ?? "");
  const next = words[i + 1];
  if (next === undefined || next.startsWith("-")) return i;
  if (leadingQuote(next) !== "") return hideWord(words, i + 1, shown);
  let last = i + 1;
  while (last + 1 < words.length && !(words[last + 1] ?? "").startsWith("-")) last++;
  shown.push(`${HIDDEN}${trailingQuote(words[last] ?? "")}`);
  return last;
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
