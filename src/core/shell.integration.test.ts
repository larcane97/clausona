import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderPowerShellInit, renderShellInit } from "./shell.js";

const ZSH_AVAILABLE = spawnSync("which", ["zsh"]).status === 0;

// Two PowerShell cold starts running concurrently on a CI runner took 10s and 22s, so
// both the spawn budget and the surrounding test budget are sized for contention.
const POWERSHELL_SPAWN_TIMEOUT_MS = 45_000;
const POWERSHELL_TEST_TIMEOUT_MS = 60_000;
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

const describeIfPowerShell = process.platform === "win32" ? describe : describe.skip;

describeIfPowerShell("PowerShell wrapper integration", () => {
  it(
    "sets the active profile environment and preserves metacharacters in arguments",
    () => {
      const tmpDir = makeTmpDir();
      const profilesPath = path.join(tmpDir, "profiles.json");
      const claudeDir = path.join(tmpDir, ".claude");
      const workDir = path.join(tmpDir, ".claude-work");
      const binDir = path.join(tmpDir, "bin");
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
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
      writeFileSync(path.join(binDir, "clausona.cmd"), "@echo off\r\nexit /b 0\r\n");
      writeFileSync(
        path.join(binDir, "claude.cmd"),
        `@echo off\r\nnode -e "process.stdout.write(process.env.CLAUDE_CONFIG_DIR + '|' + process.argv[1])" %*\r\n`,
      );

      const escapedProfilesPath = profilesPath.replaceAll("'", "''");
      const script = renderPowerShellInit().replace(
        '$profilesPath = Join-Path $HOME ".clausona\\profiles.json"',
        `$profilesPath = '${escapedProfilesPath}'`,
      );
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `${script}\nclaude 'hello & echo INJECTED'`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
          timeout: POWERSHELL_SPAWN_TIMEOUT_MS,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${workDir}|hello & echo INJECTED`);
      rmSync(tmpDir, { recursive: true, force: true });
    },
    // Cold powershell.exe startup on a CI runner took 5.4s, over vitest's 5s default, so
    // the test was killed before it could assert. Must exceed the spawn timeout above.
    POWERSHELL_TEST_TIMEOUT_MS,
  );
});
