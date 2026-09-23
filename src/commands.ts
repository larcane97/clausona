import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { isAnthropicHost } from "./core/api-url.js";
import { plaintextEnvRemedy } from "./core/doctor.js";
import { spawnCommandSync } from "./core/process.js";
import { isPosixEnvName, renderPosixExports } from "./core/shell.js";
import { trackUsage } from "./core/track-usage.js";
import { accent, bold, box, dim, helpSection, helpUsage, secondary, success, warnIcon } from "./lib/cli-style.js";
import { renderDoctor, renderList, renderUsageSummary } from "./lib/format.js";
import { buildProfileEnv, CREDENTIAL_ENV_KEYS, controlledEnvKeys, displayName } from "./lib/profile-env.js";
import {
  CREDENTIAL_AS_NAME_ERROR,
  looksLikeCredential,
  parseProfileRef,
  profileId,
  validateProfileName,
} from "./lib/profile-ref.js";
import { promptSecret } from "./lib/prompt-secret.js";
import {
  addApiProfile,
  addProfile,
  checkLabel,
  discoverAccounts,
  doctorProfiles,
  getUsageSummary,
  initializeRegistry,
  listProfiles,
  loadRegistry,
  loginProfile,
  parseBaseUrl,
  proposeInitProfileNames,
  removeProfile,
  repairProfile,
  setActiveProfileByName,
  shellInit,
  syncPluginsJson,
  uninstallClausona,
  updateProfileApi,
  updateProfileConfig,
  updateProfileEnv,
  updateProfileSecret,
} from "./lib/service.js";
import { CLAUDE_ENV_CATALOG, validateEnvEntry } from "./tools/claude-env-catalog.js";
import { ALL_TOOLS } from "./tools/registry.js";
import type { Profile, SecretSource, ToolName } from "./types.js";

function jsonFlag(args: string[]) {
  return args.includes("--json");
}

function helpFlag(args: string[]) {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Options that take a value. Each one is listed under `flags` for the `--opt value` form
 * and under `prefixes` with its `=` for the `--opt=value` form, so a misspelling such as
 * `--base-urls` is still refused - a bare `--base-url` prefix would accept it.
 */
const ADD_VALUE_FLAGS = ["--from", "--base-url", "--model", "--auth", "--key-from", "--label", "--set"];
const CONFIG_VALUE_FLAGS = ["--set", "--unset", "--model", "--key-from", "--base-url", "--auth", "--label"];

/** Every `add` option that only means anything for an API profile. */
const API_ONLY_FLAGS = ["--base-url", "--model", "--auth", "--key-from", "--label", "--set"];

function valuePrefixes(flags: string[]): string[] {
  return flags.map((flag) => `${flag}=`);
}

const commandFlags: Record<string, { flags: string[]; prefixes?: string[] }> = {
  init: { flags: ["--auto", "--merge-sessions"] },
  add: { flags: ["--merge-sessions", "--api", ...ADD_VALUE_FLAGS], prefixes: valuePrefixes(ADD_VALUE_FLAGS) },
  use: { flags: [] },
  list: { flags: ["--json", "--no-quota", "--no-renew", "--refresh"] },
  usage: { flags: ["--json"], prefixes: ["--period="] },
  current: { flags: ["--json"] },
  doctor: { flags: ["--json"] },
  config: {
    flags: ["--merge-sessions", "--separate-sessions", "--key", "--edit", "--show", "--json", ...CONFIG_VALUE_FLAGS],
    prefixes: valuePrefixes(CONFIG_VALUE_FLAGS),
  },
  repair: { flags: [] },
  login: { flags: [] },
  remove: { flags: [] },
  run: { flags: [] },
  "shell-init": { flags: [] },
  uninstall: { flags: [] },
  version: { flags: [] },
  "_shell-env": { flags: ["--json"] },
};

function validateFlags(command: string, args: string[]) {
  const spec = commandFlags[command];
  if (!spec) return;
  const known = ["--help", "-h", ...spec.flags];
  const prefixes = spec.prefixes ?? [];
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    if (known.includes(arg)) continue;
    if (prefixes.some((p) => arg.startsWith(p))) continue;
    // The name only, never what follows `=`. `--key` takes no value, so `--key=<the key>`
    // lands here, and quoting the whole token would print the key into the window and the
    // scrollback. Cutting at the `=` covers every option that will ever be misspelled
    // this way, rather than special-casing the ones next to a credential today.
    throw new Error(`Unknown option: ${arg.split("=")[0]}\nRun \`clausona ${command} --help\` for usage.`);
  }
}

// ─── Option parsing ─────────────────────────────────────────────────
//
// One rule runs through every message below: an option's *value* is never echoed back.
// `--key-from sk-ant-…` is one keystroke away from the option that takes the key, and an
// error that quotes what it was given would print the key to the terminal and into the
// scrollback. Variable *names* are echoed, because they are validated identifiers.

const ADD_API_USAGE =
  "Usage: clausona add <profile> --api --base-url <url> [--model <id>] [--auth bearer|api-key] [--key-from <source>]";

const CONFIG_USAGE =
  "Usage: clausona config <profile> [--model <id>] [--set KEY=VALUE] [--unset KEY] [--base-url <url>] [--auth bearer|api-key] [--label <name>] [--key] [--edit] [--show] [--merge-sessions | --separate-sessions]";

/**
 * An argument nobody asked for is usually a key someone expected an option to take.
 * Neither message repeats it, and both say where a key actually goes.
 */
const ADD_EXTRA_ARGUMENT =
  'clausona add takes one profile name and nothing else. If that was an API key: it is never an argument, so pipe it in (printf %s "$KEY" | clausona add <profile> --api …) or point at it with --key-from env:NAME.';

const CONFIG_EXTRA_ARGUMENT =
  'clausona config takes one profile and nothing else. --key takes no value: the key is read from a prompt that does not echo it, or from stdin (printf %s "$KEY" | clausona config <profile> --key).';

/** Never says what was read: the answer is the key, or what the user meant to be one. */
const NO_KEY_SUPPLIED =
  'No API key supplied. Type it at the prompt, pipe it in (printf %s "$KEY" | clausona …), or read it from elsewhere with --key-from env:NAME.';

/** Reads `--flag value` and `--flag=value`, returning every occurrence in order. */
function optionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && args[i + 1] !== undefined) {
      values.push(args[i + 1]);
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

/** The one value of an option, refusing a repeat rather than silently keeping the first. */
function optionValue(args: string[], flag: string): string | undefined {
  const values = optionValues(args, flag);
  if (values.length > 1) throw new Error(`${flag} was given more than once. Pass it at most once.`);
  return values[0];
}

/**
 * The bare arguments, skipping whatever follows a value-carrying option - otherwise
 * `clausona add --base-url https://… work` would read the URL as the profile name.
 *
 * Both callers take the first and refuse the rest. A dropped extra argument is how
 * `config <profile> --key <the key>` used to succeed while quietly ignoring the key and
 * prompting anyway, leaving the user sure they had supplied one.
 */
function positionalArgs(args: string[], valueFlags: string[]): string[] {
  const consumed = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i]) && args[i + 1] !== undefined) consumed.add(i + 1);
  }
  return args.filter((arg, i) => !arg.startsWith("--") && !consumed.has(i));
}

