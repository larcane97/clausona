import type { DoctorIssue, Profile } from "../types.js";
import { checkBaseUrl, redactBaseUrl } from "./api-url.js";

export function evaluateSymlinkHealth({
  isPrimary,
  items,
  missingSharedDirs = [],
}: {
  isPrimary: boolean;
  items: Array<{
    name: string;
    isSharedLink: boolean;
    pointsToPrimary: boolean;
    targetExists: boolean;
    existsInPrimary: boolean;
  }>;
  /**
   * Directories that exist in the primary config dir but are absent from this
   * profile. Shared links are only ever created from a snapshot of the primary
   * taken when the profile was set up, so anything the tool adds in a later
   * version never reaches an existing profile — the tool then creates it locally
   * and the two accounts silently stop sharing that state.
   *
   * Only directories are reported. Files in the primary are dominated by
   * transient state (`*.tmp.*`, `settings.json.bak.*`) that no profile is ever
   * expected to carry, and a file's shared link is replaced by a real file the
   * first time the tool writes it atomically — so file-level gaps are noise,
   * while a missing directory is always a real sharing gap.
   */
  missingSharedDirs?: string[];
}): DoctorIssue[] {
  if (isPrimary) {
    return [];
  }

  const issues: DoctorIssue[] = [];
  for (const item of items) {
    if (item.isSharedLink && !item.targetExists) {
      issues.push({
        kind: "broken_symlink",
        message: `${item.name} shared link points to a missing target`,
      });
    }

    // Should be a shared link to primary but isn't
    if (!item.pointsToPrimary && item.existsInPrimary) {
      issues.push({
        kind: "local_override",
        message: `${item.name} replaced an expected shared link`,
      });
    }
  }

  for (const name of missingSharedDirs) {
    issues.push({
      kind: "missing_shared_link",
      message: `${name}/ is shared in primary but missing here — run 'clausona repair'`,
    });
  }

  return issues;
}

/**
 * How many findings of each kind a list holds, with "no `severity` key" read as an error.
 *
 * The one place that rule lives. A profile is healthy when `errors` is 0 - warnings are
 * things to know about a profile that works, and a profile that works must not render as
 * broken.
 */
export function countIssues(issues: DoctorIssue[]): { errors: number; warnings: number } {
  let warnings = 0;
  for (const issue of issues) if (issue.severity === "warning") warnings += 1;
  return { errors: issues.length - warnings, warnings };
}

/** Where an API profile's endpoint, key source and env map live. */
const REGISTRY_FILE = "~/.clausona/profiles.json";

/**
 * What to run for a base URL that cannot be used. `config --base-url` rewrites it and keeps
 * the key source, but only where there is an endpoint block to rewrite: a profile marked
 * `api` with no block has no key source for `config` to keep, and `--base-url` refuses it.
 * That one is added again - under a new name, because `remove` leaves the config directory
 * in place and `add` will not reuse one. Never "edit profiles.json": a hand edit is how a
 * base URL gets broken in the first place.
 */
function baseUrlRemedy(id: string, hasEndpoint: boolean): string {
  return hasEndpoint
    ? `run 'clausona config ${id} --base-url <url>'`
    : `run 'clausona remove ${id}' and then 'clausona add <new-name> --api --base-url <url>' - remove keeps the config directory, so the old name stays taken`;
}

/**
 * What resolving a profile's key produced - whether it resolved, and if not, why.
 *
 * Never the key. doctor resolves it only to find out whether it resolves; the value is
 * read from a Keychain item, a variable or a command's stdout on every run, and nothing
 * about it - not a prefix, not a length - belongs in a report a user pastes into a bug.
 */
export type SecretResolution = { ok: true } | { ok: false; error: string };

