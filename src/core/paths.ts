import crypto from "node:crypto";
import path from "node:path";

import type { ToolName } from "../types.js";

export function claudeJsonPathForConfigDir({ homeDir, configDir }: { homeDir: string; configDir: string }): string {
  const primary = path.join(homeDir, ".claude");
  if (configDir === primary) {
    return path.join(homeDir, ".claude.json");
  }

  return path.join(configDir, ".claude.json");
}

export function keychainServiceForConfigDir({ homeDir, configDir }: { homeDir: string; configDir: string }): string {
  const primary = path.join(homeDir, ".claude");
  if (configDir === primary) {
    return "Claude Code-credentials";
  }

  const hash = crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);

  return `Claude Code-credentials-${hash}`;
}

/**
 * Every caller clears this directory with a recursive rm at some point, so it must be this
 * profile's own: one path segment directly under the tool's backups. `..` or `.` would
 * point that rm at every backup clausona holds, and a name that normalizes to another one
 * (`work/`, `./work`, `x/../work`) or nests under it (`work/x`) at that profile's backup.
 * Names are checked when a profile is created, but a registry written before that check
 * can still hold any of these, and this is the one place every backup path passes through.
 */
export function backupDirFor(clausonaDir: string, tool: ToolName, name: string): string {
  const base = path.join(clausonaDir, "backups", tool);
  const dir = path.join(base, name);
  if (path.dirname(dir) !== base || path.basename(dir) !== name) {
    throw new Error(
      `Profile name '${name}' does not map to a directory of its own inside ${base} (it resolves to ${dir}); refusing to use it as a backup directory. To recover, remove the '${tool}:${name}' entry from ${path.join(clausonaDir, "profiles.json")} by hand.`,
    );
  }
  return dir;
}
