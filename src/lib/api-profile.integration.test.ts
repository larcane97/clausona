import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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

/** A file in backups/claude/<name>, wherever that name resolves to. */
function seedBackupFile(home: string, name: string) {
  const sentinel = path.join(home, ".clausona", "backups", "claude", name, "sentinel.json");
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, '{"original":true}');
  return sentinel;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** A claude profile written straight into profiles.json, as the code before the name rule accepted it. */
function registerLegacy(h: Harness, name: string, configDir: string) {
  mkdirSync(configDir, { recursive: true });
  const registry = h.registry();
  registry.profiles[`claude:${name}`] = { tool: "claude", configDir, email: "legacy@example.com" };
  writeFileSync(h.registryPath, JSON.stringify(registry));
}

function captureStderr() {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return () => lines.join("");
}

/** How an error names a backup directory: under ~, as the user would type it. */
function shownBackupDir(name: string) {
  return path.join("~", ".clausona", "backups", "claude", name);
}

const KEY = "sk-test-glm-0001";

/** A keychain-backed API profile; tests override what they are about. */
function apiOptions(overrides: Partial<Parameters<typeof import("./service.js").addApiProfile>[0]> = {}) {
  return {
    tool: "claude" as const,
    name: "glm",
    baseUrl: "http://gpu-box:30000",
    authScheme: "bearer" as const,
    secret: { source: "keychain" } as SecretSource,
    secretValue: KEY,
    ...overrides,
  };
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

    it(`addApiProfile refuses '${name}' and leaves existing backups alone`, async () => {
      const h = await harness();
      const sentinel = seedBackupSentinel(h.home);
      const before = h.snapshot();

      const outcome = await h.service.addApiProfile(apiOptions({ name })).catch((error: Error) => error);

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
  for (const name of ["..", ".", "a/../.."]) {
    it(`removeProfile refuses 'claude:${name}' and leaves existing backups alone`, async () => {
      const h = await harness();
      const sentinel = seedBackupSentinel(h.home);
      const legacyDir = path.join(h.home, ".claude-legacy");
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

  it("addApiProfile refuses 'Work' when 'work' exists", async () => {
    const { h, sentinel } = await withWork();
    const before = h.snapshot();

    const outcome = await h.service.addApiProfile(apiOptions({ name: "Work" })).catch((error: Error) => error);

    expect(existsSync(sentinel), "the existing profile's backup was deleted").toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Profile 'claude:work' already exists (names are compared without case).");
    expect(h.snapshot()).toEqual(before);
  });

  it("adding a name whose case variant's backup outlived its profile leaves that backup alone", async () => {
    const h = await harness();
    const sentinel = seedBackupFile(h.home, "Work");
    const caseInsensitive = existsSync(path.join(h.home, ".clausona", "backups", "claude", "work"));
    const fromPath = seedAccountDir(h.home, "work-account", "work@example.com");
    const before = h.snapshot();

    const outcome = await h.service.addProfile({ tool: "claude", name: "work", fromPath }).catch((e: Error) => e);

    expect(existsSync(sentinel), "the other name's backup was deleted").toBe(true);
    // Only on a case-insensitive filesystem are the two names one directory.
    if (caseInsensitive) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/^~.*backups.claude.work already exists/);
      expect(h.snapshot()).toEqual(before);
    } else {
      expect(outcome).not.toBeInstanceOf(Error);
    }
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

describe("legacy names that share another profile's backup directory", () => {
  // Before the name rule, `add` accepted any name free of ':'. Each legacy name below stays
  // inside backups/claude/ but resolves to the directory another name owns - the same one
  // (`work/`, `./work`, ...) or one nested inside it (`a/b` under `a`) - and add and remove
  // both run a recursive rm on a profile's backup directory.
  const aliases = ["work/", "./work", "work/.", "/work", "x/../work"];
  const pairs: Array<[legacy: string, name: string]> = [
    ...aliases.map((a): [string, string] => [a, "work"]),
    ["a/b", "a"],
  ];

  for (const [legacy, name] of pairs) {
    it(`addProfile '${name}' refuses while legacy '${legacy}' keeps a backup there`, async () => {
      const h = await harness();
      registerLegacy(h, legacy, path.join(h.home, ".claude-legacy"));
      const sentinel = seedBackupFile(h.home, legacy);
      const fromPath = seedAccountDir(h.home, "import-me", "import@example.com");
      const before = h.snapshot();

      const outcome = await h.service.addProfile({ tool: "claude", name, fromPath }).catch((e: Error) => e);

      expect(existsSync(sentinel), "the legacy profile's backup was deleted").toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(`${shownBackupDir(name)} already exists`);
      expect(h.snapshot()).toEqual(before);
    });

    it(`addApiProfile '${name}' refuses while legacy '${legacy}' keeps a backup there`, async () => {
      const h = await harness();
      registerLegacy(h, legacy, path.join(h.home, ".claude-legacy"));
      const sentinel = seedBackupFile(h.home, legacy);
      const before = h.snapshot();

      const outcome = await h.service.addApiProfile(apiOptions({ name })).catch((e: Error) => e);

      expect(existsSync(sentinel), "the legacy profile's backup was deleted").toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(`${shownBackupDir(name)} already exists`);
      expect(h.storedSecrets(), "a key was stored").toEqual({});
      expect(h.snapshot()).toEqual(before);
    });

    it(`removeProfile '${name}' leaves the backup directory legacy '${legacy}' shares with it in place`, async () => {
      const h = await harness();
      const ownDir = seedAccountDir(h.home, `${name}-account`, `${name}@example.com`);
      await h.service.addProfile({ tool: "claude", name, fromPath: ownDir });
      registerLegacy(h, legacy, path.join(h.home, ".claude-legacy"));
      const sentinel = seedBackupFile(h.home, legacy);
      const stderr = captureStderr();

      await h.service.removeProfile(`claude:${name}`);

      expect(existsSync(sentinel), "the legacy profile's backup was deleted").toBe(true);
      expect(existsSync(path.join(ownDir, "sentinel.json")), "another profile's backup was restored here").toBe(false);
      expect(Object.keys(h.registry().profiles).sort()).toEqual(["claude:default", `claude:${legacy}`].sort());
      expect(stderr()).toContain(`because 'claude:${legacy}' keeps its backup there too`);
    });
  }

  for (const legacy of aliases) {
    it(`removeProfile refuses legacy '${legacy}' and leaves the backup of 'work' alone`, async () => {
      const h = await harness();
      await h.service.addProfile({
        tool: "claude",
        name: "work",
        fromPath: seedAccountDir(h.home, "work-account", "work@example.com"),
      });
      const sentinel = seedBackupFile(h.home, "work");
      const legacyDir = path.join(h.home, ".claude-legacy");
      registerLegacy(h, legacy, legacyDir);
      const before = h.snapshot();

      const outcome = await h.service.removeProfile(`claude:${legacy}`).catch((e: Error) => e);

      expect(existsSync(sentinel), "the backup of 'work' was deleted").toBe(true);
      expect(existsSync(path.join(legacyDir, "sentinel.json")), "the backup of 'work' was restored here").toBe(false);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/refusing to use it as a backup directory/);
      expect((outcome as Error).message).toContain(`remove the 'claude:${legacy}' entry from`);
      expect(h.snapshot()).toEqual(before);
    });
  }
});

describe("a legacy pair of names that differ only by case", () => {
  // Ruling B stops a new pair, but a registry can already hold one. On a case-insensitive
  // filesystem the two share one backup directory, and whichever is removed first used to
  // restore that directory into its own config dir and then delete it.
  async function withPair() {
    const h = await harness();
    const workDir = seedAccountDir(h.home, "work-account", "work@example.com");
    await h.service.addProfile({ tool: "claude", name: "work", fromPath: workDir });
    const sentinel = seedBackupFile(h.home, "work");
    const legacyDir = path.join(h.home, ".claude-Work-legacy");
    registerLegacy(h, "Work", legacyDir);
    return { h, sentinel, workDir, legacyDir };
  }

  it("removing the legacy one leaves the backup directory in place", async () => {
    const { h, sentinel, legacyDir } = await withPair();
    const stderr = captureStderr();

    await h.service.removeProfile("claude:Work");

    expect(existsSync(sentinel), "the backup of 'work' was deleted").toBe(true);
    expect(existsSync(path.join(legacyDir, "sentinel.json")), "the backup of 'work' was restored here").toBe(false);
    expect(Object.keys(h.registry().profiles).sort()).toEqual(["claude:default", "claude:work"]);
    expect(stderr()).toContain("because 'claude:work' keeps its backup there too");
  });

  it("removing the other one does too", async () => {
    const { h, sentinel, workDir } = await withPair();
    const stderr = captureStderr();

    await h.service.removeProfile("claude:work");

    expect(existsSync(sentinel), "the shared backup was deleted").toBe(true);
    expect(existsSync(path.join(workDir, "sentinel.json")), "the shared backup was restored here").toBe(false);
    expect(Object.keys(h.registry().profiles).sort()).toEqual(["claude:Work", "claude:default"]);
    expect(stderr()).toContain("because 'claude:Work' keeps its backup there too");
  });
});

describe("adding a profile over a backup directory that outlived its profile", () => {
  // An interrupted removal, or a re-init that renamed an account, can leave
  // backups/<tool>/<name> behind with the only copy of someone's original config in it.
  // Adding that name again used to clear it before use.
  const refusal = `${shownBackupDir("work")} already exists, so 'claude:work' cannot use it as its backup directory.`;

  it("addProfile --from refuses and leaves it alone", async () => {
    const h = await harness();
    const orphan = seedBackupFile(h.home, "work");
    const fromPath = seedAccountDir(h.home, "work-account", "work@example.com");
    const before = h.snapshot();

    const outcome = await h.service.addProfile({ tool: "claude", name: "work", fromPath }).catch((e: Error) => e);

    expect(existsSync(orphan), "the orphaned backup was deleted").toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(refusal);
    expect((outcome as Error).message).toMatch(/move it somewhere else/);
    expect(h.snapshot()).toEqual(before);
  });

  it("addProfile without --from refuses before it creates a config dir or starts a login", async () => {
    const h = await harness();
    const orphan = seedBackupFile(h.home, "work");
    const before = h.snapshot();

    const outcome = await h.service.addProfile({ tool: "claude", name: "work" }).catch((e: Error) => e);

    expect(existsSync(orphan), "the orphaned backup was deleted").toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(refusal);
    expect(h.snapshot()).toEqual(before);
  });

  it("addApiProfile refuses and leaves it alone", async () => {
    const h = await harness();
    const orphan = seedBackupFile(h.home, "work");
    const before = h.snapshot();

    const outcome = await h.service.addApiProfile(apiOptions({ name: "work" })).catch((e: Error) => e);

    expect(existsSync(orphan), "the orphaned backup was deleted").toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(refusal);
    expect(h.storedSecrets(), "a key was stored").toEqual({});
    expect(h.snapshot()).toEqual(before);
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

  // Re-registering a profile under the name it already has is not creating a name.
  it("keeps registered names from before the rules for the accounts that hold them", async () => {
    const h = await harness();
    const found = accounts(h, "account-0", "account-1", "account-2");
    const registry = h.registry();
    registry.profiles["claude:.old"] = { tool: "claude", configDir: found[1].configDir, email: "x@example.com" };
    registry.profiles["claude:Work"] = { tool: "claude", configDir: found[2].configDir, email: "x@example.com" };
    registry.profiles["claude:work"] = { tool: "claude", configDir: found[3].configDir, email: "x@example.com" };
    writeFileSync(h.registryPath, JSON.stringify(registry));

    await h.service.initializeRegistry({ accounts: found, profileNames: {}, defaultProfile: ".old" });

    expect(Object.keys(h.registry().profiles).sort()).toEqual([
      "claude:.old",
      "claude:Work",
      "claude:default",
      "claude:work",
    ]);
    expect(h.registry().activeProfiles).toEqual({ claude: "claude:.old" });
  });

  it("refuses a kept name the backup guard refuses before writing anything, and says how to recover", async () => {
    const h = await harness();
    const sentinel = seedBackupSentinel(h.home);
    const found = accounts(h, "account-0");
    const registry = h.registry();
    registry.profiles["claude:.."] = { tool: "claude", configDir: found[1].configDir, email: "x@example.com" };
    writeFileSync(h.registryPath, JSON.stringify(registry));
    const before = h.snapshot();

    await expect(
      h.service.initializeRegistry({ accounts: found, profileNames: {}, defaultProfile: "default" }),
    ).rejects.toThrow(/refusing to use it as a backup directory\. To recover, remove the 'claude:\.\.' entry from/);
    expect(existsSync(sentinel)).toBe(true);
    expect(h.snapshot()).toEqual(before);
  });

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

describe("addApiProfile", () => {
  it("registers a reference to the key, stores the key, and sets up the config dir", async () => {
    const h = await harness();

    const result = await h.service.addApiProfile(apiOptions({ label: "gpu-box", env: { ANTHROPIC_MODEL: "glm-5.3" } }));

    const configDir = path.join(h.home, ".claude-glm");
    expect(result).toEqual({ name: "glm", configDir });
    expect(h.registry().profiles["claude:glm"]).toEqual({
      tool: "claude",
      kind: "api",
      configDir,
      email: "",
      label: "gpu-box",
      mergeSessions: false,
      api: { baseUrl: "http://gpu-box:30000", authScheme: "bearer", secret: { source: "keychain" } },
      env: { ANTHROPIC_MODEL: "glm-5.3" },
    });
    expect(h.registry().version).toBe(2);
    expect(h.registryText()).not.toContain(KEY);

    expect(h.storedSecrets()).toEqual({ "claude:glm": KEY });
    await expect(h.secrets.resolveSecret("claude:glm", { source: "keychain" })).resolves.toBe(KEY);

    // No login step, so no onboarding wizard either: the primary's state comes across.
    const claudeJson = JSON.parse(readFileSync(path.join(configDir, ".claude.json"), "utf8"));
    expect(claudeJson).toEqual({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.0" });
    expect(readFileSync(path.join(configDir, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
    expect(existsSync(path.join(h.home, ".clausona", "backups", "claude", "glm"))).toBe(true);
  });

  it("defaults the label to the endpoint's host and stores nothing for an env source", async () => {
    const h = await harness();

    await h.service.addApiProfile(
      apiOptions({
        name: "router",
        baseUrl: "https://openrouter.ai/api",
        authScheme: "api-key",
        secret: { source: "env", name: "OPENROUTER_API_KEY" },
        secretValue: undefined,
      }),
    );

    expect(h.registry().profiles["claude:router"]).toMatchObject({
      label: "openrouter.ai",
      api: { authScheme: "api-key", secret: { source: "env", name: "OPENROUTER_API_KEY" } },
      env: {},
    });
    expect(h.storedSecrets()).toEqual({});
  });

  it("persists only the fields a key source defines", async () => {
    const h = await harness();
    // A caller that hangs the key on the source object must not get it written out.
    const secret = { source: "env", name: "GLM_KEY", value: KEY } as unknown as SecretSource;

    await h.service.addApiProfile(apiOptions({ secret, secretValue: undefined }));

    expect(h.registry().profiles["claude:glm"].api.secret).toEqual({ source: "env", name: "GLM_KEY" });
    expect(h.registryText()).not.toContain(KEY);
  });

  // Every input is checked before the first side effect. Each case asserts the whole HOME
  // tree is untouched - no config dir, no registry change, no stored key, no backup dir.
  const rejections: Array<[string, Parameters<typeof apiOptions>[0], string | RegExp]> = [
    ["the name '..'", { name: ".." }, /Invalid profile name '\.\.'/],
    ["the name '.'", { name: "." }, /Invalid profile name '\.'/],
    ["a name with a space", { name: "my glm" }, /Invalid profile name 'my glm'/],
    ["a codex profile", { tool: "codex" }, "API profiles are supported for claude only in this version."],
    ["an existing id", { name: "default" }, "Profile 'claude:default' already exists."],
    [
      "an id that differs from an existing one only by case",
      { name: "Default" },
      "Profile 'claude:default' already exists (names are compared without case).",
    ],
    ["a base URL that does not parse", { baseUrl: "not a url" }, /Invalid base URL: must be an absolute http/],
    [
      "a base URL missing its scheme",
      { baseUrl: "gpu-box:30000" },
      "Invalid base URL: the scheme must be http or https, not 'gpu-box'.",
    ],
    ["a relative base URL", { baseUrl: "/v1" }, /Invalid base URL: must be an absolute http/],
    [
      "a non-http base URL",
      { baseUrl: "ftp://gpu-box" },
      "Invalid base URL: the scheme must be http or https, not 'ftp'.",
    ],
    [
      "a base URL carrying credentials",
      { baseUrl: `https://u:${KEY}@openrouter.ai/api` },
      /must not carry credentials/,
    ],
    ["an unknown auth scheme", { authScheme: "basic" as "bearer" }, /Invalid auth scheme 'basic'/],
    ["a blank label", { label: "   " }, /Label cannot be blank/],
    ["a keychain source with no key", { secretValue: undefined }, "no API key supplied for the keychain source"],
    ["a keychain source with a blank key", { secretValue: "  " }, "no API key supplied for the keychain source"],
    [
      "an env source whose name is the key itself",
      { secret: { source: "env", name: KEY }, secretValue: undefined },
      /Invalid key variable name/,
    ],
    ["a command source with nothing to run", { secret: { source: "command", run: " " } }, "The key command is empty."],
    ["a malformed env key", { env: { "BAD-KEY": "x" } }, /'BAD-KEY' is not a valid environment variable name/],
    ["a reserved env key", { env: { CLAUDE_CONFIG_DIR: "/tmp/x" } }, /CLAUDE_CONFIG_DIR is managed by clausona/],
    [
      "a catalog key with the wrong kind of value",
      { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "lots" } },
      /CLAUDE_CODE_MAX_CONTEXT_TOKENS expects a whole number/,
    ],
  ];
  for (const [label, overrides, message] of rejections) {
    it(`refuses ${label} and leaves nothing behind`, async () => {
      const h = await harness();
      const options = apiOptions(overrides);
      const registryBefore = h.registryText();
      const before = h.snapshot();

      const outcome = await h.service.addApiProfile(options).catch((error: Error) => error);

      // What was left behind is checked before the message, so a regression names it.
      expect(existsSync(path.join(h.home, `.claude-${options.name}`)), "config dir created").toBe(false);
      expect(h.registryText(), "registry written").toBe(registryBefore);
      expect(h.storedSecrets(), "a key was stored").toEqual({});
      expect(h.snapshot()).toEqual(before);

      expect(outcome).toBeInstanceOf(Error);
      const error = outcome as Error;
      if (typeof message === "string") expect(error.message).toBe(message);
      else expect(error.message).toMatch(message);
      expect(error.message).not.toContain(KEY);
    });
  }
});

describe("add --from a directory clausona already manages", () => {
  // `add --from` backs up each entry the primary shares, then replaces it with a link into
  // the primary. Run on the primary itself, that turned its commands/ into a link to itself.
  const fromPaths: Array<[string, (h: Harness) => string]> = [
    ["the primary config dir", (h) => h.primary],
    ["the primary config dir with a trailing separator", (h) => `${h.primary}${path.sep}`],
    ["the primary config dir written with ~", () => path.join("~", ".claude")],
    [
      "a link to the primary config dir",
      (h) => {
        const link = path.join(h.home, "claude-link");
        symlinkSync(h.primary, link);
        return link;
      },
    ],
  ];
  for (const [label, fromPath] of fromPaths) {
    it(`refuses ${label} and leaves the primary alone`, async () => {
      const h = await harness();
      const from = fromPath(h);
      const before = h.snapshot();

      const outcome = await h.service
        .addProfile({ tool: "claude", name: "mirror", fromPath: from })
        .catch((e: Error) => e);

      expect(lstatSync(path.join(h.primary, "commands")).isDirectory(), "the primary's commands/ was replaced").toBe(
        true,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(
        /^Cannot add .*: it is claude's primary config directory, which every profile shares\.$/,
      );
      expect(h.snapshot()).toEqual(before);
    });
  }

  it("refuses a directory another profile already uses", async () => {
    const h = await harness();
    const shared = seedAccountDir(h.home, "work-account", "work@example.com");
    await h.service.addProfile({ tool: "claude", name: "work", fromPath: shared });
    const before = h.snapshot();

    const outcome = await h.service
      .addProfile({ tool: "claude", name: "again", fromPath: shared })
      .catch((e: Error) => e);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(
      `Cannot add ${path.join("~", "work-account")}: it is already registered as 'claude:work'.`,
    );
    expect(h.snapshot()).toEqual(before);
  });
});

describe("updateProfileEnv", () => {
  async function withApiProfile() {
    const h = await harness();
    await h.service.addApiProfile(apiOptions({ env: { ANTHROPIC_MODEL: "glm-5.3" } }));
    return h;
  }

  it("persists a valid set and removes an unset key", async () => {
    const h = await withApiProfile();

    const updated = await h.service.updateProfileEnv("claude:glm", {
      set: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000", ANTHROPIC_SMALL_FAST_MODEL: "glm-5.3-air" },
      unset: ["ANTHROPIC_MODEL"],
    });

    const expected = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000", ANTHROPIC_SMALL_FAST_MODEL: "glm-5.3-air" };
    expect(updated.env).toEqual(expected);
    expect(h.registry().profiles["claude:glm"].env).toEqual(expected);
  });

  const invalid: Array<[string, Record<string, string>, RegExp]> = [
    ["a malformed key", { "MY-VAR": "1" }, /'MY-VAR' is not a valid environment variable name/],
    ["a reserved key", { CLAUDE_CONFIG_DIR: "/tmp/elsewhere" }, /CLAUDE_CONFIG_DIR is managed by clausona/],
    ["a bad number", { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1e6" }, /expects a whole number/],
  ];
  for (const [label, set, message] of invalid) {
    it(`rejects ${label} and persists nothing, not even the valid entries beside it`, async () => {
      const h = await withApiProfile();
      const before = h.registryText();

      await expect(
        h.service.updateProfileEnv("claude:glm", { set: { ANTHROPIC_SMALL_FAST_MODEL: "glm-5.3-air", ...set } }),
      ).rejects.toThrow(message);
      expect(h.registryText()).toBe(before);
    });
  }

  it("rejects an unknown profile", async () => {
    const h = await withApiProfile();
    await expect(h.service.updateProfileEnv("claude:nope", { set: { A: "1" } })).rejects.toThrow(
      "Profile 'claude:nope' not found.",
    );
  });
});

describe("updateProfileSecret", () => {
  it("switching from the keychain to an env variable deletes the stored key", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions());
    expect(h.storedSecrets()).toEqual({ "claude:glm": KEY });

    await h.service.updateProfileSecret("claude:glm", { source: "env", name: "GLM_KEY" });

    expect(h.registry().profiles["claude:glm"].api.secret).toEqual({ source: "env", name: "GLM_KEY" });
    expect(h.storedSecrets()).toEqual({});
  });

  it("switching from an env variable to the keychain stores the key and keeps it out of the registry", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions({ secret: { source: "env", name: "GLM_KEY" }, secretValue: undefined }));

    await h.service.updateProfileSecret("claude:glm", { source: "keychain" }, "sk-test-rotated");

    expect(h.registry().profiles["claude:glm"].api.secret).toEqual({ source: "keychain" });
    expect(h.storedSecrets()).toEqual({ "claude:glm": "sk-test-rotated" });
    expect(h.registryText()).not.toContain("sk-test-rotated");
  });

  it("replaces a stored key in place", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions());

    await h.service.updateProfileSecret("claude:glm", { source: "keychain" }, "sk-test-rotated");

    expect(h.storedSecrets()).toEqual({ "claude:glm": "sk-test-rotated" });
  });

  it("rejects a subscription profile", async () => {
    const h = await harness();
    const before = h.snapshot();

    await expect(h.service.updateProfileSecret("claude:default", { source: "keychain" }, KEY)).rejects.toThrow(
      "Profile 'claude:default' is not an API profile.",
    );
    expect(h.snapshot()).toEqual(before);
  });

  const invalid: Array<[string, SecretSource, string | undefined, RegExp]> = [
    ["a keychain source with no key", { source: "keychain" }, undefined, /no API key supplied/],
    ["an env source with a malformed name", { source: "env", name: "1GLM" }, undefined, /Invalid key variable name/],
    ["a command source with nothing to run", { source: "command", run: "" }, undefined, /key command is empty/],
  ];
  for (const [label, secret, value, message] of invalid) {
    it(`rejects ${label} before the stored key or the registry changes`, async () => {
      const h = await harness();
      await h.service.addApiProfile(apiOptions());
      const before = h.snapshot();

      await expect(h.service.updateProfileSecret("claude:glm", secret, value)).rejects.toThrow(message);
      // In particular, the existing key was not deleted on the way to switching sources.
      expect(h.storedSecrets()).toEqual({ "claude:glm": KEY });
      expect(h.snapshot()).toEqual(before);
    });
  }
});

describe("removing an API profile", () => {
  it("deletes its stored key and nobody else's", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions());
    await h.service.addApiProfile(apiOptions({ name: "other", secretValue: "sk-test-other" }));

    await h.service.removeProfile("claude:glm");

    expect(h.registry().profiles["claude:glm"]).toBeUndefined();
    expect(h.storedSecrets()).toEqual({ "claude:other": "sk-test-other" });
  });
});

describe("loginProfile", () => {
  it("refuses an API profile and points at the command that changes its key", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions());

    // Same command the key resolver names when no key is stored.
    await expect(h.service.loginProfile("claude:glm")).rejects.toThrow(
      "'claude:glm' is an API profile. Change its key with 'clausona config claude:glm --key'.",
    );
  });
});

describe("resolveProfileEnv", () => {
  it("gives a non-primary subscription profile its config dir, over an inherited one", async () => {
    const h = await harness();
    const fromPath = seedAccountDir(h.home, ".claude-work", "work@example.com");
    await h.service.addProfile({ tool: "claude", name: "work", fromPath });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(h.home, "somewhere-else"));

    const resolved = await h.service.resolveProfileEnv("claude:work");

    expect(resolved).toMatchObject({ tool: "claude", binary: "claude", configDir: fromPath });
    expect(resolved.env.CLAUDE_CONFIG_DIR).toBe(fromPath);
    expect(resolved.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(resolved.env.HOME).toBe(h.home);
  });

  it("clears an inherited config dir for the primary profile", async () => {
    const h = await harness();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(h.home, "somewhere-else"));

    const resolved = await h.service.resolveProfileEnv("claude:default");

    expect(resolved.configDir).toBe(h.primary);
    expect("CLAUDE_CONFIG_DIR" in resolved.env).toBe(false);
  });

  it("adds an API profile's endpoint, key and env map", async () => {
    const h = await harness();
    await h.service.addApiProfile(apiOptions({ env: { ANTHROPIC_MODEL: "glm-5.3" } }));

    const { env } = await h.service.resolveProfileEnv("claude:glm");

    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: path.join(h.home, ".claude-glm"),
      ANTHROPIC_BASE_URL: "http://gpu-box:30000",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_MODEL: "glm-5.3",
    });
  });

  it("still resolves when the key cannot be, and warns without the key", async () => {
    const h = await harness();
    await h.service.addApiProfile(
      apiOptions({ secret: { source: "env", name: "GLM_KEY_UNSET" }, secretValue: undefined }),
    );
    vi.stubEnv("GLM_KEY_UNSET", "");
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });

    const { env } = await h.service.resolveProfileEnv("claude:glm");

    expect(env.ANTHROPIC_BASE_URL).toBe("http://gpu-box:30000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(warnings.join("")).toMatch(/claude:glm: environment variable GLM_KEY_UNSET is unset or empty/);
  });
});
