import { realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";

import { getAdapter } from "../tools/registry.js";
import type { Profile } from "../types.js";
import { resolveSecret } from "./secrets.js";

/** Variables clausona owns; a profile's env map may not redefine them. */
export const RESERVED_ENV_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

export function displayName(profile: Pick<Profile, "email" | "label">): string {
  return profile.label ?? profile.email;
}

export type BuiltEnv = { env: Record<string, string>; warnings: string[] };

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
    if (RESERVED_ENV_KEYS.has(key)) {
      // Honouring the override would break profile isolation, so drop it - but say so,
      // since a hand-edited profiles.json is the usual way to land here.
      warnings.push(`${id}: ignoring ${key} from the env map - clausona sets it per profile`);
      continue;
    }
    env[key] = value;
  }

  return { env, warnings };
}
