import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { isRecord } from "./read.js";

/**
 * The words that mark a name as holding a secret: `GITHUB_TOKEN`, `--api-key`, `X-Auth-Token`,
 * `apiKey`, `client_secret`, `Authorization`, `GITHUB_PAT`, `--passphrase`.
 */
const SECRET_WORDS = [
  "key",
  "token",
  "secret",
  "password",
  "passphrase",
  "passwd",
  "pwd",
  "auth",
  "authorization",
  "credential",
  "bearer",
  "pat",
  "jwt",
];

/**
 * Whether a name says it holds a secret: one of its parts (split at `-`, `_`, `.` and camelCase)
 * is a secret word, its plural or numbered form (`TOKEN1`, `oauth2`), or words run together that
 * end in one (`apikey`, `authtoken`, as ngrok and many CLIs write them). Whole parts, so a name
 * that only contains a secret word - `--path`, `PATH`, `--pattern`, `keycloak` - is a name like
 * any other. What a part ending in one also catches, `--hotkey`, `--compat`, `AUTH0_DOMAIN`, has
 * its value hidden: the safe side.
 */
function isSecretName(name: string): boolean {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .some((part) => {
      const word = part.toLowerCase().replace(/\d+$/, "").replace(/s$/, "");
      return SECRET_WORDS.some((secret) => word.endsWith(secret));
    });
}

/** An option whose name says its value is a secret: `--api-key VALUE`, `--token VALUE`. */
function isSecretFlag(word: string): boolean {
  const flag = /^--?([\w.-]+)$/.exec(word);
  return flag !== null && isSecretName(flag[1] ?? "");
}

/**
 * An assignment's name that says its value is a secret, dash or not: `--token=`, and the
 * environment forms `GITHUB_TOKEN=` (docker `-e`, `env`) and `API_KEY=x cmd` (a hook's prefix).
 * No `/` or `:` in it, so a URL's query is left to the URL rule.
 */
function isSecretAssignment(name: string): boolean {
  return /^[\w.-]+$/.test(name) && isSecretName(name);
}

/** A word that starts with a header name, its colon and the rest; a secret one, or `Cookie`, is hidden. */
const HEADER = /^([\w.-]+)(\s*:)([\s\S]*)$/;

/** A secret header's name with no colon: its value is in the words after it. */
const BARE_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie)$/i;

