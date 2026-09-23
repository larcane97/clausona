import path from "node:path";
import { describe, expect, it } from "vitest";

import { claudeAdapter, claudeLoginEnv } from "./claude.js";

/** Entries a child would actually receive for the variable, in any spelling. */
function configDirEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env).filter(
    (entry): entry is [string, string] => entry[0].toUpperCase() === "CLAUDE_CONFIG_DIR" && entry[1] !== undefined,
  );
}

describe("claudeLoginEnv", () => {
  const homeDir = "/h";
  const primary = path.join(homeDir, ".claude");
  const work = path.join(homeDir, ".claude-work");

  it("drops an inherited CLAUDE_CONFIG_DIR in any spelling for the default dir on Windows", () => {
    // Windows treats variable names case-insensitively, and Node passes the first
    // spelling it finds, so clearing only the upper-case key would let this one through.
    const env = claudeLoginEnv(primary, { homeDir, env: { claude_config_dir: work, PATH: "p" }, platform: "win32" });

    expect(configDirEntries(env)).toEqual([]);
    expect(env.PATH).toBe("p");
  });

  it("replaces an inherited CLAUDE_CONFIG_DIR in any spelling for another dir on Windows", () => {
    const other = path.join(homeDir, ".claude-other");
    const env = claudeLoginEnv(other, { homeDir, env: { Claude_Config_Dir: work }, platform: "win32" });

    expect(configDirEntries(env)).toEqual([["CLAUDE_CONFIG_DIR", other]]);
  });

  it("leaves a differently spelled variable alone where names are case-sensitive", () => {
    const env = claudeLoginEnv(primary, { homeDir, env: { claude_config_dir: work }, platform: "linux" });

    expect(env.claude_config_dir).toBe(work);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("claudeAdapter.sharedSkipSet", () => {
  it("isolates the OAuth credential file regardless of session mode", () => {
    // Claude Code keeps the tokens in the Keychain on macOS, but everywhere else it
    // writes them to $CLAUDE_CONFIG_DIR/.credentials.json. Sharing that file makes every
    // profile authenticate as the primary account.
    expect(claudeAdapter.sharedSkipSet(false).has(".credentials.json")).toBe(true);
    expect(claudeAdapter.sharedSkipSet(true).has(".credentials.json")).toBe(true);
  });

  it("isolates per-account config regardless of session mode", () => {
    expect(claudeAdapter.sharedSkipSet(false).has(".claude.json")).toBe(true);
    expect(claudeAdapter.sharedSkipSet(true).has(".claude.json")).toBe(true);
  });

  it("isolates session-keyed state when sessions are separated", () => {
    const skip = claudeAdapter.sharedSkipSet(false);
    for (const name of ["projects", "jobs", "teams"]) {
      expect(skip.has(name), `expected skip.has("${name}") to be true`).toBe(true);
    }
  });

  it("shares session-keyed state when sessions are merged", () => {
    const skip = claudeAdapter.sharedSkipSet(true);
    for (const name of ["projects", "jobs", "teams"]) {
      expect(skip.has(name), `expected skip.has("${name}") to be false`).toBe(false);
    }
  });
});
