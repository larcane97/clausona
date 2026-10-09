import path from "node:path";

/**
 * Where clausona keeps what the extension writes leave behind, and where the tools keep the
 * files those writes change. Pure: it names paths and reads nothing.
 */

export function clausonaDir(homeDir: string): string {
  return path.join(homeDir, ".clausona");
}

/** What clausona takes out of a tool's file to turn it off everywhere, one file per entry. */
export function stashDir(homeDir: string): string {
  return path.join(clausonaDir(homeDir), "extensions", "stash");
}

/** One folder per write, holding each touched file as it was and a manifest, for undo. */
export function backupRoot(homeDir: string): string {
  return path.join(clausonaDir(homeDir), "backups", "extensions");
}

/** A project's own Claude Code settings, not shared with the repo. */
export function localSettingsFile(project: string): string {
  return path.join(project, ".claude", "settings.local.json");
}

/** A project's Claude Code settings, shared with the repo. */
export function projectSettingsFile(project: string): string {
  return path.join(project, ".claude", "settings.json");
}

export function codexProjectConfig(project: string): string {
  return path.join(project, ".codex", "config.toml");
}

export function codexProjectHooks(project: string): string {
  return path.join(project, ".codex", "hooks.json");
}

/** Whether `file` is an account's `.claude.json`, which holds an entry per project wherever it is. */
export function isClaudeJson(file: string): boolean {
  return path.basename(file) === ".claude.json";
}
