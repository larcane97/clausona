import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretSource } from "./types.js";

/**
 * The names init derives must pass the rule `add` enforces, since initializeRegistry now
 * refuses any that do not - and codex is the tool whose directory prefix the derivation
 * used to keep (`~/.codex-work` -> `.codex-work`).
 *
 * HOME is the seam, as in src/commands.shell-env.test.ts. process.js is mocked: on macOS
 * discovery asks the Keychain whether each claude account has a credential, and that one
 * lookup is answered "yes" by a fake child that never runs `security`. Any other spawn
 * throws and fails the test. secrets.js is mocked onto the real file backend, as in
 * src/lib/api-profile.integration.test.ts, so an API profile's key lands in the temp
 * HOME. Nothing here reaches the real Keychain or the real home.
 */

const temps: string[] = [];
let spawned: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./core/process.js");
  vi.doUnmock("./lib/secrets.js");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

function seedClaudeAccount(home: string, dirName: string, email: string) {
  const dir = path.join(home, dirName);
  mkdirSync(dir, { recursive: true });
  // The primary keeps its account file beside the directory, every other one inside it.
  const jsonPath = dirName === ".claude" ? path.join(home, ".claude.json") : path.join(dir, ".claude.json");
  writeFileSync(jsonPath, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return dir;
}

function seedCodexAccount(home: string, dirName: string, email: string) {
  const dir = path.join(home, dirName);
  mkdirSync(dir, { recursive: true });
  // An id_token whose payload carries an email is all the codex adapter reads.
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
  return dir;
}

/** A child that reports success without running anything. */
function fakeSuccess(): ChildProcess {
  const child = new EventEmitter();
  setImmediate(() => child.emit("close", 0));
  return child as ChildProcess;
}

async function harness() {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-init-"));
  temps.push(home);
  seedClaudeAccount(home, ".claude", "primary@example.com");
  seedClaudeAccount(home, ".claude-work", "work@example.com");
  seedCodexAccount(home, ".codex", "primary@example.com");
  seedCodexAccount(home, ".codex-work", "work@example.com");

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("./core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/process.js")>();
    const spawnCommand = (command: string, args: string[] = []) => {
      if (command === "security" && args[0] === "find-generic-password") return fakeSuccess();
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return { ...actual, spawnCommand, spawnCommandSync: refuse };
  });
  vi.doMock("./lib/secrets.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./lib/secrets.js")>();
    return {
      ...actual,
      storeSecret: (id: string, value: string) => actual.storeSecret(id, value, "file"),
      deleteSecret: (id: string) => actual.deleteSecret(id, "file"),
      resolveSecret: (id: string, source: SecretSource) => actual.resolveSecret(id, source, "file"),
    };
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const commands = await import("./commands.js");
  const service = await import("./lib/service.js");
  const registryPath = path.join(home, ".clausona", "profiles.json");
  return {
    home,
    commands,
    service,
    registry: () => JSON.parse(readFileSync(registryPath, "utf8")),
    ids: () => Object.keys(JSON.parse(readFileSync(registryPath, "utf8")).profiles).sort(),
  };
}

const EXPECTED_IDS = ["claude:default", "claude:work", "codex:default", "codex:work"];

describe("init --auto", () => {
  it("names every account without its tool's directory prefix", async () => {
    const h = await harness();

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.ids()).toEqual(EXPECTED_IDS);
  });

  it("names an account whose directory name breaks the rule, rather than giving up", async () => {
    const h = await harness();
    seedClaudeAccount(h.home, ".claude-my work", "mine@example.com");

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.ids()).toEqual([...EXPECTED_IDS, "claude:my-work"].sort());
  });
});

