import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as head from "./redact.js";

/**
 * A differential check of redact.ts against an earlier version of it, for any change to the
 * redaction rules. Each rule there is a guess at where a secret sits, and a change that hid one
 * more shape has more than once shown another, so a change is judged on every case of a grammar
 * of command lines at once - MCP arguments, a command with spaces, hook strings, shell bodies -
 * each through both versions. It is good only if no secret the earlier version hid is shown now.
 *
 * Skipped unless REDACT_DIFF_BASE names a git ref to compare with:
 *   REDACT_DIFF_BASE=origin/main npx vitest run src/extensions/redact.diff.test.ts
 * It prints how many secrets each version shows and how many harmless words each hides.
 */

type Redact = Pick<typeof head, "redactCommand" | "mcpSummary" | "hookSummary">;

const BASE = process.env.REDACT_DIFF_BASE;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

/** The base version's redact.ts, from git, with its imports pointed at this tree's files. */
async function loadBase(ref: string): Promise<Redact> {
  const source = execFileSync("git", ["show", `${ref}:src/extensions/redact.ts`], { cwd: ROOT, encoding: "utf8" });
  const dir = path.join(ROOT, "node_modules", ".cache", "redact-diff");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `redact-${ref.replace(/[^\w.-]/g, "_")}.ts`);
  const pointed = source.replace(
    /from "(\.\.?\/[^"]+)\.js"/g,
    (_, spec: string) => `from ${JSON.stringify(path.resolve(HERE, `${spec}.ts`))}`,
  );
  writeFileSync(file, pointed);
  return (await import(file)) as Redact;
}

// ─── The grammar ────────────────────────────────────────────────────

/**
 * A piece of a command line, as MCP arguments and as shell text. `{S1}`, `{S2}` stand for secret
 * words and `{H1}`, `{H2}` for harmless ones; each case fills them with markers of its own.
 * `{A1}` and `{B1}` are a secret and a harmless one in letters only, for a word that must read
 * the way option names are spelled (`--{A1}-token`), which a digit in it would not.
 */
type Template = { argv: string[]; hook: string };

const t = (argv: string[], hook: string): Template => ({ argv, hook });

const SECRET_FLAGS = [
  "--token",
  "--api-key",
  "--password",
  "--secret",
  "--client-secret",
  "--auth-token",
  "--apiKey",
  "--pat",
  "--passphrase",
  "--access_token",
  "-token",
  "-api-key",
  "-password",
];

/** A secret flag's value, every way a command line writes one. */
function valueForms(flag: string): Template[] {
  return [
    t([flag, "{S1}"], `${flag} {S1}`),
    t([`${flag}={S1}`], `${flag}={S1}`),
    t([flag, "{S1}"], `${flag} "{S1}"`),
    t([flag, "{S1}"], `${flag} '{S1}'`),
    t([flag, "{S1} {S2}"], `${flag} "{S1} {S2}"`),
    t([flag, "{S1} {S2}"], `${flag} '{S1} {S2}'`),
    t([`${flag}={S1} {S2}`], `${flag}="{S1} {S2}"`),
    t([`${flag}={S1} {S2}`], `"${flag}={S1} {S2}"`),
    t([flag, "-{S1}"], `${flag} -{S1}`),
    t([flag, "--{S1}-token"], `${flag} --{S1}-token`),
    t([flag, "--Tk{S1}Secret"], `${flag} --Tk{S1}Secret`),
    t([flag, "-u {S1}"], `${flag} "-u {S1}"`),
    t([flag, "-b {S1}"], `${flag} '-b {S1}'`),
    t([flag, "-H {S1}"], `${flag} "-H {S1}"`),
    t([flag, "Bearer {S1}"], `${flag} "Bearer {S1}"`),
    t([flag, "Bearer {S1}"], `${flag} 'Bearer {S1}'`),
    t([flag, "Bearer", "{S1}"], `${flag} Bearer {S1}`),
    t([flag, "{S1}=="], `${flag} {S1}==`),
    t([flag, "{S1}:{S2}"], `${flag} {S1}:{S2}`),
  ];
}

const FLAG_FORMS = SECRET_FLAGS.flatMap(valueForms);

/** A flag that may take no value, right before a secret flag and its value. */
const VALUELESS_FORMS = ["-b", "--cookie", "--auth"].flatMap((before) =>
  SECRET_FLAGS.flatMap((flag) =>
    [0, 1, 2, 4].map((form) => {
      const after = valueForms(flag)[form] as Template;
      return t([before, ...after.argv], `${before} ${after.hook}`);
    }),
  ),
);

