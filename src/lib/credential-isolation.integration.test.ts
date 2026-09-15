import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateSymlinkHealth } from "../core/doctor.js";
import { claudeAdapter } from "../tools/claude.js";
import { setupSharedLinks } from "./service.js";

const temps: string[] = [];
function scratch(label: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `clausona-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CREDENTIALS = ".credentials.json";

/**
 * Builds the non-macOS layout: Claude Code writes the OAuth tokens as a plain file next
 * to the config, so the primary config dir holds a .credentials.json that the shared-link
 * pass will walk over.
 */
function seedPair() {
  const root = scratch("credentials");
  const primary = path.join(root, ".claude");
  const profile = path.join(root, ".claude-work");
  mkdirSync(path.join(primary, "projects"), { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(primary, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: "PRIMARY" } }), {
    mode: 0o600,
  });
  return { primary, profile };
}

describe("setupSharedLinks credential isolation", () => {
  it("never links the primary credential into a profile", async () => {
    const { primary, profile } = seedPair();

    await setupSharedLinks(claudeAdapter, profile, primary, true);

    expect(existsSync(path.join(profile, CREDENTIALS))).toBe(false);
    // Sharing is otherwise unaffected.
    expect(lstatSync(path.join(profile, "projects")).isSymbolicLink()).toBe(true);
  });

  it("never links the primary credential when sessions are separated", async () => {
    const { primary, profile } = seedPair();

    await setupSharedLinks(claudeAdapter, profile, primary, false);

    expect(existsSync(path.join(profile, CREDENTIALS))).toBe(false);
  });

  it("removes a credential symlink left by an older version", async () => {
    const { primary, profile } = seedPair();
    // What every profile created before this fix looks like on Linux.
    symlinkSync(path.join(primary, CREDENTIALS), path.join(profile, CREDENTIALS));

    await setupSharedLinks(claudeAdapter, profile, primary, true);

    expect(existsSync(path.join(profile, CREDENTIALS))).toBe(false);
    // Unlinking must not touch the account the link pointed at.
    expect(JSON.parse(readFileSync(path.join(primary, CREDENTIALS), "utf8")).claudeAiOauth.accessToken).toBe("PRIMARY");
  });

  it("leaves a profile's own credential in place", async () => {
    const { primary, profile } = seedPair();
    writeFileSync(path.join(profile, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: "SECONDARY" } }), {
      mode: 0o600,
    });

    await setupSharedLinks(claudeAdapter, profile, primary, true);

    const target = path.join(profile, CREDENTIALS);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(target, "utf8")).claudeAiOauth.accessToken).toBe("SECONDARY");
  });

  it("does not link a credential a profile never had when the primary has none (macOS)", async () => {
    const root = scratch("credentials-keychain");
    const primary = path.join(root, ".claude");
    const profile = path.join(root, ".claude-work");
    mkdirSync(path.join(primary, "projects"), { recursive: true });
    mkdirSync(profile, { recursive: true });

    await setupSharedLinks(claudeAdapter, profile, primary, true);

    expect(existsSync(path.join(profile, CREDENTIALS))).toBe(false);
  });
});

describe("doctor credential reporting", () => {
  it("reports a credential symlinked to primary as a stale symlink", () => {
    // Mirrors what doctorProfiles pushes for a skip-set entry that is linked anyway.
    const { primary, profile } = seedPair();
    symlinkSync(path.join(primary, CREDENTIALS), path.join(profile, CREDENTIALS));

    const linkTarget = readlinkSync(path.join(profile, CREDENTIALS));
    const skipped = claudeAdapter.sharedSkipSet(true).has(CREDENTIALS);

    expect(skipped).toBe(true);
    expect(linkTarget).toBe(path.join(primary, CREDENTIALS));
  });

  it("does not report a profile's own credential as a local override", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      // A skipped entry never reaches evaluateSymlinkHealth, so an isolated credential
      // must not produce an issue.
      items: [],
    });

    expect(issues).toEqual([]);
  });
});
