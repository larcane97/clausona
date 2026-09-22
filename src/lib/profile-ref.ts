import path from "node:path";

import { ALL_TOOLS } from "../tools/registry.js";
import type { DiscoveredAccount, Registry, ToolName } from "../types.js";

export type ParsedProfileRef = { tool: ToolName; name: string; id: string };

export function profileId(tool: ToolName, name: string): string {
  return `${tool}:${name}`;
}

/**
 * The names a new profile may take. A name becomes a path segment - `~/.claude-<name>`
 * and the backup directory `~/.clausona/backups/<tool>/<name>`, which removing the
 * profile clears - so `..` would point that clear at every backup clausona holds and
 * `.` at every one for the tool. An allowlist rules out the whole class (dot segments,
 * separators, `:`, whitespace) rather than enumerating the dangerous names.
 *
 * Checked at creation only: profiles registered before this rule keep working.
 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The form in which two names are compared. A case-insensitive filesystem (macOS and Windows
 * by default) treats `Work` and `work` as one directory, and APFS folds more than ASCII
 * case - `ſ` (U+017F) is `s` to it - which NFKC normalization covers.
 */
export function foldProfileName(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

export function validateProfileName(name: string): { ok: true } | { ok: false; error: string } {
  // RegExp#test stringifies its argument, and "undefined" would pass.
  if (typeof name === "string" && PROFILE_NAME.test(name)) return { ok: true };
  return {
    ok: false,
    error: `Invalid profile name '${name}': must be non-empty, start with a letter or digit, and use only letters, digits, '.', '_' and '-'.`,
  };
}

/**
 * The name offered for an account found at `dir`: the directory's name without the
 * `.claude` or `.codex` prefix. A directory can be named anything, but a derived name is
 * clausona's choice rather than the user's - `init --auto` has nobody to ask for another -
 * so one the rule rejects is made to fit it: each run of other characters becomes `-`, and
 * whatever cannot start a name is dropped. "profile" is what is left when nothing else is.
 */
export function defaultProfileName(dir: string): string {
  const name = directoryName(dir);
  if (validateProfileName(name).ok) return name;
  const fitted = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  return fitted || "profile";
}

function directoryName(dir: string): string {
  return path.basename(dir).replace(/^\.(?:claude|codex)-?/, "");
}

/**
 * The names init gives the accounts it found, keyed by config dir.
 *
 * A name the caller chose is kept as it is, and so is the name an account is already
 * registered under - even one from before the name rule - since renaming a profile strands
 * its backup directory and everything keyed by its id. Any other account gets "default" if
 * it is the primary, or defaultProfileName otherwise. A derived name is clausona's choice,
 * so rather than fail init over a clash it takes the first free `-2`, `-3`, ... suffix;
 * a directory that spells the name exactly keeps it ahead of one whose name was fitted.
 * Every account steers clear of an API profile's name, since init keeps those, and a
 * non-primary account of every registered name: a profile init drops still has a backup
 * directory under it.
 */
export function initProfileNames(
  accounts: DiscoveredAccount[],
  registry: Registry | null,
  chosen: Record<string, string> = {},
): Record<string, string> {
  const profiles = registry?.profiles ?? {};
  const registeredName = (account: DiscoveredAccount) => {
    const id = Object.keys(profiles).find(
      (candidate) =>
        profiles[candidate].tool === account.tool &&
        path.resolve(profiles[candidate].configDir) === path.resolve(account.configDir),
    );
    return registry && id ? parseProfileRef(id, registry).name : undefined;
  };

  const names = new Map<string, string>();
  // Init carries API profiles over as they are, so their names are taken before anything else.
  const assigned = new Set(
    Object.entries(profiles)
      .filter(([, profile]) => profile.kind === "api")
      .map(([id]) => foldProfileName(id)),
  );
  const assign = (account: DiscoveredAccount, name: string) => {
    names.set(account.configDir, name);
    assigned.add(foldProfileName(profileId(account.tool, name)));
  };
  const toDerive: DiscoveredAccount[] = [];
  for (const account of accounts) {
    const name = chosen[account.configDir] ?? registeredName(account);
    if (name === undefined) toDerive.push(account);
    else assign(account, name);
  }

  const registered = new Set(Object.keys(profiles).map(foldProfileName));
  const fitted = (account: DiscoveredAccount) =>
    !account.isPrimary && defaultProfileName(account.configDir) !== directoryName(account.configDir);
  for (const account of [...toDerive].sort((a, b) => Number(fitted(a)) - Number(fitted(b)))) {
    const base = account.isPrimary ? "default" : defaultProfileName(account.configDir);
    const taken = (name: string) => {
      const folded = foldProfileName(profileId(account.tool, name));
      return assigned.has(folded) || (!account.isPrimary && registered.has(folded));
    };
    let name = base;
    for (let n = 2; taken(name); n++) name = `${base}-${n}`;
    assign(account, name);
  }

  return Object.fromEntries(accounts.map((account) => [account.configDir, names.get(account.configDir) ?? ""]));
}

function isToolName(value: string): value is ToolName {
  return (ALL_TOOLS as string[]).includes(value);
}

export function parseProfileRef(input: string, registry: Registry): ParsedProfileRef {
  if (input.includes(":")) {
    const [maybeTool, ...rest] = input.split(":");
    const name = rest.join(":");
    if (!isToolName(maybeTool)) {
      throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
    }
    const id = profileId(maybeTool, name);
    if (!registry.profiles[id]) {
      throw new Error(`Profile '${id}' not found.`);
    }
    return { tool: maybeTool, name, id };
  }

  const candidates: ParsedProfileRef[] = [];
  for (const tool of ALL_TOOLS) {
    const id = profileId(tool, input);
    if (registry.profiles[id]) candidates.push({ tool, name: input, id });
  }
  if (candidates.length === 0) throw new Error(`Profile '${input}' not found.`);
  if (candidates.length > 1) {
    const list = candidates.map((c) => `'${c.id}'`).join(" or ");
    throw new Error(`'${input}' exists in both claude and codex. Use ${list}.`);
  }
  return candidates[0];
}