export type ApiHealthInput = {
  id: string;
  profile: Profile;
  /** False when the profile's config directory is not there at all. */
  configDirExists?: boolean;
  /** Absent when there is no endpoint to resolve a key for, so nothing was attempted. */
  secret?: SecretResolution;
  /** The parsed settings.json this profile reads: `{}` when it has none, null when it could not be read. */
  settings?: Record<string, unknown> | null;
  /** That file's path, as it should appear in a message. */
  settingsPath?: string;
  /** Whether that file is the primary's, reached through a shared link, rather than this profile's own. */
  settingsShared?: boolean;
  /**
   * CREDENTIAL_ENV_KEYS. Passed in rather than imported: it lives in src/lib, and core is
   * the layer lib is built on. The caller holds the one true list; this holds the rule.
   */
  credentialEnvKeys?: readonly string[];
};

/**
 * The problem with a base URL, phrased for a user, or undefined when there is none.
 *
 * The rules come from `checkBaseUrl`, the same function `add --api` enforces on the way in,
 * so a URL the command would refuse cannot be reported healthy here. Only the wording is
 * local.
 *
 * Nothing in these messages repeats the URL. A hand-edited one can carry `user:password@`,
 * which is a credential like any other - and it is reported by whichever rule rejects the
 * URL first, not only by the rule that is about credentials, so no branch may quote it.
 * `doctor --help` promises this output is safe to paste into a bug report.
 */