const COOKIE_FORMS = ["-b", "--cookie"].flatMap((flag) => [
  t([flag, "sid={S1}"], `${flag} sid={S1}`),
  t([flag, "{S1}"], `${flag} {S1}`),
  t([flag, "a=1; sid={S1}"], `${flag} "a=1; sid={S1}"`),
  t([flag, "TOKEN={S1} {S2}"], `${flag} TOKEN='{S1} {S2}'`),
  t([flag, "TOKEN={S1} {S2}"], `${flag} TOKEN="{S1} {S2}"`),
  t([flag, "sid={S1} {S2}"], `${flag} "sid={S1} {S2}"`),
  t([flag, "sid={S1} {S2}"], `${flag} sid='{S1} {S2}'`),
  t(["--cookie=sid={S1}"], "--cookie=sid={S1}"),
  t(["--cookie=a=1 sid={S1}"], `--cookie="a=1 sid={S1}"`),
  t(["--cookie=sid={S1} {S2}"], `--cookie=sid='{S1} {S2}'`),
]);

const HEADER_FORMS = [
  t(["-H", "Authorization: Bearer {S1}"], `-H "Authorization: Bearer {S1}"`),
  t(["--header", "X-Api-Key: {S1}"], `--header "X-Api-Key: {S1}"`),
  t(["-H", "X-Auth-Token: {S1} {S2}"], `-H "X-Auth-Token: {S1} {S2}"`),
  t(["-H", "Authorization:", "Bearer", "{S1}"], "-H Authorization: Bearer {S1}"),
  t(["Authorization:Bearer {S1}"], `Authorization:"Bearer {S1}"`),
  t(["-H", "Cookie: sid={S1}"], `-H "Cookie: sid={S1}"`),
  t(["--header", "X-Upstream: token {S1}"], `--header "X-Upstream: token {S1}"`),
  t(["-H", "PRIVATE-TOKEN:{S1}"], "-H PRIVATE-TOKEN:{S1}"),
  t(["--header", "Authorization: Bearer", "{S1}"], `--header "Authorization: Bearer" {S1}`),
  t(["-H", "X-Upstream: Basic", "{S1}"], `-H "X-Upstream: Basic" {S1}`),
  t(["--header", "X-Upstream:Bearer", "{S1}"], `--header 'X-Upstream:Bearer' {S1}`),
  t(["-HX-Api-Key: {S1}"], `-H"X-Api-Key: {S1}"`),
  t(["-H", "X-Api-Key: {S1}"], "-H X-Api-Key:'{S1}'"),
  t(["-H", "X-Api-Key: {S1}", "{H1}"], `-H "X-Api-Key: {S1}" {H1}`),
];

const USER_FORMS = [
  t(["-u", "alice:{S1}"], "-u alice:{S1}"),
  t(["-u", "alice:{S1} {S2}"], `-u "alice:{S1} {S2}"`),
  t(["-u", "alice:{S1} {S2}"], "-u alice:'{S1} {S2}'"),
  t(["--user=bob:{S1}"], "--user=bob:{S1}"),
  t(["--user=bob:{S1} {S2}"], `--user="bob:{S1} {S2}"`),
  t(["-ualice:{S1}"], "-ualice:{S1}"),
  t(["-U", "proxy:{S1}"], "-U proxy:{S1}"),
  t(["--proxy-user=p:{S1}"], "--proxy-user=p:{S1}"),
];

const ENV_FORMS = [
  t(["API_KEY={S1}"], "API_KEY={S1}"),
  t(["GITHUB_TOKEN={S1} {S2}"], `GITHUB_TOKEN="{S1} {S2}"`),
  t(["TOKEN={S1} {S2}"], "TOKEN='{S1} {S2}'"),
  t(["-e", "API_KEY={S1}"], "-e API_KEY={S1}"),
  t(["DB_PASSWORD={S1}"], "DB_PASSWORD={S1}"),
  t(["AUTHORIZATION=Bearer {S1}"], `AUTHORIZATION="Bearer {S1}"`),
];

