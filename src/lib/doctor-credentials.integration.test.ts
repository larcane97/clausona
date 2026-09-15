import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, Registry } from "../types.js";

// doctorProfiles resolves ~/.clausona/profiles.json at module load, so the whole module
// graph has to see a temporary home. The mock is read through `currentHome`, which each
// case sets before re-importing the module.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.resetModules();
});

const realPlatform = process.platform;

type Options = {
  platform: NodeJS.Platform;
  /** Contents of the profile's .credentials.json, or null to leave the profile without one. */
  credential: string | null;
};

/**
 * Builds a two-profile registry under a throwaway home and runs the real doctorProfiles
 * against it. Both profiles get a valid .claude.json so the only issues that can surface
 * are credential ones.
 */
async function runDoctor({ platform, credential }: Options): Promise<DoctorProfileResult[]> {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-doctorhome-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });
  mkdirSync(primary, { recursive: true });
  mkdirSync(work, { recursive: true });

  const account = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });
  writeFileSync(path.join(currentHome, ".claude.json"), account("primary@example.com"));
  writeFileSync(path.join(work, ".claude.json"), account("work@example.com"));
  // The primary always has a credential; only the secondary varies.
  writeFileSync(path.join(primary, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "P" } }));
  if (credential !== null) writeFileSync(path.join(work, ".credentials.json"), credential);

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

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  const { doctorProfiles } = await import("./service.js");
  return doctorProfiles();
}

function kinds(results: DoctorProfileResult[], name: string): string[] {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues.map((issue) => issue.kind);
}

const WITH_TOKEN = JSON.stringify({ claudeAiOauth: { accessToken: "W" } });

describe("doctorProfiles credential check off macOS", () => {
  it("does not report a Keychain issue for a profile that has its credential file", async () => {
    const results = await runDoctor({ platform: "linux", credential: WITH_TOKEN });

    // The Keychain does not exist here, so probing it can only ever produce a finding
    // no user can act on.
    expect(kinds(results, "claude:work")).not.toContain("missing_keychain");
    expect(kinds(results, "claude:default")).not.toContain("missing_keychain");
  });

  it("does not report a Keychain issue on Windows either", async () => {
    const results = await runDoctor({ platform: "win32", credential: WITH_TOKEN });

    expect(kinds(results, "claude:work")).not.toContain("missing_keychain");
  });

  it("reports the profile that has no credential file", async () => {
    const results = await runDoctor({ platform: "linux", credential: null });

    expect(kinds(results, "claude:work")).toContain("missing_oauth");
    // The primary has one, so it stays quiet — the finding tracks the credential, not
    // the platform.
    expect(kinds(results, "claude:default")).not.toContain("missing_oauth");
  });

  it("reports a credential file that carries no access token", async () => {
    const results = await runDoctor({ platform: "linux", credential: JSON.stringify({ claudeAiOauth: {} }) });

    expect(kinds(results, "claude:work")).toContain("missing_oauth");
  });

  it("stays silent when every profile has a credential", async () => {
    const results = await runDoctor({ platform: "linux", credential: WITH_TOKEN });

    expect(kinds(results, "claude:work")).not.toContain("missing_oauth");
    expect(kinds(results, "claude:default")).not.toContain("missing_oauth");
  });
});

describe("doctorProfiles credential check on macOS", () => {
  it("still probes the Keychain rather than the credential file", async () => {
    // A .credentials.json is present, but on macOS the tokens live in the Keychain and
    // the temporary profile has no Keychain item, so the Keychain finding must win.
    const results = await runDoctor({ platform: "darwin", credential: WITH_TOKEN });

    expect(kinds(results, "claude:work")).toContain("missing_keychain");
    expect(kinds(results, "claude:work")).not.toContain("missing_oauth");
  });
});
