import { realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";

import { HIDDEN } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { isPosixEnvName } from "../core/shell.js";
import { getAdapter } from "../tools/registry.js";
import type { Profile, ShownKind } from "../types.js";
import { resolveSecret } from "./secrets.js";

/**
 * Variables clausona owns; a profile's env map may not redefine them, in any spelling -
 * Windows treats `claude_config_dir` as CLAUDE_CONFIG_DIR.
 */
export const RESERVED_ENV_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

export function isReservedEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key.toUpperCase());
}

/**
 * The variables Claude Code takes a credential from, or that switch on an auth flow. For an
 * API profile each one comes from the profile or not at all: whatever the profile does not
 * set is unset for the run.
 *
 * Applying the profile on top of the caller's environment is not enough. Claude Code reads
 * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN independently and sends X-Api-Key and
 * Authorization together when both are set, so a key the user exported for some other
 * purpose would go to this profile's endpoint - a third party, often - next to the
 * profile's own, or in its place when the profile's key did not resolve. The same holds
 * for every other source here: with the profile's key missing, Claude Code falls through
 * to the next one it finds, and workload identity federation would POST the caller's
 * identity token to `${ANTHROPIC_BASE_URL}/v1/oauth/token`.
 *
 * - the three auth variables, and ANTHROPIC_CUSTOM_HEADERS, which can carry an
 *   Authorization header of its own;
 * - a subscription's OAuth refresh token;
 * - the four file-descriptor sources Claude Code reads a token or key from;
 * - workload identity federation: the identity token or its file, and the rule-id and
 *   organization-id pair that switches it on;
 * - a host's credentials: the variable naming them, and the file holding them;
 * - a remote session's token, which the worker path sends to
 *   `${ANTHROPIC_BASE_URL}/v1/code/sessions/...`, and the file it can be read from;
 * - the background handoff snapshot, a file holding an OAuth access or gateway token that
 *   startup consumes when CLAUDE_CODE_OAUTH_TOKEN is absent, which is the state clausona
 *   leaves an API profile in.
 *
 * Taken from the Claude Code 2.1.278 binary (its credential and scrub lists and the auth
 * code that reads them), and only names that supply a credential or turn an auth flow on -
 * not OAuth client configuration such as scopes or client ids. Re-check it whenever Claude
 * Code adds an auth source. Dropping a name reopens the leak for it.
 */
export const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
] as const;

/**
 * The variables that send Claude Code's traffic somewhere other than ANTHROPIC_BASE_URL.
 * An inherited one routes an API profile's run to Bedrock, Vertex, a local socket or a
 * host-managed provider with the profile's base URL silently ignored - a profile that does
 * not do what it says. Cleared on the same terms as the credentials.
 *
 * - the provider switches, CLAUDE_CODE_USE_*: routing flags only. The other USE_ flags
 *   (CLAUDE_CODE_USE_POWERSHELL_TOOL and the like) choose features, not providers;
 * - ANTHROPIC_UNIX_SOCKET, which carries every API request over a socket instead;
 * - CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, which hands provider selection to the host;
 * - CLAUDE_CODE_CUSTOM_OAUTH_URL, which moves the API and OAuth endpoints elsewhere.
 *
 * Taken from the Claude Code 2.1.278 binary. Re-check it whenever Claude Code adds a
 * provider or another way to route around the base URL.
 */
export const ROUTING_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
] as const;

const CREDENTIAL_ENV_KEY_SET = new Set<string>(CREDENTIAL_ENV_KEYS);

/** A name whose value is a credential: the variables Claude Code takes one from. */
export function isCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_ENV_KEY_SET.has(key);
}

