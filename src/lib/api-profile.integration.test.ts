import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretSource } from "../types.js";

/**
 * Drives the service functions against a real filesystem under a temp HOME.
 *
 * Two seams keep this away from the machine running it:
 *
 * - HOME. service.ts, secrets.ts and track-usage.ts derive their ~/.clausona paths from
 *   homedir() at import time, so HOME is stubbed and the module graph re-imported, as in
 *   src/commands.shell-env.test.ts.
 * - The credential store. secrets.js is mocked to delegate to the real implementation
 *   with the "file" backend forced, which exercises real reads and writes of
 *   ~/.clausona/secrets.json under the temp HOME. process.js is mocked so that any
 *   spawn at all - `security`, `secret-tool`, a `claude auth login` - throws and is
 *   recorded; afterEach fails the test if one happened. Between the two, the macOS
 *   Keychain is unreachable from this file.
 */

const temps: string[] = [];
let spawned: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./secrets.js");
  vi.doUnmock("../core/process.js");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

async function harness() {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-api-profile-"));
  temps.push(home);

  // What an initialised install has: a primary ~/.claude that has been through
  // onboarding, and a registry that knows about it.
  const primary = path.join(home, ".claude");
  mkdirSync(path.join(primary, "commands"), { recursive: true });
  writeFileSync(path.join(primary, "settings.json"), '{"theme":"dark"}');
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.0",
      oauthAccount: { emailAddress: "primary@example.com" },
    }),
  );
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  const registryPath = path.join(home, ".clausona", "profiles.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 2,
      primarySources: { claude: primary },
      activeProfiles: { claude: "claude:default" },
      profiles: {
        "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
      },
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("../core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../core/process.js")>();
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return { ...actual, spawnCommand: refuse, spawnCommandSync: refuse };
  });
  vi.doMock("./secrets.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./secrets.js")>();
    return {
      ...actual,
      storeSecret: (id: string, value: string) => actual.storeSecret(id, value, "file"),
      deleteSecret: (id: string) => actual.deleteSecret(id, "file"),
      resolveSecret: (id: string, source: SecretSource) => actual.resolveSecret(id, source, "file"),
    };
  });
  const service = await import("./service.js");
  const secrets = await import("./secrets.js");

  const secretsPath = path.join(home, ".clausona", "secrets.json");
  const storedSecrets = (): Record<string, string> =>
    existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {};

  return {
    home,
    primary,
    registryPath,
    service,
    secrets,
    registryText: () => readFileSync(registryPath, "utf8"),
    registry: () => JSON.parse(readFileSync(registryPath, "utf8")),
    storedSecrets,
    /** Every path under HOME with its content, link target, or "dir" - a whole-tree fingerprint. */
    snapshot: () => snapshotTree(home),
  };
}

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) out[rel] = `-> ${readlinkSync(full)}`;
      else if (stats.isDirectory()) {
        out[rel] = "dir";
        walk(full);
      } else out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

/** An importable account directory, as `add --from` expects to find one. */
function seedAccountDir(home: string, dirName: string, email: string) {
  const dir = path.join(home, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return dir;
}

/** A pre-clausona backup: the user's only way back to their original setup. */
function seedBackupSentinel(home: string) {
  const sentinel = path.join(home, ".clausona", "backups", "claude", "old", "settings.json");
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, '{"original":true}');
  return sentinel;
}

describe("profile names that escape the backup directory", () => {
  // Regression test for a destructive bug: a name was only checked for being non-empty
  // and free of ':', and both add paths `rm -rf` backups/<tool>/<name> before using it.
  // `..` resolved that to ~/.clausona/backups and `.` to ~/.clausona/backups/claude.
  for (const name of ["..", "."]) {
    it(`addProfile refuses '${name}' and leaves existing backups alone`, async () => {
      const h = await harness();
      const sentinel = seedBackupSentinel(h.home);
      const fromPath = seedAccountDir(h.home, "import-me", "import@example.com");
      const before = h.snapshot();

      const outcome = await h.service.addProfile({ tool: "claude", name, fromPath }).catch((error: Error) => error);

      // Checked first so that, should the guard regress, the failure names the lost data.
      expect(existsSync(sentinel), "a pre-clausona backup was deleted").toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/Invalid profile name.*start with a letter or digit/);
      expect(h.snapshot()).toEqual(before);
    });
  }
});
