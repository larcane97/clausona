import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult } from "../types.js";

/**
 * The Codex-only findings of #75, through the real service and command against a real
 * filesystem: a config directory too long for the daemon's socket, and SQLite state that
 * sqlite_home or CODEX_SQLITE_HOME puts in one place for every profile.
 *
 * HOME (and USERPROFILE, which Node reads on Windows) is a temp directory, with the module
 * graph imported again so ~/.clausona resolves into it. Nothing here signs in or spawns.
 */

const temps: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.off("exit", (await import("../core/dir-lock.js")).removeHeldDirLocks);
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(parent: string, prefix: string): string {
  const dir = mkdtempSync(path.join(parent, prefix));
  temps.push(dir);
  return dir;
}

/** A Codex config dir holding a signed-in account, as `add --from` reads it. */
function codexAccount(dir: string, accountId: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { account_id: accountId } }));
  return dir;
}

/** A temp HOME holding the Codex primary, plus whatever profiles `more` adds for that home. */
async function harness(more: (home: string, primary: string) => Record<string, unknown> = () => ({})) {
  const home = tempDir(tmpdir(), "clausona-codex-checks-");
  const primary = codexAccount(path.join(home, ".codex"), "acct-primary");
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { codex: primary },
      activeProfiles: { codex: "codex:default" },
      profiles: {
        "codex:default": { tool: "codex", configDir: primary, email: "acct-primary", isPrimary: true },
        ...more(home, primary),
      },
    }),
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // The developer's own shell may set it; each test says what it wants.
  vi.stubEnv("CODEX_SQLITE_HOME", "");
  vi.resetModules();
  return {
    home,
    service: await import("./service.js"),
    runCommand: (await import("../commands.js")).runCommand,
  };
}

function captureStderr(): () => string {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return () => writes.join("");
}

// Windows binds no Unix socket for this - the daemon uses a named pipe there - so there is
// nothing to check. The short directory is made under /tmp because the system temp dir on
// macOS (/private/var/folders/...) is already too long for the socket on its own.
describe.skipIf(process.platform === "win32")("add --from a Codex directory too long for its socket", () => {
  it("warns about a long directory and not about a short one", async () => {
    const h = await harness();
    const stderr = captureStderr();

    // sun_path fits 103 bytes on macOS and 107 on Linux, and the socket adds 38 to the path.
    const long = codexAccount(path.join(tempDir(h.home, "x"), "d".repeat(80), ".codex-long"), "acct-long");
    const short = codexAccount(path.join(tempDir("/tmp", "cs-"), "c"), "acct-short");

    await h.runCommand("add", ["codex:long", "--from", long]);
    const afterLong = stderr();
    await h.runCommand("add", ["codex:short", "--from", short]);
    const afterShort = stderr().slice(afterLong.length);

    expect(afterLong).toContain(`${long} is too long a path for Codex`);
    expect(afterLong).toContain("app-server-daemon/daemon-updater.sock");
    expect(afterShort).not.toContain("too long a path");
    // A warning, not a refusal: both were added.
    const registry = await h.service.loadRegistry();
    expect(Object.keys(registry?.profiles ?? {})).toEqual(expect.arrayContaining(["codex:long", "codex:short"]));
  });
});

describe("doctor on Codex profiles that share their SQLite state", () => {
  /** The primary and one profile whose config.toml is the primary's. */
  function twoProfiles(primaryConfig: string) {
    return harness((home, primary) => {
      writeFileSync(path.join(primary, "config.toml"), primaryConfig);
      const work = codexAccount(path.join(home, ".codex-work"), "acct-work");
      // A hard link needs no privilege on Windows, and reads as shared just as a symlink does.
      linkSync(path.join(primary, "config.toml"), path.join(work, "config.toml"));
      return { "codex:work": { tool: "codex", configDir: work, email: "acct-work" } };
    });
  }

  const sqliteFindings = (results: DoctorProfileResult[], name: string) =>
    (results.find((result) => result.name === name)?.issues ?? []).filter(
      (issue) => issue.kind === "shared_sqlite_home",
    );

  it("warns when the shared config.toml sets sqlite_home", async () => {
    const h = await twoProfiles('model = "o3"\nsqlite_home = "/srv/codex-state"  # one place\n\n[profiles.fast]\n');

    const results = await h.service.doctorProfiles();

    const [finding] = sqliteFindings(results, "codex:work");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("sqlite_home is set in");
    expect(finding?.message).toContain("(shared with the primary)");
    expect(sqliteFindings(results, "codex:default")).toHaveLength(1);
  });

  it("warns when CODEX_SQLITE_HOME is set, and says nothing when neither is", async () => {
    // Under a table, sqlite_home is not the root key Codex reads.
    const h = await twoProfiles('[profiles.fast]\nsqlite_home = "/srv/elsewhere"\n');

    expect(sqliteFindings(await h.service.doctorProfiles(), "codex:work")).toEqual([]);

    vi.stubEnv("CODEX_SQLITE_HOME", "/srv/codex-state");
    const [finding] = sqliteFindings(await h.service.doctorProfiles(), "codex:work");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("CODEX_SQLITE_HOME is set");
  });
});
