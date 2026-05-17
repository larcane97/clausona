import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderShellInit } from "./shell.js";

const ZSH_AVAILABLE = spawnSync("which", ["zsh"]).status === 0;
const describeIfZsh = ZSH_AVAILABLE ? describe : describe.skip;

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "clausona-shell-"));
}

function writeRegistry(profilesPath: string, profilesJson: object): void {
  writeFileSync(profilesPath, JSON.stringify(profilesJson));
}

function runZsh(script: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("zsh", ["-c", script], { encoding: "utf8", timeout: 5000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describeIfZsh("_clausona_resolve (real zsh integration)", () => {
  it("returns configDir for active non-primary profile", () => {
    const tmpDir = makeTmpDir();
    const profilesPath = path.join(tmpDir, "profiles.json");
    const claudeDir = path.join(tmpDir, ".claude");
    const workDir = path.join(tmpDir, ".claude-work");

    writeRegistry(profilesPath, {
      version: 2,
      primarySources: { claude: claudeDir },
      activeProfiles: { claude: "claude:work" },
      profiles: {
        "claude:work": {
          tool: "claude",
          configDir: workDir,
          email: "a@x",
          isPrimary: false,
        },
      },
    });

    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const script = renderShellInit().replace('"$HOME/.clausona/profiles.json"', `"${profilesPath}"`);
    const result = runZsh(`${script}\nHOME=${tmpDir} _clausona_resolve claude`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(workDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns __PRIMARY__ when active profile is primary", () => {
    const tmpDir = makeTmpDir();
    const profilesPath = path.join(tmpDir, "profiles.json");
    const claudeDir = path.join(tmpDir, ".claude");

    writeRegistry(profilesPath, {
      version: 2,
      primarySources: { claude: claudeDir },
      activeProfiles: { claude: "claude:default" },
      profiles: {
        "claude:default": {
          tool: "claude",
          configDir: claudeDir,
          email: "a@x",
          isPrimary: true,
        },
      },
    });

    mkdirSync(claudeDir, { recursive: true });

    const script = renderShellInit().replace('"$HOME/.clausona/profiles.json"', `"${profilesPath}"`);
    const result = runZsh(`${script}\nHOME=${tmpDir} _clausona_resolve claude`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("__PRIMARY__");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no active profile for tool", () => {
    const tmpDir = makeTmpDir();
    const profilesPath = path.join(tmpDir, "profiles.json");

    writeRegistry(profilesPath, {
      version: 2,
      primarySources: {},
      activeProfiles: {},
      profiles: {},
    });

    const script = renderShellInit().replace('"$HOME/.clausona/profiles.json"', `"${profilesPath}"`);
    const result = runZsh(`${script}\nHOME=${tmpDir} _clausona_resolve codex`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not break under zsh history-expansion (regression for T23)", () => {
    // If '!' chars in the node script triggered history expansion, the function
    // would error or return empty. Verify it works with realistic data.
    const tmpDir = makeTmpDir();
    const profilesPath = path.join(tmpDir, "profiles.json");
    const codexDir = path.join(tmpDir, ".codex");
    const codexWorkDir = path.join(tmpDir, ".codex-work");

    writeRegistry(profilesPath, {
      version: 2,
      primarySources: { codex: codexDir },
      activeProfiles: { codex: "codex:work" },
      profiles: {
        "codex:work": {
          tool: "codex",
          configDir: codexWorkDir,
          email: "user@example.com",
          isPrimary: false,
        },
      },
    });

    mkdirSync(codexDir, { recursive: true });
    mkdirSync(codexWorkDir, { recursive: true });

    const script = renderShellInit().replace('"$HOME/.clausona/profiles.json"', `"${profilesPath}"`);
    const result = runZsh(`${script}\nHOME=${tmpDir} _clausona_resolve codex`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(codexWorkDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
