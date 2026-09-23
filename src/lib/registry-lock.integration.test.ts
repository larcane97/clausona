import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Registry } from "../types.js";

// The registry and its lock live under ~/.clausona, resolved when service.ts loads, so
// each case points homedir() at a fresh temporary home and re-imports the module graph.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const registryPath = () => path.join(currentHome, ".clausona", "profiles.json");
const lockPath = () => path.join(currentHome, ".clausona", "locks", "registry.lock");
const readRegistry = () => JSON.parse(readFileSync(registryPath(), "utf8")) as Registry;

function writeAccount(configDir: string, email: string) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

function holdLock(ageMs = 0) {
  mkdirSync(path.dirname(lockPath()), { recursive: true });
  writeFileSync(lockPath(), "99999");
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(lockPath(), then, then);
  }
}

/**
 * Builds an initialized home — the primary plus one secondary, `claude:work` — and
 * replaces `claude auth login` with a stand-in the test controls. The stand-in stores
 * the account straight away but does not return until the test calls `finish`, which is
 * how a real login holds `add` open for minutes.
 */
async function setup() {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-reglock-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  mkdirSync(primary, { recursive: true });
  writeAccount(work, "work@example.com");
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "work@example.com", mergeSessions: false },
    },
  };
  writeFileSync(registryPath(), JSON.stringify(registry));

  vi.resetModules();
  const service = await import("./service.js");
  const { claudeAdapter } = await import("../tools/claude.js");

  const logins = new Map<string, { started: Deferred; finish: Deferred }>();
  vi.spyOn(claudeAdapter, "runLogin").mockImplementation(async (configDir) => {
    const name = path.basename(configDir).replace(/^\.claude-/, "");
    writeAccount(configDir, `${name}@example.com`);
    writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: name } }));
    const gate = logins.get(name);
    gate?.started.resolve();
    await gate?.finish.promise;
    return true;
  });

  /** Holds the login for profile `name` open until `finish` is called. */
  const holdLogin = (name: string) => {
    const gate = { started: deferred(), finish: deferred() };
    logins.set(name, gate);
    return { started: gate.started.promise, finish: gate.finish.resolve };
  };

  return { service, holdLogin, primary };
}

// Writers poll for the lock, and a loaded Windows runner is slow enough that a few
// serialized writes can approach vitest's 5s default.
describe("registry writes", { timeout: 30_000 }, () => {
  it("serializes concurrent updates so none is lost", async () => {
    const { service } = await setup();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.updateRegistry(async (current) => {
          if (!current) throw new Error("registry missing");
          // Yield between the read and the write — the window an unlocked writer leaves open.
          await new Promise((resolve) => setTimeout(resolve, 5));
          current.profiles[`claude:p${i}`] = {
            tool: "claude",
            configDir: path.join(currentHome, `.claude-p${i}`),
            email: `p${i}@example.com`,
          };
          return current;
        }),
      ),
    );

    expect(Object.keys(readRegistry().profiles)).toHaveLength(10);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("keeps both profiles when two adds overlap", async () => {
    const { service, holdLogin } = await setup();
    const a = holdLogin("a");

    const addingA = service.addProfile({ tool: "claude", name: "a" });
    await a.started;
    // b starts after a has read the registry and finishes while a is still signing in.
    await service.addProfile({ tool: "claude", name: "b" });
    a.finish();
    await addingA;

    expect(Object.keys(readRegistry().profiles).sort()).toEqual([
      "claude:a",
      "claude:b",
      "claude:default",
      "claude:work",
    ]);
  });

  it("keeps changes other commands make while an add is signing in", async () => {
    const { service, holdLogin } = await setup();
    const a = holdLogin("a");

    const addingA = service.addProfile({ tool: "claude", name: "a" });
    await a.started;
    await service.setActiveProfileByName("claude:work");
    await service.updateProfileConfig("claude:work", { mergeSessions: true });
    a.finish();
    await addingA;

    const registry = readRegistry();
    expect(registry.profiles["claude:a"]?.email).toBe("a@example.com");
    expect(registry.activeProfiles.claude).toBe("claude:work");
    expect(registry.profiles["claude:work"]?.mergeSessions).toBe(true);
  });

  it("does not bring back a profile removed while an add is signing in", async () => {
    const { service, holdLogin } = await setup();
    const a = holdLogin("a");

    const addingA = service.addProfile({ tool: "claude", name: "a" });
    await a.started;
    await service.removeProfile("claude:work");
    a.finish();
    await addingA;

    expect(Object.keys(readRegistry().profiles).sort()).toEqual(["claude:a", "claude:default"]);
  });

  it("rejects an add whose name was taken during its login and removes the directory it created", async () => {
    const { service, holdLogin } = await setup();
    const elsewhere = path.join(currentHome, "elsewhere");
    writeAccount(elsewhere, "elsewhere@example.com");
    const x = holdLogin("x");

    const addingX = service.addProfile({ tool: "claude", name: "x" });
    await x.started;
    await service.addProfile({ tool: "claude", name: "x", fromPath: elsewhere });
    x.finish();

    await expect(addingX).rejects.toThrow("Profile 'claude:x' already exists.");
    expect(existsSync(path.join(currentHome, ".claude-x"))).toBe(false);
    expect(readRegistry().profiles["claude:x"]?.configDir).toBe(elsewhere);
    expect(existsSync(path.join(elsewhere, ".claude.json"))).toBe(true);
  });

  it("leaves the directory alone when the add that took the name registered that same directory", async () => {
    const { service, holdLogin } = await setup();
    const dir = path.join(currentHome, ".claude-x");
    const x = holdLogin("x");

    const addingX = service.addProfile({ tool: "claude", name: "x" });
    await x.started;
    // The stand-in login has already stored the account, so importing the directory works.
    await service.addProfile({ tool: "claude", name: "x", fromPath: dir });
    x.finish();

    await expect(addingX).rejects.toThrow("Profile 'claude:x' already exists.");
    // Deleting it would leave the registered profile pointing at nothing.
    expect(readRegistry().profiles["claude:x"]?.configDir).toBe(dir);
    expect(existsSync(path.join(dir, ".claude.json"))).toBe(true);
  });

  it("waits for a lock another process holds instead of skipping the write", async () => {
    const { service } = await setup();
    holdLock();

    const switching = service.setActiveProfileByName("claude:work");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readRegistry().activeProfiles.claude).toBe("claude:default");

    rmSync(lockPath(), { force: true });
    await switching;

    expect(readRegistry().activeProfiles.claude).toBe("claude:work");
  });

  it("takes over a lock left behind by a process that died holding it", async () => {
    const { service } = await setup();
    holdLock(10 * 60_000);

    await service.setActiveProfileByName("claude:work");

    expect(readRegistry().activeProfiles.claude).toBe("claude:work");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("migrates a v1 registry once when two commands read it at the same time", async () => {
    const { service, primary } = await setup();
    writeFileSync(
      registryPath(),
      JSON.stringify({
        primarySource: primary,
        activeProfile: "default",
        profiles: { default: { configDir: primary, email: "primary@example.com", isPrimary: true } },
      }),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const [first, second] = await Promise.all([service.loadRegistry(), service.loadRegistry()]);

    expect(first?.version).toBe(2);
    expect(second?.version).toBe(2);
    expect(readRegistry().version).toBe(2);
    const notices = stderr.mock.calls.filter(([chunk]) => String(chunk).includes("migrated registry"));
    expect(notices).toHaveLength(1);
  });
});