describe("bootstrapInitFromCurrentState", () => {
  it("offers registered accounts their bare names, so re-running init reproduces the same ids", async () => {
    const h = await harness();
    // Named explicitly, so this depends on the bootstrap alone and not on init's defaults;
    // the active profile is one init would not pick on its own.
    const accounts = await h.service.discoverAccounts();
    const names: Record<string, string> = {
      ".claude": "default",
      ".claude-work": "work",
      ".codex": "default",
      ".codex-work": "work",
    };
    const profileNames = Object.fromEntries(accounts.map((a) => [a.configDir, names[path.basename(a.configDir)]]));
    await h.service.initializeRegistry({ accounts, profileNames, defaultProfile: "work" });
    expect(h.ids()).toEqual(EXPECTED_IDS);
    expect(h.registry().activeProfiles.claude).toBe("claude:work");

    const state = await h.commands.bootstrapInitFromCurrentState();
    // What the TUI's init does with that state when every offered name is accepted.
    await h.service.initializeRegistry(state);

    expect(h.ids()).toEqual(EXPECTED_IDS);
    expect(h.registry().activeProfiles.claude).toBe("claude:work");
    expect(state.profileNames).toEqual({
      [path.join(h.home, ".claude")]: "default",
      [path.join(h.home, ".claude-work")]: "work",
      [path.join(h.home, ".codex")]: "default",
      [path.join(h.home, ".codex-work")]: "work",
    });
    expect(state.defaultProfile).toBe("work");
  });
});