const JSON_FORMS = [
  t(['{"token":"{S1}"}'], `'{"token":"{S1}"}'`),
  t(['{"apiKey": "{S1} {S2}"}'], `'{"apiKey": "{S1} {S2}"}'`),
  t(['{"headers":{"Authorization":"Bearer {S1}"}}'], `'{"headers":{"Authorization":"Bearer {S1}"}}'`),
  t(["--config", '{"password":"{S1}"}'], `--config '{"password":"{S1}"}'`),
  t(['{"token":"{S1}","name":"{H1}"}'], `'{"token":"{S1}","name":"{H1}"}'`),
];

const FORM_FORMS = [
  t(["-d", "user=bob&password={S1}"], `-d "user=bob&password={S1}"`),
  t(["-d", "user=bob&password={S1} {S2}"], `-d "user=bob&password={S1} {S2}"`),
  t(["--data", "x=1&token={S1} {S2}&y=2"], "--data 'x=1&token={S1} {S2}&y=2'"),
  t(["-d", "password={S1} {S2}"], "-d 'password={S1} {S2}'"),
  t(["--data-urlencode", "api_key={S1} {S2}"], `--data-urlencode "api_key={S1} {S2}"`),
  t(["-d", "password={S1}&name={H1}"], `-d "password={S1}&name={H1}"`),
  t(["-d", "a=1&password={S1} {S2}&name={H1}"], `-d "a=1&password={S1} {S2}&name={H1}"`),
  t(["-d", "a=1 password={S1} {S2}"], `-d "a=1 password={S1} {S2}"`),
];

const URL_FORMS = [
  t(["https://alice:{S1}@h.example/p"], "https://alice:{S1}@h.example/p"),
  t(["https://h.example/p?token={S1}&m=1"], `"https://h.example/p?token={S1}&m=1"`),
  t(["--url=https://h.example/mcp?key={S1}"], "--url=https://h.example/mcp?key={S1}"),
  t(["https://h.example/p#{S1}"], "https://h.example/p#{S1}"),
];

const SQL_FORMS = [
  t(["-c", "ALTER ROLE r PASSWORD '{S1}'"], `-c "ALTER ROLE r PASSWORD '{S1}'"`),
  t(
    ["-c", "CREATE USER u WITH ENCRYPTED PASSWORD '{S1} {S2}'"],
    `-c "CREATE USER u WITH ENCRYPTED PASSWORD '{S1} {S2}'"`,
  ),
  t(["-e", "CREATE USER u IDENTIFIED BY '{S1}'"], `-e "CREATE USER u IDENTIFIED BY '{S1}'"`),
  t(["-c", "alter user u password '{S1}' valid until '{H1}'"], `-c "alter user u password '{S1}' valid until '{H1}'"`),
];

const HARMLESS_FORMS = [
  t(["--verbose"], "--verbose"),
  t(["-v"], "-v"),
  t(["--path", "/srv/{H1}"], "--path /srv/{H1}"),
  t(["--name", "{H1}"], "--name {H1}"),
  t(["-o", "{H1}.txt"], "-o {H1}.txt"),
  t(["{H1}"], "{H1}"),
  t(["--port", "8080"], "--port 8080"),
  t(["--header", "Accept: {H1}"], `--header "Accept: {H1}"`),
  t(["PATH=/usr/{H1}"], "PATH=/usr/{H1}"),
  t(["--pattern", "{H1}"], "--pattern {H1}"),
  t(["-c", "{H1}.toml"], "-c {H1}.toml"),
  t(["--session-name", "{H1}"], "--session-name {H1}"),
  t(["--message", "{H1} {H2}"], `--message "{H1} {H2}"`),
  t(["https://h.example/{H1}"], "https://h.example/{H1}"),
  t(["&&", "{H1}"], "&& {H1}"),
];

/** Under git, `-b` names a branch. */
const GIT_FORMS = [
  t(["checkout", "-b", "{H1}"], "checkout -b {H1}"),
  t(["switch", "-c", "{H1}"], "switch -c {H1}"),
  t(["checkout", "-b", "{H1}", "origin/{H2}"], "checkout -b {H1} origin/{H2}"),
  t(["-b", "{H1}"], "-b {H1}"),
];