/** Splits `KEY=VALUE`, rejecting a bare key so a typo never silently clears a setting. */
function parseAssignment(input: string, flag: string): [string, string] {
  const index = input.indexOf("=");
  if (index <= 0) throw new Error(`Expected ${flag} KEY=VALUE, for example ${flag} ANTHROPIC_MODEL=my-model.`);
  return [input.slice(0, index), input.slice(index + 1)];
}

/** An environment variable name given on the command line, for `--unset`. */
function parseEnvName(input: string, flag: string): string {
  if (!isPosixEnvName(input)) {
    throw new Error(`Expected ${flag} to name an environment variable, for example ${flag} ANTHROPIC_MODEL.`);
  }
  return input;
}

/**
 * `--model`, for `add` and `config` alike: the id, trimmed. A blank one is refused rather
 * than stored or read as "clear it" - `--model "$MODEL"` with MODEL unset would otherwise
 * pin an empty model, or drop the profile's own without a word. Clearing has its own
 * spelling, and the message names it.
 */
function parseModel(input: string): string {
  const model = input.trim();
  if (model === "") {
    throw new Error(
      "--model needs a model id. Leave it out to pin none, or clear one with clausona config <profile> --unset ANTHROPIC_MODEL.",
    );
  }
  return model;
}

/** `--model` writes ANTHROPIC_MODEL, so naming the variable as well is two answers to one question. */
const MODEL_TWICE = "ANTHROPIC_MODEL is what --model sets. Pass one or the other.";

/** `--auth`, for `add` and `config` alike. */
function parseAuthScheme(input: string): "bearer" | "api-key" {
  if (input !== "bearer" && input !== "api-key") throw new Error("Invalid --auth: use bearer or api-key.");
  return input;
}

function parseSecretSource(input: string): SecretSource {
  if (input === "keychain") return { source: "keychain" };
  if (input.startsWith("env:")) {
    const name = input.slice(4);
    if (!name) throw new Error("Usage: --key-from env:VARIABLE_NAME");
    return { source: "env", name };
  }
  if (input.startsWith("command:")) {
    const run = input.slice(8);
    if (!run) throw new Error('Usage: --key-from command:"<shell command>"');
    return { source: "command", run };
  }
  throw new Error('Invalid --key-from: use keychain, env:NAME, or command:"<shell command>".');
}

/**
 * The env map is stored in plain text in profiles.json. That is deliberate - the map is
 * how a user reaches a Claude Code variable clausona has no flag for - but these names
 * are the ones whose value is a credential, and a key pasted into one is a key in a file
 * that nothing treats as a secret. Warn, never block: a legitimate non-secret header
 * override goes through the same map.
 *
 * The commands come from `plaintextEnvRemedy`, which doctor's finding uses too, and they
 * differ by kind because `--key` only works on an API profile. A subscription profile is
 * also pointed at `add --help`: a key in its map most likely means an API profile was
 * wanted, and that is where to find out how to make one.
 */
const CREDENTIAL_ENV_KEY_SET = new Set<string>(CREDENTIAL_ENV_KEYS);

function warnPlaintextEnv(id: string, kind: Profile["kind"], keys: string[]) {
  for (const key of keys) {
    if (!CREDENTIAL_ENV_KEY_SET.has(key)) continue;
    const commands = plaintextEnvRemedy(id, kind, key).map((command) => `      ${accent(command)}\n`);
    const advice =
      kind === "api"
        ? "    If it carries this profile's API key, move the key to the credential store and remove this copy:\n" +
          commands.join("")
        : "    A subscription profile signs in with its account, so if it carries an API key it does not belong here:\n" +
          commands.join("") +
          "    To use an API key instead, give it an API profile of its own:\n" +
          `      ${accent("clausona add --help")}\n`;
    process.stderr.write(`  ${warnIcon} ${key} is stored in plain text in ~/.clausona/profiles.json.\n${advice}`);
  }
}

function describeSecretSource(secret: SecretSource): string {
  if (secret.source === "env") return `env:${secret.name}`;
  if (secret.source === "command") return `command:${secret.run}`;
  return "keychain";
}

/**
 * `config --show`: what this profile is and what it sets. The JSON form also carries the
 * advanced-settings catalog, so a caller who has only `--help` and this command can find
 * out which keys exist and what each one expects.
 *
 * A value under one of the credential names is reported as present but not printed.
 * Nothing here should make `--show` a way to read a key out of a profile - not on a
 * shared terminal, and not into a log. The credential itself is never in the registry at
 * all; only its source is, and that is shown.
 */
function showProfile(id: string, profile: Profile, asJson: boolean): string {
  const env = profile.env ?? {};
  const hiddenEnvKeys = Object.keys(env).filter((key) => CREDENTIAL_ENV_KEY_SET.has(key));

  if (asJson) {
    const shown = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, CREDENTIAL_ENV_KEY_SET.has(key) ? "<hidden>" : value]),
    );
    return JSON.stringify(
      {
        profile: {
          id,
          kind: profile.kind ?? "subscription",
          label: profile.label,
          email: profile.email,
          configDir: profile.configDir,
          isPrimary: profile.isPrimary ?? false,
          mergeSessions: profile.mergeSessions ?? false,
          // The key's VALUE is deliberately absent; only where it is read from.
          api: profile.api
            ? { baseUrl: profile.api.baseUrl, authScheme: profile.api.authScheme, secret: profile.api.secret }
            : undefined,
          env: shown,
          /** Names whose value `env` reports as "<hidden>" rather than printing. */
          hiddenEnvKeys,
        },
        catalog: CLAUDE_ENV_CATALOG,
      },
      null,
      2,
    );
  }

  const lines = [
    `${secondary("Kind".padEnd(12))}${profile.kind ?? "subscription"}`,
    `${secondary("Account".padEnd(12))}${displayName(profile)}`,
    `${secondary("Config".padEnd(12))}${dim(profile.configDir)}`,
  ];
  if (profile.api) {
    lines.push(`${secondary("Endpoint".padEnd(12))}${profile.api.baseUrl}`);
    lines.push(`${secondary("Auth".padEnd(12))}${profile.api.authScheme}`);
    lines.push(`${secondary("Key".padEnd(12))}${describeSecretSource(profile.api.secret)}`);
  }
  if (!profile.isPrimary) {
    lines.push(`${secondary("Sessions".padEnd(12))}${profile.mergeSessions ? "merged" : "separated"}`);
  }
  const keys = Object.keys(env).sort();
  lines.push(`${secondary("Settings".padEnd(12))}${keys.length === 0 ? dim("none") : ""}`);
  for (const key of keys) {
    lines.push(
      CREDENTIAL_ENV_KEY_SET.has(key)
        ? `  ${accent(key)} ${dim("(set; not shown - it can hold a credential)")}`
        : `  ${accent(key)}=${env[key]}`,
    );
  }
  lines.push("", dim("Run `clausona config <profile> --show --json` for the full advanced-settings catalog."));
  return box(id, lines);
}