describe("re-running init over a registry that holds a name from before the name rule", () => {
  // The old `init --auto` named a second codex account `.codex-work`. Its backup directory
  // is backups/codex/.codex-work, and everything clausona keys by id says `codex:.codex-work`.
  async function withLegacyCodexName() {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    const registry = h.registry();
    registry.profiles["codex:.codex-work"] = registry.profiles["codex:work"];
    delete registry.profiles["codex:work"];
    writeFileSync(path.join(h.home, ".clausona", "profiles.json"), JSON.stringify(registry));
    const backups = path.join(h.home, ".clausona", "backups", "codex");
    renameSync(path.join(backups, "work"), path.join(backups, ".codex-work"));
    const sentinel = path.join(backups, ".codex-work", "sentinel.json");
    writeFileSync(sentinel, '{"original":true}');
    return { h, sentinel, backups };
  }
  const LEGACY_IDS = ["claude:default", "claude:work", "codex:.codex-work", "codex:default"];

  it("init --auto keeps the registered name instead of deriving a new one", async () => {
    const { h, sentinel, backups } = await withLegacyCodexName();

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.ids()).toEqual(LEGACY_IDS);
    expect(existsSync(sentinel), "the profile's backup is no longer where its name points").toBe(true);
    expect(existsSync(path.join(backups, "work")), "a second backup directory was started").toBe(false);
  });

  it("TUI init accepts the registered name it offers", async () => {
    const { h, sentinel } = await withLegacyCodexName();

    const state = await h.commands.bootstrapInitFromCurrentState();
    await h.service.initializeRegistry(state);

    expect(state.profileNames[path.join(h.home, ".codex-work")]).toBe(".codex-work");
    expect(h.ids()).toEqual(LEGACY_IDS);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("still refuses that name for any other account", async () => {
    const { h } = await withLegacyCodexName();
    seedCodexAccount(h.home, ".codex-other", "other@example.com");
    const accounts = await h.service.discoverAccounts();
    const profileNames = {
      [path.join(h.home, ".codex-work")]: "work",
      [path.join(h.home, ".codex-other")]: ".codex-work",
    };
    const before = readFileSync(path.join(h.home, ".clausona", "profiles.json"), "utf8");

    await expect(h.service.initializeRegistry({ accounts, profileNames, defaultProfile: "default" })).rejects.toThrow(
      "Invalid profile name '.codex-work'",
    );
    expect(readFileSync(path.join(h.home, ".clausona", "profiles.json"), "utf8")).toBe(before);
  });
});

describe("derived names that collide", () => {
  it("init --auto numbers the second one instead of giving up", async () => {
    const h = await harness();
    seedClaudeAccount(h.home, ".claude-my work", "spaced@example.com");
    seedClaudeAccount(h.home, ".claude-my-work", "dashed@example.com");

    await h.commands.runCommand("init", ["--auto"]);

    const profiles = h.registry().profiles;
    expect(h.ids()).toEqual([...EXPECTED_IDS, "claude:my-work", "claude:my-work-2"].sort());
    // The directory that already spells the name keeps it.
    expect(profiles["claude:my-work"].configDir).toBe(path.join(h.home, ".claude-my-work"));
    expect(profiles["claude:my-work-2"].configDir).toBe(path.join(h.home, ".claude-my work"));
  });
});

describe("re-running init with an API profile registered", () => {
  // init rebuilds the registry from the accounts it discovers, and an API profile is not
  // one of them. Dropping it orphaned its stored key, config dir and backup.
  const KEY = "sk-test-glm-0001";
  async function withApiProfile(options: { active: boolean }) {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    await h.service.addApiProfile({
      tool: "claude",
      name: "glm",
      baseUrl: "http://gpu-box:30000",
      authScheme: "bearer",
      secret: { source: "keychain" },
      secretValue: KEY,
      env: { ANTHROPIC_MODEL: "glm-5.3" },
    });
    if (options.active) await h.service.setActiveProfileByName("claude:glm");
    const entry = h.registry().profiles["claude:glm"];
    const storedKeys = () => JSON.parse(readFileSync(path.join(h.home, ".clausona", "secrets.json"), "utf8"));
    return { h, entry, storedKeys };
  }

  it("init --auto keeps it, its key, and its place as the active profile", async () => {
    const { h, entry, storedKeys } = await withApiProfile({ active: true });

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().profiles["claude:glm"], "the API profile was dropped").toEqual(entry);
    expect(storedKeys()).toEqual({ "claude:glm": KEY });
    expect(h.registry().activeProfiles.claude).toBe("claude:glm");
    expect(h.ids()).toEqual([...EXPECTED_IDS, "claude:glm"].sort());
  });

  it("TUI init keeps it, its key, and its place as the active profile", async () => {
    const { h, entry, storedKeys } = await withApiProfile({ active: true });

    const state = await h.commands.bootstrapInitFromCurrentState();
    await h.service.initializeRegistry(state);

    expect(h.registry().profiles["claude:glm"], "the API profile was dropped").toEqual(entry);
    expect(storedKeys()).toEqual({ "claude:glm": KEY });
    expect(h.registry().activeProfiles.claude).toBe("claude:glm");
    expect(h.ids()).toEqual([...EXPECTED_IDS, "claude:glm"].sort());
  });

  it("gives way to a default the user picks in TUI init", async () => {
    const { h, entry } = await withApiProfile({ active: true });

    const state = await h.commands.bootstrapInitFromCurrentState();
    // The TUI's default step always ends in an explicit pick.
    await h.service.initializeRegistry({ ...state, defaultProfile: "work" });

    expect(h.registry().activeProfiles.claude).toBe("claude:work");
    expect(h.registry().profiles["claude:glm"]).toEqual(entry);
  });

  it("keeps an inactive one without making it active", async () => {
    const { h, entry } = await withApiProfile({ active: false });

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().profiles["claude:glm"]).toEqual(entry);
    expect(h.registry().activeProfiles.claude).toBe("claude:default");
  });

  it("does not register its config dir a second time if an account turns up in it", async () => {
    // A `/login` inside the API profile would leave an account behind in its directory.
    const { h, entry } = await withApiProfile({ active: false });
    seedClaudeAccount(h.home, ".claude-glm", "signed-in@example.com");

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().profiles["claude:glm"]).toEqual(entry);
    expect(h.ids()).toEqual([...EXPECTED_IDS, "claude:glm"].sort());
  });

  it("refuses to give a found account the API profile's name", async () => {
    const { h } = await withApiProfile({ active: false });
    const state = await h.commands.bootstrapInitFromCurrentState();
    const before = readFileSync(path.join(h.home, ".clausona", "profiles.json"), "utf8");

    await expect(
      h.service.initializeRegistry({
        ...state,
        profileNames: { ...state.profileNames, [path.join(h.home, ".claude-work")]: "GLM" },
      }),
    ).rejects.toThrow("'claude:glm' is an API profile, which init keeps. Give 'claude:GLM' another name.");
    expect(readFileSync(path.join(h.home, ".clausona", "profiles.json"), "utf8")).toBe(before);
  });
});

