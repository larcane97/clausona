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
 * Every caller clears this directory with a recursive rm at some point, so it must be a
 * directory of its own under the tool's backups - never the tool's directory itself and
 * never anything above it. Names are checked when a profile is created, but a registry
 * written before that check can still hold `..` or `.`, and this is the one place every
 * backup path passes through.
 */
export function backupDirFor(clausonaDir: string, tool: ToolName, name: string): string {
  const base = path.join(clausonaDir, "backups", tool);
  const dir = path.join(base, name);
  const relative = path.relative(base, dir);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Profile name '${name}' does not map to a directory inside ${base} (it resolves to ${dir}); refusing to use it as a backup directory.`,
    );
  }
  return dir;
}
