import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, Registry } from "../types.js";

// doctorProfiles and repairProfile resolve ~/.clausona at module load, so the whole module graph
// has to see a temporary home. The mock is read through `currentHome`, which each case sets
// before re-importing the module.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const realPlatform = process.platform;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.resetModules();
});

/**
 * What Claude Code 2.1.299 keeps for one account or one org in its config directory: the org's
 * policy limits and remote managed settings with every sibling it names for them, the MCP servers
 * that need this account's sign-in, its `state/` and the Claude in Chrome host it writes for the
 * directory. Directories are the ones it keeps as directories.
 */
const ACCOUNT_FILES = [
  "policy-limits.json",
  "policy-limits.json.signature.json",
  "policy-limits.json.signature-iat.json",
  "policy-limits.json.stamp.json",
  "remote-settings.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.signature-iat.json",
  "remote-settings.json.synced-at",
  "remote-settings-helper-consent",
  "remote-settings-consent.json",
  "mcp-needs-auth-cache.json",
];
const ACCOUNT_DIRS = ["state", "chrome"];
const ACCOUNT_STATE = [...ACCOUNT_FILES, ...ACCOUNT_DIRS];

/** The one file inside each directory above, holding whose it is. */
const OWNER_FILE: Record<string, string> = { state: "mcp-discover-verdicts.json", chrome: "chrome-native-host" };

/**
 * Writes `owner` into entry `name` under `dir`, as `as` (a backup's name, say): the file, or the
 * one file inside the directory.
 */
function writeOwned(dir: string, name: string, owner: string, as = name) {
  const file = OWNER_FILE[name];
  if (file) {
    mkdirSync(path.join(dir, as), { recursive: true });
    writeFileSync(path.join(dir, as, file), JSON.stringify({ owner }));
  } else {
    writeFileSync(path.join(dir, as), JSON.stringify({ owner }));
  }
}

/** Whose `name` under `dir` is. */
function ownerOf(dir: string, name: string): string {
  const file = OWNER_FILE[name];
  return JSON.parse(readFileSync(file ? path.join(dir, name, file) : path.join(dir, name), "utf8")).owner;
}

/**
 * A primary and one secondary Claude profile under a throwaway home, the primary holding its own
 * copy of each entry. Both profiles have an account and a credential file, and the platform is
 * pinned to Linux so doctor reads that file instead of probing the Keychain: the only findings
 * left are about links.
 */
async function seedHome() {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-accountstate-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });
  mkdirSync(primary, { recursive: true });
  mkdirSync(work, { recursive: true });

  const account = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });
  writeFileSync(path.join(currentHome, ".claude.json"), account("primary@example.com"));
  writeFileSync(path.join(work, ".claude.json"), account("work@example.com"));
  const credential = JSON.stringify({ claudeAiOauth: { accessToken: "T" } });
  writeFileSync(path.join(primary, ".credentials.json"), credential);
  writeFileSync(path.join(work, ".credentials.json"), credential);
  for (const name of ACCOUNT_STATE) writeOwned(primary, name, "primary");

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "work@example.com" },
    },
  };
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.resetModules();
  const service = await import("./service.js");
  const { claudeAdapter } = await import("../tools/claude.js");
  const backupDir = path.join(currentHome, ".clausona", "backups", "claude", "work");
  return { primary, work, backupDir, service, claudeAdapter };
}

function issuesFor(results: DoctorProfileResult[], name: string) {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues;
}

const lstatOrNull = (p: string) => lstatSync(p, { throwIfNoEntry: false }) ?? null;

describe("Claude Code state for one account or org", () => {
  it("is never linked into a profile, in either session mode", async () => {
    const { primary, work, backupDir, service, claudeAdapter } = await seedHome();

    for (const mergeSessions of [false, true]) {
      await service.setupSharedLinks(claudeAdapter, work, primary, mergeSessions, backupDir);
      for (const name of ACCOUNT_STATE) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
    }
  });

  it("loses a link to the primary's on repair, and the primary's copy is untouched", async () => {
    const { primary, work, service } = await seedHome();
    // A profile linked before these entries were kept apart, whose Claude Code has not yet
    // saved its own copy over the link.
    for (const name of ACCOUNT_STATE) symlinkSync(path.join(primary, name), path.join(work, name));

    // stale_symlink is a finding doctor points at `clausona repair`.
    const before = issuesFor(await service.doctorProfiles(), "claude:work");
    expect(before.map((issue) => issue.kind)).toEqual(ACCOUNT_STATE.map(() => "stale_symlink"));

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name)), name).toBeNull();
      expect(ownerOf(primary, name), name).toBe("primary");
    }
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("stays the profile's own where it has a copy, and doctor does not report it", async () => {
    const { primary, work, service } = await seedHome();
    // What Claude Code leaves where the link was: its own copy, written by a rename over it.
    for (const name of ACCOUNT_STATE) writeOwned(work, name, "work");

    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name))?.isSymbolicLink(), name).toBe(false);
      expect(ownerOf(work, name), name).toBe("work");
      expect(ownerOf(primary, name), name).toBe("primary");
    }
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("comes back on repair from the profile's own backup, never from one that is a link to the primary's", async () => {
    const { primary, work, backupDir, service } = await seedHome();
    // An earlier repair set aside the profile's own copy to put the link back, and a later one
    // set aside a link to the primary's: the newer backup holds nothing of the profile's.
    mkdirSync(backupDir, { recursive: true });
    for (const name of ACCOUNT_STATE) {
      writeOwned(backupDir, name, "work", `${name}.2026-01-01T00-00-00-000Z`);
      symlinkSync(path.join(primary, name), path.join(backupDir, `${name}.2026-02-01T00-00-00-000Z`));
      symlinkSync(path.join(primary, name), path.join(work, name));
    }

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name))?.isSymbolicLink(), name).toBe(false);
      expect(ownerOf(work, name), name).toBe("work");
    }
    // Copied, so the backups stay.
    expect(readdirSync(backupDir)).toHaveLength(ACCOUNT_STATE.length * 2);
    expect(existsSync(path.join(primary, "policy-limits.json"))).toBe(true);
  });
});

describe("temp files left from a save", () => {
  // One left in the primary on a real machine, linked into every profile from there.
  const LEFTOVER = ".session-stats.json.tmp.56475.1780981766229.1qip4a37kvx";
  const CLAUDE_CODE_LEFTOVER = "settings.json.tmp.12345.0a1b2c3d4e5f";

  it("are never linked into a profile", async () => {
    const { primary, work, backupDir, service, claudeAdapter } = await seedHome();
    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) writeFileSync(path.join(primary, name), "{}");

    await service.setupSharedLinks(claudeAdapter, work, primary, true, backupDir);

    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
  });

  it("lose a link left from before on repair, even once the primary's is gone", async () => {
    const { primary, work, service } = await seedHome();
    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) {
      writeFileSync(path.join(primary, name), "{}");
      symlinkSync(path.join(primary, name), path.join(work, name));
    }
    // Its writer, or Claude Code's cleanup, takes the primary's out in time.
    rmSync(path.join(primary, CLAUDE_CODE_LEFTOVER));

    await service.repairProfile("claude:work");

    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
    expect(readFileSync(path.join(primary, LEFTOVER), "utf8")).toBe("{}");
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("of the profile's own are left alone, and doctor does not report them", async () => {
    const { work, service } = await seedHome();
    const own = ".claude.json.tmp.78985.429da2c70baf";
    writeFileSync(path.join(work, own), "{}");

    await service.repairProfile("claude:work");

    expect(readFileSync(path.join(work, own), "utf8")).toBe("{}");
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });
});
