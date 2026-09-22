import { realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";

import { isPosixEnvName } from "../core/shell.js";
import { getAdapter } from "../tools/registry.js";
import type { Profile } from "../types.js";
import { resolveSecret } from "./secrets.js";

/** Variables clausona owns; a profile's env map may not redefine them. */
export const RESERVED_ENV_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

/**
 * Every variable Claude Code authenticates with. For an API profile each one comes from
 * the profile or not at all: whatever the profile does not set is unset for the run.
 *
 * Applying the profile on top of the caller's environment is not enough. Claude Code reads
 * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN independently and sends X-Api-Key and
 * Authorization together when both are set, so a key the user exported for some other
 * purpose would go to this profile's endpoint - a third party, often - next to the
 * profile's own, or in its place when the profile's key did not resolve. A subscription
 * OAuth token is never wanted either, and Claude Code ranks it as an auth source.
 * Dropping a name from this list reopens that leak for it.
 */
export const API_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function displayName(profile: Pick<Profile, "email" | "label">): string {
  return profile.label ?? profile.email;
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
    if (RESERVED_ENV_KEYS.has(key)) {
      // Honouring the override would break profile isolation, so drop it - but say so,
      // since a hand-edited profiles.json is the usual way to land here.
      warnings.push(`${id}: ignoring ${key} from the env map - clausona sets it per profile`);
      continue;
    }
    env[key] = value;
  }

  // A set difference, taken last: the resolved key and any explicit env-map entry are in
  // env and so kept; everything else - an unresolved key's variable included - is cleared.
  const unset = profile.kind === "api" && profile.api ? API_CREDENTIAL_ENV_KEYS.filter((key) => !(key in env)) : [];
  return { env, unset, warnings };
}