/** A word that ends with a key and its colon, as JSON split at a space does: `{"token":`. */
const ENDS_WITH_KEY = /(?<![\w.-])(["']?)([\w.-]+)\1\s*:$/;

/** A key and its separator inside a word, with the value's opening quote: `PRIVATE-TOKEN:`, `"apiKey":"`, `&password=`. */
const KEY_AT = /(?<![\w.-])(["']?)([\w.-]+)\1\s*[:=]\s*(["']?)/g;

/** An auth scheme: the word after it is the credential, whatever its shape. */
const AUTH_SCHEME = /^(bearer|basic)$/i;

/** The same scheme ending a word after a separator or a quote: `X-Upstream:Bearer`, `use=Bearer`, `:"Bearer`. */
const ENDING_SCHEME = /[:="'](bearer|basic)$/i;

/** GitHub's `token X` scheme: only after a header's colon, since `token` alone is an ordinary word. */
const TOKEN_SCHEME = /^token$/i;

/** curl's options for `user:password`, its own and the proxy's. Only these: `-k` takes no value. */
const USER_FLAG = /^(-u|--user|-U|--proxy-user)$/;

/** curl's option for the cookies to send, which carry a session as a password would. */
const COOKIE_FLAG = /^(-b|--cookie)$/;

/** `-ualice:pw`: the short option with the user attached, which no `=` or URL looks like. */
const ATTACHED_USER = /^-[uU][^\s:=/-][^\s:=/]*:/;

/** A URL inside a word: a scheme, `//`, then up to a space, a quote or a backtick. */
const URL_RUN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi;

/** A command line's words, and whether each ends an argument: an MCP server's can hold several. */
type Line = { words: string[]; ends: boolean[]; shown: string[] };

/** A POSIX shell's option for a command line: `-c`, alone or ending a run of short options (`-lc`, `-euc`). */
const POSIX_COMMAND = /^-[a-zA-Z]*c$/;

/** Each shell, by program name, with the option whose value is a command line for it to run. */
const SHELL_COMMAND = new Map<string, RegExp>([
  ...["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"].map((shell) => [shell, POSIX_COMMAND] as const),
  ["cmd", /^\/[cCkK]$/],
  // PowerShell's parameters ignore case.
  ["powershell", /^-c(ommand)?$/i],
  ["pwsh", /^-c(ommand)?$/i],
]);

/** A program's name from how a command line names it: `/bin/bash` and `C:\Windows\cmd.exe` are bash and cmd. */
function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

/** An option rather than a program: `-e`, `--`, or a cmd switch such as `/d` or `/e:on`. */
function isOption(word: string): boolean {
  return word.startsWith("-") || /^\/[a-z](:\S*)?$/i.test(word);
}

/**
 * Whether `args[at]` is a shell's option for a command line, so the next argument's words are
 * the shell's own words rather than one value. The shell is the program - `args[0]` - or the
 * nearest word before the option that is no option itself, so `env bash -c` and
 * `docker exec ctr sh -c` count too. After any other program's `-c`, `-C` or `/c` the argument
 * stays one value, which hides all of a value that runs through it (`make -C "TOKEN=a b"`):
 * a shell this does not know is over-hidden, never shown.
 *
 * Known limits, as the name rules have them anywhere: a password in free-form text - SQL's
 * `psql -c "ALTER ROLE r PASSWORD 'x'"` - is no secret-named key or option and is shown, and so
 * is a spaced value in a one-argument form body (`-d "user=bob&password=a b"` shows `b`).
 */
function isShellCommand(args: string[], at: number): boolean {
  const option = args[at];
  if (option === undefined || at < 1) return false;
  let nearest: string | undefined;
  for (let i = at - 1; i >= 0 && nearest === undefined; i--) {
    const word = args[i] ?? "";
    if (!isOption(word)) nearest = word;
  }
  return [args[0], nearest].some(
    (program) => program !== undefined && SHELL_COMMAND.get(programName(program))?.test(option) === true,
  );
}

/**
 * A command line as the inventory shows it, for reading, not running. Every argument is read
 * word by word, and hidden are:
 * - a key-shaped word, and the value of an option or assignment named for a secret
 *   (`--api-key VALUE`, `--token=VALUE`, `API_KEY=VALUE`);
 * - a value after any secret-named key inside a word, a header's or JSON's or a form body's
 *   (`X-Auth-Token: ...`, `{"apiKey":"..."}`, `user=bob&password=...`), and `Cookie`'s;
 * - the word after `Bearer` or `Basic`, and after `token` behind a header's colon;
 * - the password of `-u`/`--user`/`-U`/`--proxy-user` `user:password`;
 * - in every URL, its userinfo, query and fragment, and a path segment that is a secret.
 * The name rules are what catch a token that is not key-shaped - a gateway's hex token, say -
 * which the shape check misses.
 *
 * The words come from an MCP server's command and args, one argument each, or from a hook
 * command split at whitespace, where a quoted argument arrives as several words with the quotes
 * still on its first and last. So a value that opens a quote runs on through the word that
 * closes it, the way the shell would read it, and one in an argument of several words runs to
 * that argument's end. The quotes are kept around what stands in for a value.
 */
export function redactCommand(args: string[]): string {
  const line: Line = { words: [], ends: [], shown: [] };
  for (const [n, arg] of args.entries()) {
    const words = arg.split(/\s+/).filter(Boolean);
    const commandLine = isShellCommand(args, n - 1);
    for (const [k, word] of words.entries()) {
      line.words.push(word);
      line.ends.push(commandLine || k === words.length - 1);
    }
  }
  for (let i = 0; i < line.words.length; i++) i = redactAt(line, i);
  return line.shown.join(" ");
}

/** Shows `words[i]`, and the words its value takes, redacted; returns the index of the last one. */
function redactAt(line: Line, i: number): number {
  const word = line.words[i] ?? "";
  const quote = leadingQuote(word);
  const body = word.slice(quote.length);
  const equals = body.indexOf("=");
  const name = equals > 0 ? body.slice(0, equals) : "";
  const value = equals > 0 ? body.slice(equals + 1) : undefined;
  if (value !== undefined && isSecretAssignment(name)) {
    const valueQuote = quote === "" ? leadingQuote(value) : "";
    const rest = quote === "" ? value.slice(valueQuote.length) : value;
    return hideValue(line, i, `${quote}${name}=${valueQuote}`, quote || valueQuote, rest);
  }
  const assigned = value !== undefined && quote === "" ? value : undefined;
  const special =
    hideHeader(line, i, "", word) ??
    (word.startsWith("-H") ? hideHeader(line, i, "-H", word.slice(2)) : undefined) ??
    (assigned === undefined ? undefined : hideHeader(line, i, `${name}=`, assigned)) ??
    (assigned !== undefined && USER_FLAG.test(name) ? hideUserinfo(line, i, `${name}=`, assigned) : undefined) ??
    (assigned !== undefined && COOKIE_FLAG.test(name) ? hideCookie(line, i, `${name}=`, assigned) : undefined) ??
    (ATTACHED_USER.test(word) ? hideUserinfo(line, i, word.slice(0, 2), word.slice(2)) : undefined);
  if (special !== undefined) return special;
  if (carriesCredentialToken(word)) {
    line.shown.push(HIDDEN);
    return i;
  }
  const open = openKeyValue(word);
  if (open) return hideValue(line, i, redactWord(word.slice(0, open.at)), open.quote, word.slice(open.at));
  line.shown.push(redactWord(word));
  if (i + 1 >= line.words.length) return i;
  if (isSecretName(ENDS_WITH_KEY.exec(word)?.[2] ?? ""))
    return hideFollowing(line, i, quote !== "" && !body.includes(quote) ? quote : "");
  const afterColon = (line.words[i - 1] ?? "").endsWith(":");
  const scheme = AUTH_SCHEME.test(body) || ENDING_SCHEME.test(word) || (afterColon && TOKEN_SCHEME.test(body));
  // After a scheme, the next word is the credential, whatever its shape.
  if (scheme) return hideWord(line, i + 1);
  if (isSecretFlag(body) || COOKIE_FLAG.test(body)) {
    // The next word is this flag's value, dash or not - a URL-safe token or a password can start
    // with one - unless its own rule hides what it carries: then this flag takes no value (`-b`
    // in many tools, `--auth`), and taking the word would print that word's secret instead.
    if (hidesOwnValue(line.words[i + 1] ?? "")) return i;
    return hideWord(line, i + 1);
  }
  if (USER_FLAG.test(body)) return hideUserinfo(line, i + 1, "", line.words[i + 1] ?? "") ?? i;
  return i;
}

/**
 * Whether `word`'s own rule hides the value it carries or takes: an option spelled out and named
 * for a secret (`--api-key`, `--token=x`), curl's cookie and user options, `-H`/`--header`, an
 * auth scheme, a header named for a secret (`X-Api-Key:`). Only a double-dash option name
 * counts as named for a secret: a dash-led token can read like a single-dash one (`-xKey9…`).
 */
function hidesOwnValue(word: string): boolean {
  const body = word.slice(leadingQuote(word).length);
  if (COOKIE_FLAG.test(body) || USER_FLAG.test(body) || /^(-H|--header)$/.test(body) || AUTH_SCHEME.test(body)) {
    return true;
  }
  const option = /^(--[\w.-]+)(=?)/.exec(body);
  if (option) {
    const [whole = "", name = "", assigns = ""] = option;
    const spelled = assigns !== "" || whole === body;
    // `--api-key`, `--token=x`; and `--cookie=x`, `--user=u:p`, whose values their rules hide.
    if (spelled && isSecretName(name.slice(2))) return true;
    if (assigns !== "" && (COOKIE_FLAG.test(name) || USER_FLAG.test(name))) return true;
  }
  const header = /^([\w.-]+)\s*:/.exec(body);
  return header !== null && (isSecretName(header[1] ?? "") || /^cookie$/i.test(header[1] ?? ""));
}

function leadingQuote(text: string): string {
  return text.startsWith('"') || text.startsWith("'") ? (text[0] ?? "") : "";
}

const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * What closes around a value at the end of a word - quotes and brackets that something before
 * the value opened - to show after it. One the value opened itself is the value's: the `}` of
 * `${API_KEY}`.
 */
function closingTail(text: string): string {
  let tail = /["'`)\]}]*$/.exec(text)?.[0] ?? "";
  let value = text.slice(0, text.length - tail.length);
  const count = (c: string) => value.split(c).length - 1;
  for (;;) {
    const c = tail[0];
    if (c === undefined) break;
    const opener = OPENER[c];
    const ownsIt = opener ? count(opener) > count(c) : count(c) % 2 === 1;
    if (!ownsIt) break;
    value += c;
    tail = tail.slice(1);
  }
  return tail;
}

/** The index of the last word of the argument `words[i]` is in. */
function argEnd(line: Line, i: number): number {
  let last = i;
  while (last + 1 < line.words.length && !line.ends[last]) last++;
  return last;
}

/**
 * The last word of a value hidden to the end of `words[i]`'s argument - and when that argument
 * ends in a bare `Bearer` or `Basic`, of the next argument too, which then holds the credential:
 * `--header "Authorization: Bearer" "$TOKEN"`.
 */
function valueEnd(line: Line, i: number): number {
  const last = argEnd(line, i);
  const word = (line.words[last] ?? "").replace(/^["']+|["']+$/g, "");
  return AUTH_SCHEME.test(word) && last + 1 < line.words.length ? argEnd(line, last + 1) : last;
}

/**
 * Shows `prefix` and HIDDEN in place of a value that starts in `words[at]`, and returns the
 * index of the value's last word. `rest` is the value's text in that word after `quote`, the
 * quote it is in, if any: the value runs to the quote's closing - in this word or a later one,
 * or the end - and what follows that is shown, redacted. An unquoted value is the rest of the
 * word, with any closing quotes or brackets after it shown - or, when the word is not the last
 * of its argument, the rest of that argument.
 */
function hideValue(line: Line, at: number, prefix: string, quote: string, rest: string): number {
  if (quote === "") {
    // An argument that goes on past the value's word is value to its end: `API_KEY=a b`,
    // `alice:a b`, and `--api-key a b` as one argument. It is one value to the program, whatever
    // its spaces; a shell's command line, whose words are the shell's own, ends at each word.
    if (!line.ends[at]) {
      line.shown.push(`${prefix}${HIDDEN}`);
      return valueEnd(line, at);
    }
    line.shown.push(`${prefix}${HIDDEN}${closingTail(rest)}`);
    return at;
  }
  let last = at;
  let text = rest;
  let close = text.indexOf(quote);
  while (close < 0 && last + 1 < line.words.length) {
    last++;
    text = line.words[last] ?? "";
    close = text.indexOf(quote);
  }
  line.shown.push(`${prefix}${HIDDEN}${quote}${close < 0 ? "" : redactWord(text.slice(close + 1))}`);
  return last;
}

/** Hides `words[at]`, a secret on its own: what follows `--api-key` or `Bearer`, and the rest of its argument. */
function hideWord(line: Line, at: number): number {
  const word = line.words[at] ?? "";
  const quote = leadingQuote(word);
  if (quote !== "") return hideValue(line, at, quote, quote, word.slice(1));
  return hideValue(line, at, "", "", word);
}

/**
 * Hides the value after `words[i]`, a key or header name whose value is not in the word: the
 * quoted string the next word opens; else the rest of `openQuote`, a quote `words[i]` left open;
 * else the rest of `words[i]`'s argument; else the words up to the next option or the end.
 */
function hideFollowing(line: Line, i: number, openQuote: string): number {
  const next = line.words[i + 1];
  if (next === undefined) return i;
  const quote = leadingQuote(next);
  if (quote !== "") return hideValue(line, i + 1, quote, quote, next.slice(1));
  if (openQuote !== "") return hideValue(line, i + 1, "", openQuote, next);
  let last = i + 1;
  if (!line.ends[i]) {
    last = valueEnd(line, i);
  } else {
    if (next.startsWith("-")) return i;
    while (last + 1 < line.words.length && !(line.words[last + 1] ?? "").startsWith("-")) last++;
  }
  line.shown.push(`${HIDDEN}${closingTail(line.words[last] ?? "")}`);
  return last;
}

/**
 * When `text` - all of `words[i]`, or what follows `prefix` in it - starts with a secret header,
 * shows it with its value hidden and returns the index of the value's last word. The value is
 * what follows the colon in the word (`PRIVATE-TOKEN:x`), with a quote it opens there
 * (`Authorization:"Bearer x"`) or the word opened before the name (`"Authorization:` `Bearer`
 * `x"`) running on to its closing. A name with nothing after it but a scheme takes its value
 * from the words after it (`hideFollowing`), as a bare `Authorization` or `Cookie` does.
 */
function hideHeader(line: Line, i: number, prefix: string, text: string): number | undefined {
  const quote = leadingQuote(text);
  const body = text.slice(quote.length);
  const header = HEADER.exec(body);
  if (!header || !(isSecretName(header[1] ?? "") || /^cookie$/i.test(header[1] ?? ""))) {
    const closed = quote !== "" && body.endsWith(quote);
    if (!BARE_HEADER.test(closed ? body.slice(0, -1) : body)) return undefined;
    line.shown.push(line.words[i] ?? "");
    return hideFollowing(line, i, closed ? "" : quote);
  }
  const [, headerName = "", colon = "", after = ""] = header;
  const space = /^\s*/.exec(after)?.[0] ?? "";
  const value = after.slice(space.length);
  const head = `${prefix}${quote}${headerName}${colon}${space}`;
  const valueQuote = leadingQuote(value);
  if (valueQuote !== "") return hideValue(line, i, `${head}${valueQuote}`, valueQuote, value.slice(1));
  const open = quote !== "" && !after.includes(quote);
  const inWord = (quote !== "" && !open ? after.slice(0, after.indexOf(quote)) : after).trim();
  if (inWord !== "" && !AUTH_SCHEME.test(inWord) && !TOKEN_SCHEME.test(inWord)) {
    if (quote === "" && !line.ends[i]) {
      line.shown.push(`${head}${HIDDEN}`);
      return valueEnd(line, i);
    }
    return hideValue(line, i, head, quote, value);
  }
  line.shown.push(line.words[i] ?? "");
  return hideFollowing(line, i, open ? quote : "");
}

/**
 * When `text` - all of `words[at]`, or what follows `prefix` in it - is `user:password`, shows
 * the user and hides the rest, and returns the index of its last word. A bare user is left to
 * the other rules, curl asking for the password then, and so is a URL, whose rules hide its
 * userinfo.
 */
function hideUserinfo(line: Line, at: number, prefix: string, text: string): number | undefined {
  const quote = leadingQuote(text);
  const body = text.slice(quote.length);
  const colon = body.indexOf(":");
  if (colon < 0 || body.includes("://")) return undefined;
  return hideValue(line, at, `${prefix}${quote}${body.slice(0, colon + 1)}`, quote, body.slice(colon + 1));
}

/**
 * Hides a cookie list that follows `prefix` in `words[at]` - `--cookie=` - with a quote it
 * opens running on to its closing, as a hook command split at spaces has `"a=1` `sid=x"`.
 */
function hideCookie(line: Line, at: number, prefix: string, text: string): number {
  const quote = leadingQuote(text);
  return hideValue(line, at, `${prefix}${quote}`, quote, text.slice(quote.length));
}

/** A word with every URL in it shown as `showUrl` does, and the text around them by `redactText`. */
function redactWord(word: string): string {
  let shown = "";
  let from = 0;
  for (const match of word.matchAll(URL_RUN)) {
    const start = match.index ?? 0;
    shown += redactText(word.slice(from, start)) + showUrl(match[0]);
    from = start + match[0].length;
  }
  return shown + redactText(word.slice(from));
}

/** Text that is not a URL: a secret-named key's value hidden, and `user:password@host` userinfo. */
function redactText(text: string): string {
  return text === "" ? "" : redactUrlsIn(hideKeyValues(text));
}

/**
 * Where a secret-named key's quoted value starts in `word` when the word does not close its
 * quote: the value is then the shell's or JSON's one string across words, as in
 * `{"Authorization":"Bearer x"}` read word by word, and runs on to the closing quote.
 */
function openKeyValue(word: string): { at: number; quote: string } | undefined {
  const keys = new RegExp(KEY_AT.source, "g");
  for (let key = keys.exec(word); key !== null; key = keys.exec(word)) {
    const quote = key[3] ?? "";
    const at = key.index + key[0].length;
    if (quote !== "" && isSecretName(key[2] ?? "") && !word.slice(at).includes(quote)) return { at, quote };
  }
  return undefined;
}

/**
 * A secret-named key's value inside a word: `PRIVATE-TOKEN:x`, `{"apiKey":"x"}`,
 * `user=bob&password=x`. The separator is required, which leaves prose that names a secret as
 * written; the value runs to a quote, a space or the next field. A key that is not secret-named
 * is stepped over at its separator, so one in its value - `opt=token=x` - is still found.
 */
function hideKeyValues(text: string): string {
  const keys = new RegExp(KEY_AT.source, "g");
  let shown = "";
  let from = 0;
  for (let key = keys.exec(text); key !== null; key = keys.exec(text)) {
    if (!isSecretName(key[2] ?? "")) continue;
    const start = key.index + key[0].length;
    const value = /^[^\s"'&,;}]+/.exec(text.slice(start))?.[0];
    if (value === undefined) continue;
    shown += `${text.slice(from, start)}${HIDDEN}`;
    from = start + value.length;
    keys.lastIndex = from;
  }
  return shown + text.slice(from);
}

/**
 * A path segment that is a secret rather than a name: a run of 20 or more letters, digits, `_`
 * and `-` with both letters and digits in it (a Slack or Discord webhook's secret, an API key in
 * a path), or a UUID (a capability URL's, as Pipedream's MCP URLs are). A commit hash or a long
 * versioned name goes too.
 */
function opaqueSegment(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  return /^[\w-]{20,}$/.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment);
}

/**
 * A URL as the inventory shows it: userinfo, query and fragment hidden by `redactBaseUrl`'s
 * rules, then each path segment that is a secret, and the token of a Telegram `bot<id>:` one.
 * The path is cut from the string `redactBaseUrl` returns, after the authority, so what it hid
 * stays hidden and the rest reads as typed.
 */
function showUrl(url: string): string {
  const shown = redactBaseUrl(url);
  const parts = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)([\s\S]*)$/i.exec(shown);
  if (!parts) return shown;
  const path = (parts[2] ?? "")
    .split("/")
    .map((segment) => {
      const bot = /^(bot\d+:)./.exec(segment);
      if (bot) return `${bot[1]}${HIDDEN}`;
      return opaqueSegment(segment) ? HIDDEN : segment;
    })
    .join("/");
  return `${parts[1]}${path}${parts[3]}`;
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
  if (url) out.url = showUrl(url);
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === "string") : [];
    // The command is a command line when it holds spaces, so its words are its own arguments.
    out.command = redactCommand([...config.command.split(/\s+/), ...args]);
  }
  const env = names(config.env);
  if (env.length > 0) out.env = env.join(", ");
  const headers = [...names(config.headers), ...names(config.http_headers), ...names(config.env_http_headers)];
  if (headers.length > 0) out.headers = headers.join(", ");
  return out;
}

/**
 * What the inventory says about one hook command. The command is split at whitespace, each
 * word its own argument, so a quoted one is read across its words (see `redactCommand`).
 */
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
