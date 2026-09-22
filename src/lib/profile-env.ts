import { realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";

import { isPosixEnvName } from "../core/shell.js";
import { getAdapter } from "../tools/registry.js";
import type { Profile } from "../types.js";
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

export function displayName(profile: Pick<Profile, "email" | "label">): string {
  // Blank-aware, not just absent-aware: `add --api` refuses an empty label, but a
  // hand-edited profiles.json can carry one, and `label ?? email` would then hide a real
  // account email behind whitespace wherever a profile is named.
  return profile.label?.trim() || profile.email;
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