/** #139: under a tool whose `-b` is no credential, it is a block size, a byte list, a flag. */
const TOOL_B_FORMS = [
  t(["-b", "{H1}"], "-b {H1}"),
  t(["-b", "{H1}", "{H2}"], "-b {H1} {H2}"),
  t(["-f", "{H1}", "-b", "{H2}"], "-f {H1} -b {H2}"),
  t(["-b", "{H1}", "--token", "{S1}"], "-b {H1} --token {S1}"),
  t(["-b", "--api-key", "{S1}"], "-b --api-key {S1}"),
  t(["-b", "{H1}", "&&", "curl", "-b", "sid={S1}"], "-b {H1} && curl -b sid={S1}"),
  t(["-b", "{H1}", "|", "curl", "--cookie", "{S1}"], "-b {H1} | curl --cookie {S1}"),
];

/** The forms #97's run had; the followers are drawn from these, so its cases stay as they were. */
const FIRST_SECRET_FORMS = [
  ...FLAG_FORMS,
  ...VALUELESS_FORMS,
  ...COOKIE_FORMS,
  ...HEADER_FORMS,
  ...USER_FORMS,
  ...ENV_FORMS,
  ...JSON_FORMS,
  ...FORM_FORMS,
  ...URL_FORMS,
  ...SQL_FORMS,
];

/**
 * #139: a password spelled like an option named for a secret, right after a secret flag; and
 * the real option of that spelling after a flag that may take no value, its name harmless.
 */
const OPTION_VALUE_FORMS = [
  ...SECRET_FLAGS.flatMap((flag) => [
    t([flag, "--{A1}-token"], `${flag} --{A1}-token`),
    t([flag, "--{A1}password"], `${flag} --{A1}password`),
  ]),
  ...["-b", "--cookie", "--auth"].flatMap((before) => [
    t([before, "--api-key", "--{A1}-token"], `${before} --api-key --{A1}-token`),
    t([before, "--api-key", "-{S1}"], `${before} --api-key -{S1}`),
    t([before, "--{B1}-token", "{S1}"], `${before} --{B1}-token {S1}`),
    t([before, "--{B1}-token", "-{S1}"], `${before} --{B1}-token -{S1}`),
    t([before, "--{B1}-token", "{S1} {S2}"], `${before} --{B1}-token "{S1} {S2}"`),
  ]),
];

/**
 * #139: a spaced secret in a form body, with fields after it, which are no part of it; and a
 * value with `&x=` in it that is no form, all of which is the secret.
 */
const FIELD_FORMS = [
  t(["-d", "a=1&password={S1} {S2}&name={H1}&x={H2}"], `-d "a=1&password={S1} {S2}&name={H1}&x={H2}"`),
  t(
    ["-d", "a=1&password={S1} {S2}&token={S3} {S4}&name={H1}"],
    `-d "a=1&password={S1} {S2}&token={S3} {S4}&name={H1}"`,
  ),
  t(["-d", "a=1&password={S1} {S2} {S3}&name={H1}"], `-d "a=1&password={S1} {S2} {S3}&name={H1}"`),
  t(["-d", "a=1&password={S1} {S2}&name={H1} {H2}"], `-d "a=1&password={S1} {S2}&name={H1} {H2}"`),
  t(["-d", "a=1&password={S1} {S2} &name={H1}"], `-d "a=1&password={S1} {S2} &name={H1}"`),
  t(["--data", "x=1&token={S1} {S2}&y={H1}"], "--data 'x=1&token={S1} {S2}&y={H1}'"),
  t(["-d", "a=1&password={S1} {S2}&{S3} {S4}"], `-d "a=1&password={S1} {S2}&{S3} {S4}"`),
  t(["-d", "a=1&password={S1} {S2}&{S3}"], `-d "a=1&password={S1} {S2}&{S3}"`),
  t(["-d", "password={S1} {S2}&name={H1}"], `-d "password={S1} {S2}&name={H1}"`),
  t(["-d", "a=1&password={S1} {S2}", "&name={H1}"], `-d "a=1&password={S1} {S2}" "&name={H1}"`),
  t(["TOKEN={S1} {S2}&x={S3}"], "TOKEN='{S1} {S2}&x={S3}'"),
  t(["--api-key", "{S1} {S2}&x={S3}"], `--api-key "{S1} {S2}&x={S3}"`),
  t(["--api-key={S1} {S2}&x={S3}"], `--api-key="{S1} {S2}&x={S3}"`),
  t(["-u", "alice:{S1} {S2}&x={S3}"], `-u "alice:{S1} {S2}&x={S3}"`),
  t(["-H", "X-Api-Key: {S1} {S2}&x={S3}"], `-H "X-Api-Key: {S1} {S2}&x={S3}"`),
  t(["--cookie", "sid={S1} {S2}&x={S3}"], `--cookie "sid={S1} {S2}&x={S3}"`),
  t(['{"token":"{S1} {S2}&x={S3}"}'], `'{"token":"{S1} {S2}&x={S3}"}'`),
  t(["-d", "a=1&password='{S1} {S2}&x={S3}'"], `-d "a=1&password='{S1} {S2}&x={S3}'"`),
];

