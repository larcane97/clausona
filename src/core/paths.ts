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

export function backupDirFor(clausonaDir: string, tool: ToolName, name: string): string {
  return path.join(clausonaDir, "backups", tool, name);
}
