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

export function validateProfileName(name: string): { ok: true } | { ok: false; error: string } {
  if (PROFILE_NAME.test(name)) return { ok: true };
  return {
    ok: false,
    error: `Invalid profile name '${name}': must be non-empty, start with a letter or digit, and use only letters, digits, '.', '_' and '-'.`,
  };
}

/**
 * The name offered for an account found at `dir`: the directory's name without the
 * `.claude` or `.codex` prefix, or "profile" when nothing is left. A directory can be
 * named anything, so the result can still fail validateProfileName; whatever creates the
 * profile checks it.
 */
export function defaultProfileName(dir: string): string {
  return path.basename(dir).replace(/^\.(?:claude|codex)-?/, "") || "profile";
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