/**
 * #139: a tool's name where the command is not that tool's, so its `-b` stays curl's: after an
 * option, or after another program's word.
 */
const NOT_A_TOOL_FORMS = [
  t(["--name", "tar", "-b", "{S1}"], "--name tar -b {S1}"),
  t(["img", "sort", "-b", "{S1}"], "img sort -b {S1}"),
  t(["--file", "/srv/du", "-b", "sid={S1}"], "--file /srv/du -b sid={S1}"),
  t(["-c", "tar", "-b", "{S1}"], "-c tar -b {S1}"),
  t(["-c", "git", "-b", "{S1}"], "-c git -b {S1}"),
  t(["--mode", "time", "sort", "-b", "{S1}"], "--mode time sort -b {S1}"),
  t(["--run", "env", "git", "-b", "{S1}"], "--run env git -b {S1}"),
];

const SECRET_FORMS = [...FIRST_SECRET_FORMS, ...OPTION_VALUE_FORMS, ...FIELD_FORMS, ...NOT_A_TOOL_FORMS];

const PROGRAMS = [
  ["tool"],
  ["srv"],
  ["curl"],
  ["/usr/bin/curl", "-s"],
  ["npx", "-y", "@acme/srv"],
  ["psql"],
  ["mysql"],
  ["env"],
  ["docker", "run"],
  ["tool", "-c"],
  ["make", "-C"],
];

const GIT_PROGRAMS = [["git"], ["git", "-C", "/srv/repo"]];

/**
 * #139: tools whose `-b` is no credential, as their man pages give it. ssh's is a bind address,
 * but redact.ts leaves ssh out, since the words after its host are a remote command's: its
 * cases count what that costs.
 */
const TOOL_B_PROGRAMS = [["tar"], ["sort"], ["/usr/bin/du"], ["cut"], ["ssh"], ["wget"], ["sudo", "rsync"]];

const SHELLS = [
  ["bash", "-c"],
  ["sh", "-euc"],
  ["/bin/zsh", "-lc"],
  ["cmd", "/c"],
  ["pwsh", "-Command"],
  ["env", "bash", "-c"],
];

/** A second piece for some cases, before or after the first: harmless words, and a few secret shapes. */
const FOLLOWERS = [
  ...HARMLESS_FORMS,
  ...FIRST_SECRET_FORMS.filter((_, i) => i % 61 === 0),
  ...COOKIE_FORMS.slice(0, 2),
  ...SQL_FORMS.slice(0, 1),
];

const PROSE = [
  "Rotate the token when the key expires, then tell {H1}",
  "Don't print the password; ask {H1} instead",
  "Check the 'token' field and the {H1} one",
  `Say "done" when {H1} passes`,
  "If the secret's missing, stop and ask {H1}",
  "Use git checkout -b {H1} for the branch",
];

/**
 * The followers for a git command, where `-b` names a branch: no cookie after `-b` there, which
 * would be a branch name the grammar called a secret. `--cookie` and the rest stay.
 */
const GIT_FOLLOWERS = FOLLOWERS.filter((form) => !form.hook.startsWith("-b "));

// ─── Cases ──────────────────────────────────────────────────────────

/** A marker in a case, and the template it came from. */
type Mark = { word: string; from: string };

/** One input, the way it reaches the redactor, and the markers in it. */
type Case = { mode: string; input: string; run: (r: Redact) => string; secrets: Mark[]; harmless: Mark[] };

type Filled = { argv: string[]; hook: string; secrets: Mark[]; harmless: Mark[]; spaced: boolean };

/** A marker's middle in letters only: base 26, its digits written `a` to `z`. */
const letters = (n: number) =>
  [...n.toString(26).padStart(4, "0")].map((c) => String.fromCharCode(97 + Number.parseInt(c, 26))).join("");

/**
 * Fills a case's templates with markers, secret ones `zq…k` and harmless ones `hm…w`, unique in
 * the case; `{A}` and `{B}` take the letters-only middle.
 */