/**
 * A name that says its value is a secret. Built for redaction and for the plain-text warning,
 * not for launch: CREDENTIAL_ENV_KEYS above is what an API profile CLEARS, and it is the
 * Anthropic credentials only. Another service's token under a name of its own - OTEL's
 * exporter headers, a Bedrock bearer token, an AWS secret key - is not cleared and should not
 * be, but it is no less a secret in profiles.json or on a screen.
 *
 * Whole words only, so a count of tokens is not a token: CLAUDE_CODE_MAX_CONTEXT_TOKENS and
 * MAX_THINKING_TOKENS stay visible, and of the catalog only ANTHROPIC_CUSTOM_HEADERS matches,
 * which the clear list already has. PASSWORD is the exception, matched anywhere, because
 * PGPASSWORD - what postgres MCP servers read - has no underscore before it. Any case: a shell
 * exports `github_token` as readily as `GITHUB_TOKEN`.
 *
 * Measured against the 1720 environment names in the Claude Code binary's strings, the words
 * after CREDENTIALS newly hide three: ANTHROPIC_WEBHOOK_SIGNING_KEY, which is a secret; the
 * lowercase spelling of GOOGLE_APPLICATION_CREDENTIALS, whose uppercase one was already hidden;
 * and SSH_SIGNING_KEY, which can be a path. Hidden too, if anyone sets them: PWD, the shell's
 * own, and a path such as COOKIES_PATH. Hiding one too many costs a `<hidden>` the user can
 * still read in `config --edit`, and a plain-text note on `--set`; one too few prints a secret.
 */
const SECRET_ENV_NAME =
  /(^|_)(TOKEN|SECRET|PASSPHRASE|API_KEY|ACCESS_KEY|HEADERS|CREDENTIALS?|PRIVATE_KEY|MASTER_KEY|SIGNING_KEY|ENCRYPTION_KEY|SESSION_KEY|LICENSE_KEY|STORAGE_KEY|APP_KEY|CONNECTION_STRING|PAT|PWD|COOKIES?)(_|$)|PASSWORD/i;

export function isSecretEnvName(key: string): boolean {
  return isCredentialEnvKey(key) || SECRET_ENV_NAME.test(key);
}

/** Everything clausona sets or clears for an API profile, besides its free-form env map. */
const API_MANAGED_ENV_KEYS: readonly string[] = ["ANTHROPIC_BASE_URL", ...CREDENTIAL_ENV_KEYS, ...ROUTING_ENV_KEYS];

/**
 * The name `key` would be the same variable as on Windows, which treats environment names
 * case-insensitively: another name already in `others`, or - for an API profile - a name
 * clausona sets or clears for it, spelled differently. Undefined when there is none.
 *
 * Two such names cannot both be honoured. PowerShell's ConvertFrom-Json refuses a JSON
 * object carrying both, and the hook would then apply no profile at all; and on POSIX a
 * miscased `anthropic_custom_headers` is a variable Claude Code never reads, while treating
 * it as the real one would leave the caller's ANTHROPIC_CUSTOM_HEADERS uncleared. So the
 * env map may hold at most one spelling of a name, and never a variant of a managed one.
 */
export function envKeyCaseTwin(key: string, others: Iterable<string>, kind: Profile["kind"]): string | undefined {
  const upper = key.toUpperCase();
  for (const other of others) if (other !== key && other.toUpperCase() === upper) return other;
  if (kind === "api") return API_MANAGED_ENV_KEYS.find((managed) => managed !== key && managed === upper);
  return undefined;
}

export function envKeyCaseTwinError(key: string, twin: string): string {
  return `'${key}' differs from ${twin} only in case, and Windows treats the two as one variable. Did you mean ${twin}?`;
}

/**
 * Every name an API profile's run must control: the ones it clears, and every one it sets.
 * The POSIX renderer refuses to launch when one of them can be neither unset nor exported,
 * because the profile would then only half apply - and how it half applies depends on the
 * shell. A `readonly` ANTHROPIC_API_KEY would leave the caller's key next to the profile's
 * endpoint; a `readonly` copy of any other exported name stops bash from applying that one
 * entry, and stops zsh from applying that entry and every one after it, silently. So the
 * rule is the same for all of them: the profile launches only if every variable it sets
 * lands exactly as it says.
 *
 * Empty for every other profile, whose output is what it always was.
 */
export function controlledEnvKeys(profile: Profile, built: BuiltEnv): string[] {
  if (profile.kind !== "api" || !profile.api) return [];
  return [...built.unset, ...Object.keys(built.env)];
}

/**
 * Whether a profile's env map is a map at all. A hand edit can leave it a list - the
 * docker-compose habit - or a string, and walked as an object either one prints its content
 * under index keys, the string one character per key. None of it is ever applied: no index
 * is a variable name.
 */
