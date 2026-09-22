import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The names init derives must pass the rule `add` enforces, since initializeRegistry now
 * refuses any that do not - and codex is the tool whose directory prefix the derivation
 * used to keep (`~/.codex-work` -> `.codex-work`).
 *
 * HOME is the seam, as in src/commands.shell-env.test.ts. process.js is mocked: on macOS
 * discovery asks the Keychain whether each claude account has a credential, and that one
 * lookup is answered "yes" by a fake child that never runs `security`. Any other spawn
 * throws and fails the test, so nothing here reaches the real Keychain or the real home.
 */

const temps: string[] = [];
let spawned: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./core/process.js");
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

describe("initializeRegistry", () => {
  it("names an account the caller left unnamed exactly as init --auto would", async () => {
    const h = await harness();
    const accounts = await h.service.discoverAccounts();

    await h.service.initializeRegistry({ accounts, profileNames: {}, defaultProfile: "default" });

    expect(h.ids()).toEqual(EXPECTED_IDS);
  });
});