function fill(parts: Template[]): Filled {
  const secrets: Mark[] = [];
  const harmless: Mark[] = [];
  const argv: string[] = [];
  const hooks: string[] = [];
  for (const part of parts) {
    const names = new Map<string, string>();
    const sub = (text: string) =>
      text.replace(/\{([SHAB])(\d)\}/g, (whole, kind: "S" | "H" | "A" | "B") => {
        const known = names.get(whole);
        if (known) return known;
        const count = secrets.length + harmless.length;
        const n = kind === "A" || kind === "B" ? letters(count) : count.toString(36).padStart(4, "0");
        const secret = kind === "S" || kind === "A";
        const word = secret ? `zq${n}k` : `hm${n}w`;
        (secret ? secrets : harmless).push({ word, from: part.hook });
        names.set(whole, word);
        return word;
      });
    // The same markers in both forms of the part.
    hooks.push(sub(part.hook));
    argv.push(...part.argv.map(sub));
  }
  return { argv, hook: hooks.join(" "), secrets, harmless, spaced: argv.some((arg) => /\s/.test(arg)) };
}

const hookCommand = (r: Redact, line: string) =>
  r.hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";

/** Each way the filled parts reach the redactor: as MCP arguments, as an MCP command, as a hook. */
function* forms(f: Filled): Generator<Case> {
  const { argv, hook, secrets, harmless } = f;
  const [first = "", ...rest] = argv;
  yield { mode: "mcp args", input: JSON.stringify(argv), run: (r) => r.redactCommand(argv), secrets, harmless };
  yield {
    mode: "mcp command+args",
    input: JSON.stringify({ command: first, args: rest }),
    run: (r) => r.mcpSummary({ command: first, args: rest }).command ?? "",
    secrets,
    harmless,
  };
  // A command with spaces is split at each one, so an argument with spaces in it is not one there.
  if (!f.spaced) {
    const line = argv.join(" ");
    yield {
      mode: "mcp command",
      input: line,
      run: (r) => r.mcpSummary({ command: line }).command ?? "",
      secrets,
      harmless,
    };
  }
  yield { mode: "hook", input: hook, run: (r) => hookCommand(r, hook), secrets, harmless };
}

/** A program, then a template, alone and with each follower before and after it. */
function* withPrograms(templates: Template[], programs: string[][], followers: Template[]): Generator<Template[]> {
  for (const program of programs) {
    const p = t(program, program.join(" "));
    for (const a of templates) {
      yield [p, a];
      for (const b of followers) {
        yield [p, a, b];
        yield [p, b, a];
      }
    }
  }
}

function* cases(): Generator<Case> {
  const sets = [
    withPrograms(SECRET_FORMS, PROGRAMS, []),
    withPrograms(SECRET_FORMS, [["tool"], ["curl"]], FOLLOWERS),
    withPrograms([...GIT_FORMS, ...HARMLESS_FORMS], GIT_PROGRAMS, GIT_FOLLOWERS),
    withPrograms(
      FLAG_FORMS.filter((_, i) => i % 7 === 0),
      GIT_PROGRAMS,
      GIT_FORMS,
    ),
    withPrograms([...TOOL_B_FORMS, ...HARMLESS_FORMS], TOOL_B_PROGRAMS, GIT_FOLLOWERS),
    withPrograms([...FLAG_FORMS.filter((_, i) => i % 7 === 0), ...OPTION_VALUE_FORMS], TOOL_B_PROGRAMS, TOOL_B_FORMS),
  ];
  for (const set of sets) for (const parts of set) yield* forms(fill(parts));
  // A shell's command line: the pieces as one argument, and as a quoted hook body.
  const inner = [["tool"], ["curl"], ["psql"]];
  for (const shell of SHELLS) {
    const followers = shell === SHELLS[0] ? FOLLOWERS : [];
    const gitFollowers = shell === SHELLS[0] ? GIT_FOLLOWERS : [];
    for (const parts of [
      ...withPrograms(SECRET_FORMS, inner, followers),
      ...withPrograms([...GIT_FORMS, ...HARMLESS_FORMS], [["git"]], gitFollowers),
      ...withPrograms(TOOL_B_FORMS, [["tar"], ["sort"]], gitFollowers),
    ]) {
      const { hook, secrets, harmless } = fill(parts);
      const args = [...shell, hook];
      yield {
        mode: "mcp shell body",
        input: JSON.stringify(args),
        run: (r) => r.redactCommand(args),
        secrets,
        harmless,
      };
      const outer = !hook.includes("'") ? `'${hook}'` : !hook.includes('"') ? `"${hook}"` : undefined;
      if (outer === undefined) continue;
      const line = `${shell.join(" ")} ${outer}`;
      yield { mode: "hook shell body", input: line, run: (r) => hookCommand(r, line), secrets, harmless };
    }
  }
  // A prompt hook's prose, which names secrets without holding one.
  for (const prose of PROSE) {
    const { hook, secrets, harmless } = fill([t([], prose)]);
    const run = (r: Redact) => r.hookSummary("Stop", undefined, { type: "prompt", prompt: hook }).prompt ?? "";
    yield { mode: "hook prompt", input: hook, run, secrets, harmless };
  }
}

