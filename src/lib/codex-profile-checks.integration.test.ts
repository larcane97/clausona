import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Codex-only findings of #75, through the real service and command against a real
 * filesystem: a config directory too long for the daemon's socket.
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