function baseUrlProblem(baseUrl: string, remedy: string): string | undefined {
  const checked = checkBaseUrl(baseUrl);
  if (checked.ok) return undefined;
  switch (checked.problem.reason) {
    case "empty":
      return `no base URL configured for this API profile - ${remedy}`;
    case "unparseable":
      return `the base URL is not an absolute http:// or https:// URL - ${remedy}`;
    case "scheme":
      // A scheme cannot contain userinfo, so naming it gives nothing away.
      return `the base URL's scheme is '${checked.problem.scheme}', not http or https - ${remedy}`;
    case "credentials":
      return `the base URL carries a username or password - put the key in the key source instead, and ${remedy}`;
    case "key-shaped":
      return `the base URL carries something shaped like an API key - put the key in the key source instead, and ${remedy}`;
    default: {
      // A new reason would otherwise take the last case's words, which describe a different
      // URL - the way "key-shaped" briefly read as "a username or password".
      const unhandled: never = checked.problem;
      throw new Error(`unhandled base URL problem: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The health checks that apply to an API profile, and only to one.
 *
 * An API profile has no account JSON and no Claude Code Keychain item by design, so the
 * subscription checks are not run for it at all (see `doctorProfiles`); these take their
 * place. Two of them are about a second key reaching the profile's endpoint: clearing the
 * credential variables stopped an exported key from being forwarded, but a key can still
 * arrive through the settings.json a profile shares with the primary, or sit in the
 * profile's own plain-text env map.
 *
 * Pure: the caller resolves the key and reads the settings file, so a test needs neither
 * a credential store nor a filesystem.
 */
export function evaluateApiHealth({
  id,
  profile,
  configDirExists = true,
  secret,
  settings = {},
  settingsPath = "settings.json",
  settingsShared = false,
  credentialEnvKeys = [],
}: ApiHealthInput): DoctorIssue[] {
  // `kind` is tri-state: undefined means subscription, and a subscription profile's
  // report has to stay exactly what it was.
  if (profile.kind !== "api") return [];

  const issues: DoctorIssue[] = [];

  if (!configDirExists) {
    // Nothing else looks for it. The account-file check noticed in passing, and it is not
    // run for an API profile; the shared-link checks only speak when the primary holds a
    // directory this profile could be missing, so a primary that holds none left a profile
    // pointing at nothing looking healthy. `repair` cannot help - it symlinks into a
    // directory it does not create - so the remedy is to add the profile again.
    issues.push({
      kind: "missing_config_dir",
      message: `config directory ${profile.configDir} is missing - remove and re-add the profile`,
    });
  }

  const baseUrl = profile.api?.baseUrl ?? "";
  const urlProblem = baseUrlProblem(baseUrl, baseUrlRemedy(id, profile.api !== undefined));
  if (urlProblem) issues.push({ kind: "invalid_api_config", message: urlProblem });

  if (secret && !secret.ok) {
    // resolveSecret's own message, unchanged. It already names the remedy where there is
    // one ("run 'clausona config <id> --key'"), and where there is not - a secrets.json
    // that cannot be parsed - adding that remedy would send the user to a command that
    // reads the same broken file and fails the same way.
    issues.push({ kind: "missing_api_secret", message: `API key unavailable: ${secret.error.trim() || "unknown"}` });
  }

  // Never a base URL that was just reported as unusable: it can be the thing carrying a
  // password. A usable one can still carry a key in its query, so it is printed the way every
  // other path prints it.
  const endpoint = urlProblem ? "this profile's endpoint" : redactBaseUrl(baseUrl);

  if (settings === null) {
    // Falling back to an empty object hid a helper sitting in a file that does not parse:
    // a check that cannot run must say so rather than read as "nothing found here".
    issues.push({
      kind: "unreadable_settings",
      severity: "warning",
      message: `${settingsPath} could not be read, so apiKeyHelper was not checked - fix or remove it`,
    });
  } else {
    const helper = settings.apiKeyHelper;
    if (typeof helper === "string" && helper.trim() !== "") {
      // Claude Code runs apiKeyHelper and sends what it prints, and settings.json is
      // normally a shared link into the primary - so a helper written for the primary's
      // account also runs for this profile, and hands that key to whatever endpoint this
      // profile points at. The helper's own command line is not repeated: it can name the
      // secret.
      //
      // Independent of authScheme, deliberately. The scheme decides which variable clausona
      // sets, not whether the helper runs: Claude Code sends X-Api-Key and Authorization
      // together when it has both, so the helper's key reaches the endpoint either way.
      // Do not narrow this to `bearer` later.
      //
      // A warning: the profile works, and whether a second key reaching this endpoint is a
      // problem is the user's call, not doctor's.
      const where = settingsShared ? `${settingsPath} (shared with the primary)` : settingsPath;
      issues.push({
        kind: "shared_api_key_helper",
        severity: "warning",
        message: `apiKeyHelper in ${where} ${settingsShared ? "also runs" : "runs"} for this profile, so the key it prints can reach ${endpoint}`,
      });
    }
  }

  // Sorted, so two runs over the same profile read the same way.
  for (const key of Object.keys(profile.env ?? {}).sort()) {
    if (!credentialEnvKeys.includes(key)) continue;
    // Also a warning: the env map is a documented, supported place to put a value, and a
    // profile that keeps a key there runs exactly as intended.
    const remedy = plaintextEnvRemedy(id, profile.kind, key)
      .map((command) => `'${command}'`)
      .join(" and then ");
    issues.push({
      kind: "plaintext_env_secret",
      severity: "warning",
      message: `${key} is stored in plain text in ${REGISTRY_FILE} - if it holds this profile's API key, run ${remedy}`,
    });
  }

  return issues;
}

/**
 * The commands that take a credential out of a profile's plain-text env map, in the order
 * to run them. Shared by `doctor` and by the warning `config` and `add` print when the name
 * is written, so the two cannot advise different things for the same finding.
 *
 * Different per kind, because the commands that work are:
 *
 * - An API profile has a credential store, so the key moves there with `--key`. That alone
 *   is not enough: the env map is applied after the stored key, so a copy left in it is
 *   still what Claude Code is handed - and still in plain text. Hence the `--unset` too.
 * - A subscription profile signs in with its account and has no store to move a key into;
 *   `--key` refuses it. A key there is a mistake or a sign an API profile was wanted, and
 *   either way the copy in the map goes. The second reading is the caller's to point at,
 *   since it is not a step in removing this one.
 */
export function plaintextEnvRemedy(id: string, kind: Profile["kind"], key: string): string[] {
  const unset = `clausona config ${id} --unset ${key}`;
  return kind === "api" ? [`clausona config ${id} --key`, unset] : [unset];
}