// ─── The comparison ─────────────────────────────────────────────────

type Example = { mode: string; input: string; base: string; head: string; from: string };

/** A category's words by the template that made them, most first, each with its first example. */
function byTemplate(list: Example[]): { from: string; count: number; example: Example }[] {
  const groups = new Map<string, { from: string; count: number; example: Example }>();
  for (const e of list) {
    const group = groups.get(e.from) ?? { from: e.from, count: 0, example: e };
    group.count += 1;
    groups.set(e.from, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

describe.skipIf(BASE === undefined)(`redact.ts against ${BASE ?? "a base version"}`, () => {
  it("shows no secret the base version hid", { timeout: 1_200_000 }, async () => {
    const base = await loadBase(BASE ?? "HEAD");
    let total = 0;
    let secretWords = 0;
    let harmlessWords = 0;
    const found = {
      /** Secrets base hid that head shows: never allowed. */
      regressed: [] as Example[],
      /** Secrets base showed that head hides: what the change fixes. */
      fixed: [] as Example[],
      /** Secrets both show: what is still open. */
      "still open": [] as Example[],
      /** Harmless words base hid that head shows. */
      unhidden: [] as Example[],
      /** Harmless words base showed that head hides. */
      "over-hidden": [] as Example[],
      /** Harmless words both hide: the over-hiding still left. */
      "still over-hidden": [] as Example[],
    };
    for (const c of cases()) {
      total += 1;
      const was = c.run(base);
      const now = c.run(head);
      const example = (mark: Mark): Example => ({
        mode: c.mode,
        input: c.input,
        base: was,
        head: now,
        from: mark.from,
      });
      for (const mark of c.secrets) {
        secretWords += 1;
        const before = was.includes(mark.word);
        const after = now.includes(mark.word);
        if (!before && after) found.regressed.push(example(mark));
        if (before && !after) found.fixed.push(example(mark));
        if (before && after) found["still open"].push(example(mark));
      }
      for (const mark of c.harmless) {
        harmlessWords += 1;
        const before = was.includes(mark.word);
        const after = now.includes(mark.word);
        if (!before && after) found.unhidden.push(example(mark));
        if (before && !after) found["over-hidden"].push(example(mark));
        if (!before && !after) found["still over-hidden"].push(example(mark));
      }
    }
    const lines = [
      `cases ${total}, secret words ${secretWords}, harmless words ${harmlessWords}`,
      `secrets base hid, head shows (regressed, must be 0): ${found.regressed.length}`,
      `secrets base showed, head hides (fixed): ${found.fixed.length}`,
      `secrets both show (still open): ${found["still open"].length}`,
      `harmless words base hid, head shows (unhidden): ${found.unhidden.length}`,
      `harmless words base showed, head hides (over-hidden): ${found["over-hidden"].length}`,
      `harmless words both hide (still over-hidden): ${found["still over-hidden"].length}`,
    ];
    const limit = Number(process.env.REDACT_DIFF_EXAMPLES ?? 60);
    for (const [name, list] of Object.entries(found)) {
      const groups = byTemplate(list);
      lines.push("", `── ${name}: ${list.length} words from ${groups.length} templates`);
      for (const { from, count, example: e } of groups.slice(0, limit)) {
        lines.push(`  ${count} × ${from}`, `    [${e.mode}] ${e.input}`, `    base: ${e.base}`, `    head: ${e.head}`);
      }
    }
    const out = process.env.REDACT_DIFF_OUT;
    if (out) writeFileSync(out, `${lines.join("\n")}\n`);
    else console.log(lines.join("\n"));
    expect(found.regressed).toEqual([]);
  });
});
