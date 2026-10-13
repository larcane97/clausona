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

/** The word SQL puts before a password literal: `PASSWORD 'x'`. MySQL's `IDENTIFIED BY 'x'` is the other. */
const SQL_PASSWORD = /^password$/i;

/** A word that ends one command and starts the next, in a shell's command line: `&&`, `|`, `&`, `cmd;`. */
const SEPARATOR = /^(&&|\|\||\||\|&|&|;)$|;$/;

/** A line break, which ends a command in a command line as `;` does. */
const LINE_BREAK = /\r\n|\r|\n/;

/** A word that goes on to the next line: a `\` at its end, or cmd's `^`, or PowerShell's backtick. */
const CONTINUES = /[\\^`]$/;

/** A word that may start a command: what a command line or a separator puts first, or runs the rest. */
const RUNS_NEXT = /^(env|sudo|exec|command|nohup|time|xargs)$/;

/** An option name as people spell them: lowercase words in kebab, snake or camel case, a number only at the end. */
const SPELLED_OPTION = /^[a-z]+(?:[A-Z][a-z]+)*(?:[-_][a-z]+(?:[A-Z][a-z]+)*)*\d?$/;

/** A single-dash option in Go's style: lowercase words, `-token`, `-api-key`. */
const GO_OPTION = /^-[a-z][a-z\d]*(?:[-_][a-z\d]+)*$/;

/**
 * A command line's words: whether each ends an argument (an MCP server's argument can hold
 * several), the quote a value that ends at a word goes on in (`openQuotes`), the words whose
 * shown text joins the one before it with no space - a form field cut from the word a hidden
 * value ended in (`stopAtField`) - and the words a line break comes before, in a command line.
 */
type Line = {
  words: string[];
  ends: boolean[];
  open: string[];
  shown: string[];
  joined: Set<number>;
  breaks: Set<number>;
};

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
 * - SQL's password literal, `PASSWORD 'x'` and `IDENTIFIED BY 'x'`;
 * - in every URL, its userinfo, query and fragment, and a path segment that is a secret.
 * The name rules are what catch a token that is not key-shaped - a gateway's hex token, say -
 * which the shape check misses.
 *
 * The words come from an MCP server's command and args, one argument each, or from a hook
 * command split at whitespace, where a quoted argument arrives as several words with the quotes
 * still on its first and last. So a value that opens a quote runs on through the word that
 * closes it, the way the shell would read it, and so does one that ends at a word inside a
 * quoted string (`-d "user=bob&password=a b"`); one in an argument of several words runs to
 * that argument's end. A form field's value that runs on so ends at the next field
 * (`-d "a=1&password=a b&name=c"`), as a form's reader splits it. The quotes are kept around
 * what stands in for a value.
 *
 * A line break ends a command where `args` is a command line: the text of a hook or a command
 * split at its whitespace, the arguments `lineStarts` names coming after one (`commandWords`),
 * and a shell's command line in one argument. An MCP server's other arguments are values, a line
 * break in them too.
 */
export function redactCommand(args: string[], lineStarts: ReadonlySet<number> = new Set()): string {
  const line: Line = { words: [], ends: [], open: [], shown: [], joined: new Set(), breaks: new Set() };
  const bodies: boolean[] = [];
  let broken = false;
  for (const [n, arg] of args.entries()) {
    const commandLine = isShellCommand(args, n - 1);
    const lines = commandLine ? arg.split(LINE_BREAK) : [arg];
    broken ||= lineStarts.has(n);
    const words = lines.flatMap((text, l) =>
      text
        .split(/\s+/)
        .filter(Boolean)
        .map((word, w) => ({ word, after: l > 0 && w === 0 })),
    );
    for (const [k, { word, after }] of words.entries()) {
      if (broken || after) line.breaks.add(line.words.length);
      broken = false;
      line.words.push(word);
      line.ends.push(commandLine || k === words.length - 1);
      bodies.push(commandLine && k === 0);
    }
  }
  line.open = openQuotes(line.words, bodies);
  for (let i = 0; i < line.words.length; i++) {
    const from = line.shown.length;
    const joins = line.joined.has(i) && from > 0;
    i = redactAt(line, i);
    if (joins) line.shown.splice(from - 1, 2, `${line.shown[from - 1]}${line.shown[from] ?? ""}`);
  }
  return line.shown.join(" ");
}

/** What may stand after a closing quote at a word's end: `x"}`, `y'),`. */
const CLOSERS = /[)\]},;]/;

