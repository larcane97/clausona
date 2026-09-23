import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { describeSecretSource, redactSecretSource } from "../core/key-source.js";
import { catalogEntry } from "../tools/claude-env-catalog.js";
import type { Profile, ShownKind } from "../types.js";
import {
  envMapOf,
  isCredentialEnvKey,
  isEnvMap,
  isSecretEnvName,
  printable,
  shownEnvName,
  shownKind,
  shownLabel,
} from "./profile-env.js";

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
 * - a name in the env map that is shaped like an API key, and its value;
 * - a value shaped like an API key under any name, and a label shaped like one;
 * - a URL's userinfo, query and fragment, in the base URL and in any env value;
 * - a command key source's command line, which can carry a vault path, a token argument or
 *   the key itself. The dashboard hid it and `config --show` did not; it is hidden on both,
 *   because `--json` output ends up in pipes, logs and agents like any other;
 * - an env key source's name when it is not a name, which is how a hand-edited profiles.json
 *   carries a key in that slot;
 * - any field the registry has no name for;
 * - a control character in the kind, the label or the auth scheme, which a hand edit can use
 *   to drive the terminal.
 *
 * The exceptions are the paths whose job is the values themselves: `_shell-env`, which hands
 * them to the tool, and `config --edit`, whose file has to round-trip them.
 */

export { describeSecretSource, HIDDEN, isCredentialEnvKey, redactSecretSource };

/**
 * A name whose value is never printed, in part or whole: any name that says it holds a
 * secret (`isSecretEnvName`, which is wider than the clear list), and a json setting. The API
 * form draws these masked for the same reason, so a value is on screen exactly where it would
 * be in `config --show`.
 */
export function hidesEnvValue(key: string): boolean {
  return isSecretEnvName(key) || catalogEntry(key)?.kind === "json" || shownEnvName(key) !== key;
}

/**
 * Whether a value is hidden whole under any name: one shaped like a key - `--model "$KEY"`
 * stored before `checkModelEntry` refused one - by the rule the API form masks a field by.
 */
function keyShapedValue(value: unknown): boolean {
  return typeof value === "string" && carriesCredentialToken(value);
}

/**
 * Whether `redactEnv` hides a value whole: by its name, or because it is not a string - a
 * hand edit's number, which launch drops and doctor reports - or is shaped like a key, as
 * stored or once its control characters are gone, which is how it would be printed.
 */
function hidesWholeValue(key: string, value: unknown): boolean {
  return hidesEnvValue(key) || typeof value !== "string" || keyShapedValue(value) || keyShapedValue(printable(value));
}

/**
 * The names `redactEnv` hides the whole value of, in the map's order and as it prints them. None
 * for a map that is not one.
 */
export function hiddenEnvKeys(env: Record<string, string>): string[] {
  return isEnvMap(env)
    ? [
        ...new Set(
          Object.keys(env)
            .filter((key) => hidesWholeValue(key, env[key]))
            .map(shownEnvName),
        ),
      ]
    : [];
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      shownEnvName(key),
      // Without control characters, like the label: `--set X=$'\e[2J'` must not clear the
      // screen of whoever runs `config --show`.
      hidesWholeValue(key, value) ? HIDDEN : redactUrlsIn(printable(value)),
    ]),
  );
}

/**
 * The profile, built from the fields the registry defines rather than spread: a field added
 * to profiles.json by hand is not one clausona can vouch for. Never mutates its argument.
 */
export function redactProfile(profile: Profile): Omit<Profile, "kind"> & { kind?: ShownKind } {
  return {
    tool: profile.tool,
    kind: shownKind(profile.kind),
    configDir: profile.configDir,
    email: profile.email,
    label: shownLabel(profile.label),
    orgName: profile.orgName,
    isPrimary: profile.isPrimary,
    mergeSessions: profile.mergeSessions,
    api: profile.api && {
      baseUrl: redactBaseUrl(profile.api.baseUrl),
      authScheme: printable(profile.api.authScheme),
      secret: redactSecretSource(profile.api.secret),
    },
    env: profile.env === undefined ? undefined : redactEnvMap(profile.env),
  };
}

/**
 * An env map that is not a map is hidden whole: its content is not settings, and there is no
 * key to print a name under. doctor says so, with the command that fixes it. `null` and `[]`
 * apply what `{}` does, and print as it does.
 */
function redactEnvMap(env: unknown): Record<string, string> {
  const map = envMapOf(env);
  return map === undefined ? (HIDDEN as unknown as Record<string, string>) : redactEnv(map);
}
