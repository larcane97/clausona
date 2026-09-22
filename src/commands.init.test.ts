import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The names init offers must pass the same rule `add` enforces, since initializeRegistry
 * now refuses any that do not. The accounts here are codex ones: codex is the tool whose
 * directory prefix the name derivation used to keep (`~/.codex-work` -> `.codex-work`),
 * and it has no Keychain gate in discovery, so nothing here needs a credential store.
 *
 * HOME is the seam, as in src/commands.shell-env.test.ts. process.js is mocked so that a
 * spawn of any kind - a Keychain lookup included - fails the test instead of running.
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

function seedCodexAccount(home: string, dirName: string, email: string) {
  const dir = path.join(home, dirName);
  mkdirSync(dir, { recursive: true });
  // An id_token whose payload carries an email is all the codex adapter reads.
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
  return dir;
}

async function harness(registry?: (home: string) => unknown) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-init-"));
  temps.push(home);
  seedCodexAccount(home, ".codex", "primary@example.com");
  seedCodexAccount(home, ".codex-work", "work@example.com");
  if (registry) {
    mkdirSync(path.join(home, ".clausona"), { recursive: true });
    writeFileSync(path.join(home, ".clausona", "profiles.json"), JSON.stringify(registry(home)));
  }

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("./core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/process.js")>();
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return { ...actual, spawnCommand: refuse, spawnCommandSync: refuse };
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const commands = await import("./commands.js");
  return {
    home,
    commands,
    registry: () => JSON.parse(readFileSync(path.join(home, ".clausona", "profiles.json"), "utf8")),
  };
}

describe("init --auto", () => {
  it("names a second codex account without its directory prefix", async () => {
    const h = await harness();

    await h.commands.runCommand("init", ["--auto"]);

    expect(Object.keys(h.registry().profiles).sort()).toEqual(["codex:default", "codex:work"]);
  });
});

describe("bootstrapInitFromCurrentState", () => {
  it("offers an account's registered name without the tool prefix", async () => {
    const h = await harness((home) => ({
      version: 2,
      primarySources: { codex: path.join(home, ".codex") },
      activeProfiles: { codex: "codex:main" },
      profiles: {
        "codex:main": { tool: "codex", configDir: path.join(home, ".codex"), email: "primary@example.com" },
        "codex:office": { tool: "codex", configDir: path.join(home, ".codex-work"), email: "work@example.com" },
      },
    }));
    seedCodexAccount(h.home, ".codex-personal", "personal@example.com");

    const state = await h.commands.bootstrapInitFromCurrentState();

    expect(state.profileNames).toEqual({
      [path.join(h.home, ".codex")]: "main",
      [path.join(h.home, ".codex-work")]: "office",
      [path.join(h.home, ".codex-personal")]: "personal",
    });
  });
});
