import crypto from "node:crypto";
import path from "node:path";

import type { ToolName } from "../types.js";

/**
 * Claude Code picks its account file and Keychain item by whether CLAUDE_CONFIG_DIR is
 * set, not by its value: set even to ~/.claude, it uses $CLAUDE_CONFIG_DIR/.claude.json
 * and a hashed Keychain item. clausona reads the dir this returns true for from the
 * unset-variable stores, so signing in to it must leave the variable unset too.
 */
export function isDefaultClaudeConfigDir(homeDir: string, configDir: string): boolean {
  return configDir === path.join(homeDir, ".claude");
}

export function claudeJsonPathForConfigDir({ homeDir, configDir }: { homeDir: string; configDir: string }): string {
  if (isDefaultClaudeConfigDir(homeDir, configDir)) {
    return path.join(homeDir, ".claude.json");
  }

  return path.join(configDir, ".claude.json");
}

export function keychainServiceForConfigDir({ homeDir, configDir }: { homeDir: string; configDir: string }): string {
  if (isDefaultClaudeConfigDir(homeDir, configDir)) {
    return "Claude Code-credentials";
  }

  const hash = crypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);

  return `Claude Code-credentials-${hash}`;
}

export function backupDirFor(clausonaDir: string, tool: ToolName, name: string): string {
  return path.join(clausonaDir, "backups", tool, name);
}
