import { describe, expect, it } from "vitest";

import { claudeJsonPathForConfigDir, keychainServiceForConfigDir } from "./paths.js";

describe("paths", () => {
  it("uses ~/.claude.json for the primary config dir", () => {
    expect(
      claudeJsonPathForConfigDir({
        homeDir: "/Users/test",
        configDir: "/Users/test/.claude",
      }),
    ).toBe("/Users/test/.claude.json");
  });

  it("uses config-local .claude.json for custom config dirs", () => {
    expect(
      claudeJsonPathForConfigDir({
        homeDir: "/Users/test",
        configDir: "/Users/test/.claude-work",
      }),
    ).toBe("/Users/test/.claude-work/.claude.json");
  });

  it("uses the default keychain service for the primary config dir", () => {
    expect(
      keychainServiceForConfigDir({
        homeDir: "/Users/test",
        configDir: "/Users/test/.claude",
      }),
    ).toBe("Claude Code-credentials");
  });

  it("uses a hashed keychain service for custom config dirs", () => {
    expect(
      keychainServiceForConfigDir({
        homeDir: "/Users/test",
        configDir: "/Users/test/.claude-work",
      }),
    ).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
  });
});
