import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, Registry } from "../types.js";

// doctorProfiles and repairProfile resolve ~/.clausona at module load, so the whole
// module graph has to see a temporary home. The mock is read through `currentHome`,
// which each case sets before re-importing the module.
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

const STATE_FILES = [".last-update-result.json", "gh-pr-status-cache.json", ".session-stats.json"];

/**
 * Builds a primary and one secondary Claude profile under a throwaway home, with the
 * primary holding its own copy of each state file. Both profiles have an account and a
 * credential file, and the platform is pinned to Linux so doctor reads that file instead
 * of probing the Keychain — the only findings left are about links.
 */
async function seedHome() {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-statehome-"));
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
  for (const name of STATE_FILES) writeFileSync(path.join(primary, name), JSON.stringify({ owner: "primary" }));

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
  return { primary, work, service };
}

function issuesFor(results: DoctorProfileResult[], name: string) {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues;
}

const lstatOrNull = (p: string) => lstatSync(p, { throwIfNoEntry: false }) ?? null;

describe("per-dir Claude state files", () => {
  it("are not reported when a profile keeps its own copies", async () => {
    const { work, service } = await seedHome();
    // What each writer leaves behind: a regular file where the shared link was.
    for (const name of STATE_FILES) writeFileSync(path.join(work, name), JSON.stringify({ owner: "work" }));

    const results = await service.doctorProfiles();

    expect(issuesFor(results, "claude:work")).toEqual([]);
  });

  it("lose a link to the primary's copy left from before on repair", async () => {
    const { primary, work, service } = await seedHome();
    // A profile linked before these files were skipped, whose own writer has not run yet.
    for (const name of STATE_FILES) symlinkSync(path.join(primary, name), path.join(work, name));

    // stale_symlink is a finding doctor points at `clausona repair`.
    const before = issuesFor(await service.doctorProfiles(), "claude:work");
    expect(before.map((issue) => issue.kind)).toEqual(STATE_FILES.map(() => "stale_symlink"));

    await service.repairProfile("claude:work");

    for (const name of STATE_FILES) {
      expect(lstatOrNull(path.join(work, name)), name).toBeNull();
      // Unlinking must not touch the copy the link pointed at.
      expect(JSON.parse(readFileSync(path.join(primary, name), "utf8")).owner).toBe("primary");
    }
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("lose a leftover link on repair even when the primary no longer has the file", async () => {
    const { primary, work, service } = await seedHome();
    const name = ".session-stats.json";
    symlinkSync(path.join(primary, name), path.join(work, name));
    rmSync(path.join(primary, name));

    const before = issuesFor(await service.doctorProfiles(), "claude:work");
    expect(before.map((issue) => issue.kind)).toEqual(["stale_symlink"]);

    await service.repairProfile("claude:work");

    expect(lstatOrNull(path.join(work, name))).toBeNull();
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });
});
