import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Registry, ToolName } from "../types.js";

// The registry path is resolved from homedir() at module load, so the module graph has to
// see a temporary home. The mock is read through `currentHome`, which each case sets
// before re-importing the modules.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/**
 * Registers a primary and a `work` profile for both tools under a throwaway home. The
 * `work` config dirs exist on disk too, so even if the duplicate check were skipped, add
 * would stop at "already exists, use --from" rather than start a real login.
 */
async function setupHome() {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-addhome-"));
  temps.push(currentHome);

  const dirs = {
    claude: path.join(currentHome, ".claude"),
    claudeWork: path.join(currentHome, ".claude-work"),
    codex: path.join(currentHome, ".codex"),
    codexWork: path.join(currentHome, ".codex-work"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });

  const registry: Registry = {
    version: 2,
    primarySources: { claude: dirs.claude, codex: dirs.codex },
    activeProfiles: { claude: "claude:default", codex: "codex:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: dirs.claude, email: "a@example.com", isPrimary: true },
      "claude:work": { tool: "claude", configDir: dirs.claudeWork, email: "b@example.com" },
      "codex:default": { tool: "codex", configDir: dirs.codex, email: "c@example.com", isPrimary: true },
      "codex:work": { tool: "codex", configDir: dirs.codexWork, email: "d@example.com" },
      "claude:gw": { tool: "claude", kind: "api", configDir: path.join(currentHome, ".claude-gw"), email: "" },
    },
  };
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  vi.resetModules();
  const { runCommand } = await import("../commands.js");
  return { runCommand, dirs };
}

describe("add for a profile that is already registered", () => {
  it.each<ToolName>(["claude", "codex"])("points %s at clausona login", async (tool) => {
    const { runCommand } = await setupHome();
    await expect(runCommand("add", [`${tool}:work`])).rejects.toThrow(
      `Profile '${tool}:work' already exists. Run \`clausona login ${tool}:work\` to sign in again.`,
    );
  });

  it("points a name that differs only by case at the profile that has it", async () => {
    const { runCommand } = await setupHome();
    await expect(runCommand("add", ["claude:Work"])).rejects.toThrow(
      "Profile 'claude:work' already exists (names are compared without case). Run `clausona login claude:work` to sign in again.",
    );
  });

  // An API profile has no sign-in to redo, and `--from` asks to import a directory under the
  // name - signing the existing profile in again would do neither.
  it.each([
    ["an API profile", ["claude:gw"], "Profile 'claude:gw' already exists."],
    ["an import with --from", ["claude:work", "--from", "~/.claude-work"], "Profile 'claude:work' already exists."],
  ])("gives no sign-in hint for %s", async (_label, args, message) => {
    const { runCommand } = await setupHome();
    // The whole message, so a hint appended to it fails the case.
    await expect(runCommand("add", args)).rejects.toMatchObject({ message });
  });
});
