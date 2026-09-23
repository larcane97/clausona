import path from "node:path";
import { describe, expect, it } from "vitest";

import { backupDirFor, claudeJsonPathForConfigDir, keychainServiceForConfigDir } from "./paths.js";

describe("paths", () => {
  const homeDir = path.join(path.parse(process.cwd()).root, "Users", "test");

  it("uses ~/.claude.json for the primary config dir", () => {
    expect(
      claudeJsonPathForConfigDir({
        homeDir,
        configDir: path.join(homeDir, ".claude"),
      }),
    ).toBe(path.join(homeDir, ".claude.json"));
  });

  it("uses config-local .claude.json for custom config dirs", () => {
    expect(
      claudeJsonPathForConfigDir({
        homeDir,
        configDir: path.join(homeDir, ".claude-work"),
      }),
    ).toBe(path.join(homeDir, ".claude-work", ".claude.json"));
  });

  it("uses the default keychain service for the primary config dir", () => {
    expect(
      keychainServiceForConfigDir({
        homeDir,
        configDir: path.join(homeDir, ".claude"),
      }),
    ).toBe("Claude Code-credentials");
  });

  it("uses a hashed keychain service for custom config dirs", () => {
    expect(
      keychainServiceForConfigDir({
        homeDir,
        configDir: path.join(homeDir, ".claude-work"),
      }),
    ).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
  });
});

describe("backupDirFor", () => {
  it("nests by tool then name", () => {
    const clausonaDir = path.join(path.parse(process.cwd()).root, "h", ".clausona");
    expect(backupDirFor(clausonaDir, "claude", "work")).toBe(path.join(clausonaDir, "backups", "claude", "work"));
    expect(backupDirFor(clausonaDir, "codex", "personal")).toBe(path.join(clausonaDir, "backups", "codex", "personal"));
  });

  // A registry written before names were checked can still hold these, and every caller
  // eventually runs a recursive rm on the result.
  it("refuses a name that resolves to the tool's backups directory or above it", () => {
    const clausonaDir = path.join(path.parse(process.cwd()).root, "h", ".clausona");
    for (const name of ["..", ".", "", "a/../..", "a/..", "../codex", "../../x"]) {
      expect(() => backupDirFor(clausonaDir, "claude", name), JSON.stringify(name)).toThrow(
        /does not map to a directory of its own inside .*refusing to use it as a backup directory/,
      );
    }
  });

  // Inside the tool's directory is not enough: these all land in the directory `work` or `a`
  // owns, so a recursive rm meant for the legacy profile would take the other one's backup.
  it("refuses a name that normalizes to another name or nests under one", () => {
    const clausonaDir = path.join(path.parse(process.cwd()).root, "h", ".clausona");
    for (const name of ["work/", "./work", "work/.", "/work", "x/../work", "../claude/work", "a/b", "a/../b"]) {
      expect(() => backupDirFor(clausonaDir, "claude", name), JSON.stringify(name)).toThrow(
        /does not map to a directory of its own inside .*refusing to use it as a backup directory/,
      );
    }
  });

  it("tells the user how to get rid of a profile it refuses", () => {
    const clausonaDir = path.join(path.parse(process.cwd()).root, "h", ".clausona");
    expect(() => backupDirFor(clausonaDir, "claude", "..")).toThrow(
      `To recover, remove the 'claude:..' entry from ${path.join(clausonaDir, "profiles.json")} by hand.`,
    );
  });

  it("accepts a name that is one path segment directly under the tool's backups directory", () => {
    const clausonaDir = path.join(path.parse(process.cwd()).root, "h", ".clausona");
    const base = path.join(clausonaDir, "backups", "claude");
    // A leading `..` that is part of a longer segment is an ordinary name, not a parent step.
    for (const name of ["work", "Work", "..work", "glm-5.3", ".codex-work"]) {
      expect(backupDirFor(clausonaDir, "claude", name), name).toBe(path.join(base, name));
    }
  });
});