describe("init --auto when an API profile holds the primary's usual name", () => {
  // Reachable when TUI init left the claude primary out, which let an API profile take `default`.
  it("names the primary default-2 instead of giving up", async () => {
    const h = await harness();
    const found = await h.service.discoverAccounts();
    await h.service.initializeRegistry({
      accounts: found.filter((account) => !(account.tool === "claude" && account.isPrimary)),
      profileNames: {},
    });
    await h.service.addApiProfile({
      tool: "claude",
      name: "default",
      baseUrl: "http://gpu-box:30000",
      authScheme: "bearer",
      secret: { source: "env", name: "GLM_KEY" },
    });
    const entry = h.registry().profiles["claude:default"];

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().profiles["claude:default"], "the API profile changed").toEqual(entry);
    expect(h.registry().profiles["claude:default-2"]).toMatchObject({
      configDir: path.join(h.home, ".claude"),
      isPrimary: true,
    });
  });
});

describe("re-running init --auto leaves the active profiles alone", () => {
  // `init --auto` never asks which profile should be active, so it has no business changing
  // it. It used to make the first account of each tool active on every run.
  it("keeps a non-first codex profile active", async () => {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    await h.service.setActiveProfileByName("codex:work");

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().activeProfiles.codex).toBe("codex:work");
  });

  it("keeps a non-first claude subscription profile active", async () => {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    await h.service.setActiveProfileByName("claude:work");

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().activeProfiles).toEqual({ claude: "claude:work", codex: "codex:default" });
  });

  it("falls back to a tool's first account when its active profile is gone", async () => {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    await h.service.setActiveProfileByName("claude:work");
    rmSync(path.join(h.home, ".claude-work"), { recursive: true, force: true });

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.ids()).toEqual(["claude:default", "codex:default", "codex:work"]);
    expect(h.registry().activeProfiles.claude).toBe("claude:default");
  });

  it("makes each tool's first account active on the first run", async () => {
    const h = await harness();

    await h.commands.runCommand("init", ["--auto"]);

    expect(h.registry().activeProfiles).toEqual({ claude: "claude:default", codex: "codex:default" });
  });
});

describe("TUI init", () => {
  it("keeps the active codex profile, since its default step picks the claude one", async () => {
    const h = await harness();
    await h.commands.runCommand("init", ["--auto"]);
    await h.service.setActiveProfileByName("codex:work");

    const state = await h.commands.bootstrapInitFromCurrentState();
    await h.service.initializeRegistry({ ...state, defaultProfile: "work" });

    expect(h.registry().activeProfiles).toEqual({ claude: "claude:work", codex: "codex:work" });
  });
});

describe("init --auto over a registry from before codex support", () => {
  // Reading the registry to reuse its names runs the existing v1 -> v2 migration first.
  it("ends with the v1 profiles under their names, their backups in place, and the active one kept", async () => {
    const h = await harness();
    const clausona = path.join(h.home, ".clausona");
    mkdirSync(path.join(clausona, "backups", "work"), { recursive: true });
    writeFileSync(path.join(clausona, "backups", "work", "settings.json"), '{"original":true}');
    const v1 = {
      primarySource: path.join(h.home, ".claude"),
      activeProfile: "work",
      profiles: {
        default: { configDir: path.join(h.home, ".claude"), email: "primary@example.com", isPrimary: true },
        work: { configDir: path.join(h.home, ".claude-work"), email: "work@example.com" },
      },
    };
    writeFileSync(path.join(clausona, "profiles.json"), JSON.stringify(v1));

    await h.commands.runCommand("init", ["--auto"]);

    const registry = h.registry();
    expect(registry.version).toBe(2);
    expect(h.ids()).toEqual(EXPECTED_IDS);
    expect(registry.activeProfiles).toEqual({ claude: "claude:work", codex: "codex:default" });
    expect(readFileSync(path.join(clausona, "backups", "claude", "work", "settings.json"), "utf8")).toBe(
      '{"original":true}',
    );
    expect(existsSync(path.join(clausona, "backups", "work")), "the v1 backup was left in the old layout").toBe(false);
    expect(JSON.parse(readFileSync(path.join(clausona, "profiles.json.v1.bak"), "utf8"))).toEqual(v1);
  });
});

describe("initializeRegistry", () => {
  it("names an account the caller left unnamed exactly as init --auto would", async () => {
    const h = await harness();
    const accounts = await h.service.discoverAccounts();

    await h.service.initializeRegistry({ accounts, profileNames: {}, defaultProfile: "default" });

    expect(h.ids()).toEqual(EXPECTED_IDS);
  });
});
