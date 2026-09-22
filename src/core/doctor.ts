import type { DoctorIssue, Profile } from "../types.js";

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

/**
 * Where an API profile's endpoint and key source live. No command rewrites either one:
 * `config --key` changes the key, `config --edit` the env map, and the rest of the block
 * is only ever written by `add --api`.
 */
const REGISTRY_FILE = "~/.clausona/profiles.json";
const FIX_IN_REGISTRY = `fix it in ${REGISTRY_FILE} or remove and re-add the profile`;

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
  /** Absent when there is no endpoint to resolve a key for, so nothing was attempted. */
  secret?: SecretResolution;
  /** The parsed settings.json this profile reads; `{}` when it has none. */
  settings?: Record<string, unknown>;
  /** That file's path, as it should appear in a message. */
  settingsPath?: string;
  /**
   * CREDENTIAL_ENV_KEYS. Passed in rather than imported: it lives in src/lib, and core is
   * the layer lib is built on. The caller holds the one true list; this holds the rule.
   */
  credentialEnvKeys?: readonly string[];
};

/**
 * The problem with a base URL, phrased for a user, or undefined when there is none.
 *
 * The rules are `parseBaseUrl`'s, which `add --api` enforces on the way in - a profile
 * only reaches this state through a hand-edited profiles.json. They are restated here
 * rather than imported for the layering reason above, and src/core/doctor.test.ts checks
 * the two against each other so they cannot drift apart unnoticed.
 */
function baseUrlProblem(baseUrl: string): string | undefined {
  if (baseUrl.trim() === "") return `no base URL configured for this API profile - ${FIX_IN_REGISTRY}`;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `base URL '${baseUrl}' is not a valid absolute URL - ${FIX_IN_REGISTRY}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `base URL '${baseUrl}' must be http or https - ${FIX_IN_REGISTRY}`;
  }
  // Quoting this one back would print the password. `add --api` refuses a URL that
  // carries credentials for the same reason: profiles.json is not a credential store.
  if (url.username !== "" || url.password !== "") {
    return `base URL carries a username or password - put the key in the key source instead, and ${FIX_IN_REGISTRY}`;
  }
  return undefined;
}

/**
 * The health checks that apply to an API profile, and only to one.
 *
 * An API profile has no account JSON and no Claude Code Keychain item by design, so the
 * subscription checks are not run for it at all (see `doctorProfiles`); these take their
 * place. Two of the four are about a second key reaching the profile's endpoint: clearing
 * the credential variables stopped an exported key from being forwarded, but a key can
 * still arrive through the settings.json every profile shares with the primary, or sit in
 * the profile's own plain-text env map.
 *
 * Pure: the caller resolves the key and reads the settings file, so a test needs neither
 * a credential store nor a filesystem.
 */
export function evaluateApiHealth({
  id,
  profile,
  secret,
  settings = {},
  settingsPath = "settings.json",
  credentialEnvKeys = [],
}: ApiHealthInput): DoctorIssue[] {
  // `kind` is tri-state: undefined means subscription, and a subscription profile's
  // report has to stay exactly what it was.
  if (profile.kind !== "api") return [];

  const issues: DoctorIssue[] = [];

  const baseUrl = profile.api?.baseUrl ?? "";
  const urlProblem = baseUrlProblem(baseUrl);
  if (urlProblem) issues.push({ kind: "invalid_api_config", message: urlProblem });

  if (secret && !secret.ok) {
    // resolveSecret's own message, unchanged. It already names the remedy where there is
    // one ("run 'clausona config <id> --key'"), and where there is not - a secrets.json
    // that cannot be parsed - adding that remedy would send the user to a command that
    // reads the same broken file and fails the same way.
    issues.push({ kind: "missing_api_secret", message: `API key unavailable: ${secret.error.trim() || "unknown"}` });
  }

  // Never a base URL that was just reported as unusable: it can be the thing carrying a
  // password.
  const endpoint = urlProblem ? "this profile's endpoint" : baseUrl;

  const helper = settings.apiKeyHelper;
  if (typeof helper === "string" && helper.trim() !== "") {
    // Claude Code runs apiKeyHelper and sends what it prints. settings.json is a shared
    // link into the primary, so a helper written for the primary's account also runs for
    // this profile - and hands that key to whatever endpoint this profile points at.
    // The helper's own command line is not repeated: it can name the secret.
    // A warning: the profile works, and whether a second key reaching this endpoint is a
    // problem is the user's call, not doctor's.
    issues.push({
      kind: "shared_api_key_helper",
      severity: "warning",
      message: `apiKeyHelper in ${settingsPath} (shared with the primary) also runs for this profile, so the key it prints can reach ${endpoint}`,
    });
  }

  // Sorted, so two runs over the same profile read the same way.
  for (const key of Object.keys(profile.env ?? {}).sort()) {
    if (!credentialEnvKeys.includes(key)) continue;
    // Also a warning: the env map is a documented, supported place to put a value, and a
    // profile that keeps a key there runs exactly as intended.
    issues.push({
      kind: "plaintext_env_secret",
      severity: "warning",
      message: `${key} is stored in plain text in ${REGISTRY_FILE} - if it holds this profile's API key, run 'clausona config ${id} --key' instead`,
    });
  }

  return issues;
}