export function isEnvMap(env: unknown): env is Record<string, string> {
  return typeof env === "object" && env !== null && !Array.isArray(env);
}

/**
 * The env map to read and to change: the map itself, and an empty one for a missing map,
 * `null` or `[]`, each of which applies exactly what `{}` does - so none of them is reported
 * or refused. Undefined for one that is not a map at all: a list with entries, a string, a
 * number. None of that is applied, and `invalidEnvMapMessage` says what fixes it.
 */
export function envMapOf(env: unknown): Record<string, string> | undefined {
  if (env === undefined || env === null || (Array.isArray(env) && env.length === 0)) return {};
  return isEnvMap(env) ? env : undefined;
}

/**
 * doctor's finding for an env map that is not one, and `config`'s refusal to change it. The
 * value is never quoted: it is what the user meant to set, credentials included. `--edit`
 * opens what is there and saves the object it is given.
 */
export function invalidEnvMapMessage(id: string): string {
  return `the env map in ~/.clausona/profiles.json is not a map of NAME: value, so none of it is applied - run 'clausona config ${id} --edit' and save it as one`;
}

/**
 * A name in the env map as it may be printed: itself, or `<hidden>` when it is shaped like an
 * API key. No variable is named that way, so it is a key pasted where the name goes - a hand
 * edit, or a paste that missed - and printing the name would print the key.
 */
export function shownEnvName(key: string): string {
  return carriesCredentialToken(key) ? HIDDEN : key;
}

/**
 * A label as it may be printed: without control characters, and `<hidden>` when it is shaped
 * like an API key - `checkLabel` refuses one now, and a profile stored before that, or edited
 * by hand, can still hold one.
 */
export function shownLabel(label: string | undefined): string | undefined {
  const shown = printable(label);
  return shown !== undefined && carriesCredentialToken(shown) ? HIDDEN : shown;
}

/**
 * A kind as it may be printed. A hand edit can leave anything in the slot; one that is neither
 * kind launches as a subscription and doctor reports it, so it is shown as `unknown` - never
 * stripped of its control characters, which would turn `api\u0007` into a valid-looking `api`.
 */
export function shownKind(kind: unknown): ShownKind | undefined {
  return kind === undefined || kind === "subscription" || kind === "api" ? kind : "unknown";
}

export function displayName(profile: Pick<Profile, "email" | "label">): string {
  // Blank-aware, not just absent-aware: `add --api` refuses an empty label, but a
  // hand-edited profiles.json can carry one, and `label ?? email` would then hide a real
  // account email behind whitespace wherever a profile is named. A key-shaped one is refused
  // too, and one stored before that, or by hand, is not printed.
  const label = printable(profile.label ?? "").trim();
  if (label && carriesCredentialToken(label)) return HIDDEN;
  return label || printable(profile.email);
}

/**
 * A stored string as it may be printed: without C0 or C1 control characters - ESC among
 * them, so no terminal escape sequence survives. For the fields a hand edit can put anything
 * in and that are printed as they are - the label, the kind, the auth scheme - so that
 * opening `list` cannot retitle the terminal, clear it or rewrite what came before. Only
 * what is printed changes; anything that is not a string is left as it is.
 */
export function printable<T>(value: T): T {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  return (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "") : value) as T;
}

/**
 * The model a profile pins. There is no field for it: it is the env map's ANTHROPIC_MODEL,
 * the variable Claude Code reads, which `add --model` and `config --model` write and
 * `--set`, `--unset` and `--edit` can change as well. One place, so nothing can disagree
 * with it. This is the one reading of it, for every surface that shows a model.
 *
 * Undefined for a Codex profile, which does not read the variable, and for a blank value -
 * blank-aware for the same reason as `displayName`, since only a hand edit or `--set`
 * stores one and a blank cell reads as a rendering bug. HIDDEN for a key-shaped one, which
 * `checkModelEntry` refuses now and a profile stored before that can still hold.
 */
export function profileModel(profile: Pick<Profile, "tool" | "env">): string | undefined {
  if (profile.tool !== "claude") return undefined;
  const model = profile.env?.ANTHROPIC_MODEL;
  if (!model?.trim()) return undefined;
  return carriesCredentialToken(model) ? HIDDEN : model;
}