/**
 * For each word, the quote a value that ends at it goes on in: one opened by it or by a word
 * before it - at a word's start, or right after the `=` or `:` of an assignment
 * (`TOKEN='a`) - and not closed by its end. Empty when there is none, or when the innermost
 * open quote holds a shell's command line (`bash -c "...`, `bodies`), whose words are the
 * shell's own and not one value. A word closes the quotes its end does, innermost first, a
 * bracket or comma after them aside (`b'"`, `x"}`), but not one it opened itself (`x='y'`).
 */
function openQuotes(words: string[], bodies: boolean[]): string[] {
  const stack: { quote: string; body: boolean }[] = [];
  return words.map((word, i) => {
    const lead = leadingQuote(word);
    if (lead !== "" && word === lead) {
      // A lone quote closes the one open, or opens one.
      if (stack.at(-1)?.quote === lead) stack.pop();
      else stack.push({ quote: lead, body: bodies[i] === true });
    } else {
      if (lead !== "") stack.push({ quote: lead, body: bodies[i] === true });
      const inner = lead === "" ? /^[^\s"']*?[=:](["'])/.exec(word) : null;
      const innerQuote = inner?.[1] ?? "";
      if (inner && !word.slice(inner[0].length).includes(innerQuote)) stack.push({ quote: innerQuote, body: false });
      const tail = /["')\]},;]*$/.exec(word)?.[0] ?? "";
      const before = word.slice(lead.length, word.length - tail.length);
      for (const c of tail) {
        if (CLOSERS.test(c) || stack.at(-1)?.quote !== c) continue;
        // A quote the word opened and closed itself, as `x='y'` does, is the word's own.
        if (before.split(c).length % 2 === 0) continue;
        stack.pop();
      }
    }
    const top = stack.at(-1);
    return top === undefined || top.body ? "" : top.quote;
  });
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
  // A secret-named key's unquoted value that runs to the word's end goes on with its argument,
  // or in the quoted string the word is in: `-d "user=bob&password=a b"`.
  const tail = valueAtEnd(word);
  if (tail !== undefined && (!line.ends[i] || line.open[i] !== "")) {
    return hideValue(line, i, redactWord(word.slice(0, tail.at)), "", word.slice(tail.at), tail.field);
  }
  line.shown.push(redactWord(word));
  if (i + 1 >= line.words.length) return i;
  if (isSecretName(ENDS_WITH_KEY.exec(word)?.[2] ?? ""))
    return hideFollowing(line, i, quote !== "" && !body.includes(quote) ? quote : "");
  const afterColon = (line.words[i - 1] ?? "").endsWith(":");
  // A scheme closing a quoted value takes its credential from the next word all the same:
  // `-H "X-Upstream: Basic" "$TOKEN"`.
  const closed = word.replace(/["']+$/, "");
  const scheme =
    AUTH_SCHEME.test(unquoted(word)) || ENDING_SCHEME.test(closed) || (afterColon && TOKEN_SCHEME.test(body));
  // After a scheme, the next word is the credential, whatever its shape.
  if (scheme) return hideWord(line, i + 1);
  // SQL's password literal is the quoted string after PASSWORD, or after IDENTIFIED BY.
  const sql =
    SQL_PASSWORD.test(body) || (/^by$/i.test(body) && /^identified$/i.test(unquoted(line.words[i - 1] ?? "")));
  if (sql && leadingQuote(line.words[i + 1] ?? "") !== "") return hideWord(line, i + 1);
  if (isSecretFlag(body) || isCookieFlag(line, i)) return hideFlagValue(line, i);
  if (USER_FLAG.test(body)) return hideUserinfo(line, i + 1, "", line.words[i + 1] ?? "") ?? i;
  return i;
}

/**
 * Hides the value of `words[i]`, an option named for a secret or curl's cookie option, and
 * returns the index of its last word. The next word is the value, dash or not - a URL-safe token
 * or a password can start with one - unless its own rule hides what it carries: then this option
 * takes no value (`-b` in many tools, `--auth`), and taking the word would print that word's
 * secret instead. But a quoted string and an argument of several words are a value, whatever
 * they start with (`--token "-u x"`). And a word that may be either - an option named for a
 * secret in Go's single-dash style (`-b -token x`), or a double-dash one not spelled the way
 * option names are (`--Tk9Secret`) - is hidden as a value, and so is the word after it, its
 * value if it is an option: whichever it is, the secret is hidden. One spelled as option names
 * are is read as `optionOrValue` says.
 */
function hideFlagValue(line: Line, i: number): number {
  const at = i + 1;
  const next = line.words[at] ?? "";
  if (leadingQuote(next) !== "" || !line.ends[at]) return hideWord(line, at);
  if (isSpelledSecretOption(next)) return optionOrValue(line, at);
  const either = mayBeSecretFlag(next);
  if (!either && hidesOwnValue(line, at)) return i;
  const last = hideWord(line, at);
  if (!either || last !== at || at + 1 >= line.words.length || hidesOwnValue(line, at + 1)) return last;
  return hideWord(line, at + 1);
}

/** A double-dash option spelled the way option names are, and named for a secret: `--api-key`. */
function isSpelledSecretOption(word: string): boolean {
  const option = /^--([\w.-]+)$/.exec(word)?.[1];
  return option !== undefined && isSecretName(option) && SPELLED_OPTION.test(option);
}

/**
 * Shows `words[at]`, a word spelled like an option named for a secret right after a secret's
 * option, and what it takes; returns the index of the last word. It is read by its own rule
 * first. When that takes a plain value, it is an option, as in `--auth --api-key K`. Otherwise it
 * is the value of the option before it, a password such as `--mytoken`, and is hidden: nothing
 * follows it in its command, or what follows has a rule of its own (`-H …`), or what it took
 * starts with a dash or ends the command, which stays hidden too. So the secret is hidden
 * whichever it is; only a password of that spelling with a plain word after it still shows.
 */
function optionOrValue(line: Line, at: number): number {
  const first = line.shown.length;
  const last = redactAt(line, at);
  const taken = last > at ? unquoted(line.words[at + 1] ?? "") : "";
  const elsewhere = SEPARATOR.test(taken) || line.breaks.has(at + 1);
  if (taken === "" || taken.startsWith("-") || elsewhere) line.shown[first] = HIDDEN;
  return last;
}

/** See hideFlagValue: a word after a secret's option that may be its value or an option of its own. */
function mayBeSecretFlag(word: string): boolean {
  if (GO_OPTION.test(word)) return isSecretFlag(word);
  const option = /^--([\w.-]+)$/.exec(word)?.[1];
  return option !== undefined && isSecretName(option) && !SPELLED_OPTION.test(option);
}

/**
 * The programs whose `-b` is no credential, as their man pages give it: git's names a branch;
 * the others' is a size, a byte list, a path or a batch file (tar, cut, split, tail, base64,
 * zip, sftp), a backup (cp, mv, ln, install, rsync, patch), or a switch of their own (sort, du,
 * ls, grep, diff, ...). Left out are a tool whose `-b` can be a secret (`gh secret set -b`), and
 * one whose later words can be another program's (python's script, ssh's remote command).
 */
const NO_COOKIE_B = new Set([
  "base64",
  "cat",
  "cp",
  "cut",
  "df",
  "diff",
  "du",
  "file",
  "fold",
  "git",
  "grep",
  "hexdump",
  "install",
  "ln",
  "ls",
  "lsof",
  "md5sum",
  "mv",
  "nl",
  "od",
  "patch",
  "rg",
  "rsync",
  "sftp",
  "sha256sum",
  "shasum",
  "sort",
  "split",
  "tail",
  "tar",
  "unzip",
  "wget",
  "xxd",
  "zip",
]);

/**
 * Whether `words[i]` is curl's cookie option, `-b` or `--cookie`. Under git and the other
 * programs of NO_COOKIE_B, `-b` is their own (`git checkout -b feature`, `tar -b 20`): the
 * command it is in is theirs. Anywhere else `-b` is read as curl's, the safe side, whatever the
 * program.
 */
function isCookieFlag(line: Line, i: number): boolean {
  const word = line.words[i] ?? "";
  const body = word.slice(leadingQuote(word).length);
  return COOKIE_FLAG.test(body) && (body !== "-b" || !underNoCookieTool(line, i));
}

/**
 * Whether the command `words[i]` is in is one of NO_COOKIE_B's: walking back to a separator, a
 * line break or the line's start, a word names one of them where it starts a command
 * (`startsCommand`), and no word on the way names curl. A name that starts no command is an
 * argument (`--name tar`), and the walk goes on past it. The walk stops at any separator or line
 * break, one in a quoted value too: the command before it is not read as `-b`'s.
 */
function underNoCookieTool(line: Line, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    if (line.breaks.has(k + 1)) return false;
    const word = unquoted(line.words[k] ?? "");
    const program = programName(word);
    if (SEPARATOR.test(word) || program === "curl") return false;
    if (NO_COOKIE_B.has(program) && startsCommand(line, k)) return true;
  }
  return false;
}

/**
 * Whether `words[k]` starts a command: it is the line's first word, or follows a line break, a
 * separator or a shell's command option, or a word that runs the next one where that word starts
 * a command itself - `sudo rsync`, but not `--mode time sort`, where time is an argument. Not in
 * a value (`inValue`), whose `&&`, `;`, line break or `-c` is the value's, nor at a line a word
 * goes on from (`CONTINUES`).
 */
function startsCommand(line: Line, k: number): boolean {
  if (k === 0) return true;
  if (inValue(line, k)) return false;
  const before = line.words[k - 1] ?? "";
  if (line.breaks.has(k)) return !CONTINUES.test(before);
  if (SEPARATOR.test(before) || opensShellLine(line.words, k - 1)) return k < 2 || !inValue(line, k - 1);
  return RUNS_NEXT.test(unquoted(before)) && startsCommand(line, k - 1);
}

/**
 * Whether `words[k]` is in one value with the word before it: in a quoted string that goes on
 * past that word (`openQuotes`), or in the same argument, one that is no shell's command line.
 */
function inValue(line: Line, k: number): boolean {
  return line.open[k - 1] !== "" || line.ends[k - 1] !== true;
}

/**
 * Whether `words[at]` is the option a shell takes its command line with (`isShellCommand`), and
 * not a later program's: when the line's program is the shell, its first such option is. So in
 * `bash -c "tool -c tar -b x"`, tool's `-c` starts no command, and its `-b` stays curl's.
 */
function opensShellLine(words: string[], at: number): boolean {
  const shell = SHELL_COMMAND.get(programName(words[0] ?? ""));
  if (shell !== undefined && words.slice(1, at).some((word) => shell.test(word))) return false;
  return isShellCommand(words, at);
}

/** A word without the quotes at its ends. */
function unquoted(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/**
 * Whether `words[at]`'s own rule hides the value it carries or takes: an option spelled out and
 * named for a secret (`--api-key`, `--token=x`), curl's cookie and user options, `-H`/`--header`,
 * an auth scheme, a header named for a secret (`X-Api-Key:`). Only a double-dash option name
 * counts as named for a secret: a dash-led token can read like a single-dash one (`-xKey9…`).
 */
function hidesOwnValue(line: Line, at: number): boolean {
  const word = line.words[at] ?? "";
  const body = word.slice(leadingQuote(word).length);
  if (isCookieFlag(line, at) || USER_FLAG.test(body) || /^(-H|--header)$/.test(body) || AUTH_SCHEME.test(body)) {
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
 * of its argument, the rest of that argument; or, when the word is in a quoted string that goes
 * on past it (`openQuotes`), the rest of that string. When the value is a form's `field`, either
 * ends at the next field (`nextField`).
 */
function hideValue(line: Line, at: number, prefix: string, quote: string, rest: string, field = false): number {
  if (quote === "") {
    // An argument that goes on past the value's word is value to its end: `API_KEY=a b`,
    // `alice:a b`, and `--api-key a b` as one argument. It is one value to the program, whatever
    // its spaces; a shell's command line, whose words are the shell's own, ends at each word.
    if (!line.ends[at]) {
      const next = field ? nextField(line, at, argEnd(line, at), "") : undefined;
      if (next) return stopAtField(line, prefix, next);
      line.shown.push(`${prefix}${HIDDEN}`);
      return valueEnd(line, at);
    }
    // So is a quoted string the shell reads as one word: `-b TOKEN='a b'`, `-u alice:"a b"`. A
    // quote the value opened goes with it; one opened before it is shown closing.
    const open = line.open[at] ?? "";
    if (open !== "" && at + 1 < line.words.length) {
      const { last, after } = closing(line, at + 1, open, line.words[at + 1] ?? "");
      const next = field ? nextField(line, at, last, open) : undefined;
      if (next) return stopAtField(line, prefix, next);
      line.shown.push(`${prefix}${HIDDEN}${rest.includes(open) ? "" : open}${after}`);
      return last;
    }
    line.shown.push(`${prefix}${HIDDEN}${closingTail(rest)}`);
    return at;
  }
  const { last, after, closed, inside } = closing(line, at, quote, rest);
  line.shown.push(`${prefix}${HIDDEN}${quote}${after}`);
  // `--header "Authorization: Bearer" "$TOKEN"`: a quoted value that ends in a bare scheme takes
  // the credential from the word after it.
  const scheme = closed && after === "" && AUTH_SCHEME.test(inside.trim().split(/\s+/).pop() ?? "");
  return scheme && last + 1 < line.words.length ? hideWord(line, last + 1) : last;
}

/**
 * Where the next field of a form starts after a value that runs on from `words[at]` to `last`:
 * the word, and the place in it of the first `&` that a field's name and `=` follow
 * (`b&name=c`). `quote` is the quote the value is in, if any; a field after it closes is not
 * the value's. None when a quote comes first, since what it opens or closes is not known here.
 */
function nextField(line: Line, at: number, last: number, quote: string): { word: number; at: number } | undefined {
  for (let w = at + 1; w <= last; w++) {
    const word = line.words[w] ?? "";
    const close = quote === "" ? -1 : word.indexOf(quote);
    const text = close < 0 ? word : word.slice(0, close);
    const field = /&[\w.-]+=/.exec(text);
    if (/["'`]/.test(text.slice(0, field?.index ?? text.length))) return undefined;
    if (field) return { word: w, at: field.index };
    if (close >= 0) return undefined;
  }
  return undefined;
}

/**
 * Shows `prefix` and HIDDEN for a value that ends where `field` starts, and returns the index of
 * the value's last word. The field's word is left to be read on its own, from its `&`, and its
 * shown text joins the hidden value's, as the two were one word: `password=<hidden>&name=c`.
 */
function stopAtField(line: Line, prefix: string, field: { word: number; at: number }): number {
  line.shown.push(`${prefix}${HIDDEN}`);
  if (field.at > 0) {
    line.words[field.word] = (line.words[field.word] ?? "").slice(field.at);
    line.joined.add(field.word);
  }
  return field.word - 1;
}

/**
 * Where a quoted value that goes on from `text` in `words[at]` closes: the index of the word with
 * the closing quote - in this word or a later one, or the last word when none closes it - what
 * follows the quote there, redacted, and the closing word's text before the quote.
 */
function closing(
  line: Line,
  at: number,
  quote: string,
  text: string,
): { last: number; after: string; closed: boolean; inside: string } {
  let last = at;
  let word = text;
  let close = word.indexOf(quote);
  while (close < 0 && last + 1 < line.words.length) {
    last++;
    word = line.words[last] ?? "";
    close = word.indexOf(quote);
  }
  if (close < 0) return { last, after: "", closed: false, inside: word };
  return { last, after: redactWord(word.slice(close + 1)), closed: true, inside: word.slice(0, close) };
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
 * Where a secret-named key's unquoted value starts in `word` when it runs to the word's end, as
 * `hideKeyValues` reads it: `user=bob&password=x`; and whether the key is a form's field, after
 * an `&`. Not a key in a URL, whose rules hide its query.
 */
function valueAtEnd(word: string): { at: number; field: boolean } | undefined {
  const urls = [...word.matchAll(URL_RUN)].map((m) => ({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));
  const keys = new RegExp(KEY_AT.source, "g");
  for (let key = keys.exec(word); key !== null; key = keys.exec(word)) {
    const start = key.index;
    const at = start + key[0].length;
    if (key[3] !== "" || !isSecretName(key[2] ?? "") || urls.some((url) => start >= url.from && start < url.to))
      continue;
    const value = /^[^\s"'&,;}]+/.exec(word.slice(at))?.[0];
    if (value !== undefined && at + value.length === word.length) return { at, field: word[start - 1] === "&" };
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
    const command = commandWords(config.command);
    out.command = redactCommand([...command.words, ...args], command.lineStarts);
  }
  const env = names(config.env);
  if (env.length > 0) out.env = env.join(", ");
  const headers = [...names(config.headers), ...names(config.http_headers), ...names(config.env_http_headers)];
  if (headers.length > 0) out.headers = headers.join(", ");
  return out;
}

/**
 * A command line's text split at whitespace, each word its own argument, and the arguments a
 * line break comes before, where one command ends and the next starts (see `redactCommand`).
 */
function commandWords(text: string): { words: string[]; lineStarts: Set<number> } {
  const words: string[] = [];
  const lineStarts = new Set<number>();
  for (const [n, part] of text.split(LINE_BREAK).entries()) {
    const own = part.split(/\s+/).filter(Boolean);
    if (n > 0 && own.length > 0) lineStarts.add(words.length);
    words.push(...own);
  }
  return { words, lineStarts };
}

/** `text`, a hook's command or prompt, as the inventory shows it. */
function redactLine(text: string): string {
  const { words, lineStarts } = commandWords(text);
  return redactCommand(words, lineStarts);
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
    if (typeof hook.command === "string") out.command = redactLine(hook.command);
    if (typeof hook.prompt === "string") out.prompt = redactLine(hook.prompt);
  }
  return out;
}
