import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `clausona run <profile>` end to end, down to the environment the spawned tool receives.
 *
 * Asserting on resolveProfileEnv's return value is not enough: on Windows an npm install
 * puts `claude.cmd` on PATH, the spawn goes through a PowerShell shim, and the shim path
 * used to merge clausona's own process.env back in - returning every credential the
 * profile had just cleared. So child_process is replaced by a recorder and the platform is
 * injected, which runs the Windows shim path on every OS.
 *
 * Seams: HOME is stubbed and the module graph re-imported (as in commands.shell-env.test),
 * the profile's key comes from an env-source secret (no credential store is touched), and
 * every spawn is recorded rather than run.
 */

type Recorded = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined };

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SENTINELS = {
  ANTHROPIC_API_KEY: "sk-ant-parent-sentinel-KEY",
  ANTHROPIC_AUTH_TOKEN: "sk-ant-parent-sentinel-TOK",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-parent-sentinel-OAT",
  ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-ant-parent-sentinel-HDR",
  CLAUDE_CODE_USE_BEDROCK: "1",
};

async function harness(secretResolves: boolean) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-run-"));
  temps.push(home);
  const workDir = path.join(home, ".claude-glm");
  const bin = path.join(home, "bin");
  for (const dir of [path.join(home, ".clausona"), path.join(home, ".claude"), workDir, bin]) {
    mkdirSync(dir, { recursive: true });
  }
  // What `npm install -g` leaves on a Windows PATH.
  writeFileSync(path.join(bin, "claude.cmd"), "");
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { claude: path.join(home, ".claude") },
      activeProfiles: { claude: "claude:glm" },
      profiles: {
        "claude:glm": {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "router",
          api: {
            baseUrl: "https://openrouter.ai/api",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_PROFILE_SECRET" },
          },
        },
      },
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  for (const [key, value] of Object.entries(SENTINELS)) vi.stubEnv(key, value);
  vi.stubEnv("CLAUSONA_TEST_PROFILE_SECRET", secretResolves ? "sk-or-profile-token" : "");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

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
        return { status: 7, stdout: null, stderr: null, pid: 0, output: [], signal: null };
      },
      spawn: (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
        record(command, args, options);
        throw new Error(`unexpected async spawn of ${command}`);
      },
    };
  });
  const { runProfile } = await import("./index.js");
  return { home, bin, workDir, calls, runProfile };
}

describe("clausona run", () => {
  for (const platform of ["win32", "linux"] as const) {
    for (const secretResolves of [true, false]) {
      it(`hands the tool no inherited credential on ${platform}, key ${secretResolves ? "resolved" : "unresolved"}`, async () => {
        const h = await harness(secretResolves);

        const exitCode = await h.runProfile("claude:glm", ["--version"], platform);

        expect(exitCode).toBe(7);
        expect(h.calls).toHaveLength(1);
        const [call] = h.calls;
        if (platform === "win32") {
          // The npm shim path: PowerShell runs claude.cmd for us.
          expect(call?.command).toMatch(/powershell\.exe$/);
          expect(call?.env?.CLAUSONA_COMMAND_PATH).toBe(path.join(h.bin, "claude.cmd"));
        } else {
          expect(call?.command).toBe("claude");
        }
        const env = call?.env ?? {};
        for (const key of Object.keys(SENTINELS)) {
          expect(
            Object.keys(env).filter((name) => name.toUpperCase() === key),
            key,
          ).toEqual(secretResolves && key === "ANTHROPIC_AUTH_TOKEN" ? ["ANTHROPIC_AUTH_TOKEN"] : []);
        }
        for (const value of Object.values(SENTINELS).filter((v) => v !== "1")) {
          expect(Object.values(env)).not.toContain(value);
        }
        expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
        expect(env.CLAUDE_CONFIG_DIR).toBe(h.workDir);
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(secretResolves ? "sk-or-profile-token" : undefined);
        // Everything else the tool needs still arrives.
        expect(env.PATH ?? env.Path).toContain(h.bin);
        expect(env.HOME).toBe(h.home);
      });
    }
  }
});
