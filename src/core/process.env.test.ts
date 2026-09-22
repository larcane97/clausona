import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What a spawned child is handed as its environment, on every platform branch. The real
 * child_process is replaced by a recorder, and the platform is injected, so the Windows
 * shim path - which cannot run on this machine - is exercised on every OS.
 *
 * `clausona run` hands the tool an environment with a parent's credentials deliberately
 * removed, so an explicit `env` has to replace the child's environment, exactly as Node's
 * own `env` option does, rather than being merged back over process.env.
 */

type Recorded = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined };

const temps: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadWithRecorder() {
  const calls: Recorded[] = [];
  vi.resetModules();
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const record = (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
    };
    return {
      ...actual,
      spawnSync: (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        record(command, args, options);
        return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null };
      },
      spawn: (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        record(command, args, options);
        return { on: () => undefined };
      },
    };
  });
  const processModule = await import("./process.js");
  return { calls, ...processModule };
}

/** A PATH directory holding `<name><extension>`, as an npm or native install leaves it. */
function binWith(fileName: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-process-env-"));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), "");
  return dir;
}

describe("spawnCommandSync / spawnCommand environment", () => {
  // The variable only clausona's own process has: if the child sees it, the given env was
  // merged back over process.env instead of replacing it.
  const PARENT_ONLY = "CLAUSONA_TEST_PARENT_ONLY";

  for (const shim of ["claude.cmd", "claude.bat", "claude.ps1"]) {
    it(`hands a Windows ${shim} shim exactly the env it was given, plus the shim's own two`, async () => {
      vi.stubEnv(PARENT_ONLY, "sk-ant-parent-sentinel");
      const { calls, spawnCommandSync, spawnCommand } = await loadWithRecorder();
      const given = { PATH: binWith(shim), ANTHROPIC_AUTH_TOKEN: "sk-or-profile-token" };

      spawnCommandSync("claude", ["--version"], { env: given }, "win32");
      spawnCommand("claude", ["--version"], { env: given }, "win32");

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.command).toMatch(/powershell\.exe$/);
        expect(call.env).not.toHaveProperty(PARENT_ONLY);
        expect(call.env).toEqual({
          ...given,
          CLAUSONA_COMMAND_PATH: path.join(given.PATH, shim),
          CLAUSONA_COMMAND_ARGS: JSON.stringify(["--version"]),
        });
      }
    });
  }

  it("hands a Windows executable, and any POSIX command, exactly the env it was given", async () => {
    vi.stubEnv(PARENT_ONLY, "sk-ant-parent-sentinel");
    const { calls, spawnCommandSync } = await loadWithRecorder();
    const given = { PATH: binWith("claude.exe"), ANTHROPIC_AUTH_TOKEN: "sk-or-profile-token" };

    spawnCommandSync("claude", [], { env: given }, "win32");
    spawnCommandSync("claude", [], { env: given }, "linux");

    expect(calls.map((call) => call.env)).toEqual([given, given]);
  });

  it("still gives the shim clausona's own environment when the caller passes none", async () => {
    const bin = binWith("claude.cmd");
    vi.stubEnv("PATH", bin);
    vi.stubEnv(PARENT_ONLY, "inherited");
    const { calls, spawnCommandSync } = await loadWithRecorder();

    spawnCommandSync("claude", [], {}, "win32");

    expect(calls[0]?.env?.[PARENT_ONLY]).toBe("inherited");
    expect(calls[0]?.env?.CLAUSONA_COMMAND_PATH).toBe(path.join(bin, "claude.cmd"));
  });
});
