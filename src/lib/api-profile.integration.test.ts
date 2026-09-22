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

import type { DiscoveredAccount, SecretSource } from "../types.js";

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

describe("legacy profiles whose name escapes the backup directory", () => {
  // Names are checked at creation now, but a registry written before that can still hold
  // one - and removing it restores and then deletes backups/<tool>/<name>. The guard in
  // backupDirFor has to refuse, since the name itself can no longer be refused.
  for (const name of ["..", "."]) {
    it(`removeProfile refuses 'claude:${name}' and leaves existing backups alone`, async () => {
      const h = await harness();
      const sentinel = seedBackupSentinel(h.home);
      const legacyDir = path.join(h.home, `.claude-${name}`);
      mkdirSync(legacyDir, { recursive: true });
      const registry = h.registry();
      registry.profiles[`claude:${name}`] = { tool: "claude", configDir: legacyDir, email: "legacy@example.com" };
      writeFileSync(h.registryPath, JSON.stringify(registry));
      const before = h.snapshot();

      const outcome = await h.service.removeProfile(`claude:${name}`).catch((error: Error) => error);

      expect(existsSync(sentinel), "a pre-clausona backup was deleted").toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/refusing to use it as a backup directory/);
      expect(h.snapshot()).toEqual(before);
    });
  }
});

describe("profile names that differ only by case", () => {
  // backups/claude/Work and backups/claude/work are one directory on APFS and NTFS, and
  // both add paths clear the backup directory before use. The assertions are on the
  // rejection itself, so they hold on a case-sensitive filesystem as well.
  async function withWork() {
    const h = await harness();
    await h.service.addProfile({
      tool: "claude",
      name: "work",
      fromPath: seedAccountDir(h.home, "work-account", "work@example.com"),
    });
    const sentinel = path.join(h.home, ".clausona", "backups", "claude", "work", "sentinel.json");
    writeFileSync(sentinel, '{"original":true}');
    return { h, sentinel };
  }

  it("addProfile refuses 'Work' when 'work' exists", async () => {
    const { h, sentinel } = await withWork();
    const fromPath = seedAccountDir(h.home, "other-account", "other@example.com");
    const before = h.snapshot();

    const outcome = await h.service
      .addProfile({ tool: "claude", name: "Work", fromPath })
      .catch((error: Error) => error);

    // On a case-insensitive filesystem a regression shows up here first, as lost data.
    expect(existsSync(sentinel), "the existing profile's backup was deleted").toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Profile 'claude:work' already exists (names are compared without case).");
    expect(h.snapshot()).toEqual(before);
  });

  it("still allows the same name under the other tool", async () => {
    const { h } = await withWork();
    mkdirSync(path.join(h.home, ".codex"), { recursive: true });
    const codexDir = path.join(h.home, "codex-account");
    mkdirSync(codexDir, { recursive: true });
    // An id_token whose payload carries an email is all the codex adapter reads.
    const payload = Buffer.from(JSON.stringify({ email: "codex@example.com" })).toString("base64url");
    writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));

    await expect(h.service.addProfile({ tool: "codex", name: "Work", fromPath: codexDir })).resolves.toMatchObject({
      name: "Work",
    });
  });
});

describe("initializeRegistry names", () => {
  // init creates profiles too, from names the user typed in the TUI, so it gets the same
  // rules as add - checked for the whole set before anything is written.
  function accounts(h: { home: string; primary: string }, ...dirNames: string[]): DiscoveredAccount[] {
    const primary: DiscoveredAccount = {
      tool: "claude",
      configDir: h.primary,
      jsonPath: path.join(h.home, ".claude.json"),
      email: "primary@example.com",
      keychainService: "",
      isPrimary: true,
    };
    return [
      primary,
      ...dirNames.map((dirName) => {
        const configDir = seedAccountDir(h.home, dirName, `${dirName}@example.com`);
        return {
          tool: "claude" as const,
          configDir,
          jsonPath: path.join(configDir, ".claude.json"),
          email: `${dirName}@example.com`,
          keychainService: "",
          isPrimary: false,
        };
      }),
    ];
  }

  const rejections: Array<[string, string[], RegExp]> = [
    ["a name outside the rule", [".."], /Invalid profile name '\.\.'.*start with a letter or digit/],
    ["a name with a separator", ["a/../.."], /Invalid profile name/],
    ["two names that differ only by case", ["Work", "work"], /'claude:Work' and 'claude:work' name the same profile/],
    ["the same name twice", ["work", "work"], /Two accounts are both named 'claude:work'/],
  ];
  for (const [label, names, message] of rejections) {
    it(`refuses ${label} before writing anything`, async () => {
      const h = await harness();
      const sentinel = seedBackupSentinel(h.home);
      const found = accounts(h, ...names.map((_, i) => `account-${i}`));
      const profileNames = Object.fromEntries([
        [h.primary, "default"],
        ...names.map((name, i) => [found[i + 1].configDir, name]),
      ]);
      const before = h.snapshot();

      await expect(
        h.service.initializeRegistry({ accounts: found, profileNames, defaultProfile: "default" }),
      ).rejects.toThrow(message);
      expect(existsSync(sentinel)).toBe(true);
      expect(h.snapshot()).toEqual(before);
    });
  }

  it("accepts names that follow the rule", async () => {
    const h = await harness();
    const found = accounts(h, "account-0", "account-1");
    const profileNames = {
      [h.primary]: "default",
      [found[1].configDir]: "work",
      [found[2].configDir]: "glm-5.3",
    };

    await h.service.initializeRegistry({ accounts: found, profileNames, defaultProfile: "work" });

    expect(Object.keys(h.registry().profiles).sort()).toEqual(["claude:default", "claude:glm-5.3", "claude:work"]);
    expect(h.registry().activeProfiles).toEqual({ claude: "claude:work" });
  });
});