/**
 * `unset` lists variables that must be absent from the tool's environment, whatever the
 * caller's shell holds. It never names a key that is also in `env`.
 */
export type BuiltEnv = { env: Record<string, string>; unset: string[]; warnings: string[] };

type Deps = {
  resolveSecret?: typeof resolveSecret;
  realpath?: (target: string) => Promise<string>;
  homedir?: () => string;
};

/**
 * Turns one profile into the environment a single tool run needs.
 *
 * Merge order is config dir, then the API block, then the profile's free-form env map —
 * so anything the user set explicitly in the advanced section wins, except the config
 * variable itself, which would break profile isolation.
 */
export async function buildProfileEnv(id: string, profile: Profile, deps: Deps = {}): Promise<BuiltEnv> {
  const resolve = deps.resolveSecret ?? resolveSecret;
  const realpath = deps.realpath ?? ((target: string) => fsRealpath(target));
  const home = deps.homedir ?? homedir;
  const adapter = getAdapter(profile.tool);
  const env: Record<string, string> = {};
  const warnings: string[] = [];

  // A profile that points at the tool's own default directory must not set the variable:
  // the tool already reads that directory, and setting it changes nothing but noise.
  const resolvedConfig = await realpath(profile.configDir).catch(() => profile.configDir);
  const defaultDir = adapter.defaultConfigDir(home());
  const resolvedDefault = await realpath(defaultDir).catch(() => defaultDir);
  if (!profile.isPrimary && resolvedConfig !== resolvedDefault) {
    env[adapter.configEnvVar] = profile.configDir;
  }

  if (profile.kind === "api" && profile.api) {
    env.ANTHROPIC_BASE_URL = profile.api.baseUrl;
    try {
      const secret = await resolve(id, profile.api.secret);
      env[profile.api.authScheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = secret;
    } catch (error) {
      // Not fatal: the tool still starts and reports its own authentication error, which
      // is more actionable than a shell function that silently does nothing.
      warnings.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [key, value] of Object.entries(profile.env ?? {})) {
    if (shownEnvName(key) !== key) {
      // Even where the shell could export it, a variable named after a key hands the key to
      // every process the tool starts. Said without the name: it is the key.
      warnings.push(
        `${id}: ignoring a name shaped like an API key from the env map - remove it with 'clausona config ${id} --edit'`,
      );
      continue;
    }
    if (!isPosixEnvName(key)) {
      // No shell can export this name, and the POSIX path interpolates keys bare - so a
      // key carrying `;` or `$(...)` would become extra commands inside the `eval` around
      // _shell-env's output. Drop it, loudly, wherever it came from.
      warnings.push(`${id}: ignoring '${key}' from the env map - not a valid environment variable name`);
      continue;
    }
    if (isReservedEnvKey(key)) {
      // Honouring the override would break profile isolation, so drop it - but say so,
      // since a hand-edited profiles.json is the usual way to land here.
      warnings.push(`${id}: ignoring ${key} from the env map - clausona sets it per profile`);
      continue;
    }
    // The set-time check refuses these; a hand-edited profiles.json can still carry one.
    const twin = envKeyCaseTwin(key, Object.keys(env), profile.kind);
    if (twin !== undefined) {
      warnings.push(
        `${id}: ignoring '${key}' from the env map - it differs from ${twin} only in case, and Windows treats the two as one variable`,
      );
      continue;
    }
    env[key] = value;
  }

  // For an API profile the endpoint and every credential come from the profile or not at
  // all. A set difference, taken last: the resolved key and any explicit env-map entry are
  // in env and so kept; everything else - an unresolved key's variable included - is cleared.
  // It has to stay after the loop above, which drops any env-map key that is a case variant
  // of one of these; that is what keeps every name here from being another spelling of one
  // in env. And it matches names exactly on purpose: excluding case-insensitively would, on
  // POSIX, let a lowercase key the tool never reads keep the caller's real variable alive.
  const unset =
    profile.kind === "api" && profile.api
      ? [...CREDENTIAL_ENV_KEYS, ...ROUTING_ENV_KEYS].filter((key) => !Object.hasOwn(env, key))
      : [];
  return { env, unset, warnings };
}