/**
 * Splits $VISUAL or $EDITOR into a command and its arguments. `code -w` and `emacsclient -nw` are
 * ordinary values for it, and the whole string as one command name would look for a
 * program called "code -w". Quotes group a path with spaces in it; nothing else is
 * interpreted, because this is not a shell and the value is never handed to one.
 */
function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

/** The edited file, checked to be what the env map is: a flat object of strings. */
function parseEditedEnv(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The edited file is not valid JSON, so nothing was changed.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('The edited file must hold a JSON object of "KEY": "value" pairs, so nothing was changed.');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(`${key} must be a string in quotes, so nothing was changed.`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * `config --edit`: the env map in $VISUAL, or $EDITOR when that is unset, applied on a
 * clean exit.
 *
 * The scratch file lives in a directory of its own made by mkdtemp (0700) and is written
 * 0600. A fixed name in the shared temp directory would be world-readable and something
 * anyone on the machine could point at another file with a symlink first - and this file
 * can hold an ANTHROPIC_CUSTOM_HEADERS value. The directory goes on every way out: a
 * failed editor, an unparseable edit, a successful save, and a Ctrl-C while the editor is
 * open, which reaches clausona too (the editor shares its process group) and would
 * otherwise kill it before any `finally` ran.
 */
async function editProfileEnv(id: string, profile: Profile): Promise<string> {
  const current = profile.env ?? {};
  // A blank $VISUAL is as good as an unset one; `??` would take "" and stop there.
  const editor = [process.env.VISUAL, process.env.EDITOR].find((value) => (value ?? "").trim() !== "");
  const [command, ...editorArgs] = splitCommandLine(editor ?? "");
  if (!command) throw new Error("Set $EDITOR (or $VISUAL) to use --edit.");

  const dir = await mkdtemp(path.join(tmpdir(), "clausona-env-"));
  const scratchPath = path.join(dir, "env.json");

  const onSignal = (signal: NodeJS.Signals) => {
    // Synchronous: the process is on its way out and an awaited rm would not finish.
    rmSync(dir, { force: true, recursive: true });
    detachSignals();
    // Re-raised with our listener gone, so the signal decides the exit status as it would
    // have. A handler that just returned would swallow the Ctrl-C instead.
    process.kill(process.pid, signal);
  };
  const detachSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await writeFile(scratchPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // No env is passed, so the editor inherits this process's own - the spawn helpers
    // treat a given env as a replacement, and a partial one would start the editor
    // without a PATH, a HOME or a TERM.
    const result = spawnCommandSync(command, [...editorArgs, scratchPath], { stdio: "inherit" });
    if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${command} exited with ${result.status ?? "a signal"}, so nothing was changed.`);
    }

    const edited = parseEditedEnv(await readFile(scratchPath, "utf8"));
    const removed = Object.keys(current).filter((key) => !(key in edited));
    await updateProfileEnv(id, { set: edited, unset: removed });
    warnPlaintextEnv(id, profile.kind, Object.keys(edited));
    return success(`Updated ${bold(id)} ${dim(`(${Object.keys(edited).length} setting(s))`)}`);
  } finally {
    detachSignals();
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
}

// ─── Subcommand Help ────────────────────────────────────────────────

function subcommandHelpText(command: string): string | undefined {
  switch (command) {
    case "init":
      return [
        "",
        `  ${accent("clausona init")} ${dim("— Discover accounts interactively")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona init [--auto] [--merge-sessions]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--auto".padEnd(18))}${dim("Run non-interactively (skip TUI)")}`,
        `    ${accent("--merge-sessions".padEnd(18))}${dim("Share session history across profiles (default: separated)")}`,
        "",
      ].join("\n");

    case "add":
      return [
        "",
        `  ${accent("clausona add")} ${dim("— Add a new profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona add <profile> [--from <path>] [--merge-sessions]"),
        helpUsage("clausona add <profile> --api --base-url <url> [--model <id>] [--auth <scheme>] [--merge-sessions]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(18))}${dim("Profile to create (e.g. work or claude:work)")}`,
        `    ${" ".repeat(18)}${dim("Letters, digits, '.', '_' and '-', starting with a letter or digit:")}`,
        `    ${" ".repeat(18)}${dim("/^[A-Za-z0-9][A-Za-z0-9._-]*$/. Names are compared without case,")}`,
        `    ${" ".repeat(18)}${dim("so 'Work' and 'work' are the same profile.")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--from".padEnd(18))}${dim("Import configuration from an existing path")}`,
        `    ${accent("--merge-sessions".padEnd(18))}${dim("Share session history across profiles (default: separated)")}`,
        `    ${accent("--api".padEnd(18))}${dim("Create an API profile instead of a subscription login")}`,
        `    ${accent("--base-url".padEnd(18))}${dim("API endpoint, http:// or https:// (required with --api)")}`,
        `    ${accent("--model".padEnd(18))}${dim("Model id, stored as ANTHROPIC_MODEL. Change it later with")}`,
        `    ${" ".repeat(18)}${dim("`clausona config <profile> --model <id>`.")}`,
        `    ${accent("--auth".padEnd(18))}${dim("bearer | api-key (default: api-key for anthropic.com, else bearer)")}`,
        `    ${accent("--key-from".padEnd(18))}${dim('keychain (default) | env:NAME | command:"<shell command>"')}`,
        `    ${accent("--label".padEnd(18))}${dim("Display name shown in list (default: the endpoint host)")}`,
        `    ${accent("--set".padEnd(18))}${dim("Advanced setting KEY=VALUE; repeatable. For example")}`,
        `    ${" ".repeat(18)}${dim("--set CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144 or --set API_TIMEOUT_MS=600000.")}`,
        `    ${" ".repeat(18)}${dim("`clausona config <profile> --show --json` lists every key and its type.")}`,
        "",
        `  ${bold("EXAMPLES")}`,
        helpUsage("clausona add claude:gw --api --base-url https://openrouter.ai/api --model z-ai/glm-5.3"),
        helpUsage('printf %s "$MY_API_KEY" | clausona add claude:gw --api --base-url https://openrouter.ai/api'),
        helpUsage("clausona add claude:local --api --base-url http://localhost:8000 --key-from env:MY_API_KEY"),
        helpUsage('clausona add claude:vault --api --base-url http://localhost:8000 --key-from command:"pass show gw"'),
        "",
        `  ${bold("THE KEY")}`,
        `    ${dim("With --key-from keychain (the default) the key is read from a prompt that does")}`,
        `    ${dim("not echo it, or from stdin when something is piped in. Never pass a key as an")}`,
        `    ${dim("argument: `ps` shows every process's arguments to every user on the machine.")}`,
        "",
        `    ${dim('env:NAME and command:"..." store a reference, not the key. Each one is resolved')}`,
        `    ${dim("again every time the profile is used, in the shell that runs claude - so the")}`,
        `    ${dim("variable has to be exported there, not only in the shell that ran this command.")}`,
        `    ${dim("keychain stores the key itself, so it needs nothing set up afterwards.")}`,
        "",
      ].join("\n");

    case "use":
      return [
        "",
        `  ${accent("clausona use")} ${dim("— Switch active profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona use [profile]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to switch to (opens TUI picker if omitted)")}`,
        "",
      ].join("\n");

    case "list":
      return [
        "",
        `  ${accent("clausona list")} ${dim("— Show profiles with quota and usage")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona list [--json] [--refresh] [--no-quota] [--no-renew]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(14))}${dim("Output as JSON")}`,
        `    ${accent("--refresh".padEnd(14))}${dim("Bypass the 5-minute quota cache")}`,
        `    ${accent("--no-quota".padEnd(14))}${dim("Skip the plan-quota lookup (no network access)")}`,
        `    ${accent("--no-renew".padEnd(14))}${dim("Never renew a lapsed token; report it as expired")}`,
        "",
        `  ${bold("API PROFILES")}`,
        `    ${dim("ACCOUNT shows the profile's label rather than an account email, and the 5H")}`,
        `    ${dim("and 7D columns show a dash: an API endpoint bills per token and has no")}`,
        `    ${dim("subscription window to report. It is not queried, so --refresh and")}`,
        `    ${dim("--no-quota change nothing for it. COST and INPUT/OUTPUT still count what")}`,
        `    ${dim("clausona recorded locally.")}`,
        "",
        `  ${bold("MODEL")}`,
        `    ${dim("The model each profile pins, which is its ANTHROPIC_MODEL. A dash means it")}`,
        `    ${dim("pins none, and Claude Code picks. The column appears once some profile pins")}`,
        `    ${dim("a model. On a narrow terminal it outlasts the token counts and cost, and goes")}`,
        `    ${dim("before the quota columns or their reset times would. --json carries it as")}`,
        `    ${dim("`model`. Change it with `clausona config <profile> --model <id>`.")}`,
        "",
      ].join("\n");

    case "usage":
      return [
        "",
        `  ${accent("clausona usage")} ${dim("— Show usage summary")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona usage [profile] [--period=<period>] [--json]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile (shows all profiles if omitted)")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--period".padEnd(12))}${dim("<today|week|month|all>  Time period (default: today)")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "current":
      return [
        "",
        `  ${accent("clausona current")} ${dim("— Show active profile details")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona current [--json]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
      ].join("\n");

    case "doctor":
      return [
        "",
        `  ${accent("clausona doctor")} ${dim("— Check profile health")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona doctor [--json]"),
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--json".padEnd(12))}${dim("Output as JSON")}`,
        "",
        `  ${bold("CHECKS")}`,
        `    ${dim("Every profile: the items it shares with the primary, and its plugin state.")}`,
        `    ${dim("Run `clausona repair <profile>` for what that reports.")}`,
        "",
        `    ${dim("A subscription profile: its account file and its stored login. Run")}`,
        `    ${dim("`clausona login <profile>` for what that reports.")}`,
        "",
        `  ${bold("API PROFILES")}`,
        `    ${dim("An API profile has no account file and no stored login, so neither is")}`,
        `    ${dim("checked for it and neither is reported missing. These are, instead:")}`,
        "",
        `    ${dim("- that its config directory is still there;")}`,
        `    ${dim("- its base URL, which only a hand-edited profiles.json can break. The")}`,
        `    ${dim("  URL is never quoted back: a hand-edited one can carry a password.")}`,
        `    ${dim("  `clausona config <profile> --base-url <url>` puts it right;")}`,
        `    ${dim("- whether its key resolves. A command: key source is run, in the shell,")}`,
        `    ${dim("  every time doctor is; an env: one is read from doctor's own environment.")}`,
        `    ${dim("  doctor never prints the key, in either output form;")}`,
        `    ${dim("- apiKeyHelper in settings.json, which profiles share with the primary:")}`,
        `    ${dim("  Claude Code runs it for this profile too and the key it prints can")}`,
        `    ${dim("  reach the profile's endpoint, whatever auth scheme the profile uses.")}`,
        `    ${dim("  A settings.json that cannot be read is reported rather than skipped;")}`,
        `    ${dim("- a credential name in the profile's env map, which profiles.json holds")}`,
        `    ${dim("  in plain text. Move it with `clausona config <profile> --key`, then")}`,
        `    ${dim("  drop the copy with `clausona config <profile> --unset <NAME>`.")}`,
        "",
        `    ${dim("The last two are warnings. They describe a key that could reach the")}`,
        `    ${dim("endpoint, not a profile that is broken, so the profile stays healthy.")}`,
        "",
        `    ${dim("No request is made to the endpoint. A healthy report means the profile is")}`,
        `    ${dim("configured and its key resolves, not that the endpoint answered.")}`,
        "",
      ].join("\n");

    case "config":
      return [
        "",
        `  ${accent("clausona config")} ${dim("— Configure profile settings")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona config <profile> --merge-sessions | --separate-sessions"),
        helpUsage("clausona config <profile> --model <id>"),
        helpUsage("clausona config <profile> --set KEY=VALUE [--set ...] [--unset KEY]"),
        helpUsage("clausona config <profile> [--base-url <url>] [--auth <scheme>] [--label <name>]"),
        helpUsage("clausona config <profile> --key | --key-from <source>"),
        helpUsage("clausona config <profile> --edit"),
        helpUsage("clausona config <profile> --show [--json]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(22))}${dim("Profile to configure")}`,
        "",
        `  ${bold("OPTIONS")}`,
        `    ${accent("--merge-sessions".padEnd(22))}${dim("Share sessions with primary profile")}`,
        `    ${accent("--separate-sessions".padEnd(22))}${dim("Keep sessions isolated (default)")}`,
        `    ${accent("--model".padEnd(22))}${dim("The model the profile uses, stored as ANTHROPIC_MODEL")}`,
        `    ${accent("--set".padEnd(22))}${dim("Set an advanced env setting; repeatable")}`,
        `    ${accent("--unset".padEnd(22))}${dim("Remove an advanced env setting; repeatable")}`,
        `    ${accent("--base-url".padEnd(22))}${dim("Point an API profile at another endpoint, http:// or https://")}`,
        `    ${accent("--auth".padEnd(22))}${dim("bearer | api-key: how an API profile presents its key")}`,
        `    ${accent("--label".padEnd(22))}${dim("Name list shows for an API profile; cannot be blank")}`,
        `    ${accent("--key".padEnd(22))}${dim("Re-enter the API key for an API profile")}`,
        `    ${accent("--key-from".padEnd(22))}${dim('Switch the source: keychain | env:NAME | command:"<shell command>"')}`,
        `    ${accent("--edit".padEnd(22))}${dim("Open the profile's env map in $VISUAL or $EDITOR")}`,
        `    ${accent("--show".padEnd(22))}${dim("Print the profile's settings (add --json for the full catalog)")}`,
        "",
        `    ${dim("One change per call, except --show, which only reads. --base-url, --auth and")}`,
        `    ${dim("--label count as one: together they are the endpoint `add --api` set up.")}`,
        `    ${dim("--model counts with --set and --unset, since it is a setting too.")}`,
        "",
        `  ${bold("THE MODEL")}`,
        `    ${dim("--model writes ANTHROPIC_MODEL in the env map, the variable Claude Code reads;")}`,
        `    ${dim("there is no second copy, so --set and --edit change the same value. It works on")}`,
        `    ${dim("subscription profiles too, not on Codex ones, which never read it. An empty")}`,
        `    ${dim("--model is refused; --unset ANTHROPIC_MODEL clears it. `claude --model <id>`")}`,
        `    ${dim("changes the model for one session without touching the profile.")}`,
        "",
        `  ${bold("CHANGING THE ENDPOINT")}`,
        `    ${dim("Each value is checked by the rule add --api uses. The key is kept, so after")}`,
        `    ${dim("--base-url the next launch sends the same key to the new host; run --key")}`,
        `    ${dim("next if that endpoint takes another. A label that is still the old host,")}`,
        `    ${dim("which is what add chose when --label was left out, follows the new one.")}`,
        `    ${dim("A subscription profile has no endpoint, and list names it by its account")}`,
        `    ${dim("email, so all three refuse one.")}`,
        "",
        `  ${bold("EXAMPLES")}`,
        helpUsage("clausona config claude:gw --model z-ai/glm-5.3-flash"),
        helpUsage("clausona config claude:gw --set CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144"),
        helpUsage("clausona config claude:gw --base-url http://localhost:8000"),
        helpUsage("clausona config claude:gw --unset ANTHROPIC_MODEL"),
        helpUsage("clausona config claude:gw --show --json"),
        helpUsage('printf %s "$MY_API_KEY" | clausona config claude:gw --key'),
        "",
        `  ${bold("WHERE THINGS ARE STORED")}`,
        `    ${dim("The env map is stored in plain text in ~/.clausona/profiles.json. The API key")}`,
        `    ${dim("is not: it belongs in the credential store, set with --key or read from")}`,
        `    ${dim("--key-from. Do not put it in --set ANTHROPIC_API_KEY=... or in an")}`,
        `    ${dim("Authorization header under ANTHROPIC_CUSTOM_HEADERS.")}`,
        "",
        `    ${dim('--key-from env:NAME and command:"..." store a reference. Each is resolved again')}`,
        `    ${dim("every time the profile is used, in the shell that runs claude, so the variable")}`,
        `    ${dim("has to be exported there. --key stores the key itself and needs nothing set up.")}`,
        "",
      ].join("\n");

    case "repair":
      return [
        "",
        `  ${accent("clausona repair")} ${dim("— Repair shared links for a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona repair <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to repair")}`,
        "",
      ].join("\n");

    case "login":
      return [
        "",
        `  ${accent("clausona login")} ${dim("— Re-authenticate a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona login <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to re-authenticate")}`,
        "",
      ].join("\n");

    case "remove":
      return [
        "",
        `  ${accent("clausona remove")} ${dim("— Remove a profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona remove <profile>"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(12))}${dim("Profile to remove")}`,
        "",
      ].join("\n");

    case "run":
      return [
        "",
        `  ${accent("clausona run")} ${dim("— Run the CLI with a specific profile")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona run <profile> [-- args...]"),
        "",
        `  ${bold("ARGUMENTS")}`,
        `    ${accent("profile".padEnd(14))}${dim("Profile to use (overrides shell-init env)")}`,
        `    ${accent("args".padEnd(14))}${dim("Arguments passed through to the tool's CLI")}`,
        "",
        `  ${bold("EXAMPLES")}`,
        `    ${dim("clausona run claude:work")}`,
        `    ${dim("clausona run claude:personal -p /path/to/project")}`,
        `    ${dim("clausona run codex:personal -- 'review this'")}`,
        "",
      ].join("\n");

    case "shell-init":
      return [
        "",
        `  ${accent("clausona shell-init")} ${dim("— Print shell integration")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona shell-init"),
        "",
      ].join("\n");

    case "uninstall":
      return [
        "",
        `  ${accent("clausona uninstall")} ${dim("— Uninstall clausona completely")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona uninstall"),
        "",
        `  ${bold("DESCRIPTION")}`,
        `    ${dim("Removes all profiles, shell integration, data, and the clausona binary.")}`,
        `    ${dim("Imported profiles are restored from backup. Primary profile is left intact.")}`,
        "",
      ].join("\n");

    case "version":
      return [
        "",
        `  ${accent("clausona version")} ${dim("— Show version")}`,
        "",
        `  ${bold("USAGE")}`,
        helpUsage("clausona version"),
        "",
      ].join("\n");

    default:
      return undefined;
  }
}

// ─── Main Help ──────────────────────────────────────────────────────

function usageText() {
  return [
    "",
    `  ${bold("clausona")} ${dim("— Claude Code and Codex CLI profile manager")}`,
    "",
    `  ${bold("USAGE")}`,
    `    clausona ${accent("[command]")}`,
    "",
    helpSection("COMMANDS", [
      ["run <profile>", "Run the CLI with a specific profile"],
      ["init", "Discover accounts interactively"],
      ["add <profile>", "Add a new profile (--api for an endpoint instead of a login)"],
      ["use [profile]", "Switch active profile"],
      ["list", "Show profiles with quota and usage"],
      ["usage [profile]", "Show usage summary"],
      ["current", "Show active profile details"],
      ["config <profile>", "Configure profile settings"],
      ["doctor", "Check profile health"],
      ["repair <profile>", "Repair shared links"],
      ["login <profile>", "Re-authenticate a profile"],
      ["remove <profile>", "Remove a profile"],
      ["uninstall", "Uninstall clausona completely"],
      ["shell-init", "Print shell integration"],
      ["version", "Show version"],
    ]),
    "",
    dim("  Note: <profile> is a bare name (e.g. work) or tool:name (e.g. claude:work, codex:personal)"),
    "",
  ].join("\n");
}

// ─── Command Runner ─────────────────────────────────────────────────

export async function runCommand(command: string, args: string[]) {
  if (command !== "help" && command !== "-h" && command !== "--help" && helpFlag(args)) {
    const helpText = subcommandHelpText(command);
    if (helpText) return helpText;
  }

  validateFlags(command, args);

  switch (command) {
    case "help":
    case "-h":
    case "--help":
      return usageText();

    case "version":
    case "-v":
    case "--version":
      return `  ${accent("clausona")} ${dim(`v${__CLAUSONA_VERSION__}`)}`;

    case "shell-init":
      return shellInit();

    case "list": {
      const items = await listProfiles({
        quota: !args.includes("--no-quota"),
        refresh: args.includes("--refresh"),
        renew: !args.includes("--no-renew"),
      });
      return jsonFlag(args) ? JSON.stringify(items, null, 2) : renderList(items);
    }

    case "current": {
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");

      if (jsonFlag(args)) {
        const out: Record<string, unknown> = {};
        for (const tool of ALL_TOOLS) {
          const activeId = registry.activeProfiles[tool];
          if (!activeId) continue;
          const profile = registry.profiles[activeId];
          if (!profile) continue;
          out[tool] = { id: activeId, ...profile };
        }
        if (Object.keys(out).length === 0) {
          throw new Error("No active profiles. Run `clausona init` to set up profiles.");
        }
        return JSON.stringify(out, null, 2);
      }

      const blocks: string[] = [];
      for (const tool of ALL_TOOLS) {
        const activeId = registry.activeProfiles[tool];
        if (!activeId) continue;
        const profile = registry.profiles[activeId];
        if (!profile) continue;
        const home = homedir();
        const relativeConfigPath = path.relative(home, profile.configDir);
        const configPath =
          relativeConfigPath && !relativeConfigPath.startsWith("..")
            ? path.join("~", relativeConfigPath)
            : profile.configDir;
        blocks.push(
          box(activeId, [
            `${secondary("Account".padEnd(12))}${displayName(profile)}`,
            ...(profile.orgName ? [`${secondary("Org".padEnd(12))}${profile.orgName}`] : []),
            `${secondary("Config".padEnd(12))}${dim(configPath)}`,
            ...(!profile.isPrimary
              ? [`${secondary("Sessions".padEnd(12))}${profile.mergeSessions ? "merged" : "separated"}`]
              : []),
          ]),
        );
      }

      if (blocks.length === 0) {
        throw new Error("No active profiles. Run `clausona init` to set up profiles.");
      }
      return blocks.join("\n");
    }

    case "use": {
      const [input] = args;
      if (!input) return "__OPEN_TUI__:use";
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const profile = await setActiveProfileByName(ref.id);
      return success(`Switched to ${bold(ref.id)} ${dim(`(${displayName(profile)})`)}`);
    }

    case "usage": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      const periodArg = args.find((arg) => arg.startsWith("--period="));
      const periodValue = periodArg?.split("=")[1];
      const period: "today" | "week" | "month" | "all" = (() => {
        if (!periodValue) return "today";
        if (periodValue === "today" || periodValue === "week" || periodValue === "month" || periodValue === "all") {
          return periodValue;
        }
        // The value is not echoed, for the same reason none of the others are. This one is
        // nowhere near a key, but one exception is how a rule stops being a rule.
        throw new Error("Invalid --period: use today, week, month or all.");
      })();

      let id: string | null = null;
      if (input) {
        const registry = await loadRegistry();
        if (!registry) throw new Error("clausona is not initialized.");
        const ref = parseProfileRef(input, registry);
        if (ref.tool === "codex") {
          throw new Error("Usage tracking not supported for codex (yet).");
        }
        id = ref.id;
      }

      const summary = await getUsageSummary(id, period);
      if (!summary) return success(dim("No usage data found."));
      if (jsonFlag(args)) return JSON.stringify(summary, null, 2);
      return renderUsageSummary(summary, id ?? undefined, period);
    }

    case "doctor": {
      const results = await doctorProfiles();
      return jsonFlag(args) ? JSON.stringify(results, null, 2) : renderDoctor(results);
    }

    case "repair": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      if (!input) throw new Error("Usage: clausona repair <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const result = await repairProfile(ref.id);
      return success(`Repaired ${bold(String(result.repaired))} shared item(s) for ${bold(ref.id)}`);
    }

    case "login": {
      const [input] = args;
      if (!input) throw new Error("Usage: clausona login <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const profile = await loginProfile(ref.id);
      return success(`Token refreshed for ${bold(profile.email)}`);
    }

    case "config": {
      const setPairs = optionValues(args, "--set");
      const unsetKeys = optionValues(args, "--unset").map((key) => parseEnvName(key, "--unset"));
      const modelArg = optionValue(args, "--model");
      const keyFrom = optionValue(args, "--key-from");
      const changeKey = args.includes("--key") || keyFrom !== undefined;
      const openEditor = args.includes("--edit");
      const mergeSessions = args.includes("--merge-sessions");
      const separateSessions = args.includes("--separate-sessions");
      const baseUrl = optionValue(args, "--base-url");
      const authArg = optionValue(args, "--auth");
      const label = optionValue(args, "--label");
      // --model is a setting in the env map, so it is the same change as --set and --unset.
      const changeEnv = setPairs.length > 0 || unsetKeys.length > 0 || modelArg !== undefined;
      const changeSessions = mergeSessions || separateSessions;
      // One change, not three: together they are what `add --api` set about the endpoint.
      const changeEndpoint = baseUrl !== undefined || authArg !== undefined || label !== undefined;

      const [input, ...extraArgs] = positionalArgs(args, CONFIG_VALUE_FLAGS);
      if (!input) throw new Error(CONFIG_USAGE);
      if (extraArgs.length > 0) throw new Error(CONFIG_EXTRA_ARGUMENT);

      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      const profile = registry.profiles[ref.id];

      // A read, and it wins over everything else: `--show` next to a change is a caller
      // asking what is there, and answering that is always safe.
      if (args.includes("--show")) return showProfile(ref.id, profile, jsonFlag(args));

      // One change per call. Each branch below returns, so a second flag would be dropped
      // without a word - the caller would be told the profile was updated, for the other
      // thing they asked for.
      const changes = [changeEnv, changeEndpoint, changeKey, openEditor, changeSessions].filter(Boolean).length;
      if (changes === 0) throw new Error(CONFIG_USAGE);
      if (changes > 1) {
        throw new Error(
          "Change one thing at a time: --model/--set/--unset, --base-url/--auth/--label, --key/--key-from, --edit, or --merge-sessions/--separate-sessions.",
        );
      }

      if (changeEnv) {
        const set: Record<string, string> = {};
        if (modelArg !== undefined) {
          // Allowed on a subscription profile too: Claude Code honours a pinned model there,
          // and refusing one kind would be an accident of where the flag is parsed. Codex is
          // another matter - it never reads the variable, so storing it would report success
          // and change nothing Codex does.
          if (profile.tool !== "claude") {
            throw new Error(
              `--model sets ANTHROPIC_MODEL, which only Claude Code reads, and '${ref.id}' is a Codex profile.`,
            );
          }
          if (unsetKeys.includes("ANTHROPIC_MODEL")) throw new Error(MODEL_TWICE);
          set.ANTHROPIC_MODEL = parseModel(modelArg);
        }
        for (const assignment of setPairs) {
          const [key, value] = parseAssignment(assignment, "--set");
          if (key === "ANTHROPIC_MODEL" && modelArg !== undefined) throw new Error(MODEL_TWICE);
          set[key] = value;
        }
        // updateProfileEnv validates every entry through validateEnvEntry before it saves.
        await updateProfileEnv(ref.id, { set, unset: unsetKeys });
        warnPlaintextEnv(ref.id, profile.kind, Object.keys(set));
        const changed = [...Object.keys(set), ...unsetKeys].join(", ");
        return success(`Updated ${bold(ref.id)} ${dim(`(${changed})`)}`);
      }

      if (changeEndpoint) {
        // updateProfileApi refuses a subscription profile for all three: it has no endpoint,
        // and `list` names it by its account email - a label is by definition the name of a
        // profile that has none. There is no prompt to get ahead of here, unlike --key, so
        // the service's check is the only one.
        const result = await updateProfileApi(ref.id, {
          baseUrl,
          authScheme: authArg === undefined ? undefined : parseAuthScheme(authArg),
          label,
        });
        if (baseUrl !== undefined && result.host !== result.previousHost) {
          // The key is not the endpoint's to keep: it is whatever the profile's key source
          // holds, and the next launch hands it to the new host. That can be a third party.
          process.stderr.write(
            `  ${warnIcon} The key is unchanged, so from the next launch it goes to ${result.host}.\n` +
              "    If this endpoint takes a different key, store it:\n" +
              `      ${accent(`clausona config ${ref.id} --key`)}\n`,
          );
        }
        const changed = [
          ...(baseUrl === undefined ? [] : ["base URL"]),
          ...(authArg === undefined ? [] : ["auth"]),
          ...(label !== undefined
            ? ["label"]
            : result.profile.label !== profile.label
              ? ["label, following the host"]
              : []),
        ].join(", ");
        return success(`Updated ${bold(ref.id)} ${dim(`(${changed})`)}`);
      }

      if (changeKey) {
        // Checked before the prompt, not after: updateProfileSecret refuses the same
        // thing, but by then the user has typed a key for a profile that has no use for one.
        if (profile.kind !== "api" || !profile.api) throw new Error(`Profile '${ref.id}' is not an API profile.`);
        const secret = parseSecretSource(keyFrom ?? "keychain");
        const value = secret.source === "keychain" ? await promptSecret("API key: ") : undefined;
        if (secret.source === "keychain" && !value) throw new Error(NO_KEY_SUPPLIED);
        await updateProfileSecret(ref.id, secret, value);
        return success(`Updated the credential for ${bold(ref.id)}`);
      }

      if (openEditor) return await editProfileEnv(ref.id, profile);

      if (mergeSessions && separateSessions) {
        throw new Error("Pass --merge-sessions or --separate-sessions, not both.");
      }
      const result = await updateProfileConfig(ref.id, { mergeSessions });
      if (!result.changed) return dim(`${ref.id} is already ${mergeSessions ? "merged" : "separated"}`);
      return success(`${bold(ref.id)} sessions set to ${result.mergeSessions ? "merged" : "separated"}`);
    }

    case "remove": {
      const [input] = args.filter((arg) => !arg.startsWith("--"));
      if (!input) throw new Error("Usage: clausona remove <profile>");
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(input, registry);
      await removeProfile(ref.id);
      return success(`Removed ${bold(ref.id)}`);
    }

    case "add": {
      const api = args.includes("--api");
      const fromPath = optionValue(args, "--from");
      const mergeSessions = args.includes("--merge-sessions");

      if (api && fromPath !== undefined) {
        throw new Error("--api and --from cannot be combined: an API profile has no account to import.");
      }
      if (!api) {
        // Silently ignoring one of these would leave a subscription profile where the
        // caller asked for an endpoint, and nothing on screen would say so.
        const stray = API_ONLY_FLAGS.find((flag) => optionValues(args, flag).length > 0);
        if (stray) throw new Error(`${stray} only applies to an API profile. Add --api, or leave it out.`);
      }

      const [input, ...extraArgs] = positionalArgs(args, ADD_VALUE_FLAGS);
      if (!input) {
        throw new Error(api ? ADD_API_USAGE : "Usage: clausona add <profile> [--from <path>] [--merge-sessions]");
      }
      // Checked before the tool is resolved, because the two messages that resolution can
      // produce both quote the input, and a key in this slot would otherwise end up as a
      // profile id, a directory name and a line of stdout.
      if (looksLikeCredential(input)) throw new Error(CREDENTIAL_AS_NAME_ERROR);
      if (extraArgs.length > 0) throw new Error(ADD_EXTRA_ARGUMENT);

      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");

      let tool: ToolName;
      let name: string;
      if (input.includes(":")) {
        const [maybeTool, ...rest] = input.split(":");
        if (!(ALL_TOOLS as readonly string[]).includes(maybeTool)) {
          throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
        }
        tool = maybeTool as ToolName;
        name = rest.join(":");
      } else {
        const configured = ALL_TOOLS.filter((t) => registry.primarySources[t]);
        if (configured.length === 0) {
          throw new Error("No tools configured. Run `clausona init` first.");
        }
        if (configured.length > 1) {
          throw new Error(
            `Both tools are configured. Specify '${configured.map((t) => `${t}:${input}`).join("' or '")}'.`,
          );
        }
        tool = configured[0];
        name = input;
      }

      if (api) {
        const baseUrl = optionValue(args, "--base-url");
        if (!baseUrl) throw new Error(ADD_API_USAGE);
        // `parseBaseUrl` is addApiProfile's own check, exported and called here so that a
        // URL it will refuse is refused before the key prompt rather than after it. Same
        // function, same message - not a second rule. It also gives the host for the
        // default auth scheme and for the success line.
        const url = parseBaseUrl(baseUrl.trim());

        const authArg = optionValue(args, "--auth");
        const authScheme =
          authArg === undefined ? (isAnthropicHost(url.hostname) ? "api-key" : "bearer") : parseAuthScheme(authArg);
        // addApiProfile's own rule again, for the same reason as the URL above.
        const label = optionValue(args, "--label");
        if (label !== undefined) checkLabel(label);

        // Built before the key is asked for: a rejected setting should not cost the user
        // a typed key. This is the same validator addApiProfile runs, not a second rule.
        const env: Record<string, string> = {};
        const model = optionValue(args, "--model");
        if (model !== undefined) env.ANTHROPIC_MODEL = parseModel(model);
        for (const assignment of optionValues(args, "--set")) {
          const [key, value] = parseAssignment(assignment, "--set");
          if (key === "ANTHROPIC_MODEL" && model !== undefined) throw new Error(MODEL_TWICE);
          const result = validateEnvEntry(key, value);
          if (!result.ok) throw new Error(result.error);
          env[key] = value;
        }

        // Same reason as the settings above, and the same validator addApiProfile runs:
        // a name it is going to refuse should not cost the user a typed key first.
        const nameCheck = validateProfileName(name);
        if (!nameCheck.ok) throw new Error(nameCheck.error);

        const secret = parseSecretSource(optionValue(args, "--key-from") ?? "keychain");
        const secretValue = secret.source === "keychain" ? await promptSecret("API key: ") : undefined;
        if (secret.source === "keychain" && !secretValue) throw new Error(NO_KEY_SUPPLIED);

        const result = await addApiProfile({
          tool,
          name,
          baseUrl,
          authScheme,
          secret,
          secretValue,
          label,
          env,
          mergeSessions: mergeSessions || undefined,
        });
        const id = profileId(tool, result.name);
        warnPlaintextEnv(id, "api", Object.keys(env));
        return success(`Added ${bold(id)} ${dim(`(${url.host})`)}\n  ${dim(`Config: ${result.configDir}`)}`);
      }

      // addProfile enforces the name rule before it touches anything.
      const added = await addProfile({ tool, name, fromPath, mergeSessions: mergeSessions || undefined });
      return success(`Added ${bold(profileId(tool, added.name))} ${dim(`(${added.email})`)}`);
    }

    case "run": {
      throw new Error("Usage: clausona run <profile> [claude-args...]");
    }

    case "_shell-env": {
      // Internal: the shell wrapper runs this as `eval "$(clausona _shell-env claude)"`, so
      // stdout carries export lines and nothing else — every diagnostic goes to stderr, and
      // an unusable registry resolves to empty output rather than an error the shell would eval.
      const [toolArg] = args.filter((arg) => !arg.startsWith("-"));
      if (!toolArg || !(ALL_TOOLS as readonly string[]).includes(toolArg)) return "";

      const registry = await loadRegistry();
      if (!registry) return "";
      const id = registry.activeProfiles[toolArg as ToolName];
      const profile = id ? registry.profiles[id] : undefined;
      if (!id || !profile) return "";

      const built = await buildProfileEnv(id, profile);
      const { env, unset, warnings } = built;
      // Repeated on every launch on purpose: a warning here means a persistent
      // misconfiguration, and it should keep showing until the profile is fixed.
      for (const warning of warnings) process.stderr.write(`  ${warnIcon} ${warning}\n`);
      // The guard list covers what the profile sets as well as what it clears: on POSIX a
      // name it cannot export is as bad as one it cannot unset. Windows has no readonly
      // variables, so the JSON form below is unchanged.
      if (!jsonFlag(args)) return renderPosixExports(env, unset, controlledEnvKeys(profile, built));
      // null is how the PowerShell hook learns to remove a variable: it hands the value to
      // SetEnvironmentVariable, which deletes the variable for $null. With nothing to clear
      // this is JSON.stringify(env) exactly, so a subscription profile's output is unchanged.
      const cleared = Object.fromEntries(unset.map((key) => [key, null]));
      return JSON.stringify({ ...cleared, ...env });
    }

    case "_sync-plugins": {
      const registry = await loadRegistry();
      if (!registry) return "";
      const claudePrimary = registry.primarySources.claude ?? path.join(homedir(), ".claude");
      const configDir = process.env.CLAUDE_CONFIG_DIR ?? claudePrimary;
      await syncPluginsJson(configDir, claudePrimary).catch(() => {});
      return "";
    }

    case "_track-usage": {
      await trackUsage();
      return "";
    }

    case "uninstall": {
      process.stdout.write(
        `${[
          "",
          `  ${bold("This will completely uninstall clausona:")}`,
          `    ${dim("• Strip symlinks and restore backups for all non-primary profiles")}`,
          `    ${dim("• Profile directories at ~/.claude-<name> are preserved (data intact)")}`,
          `    ${dim("• Remove shell integration from rc files")}`,
          `    ${dim("• Delete ~/.clausona/ directory (registry, usage, backups)")}`,
          `    ${dim("• Delete app files and launcher binary")}`,
          "",
        ].join("\n")}\n`,
      );

      const confirmed = await new Promise<boolean>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`  Proceed? ${accent("(y/N)")} `, (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() === "y");
        });
      });

      if (!confirmed) {
        return dim("  Cancelled.");
      }

      const result = await uninstallClausona();
      if (result.removed.length === 0) {
        return success(dim("Nothing to uninstall."));
      }
      return [
        success("clausona has been uninstalled."),
        "",
        ...result.removed.map((item) => `  ${dim("•")} ${dim(item)}`),
        "",
        dim("  Open a new terminal to clear the shell integration."),
      ].join("\n");
    }

    case "init": {
      if (!args.includes("--auto")) {
        return "__OPEN_TUI__:init";
      }

      const accounts = await discoverAccounts();
      if (accounts.length === 0) {
        throw new Error("No Claude Code accounts found. Run `claude login` first.");
      }
      const mergeSessions = args.includes("--merge-sessions") || undefined;
      const profileNames = await proposeInitProfileNames(accounts, await loadRegistry());
      // No default: nobody was asked, so each tool keeps the profile that was active.
      await initializeRegistry({ accounts, profileNames, mergeSessions });
      return success(`Initialized ${bold(String(accounts.length))} profile(s)`);
    }

    default:
      return usageText();
  }
}

export async function bootstrapInitFromCurrentState() {
  const accounts = await discoverAccounts();
  const existing = await loadRegistry();
  const profileNames = await proposeInitProfileNames(accounts, existing);
  // Registry keys are ids (`claude:work`), but init takes bare names and adds the tool
  // itself - an id passed through would come back as `claude:claude:work`.
  const active = existing?.activeProfiles?.claude;
  const activeName =
    existing && active && existing.profiles[active] ? parseProfileRef(active, existing).name : undefined;

  return {
    accounts,
    profileNames,
    defaultProfile: activeName ?? Object.values(profileNames)[0] ?? "default",
  };
}
