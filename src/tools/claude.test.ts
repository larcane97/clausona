import { describe, expect, it } from "vitest";

import { claudeAdapter } from "./claude.js";

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
