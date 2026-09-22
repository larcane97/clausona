import path from "node:path";

import { ALL_TOOLS } from "../tools/registry.js";
import type { Registry, ToolName } from "../types.js";

export type ParsedProfileRef = { tool: ToolName; name: string; id: string };

export function profileId(tool: ToolName, name: string): string {
  return `${tool}:${name}`;
}

/**
 * The names a new profile may take. A name becomes a path segment - `~/.claude-<name>`
 * and the backup directory `~/.clausona/backups/<tool>/<name>`, which both add paths
 * clear before use - so `..` would point that clear at every backup clausona holds and
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
  const name = path.basename(dir).replace(/^\.(?:claude|codex)-?/, "");
  if (validateProfileName(name).ok) return name;
  const fitted = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
  return fitted || "profile";
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
