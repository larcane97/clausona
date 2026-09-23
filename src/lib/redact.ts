import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { describeSecretSource, redactSecretSource } from "../core/key-source.js";
import { catalogEntry } from "../tools/claude-env-catalog.js";
import type { Profile } from "../types.js";
import { CREDENTIAL_ENV_KEYS } from "./profile-env.js";

/**
 * What a profile looks like when it leaves the process.
 *
 * Every path that prints a profile - `current`, `config --show`, the dashboard, and each of
 * them in `--json` - goes through `redactProfile`, and the pieces below are the only rules
 * for what it hides. They were three separate guards before (`config --show` filtered the
 * env map, the doctor refused to quote a URL, the preview named a command source by kind) and
 * the path none of them covered, `current --json`, printed an Authorization header verbatim.
 *
 * Hidden, whatever the path and whoever asked:
 * - the value under a credential name, and under a json setting - the kind validateEnvEntry
 *   already refuses to echo, because a gateway's auth field goes there;
 * - a URL's userinfo, query and fragment, in the base URL and in any env value;
 * - a command key source's command line, which can carry a vault path, a token argument or
 *   the key itself. The dashboard hid it and `config --show` did not; it is hidden on both,
 *   because `--json` output ends up in pipes, logs and agents like any other;
 * - an env key source's name when it is not a name, which is how a hand-edited profiles.json
 *   carries a key in that slot;
 * - any field the registry has no name for.
 *
 * The exceptions are the paths whose job is the values themselves: `_shell-env`, which hands
 * them to the tool, and `config --edit`, whose file has to round-trip them.
 */

export { describeSecretSource, HIDDEN, redactSecretSource };

const CREDENTIAL_ENV_KEY_SET = new Set<string>(CREDENTIAL_ENV_KEYS);

/** A name whose value is a credential: the variables Claude Code takes one from. */
export function isCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_ENV_KEY_SET.has(key);
}

/** A name whose value is never printed, in part or whole. */
function hidesValue(key: string): boolean {
  return isCredentialEnvKey(key) || catalogEntry(key)?.kind === "json";
}

/** The names `redactEnv` hides the whole value of, in the map's order. */
export function hiddenEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter(hidesValue);
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      hidesValue(key) || typeof value !== "string" ? HIDDEN : redactUrlsIn(value),
    ]),
  );
}

/**
 * The profile, built from the fields the registry defines rather than spread: a field added
 * to profiles.json by hand is not one clausona can vouch for. Never mutates its argument.
 */
export function redactProfile(profile: Profile): Profile {
  return {
    tool: profile.tool,
    kind: profile.kind,
    configDir: profile.configDir,
    email: profile.email,
    label: profile.label,
    orgName: profile.orgName,
    isPrimary: profile.isPrimary,
    mergeSessions: profile.mergeSessions,
    api: profile.api && {
      baseUrl: redactBaseUrl(profile.api.baseUrl),
      authScheme: profile.api.authScheme,
      secret: redactSecretSource(profile.api.secret),
    },
    env: profile.env && redactEnv(profile.env),
  };
}
