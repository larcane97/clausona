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
});
