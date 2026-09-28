import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredAccount, Registry } from "../types.js";

// The registry and its lock live under ~/.clausona, resolved when service.ts loads, so
// each case points homedir() at a fresh temporary home and re-imports the module graph.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

// A path whose removal fails, as one in use does on Windows. Every other removal is real.
let unremovable = "";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof actual.rm = (target, options) =>
    target === unremovable
      ? Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, rm '${target}'`), { code: "EBUSY" }))
      : actual.rm(target, options);
  return { ...actual, default: { ...actual, rm }, rm };
});

const temps: string[] = [];
afterEach(async () => {
  unremovable = "";
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  // As in api-profile.integration.test.ts: the graph's dir-lock exit listener goes with it.
  process.off("exit", (await import("../core/dir-lock.js")).removeHeldDirLocks);
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

const addLockPath = (name: string) => path.join(currentHome, ".clausona", "locks", `add-claude-${name}.lock`);

/**
 * Backdates the add lock for `name` past its stale time, as it is once the add holding it has
 * stopped refreshing it - that add died, or was suspended mid-sign-in - so that the next add of
 * the name takes it over.
 */
function staleAddLock(name: string) {
  const then = new Date(Date.now() - 10 * 60_000);
  utimesSync(addLockPath(name), then, then);
}

/** Every path under the home, with each file's content: what a refused add must leave as it was. */
function homeTree(): Record<string, string> {
  const entries = readdirSync(currentHome, { recursive: true, encoding: "utf8" });
  return Object.fromEntries(
    entries.map((entry) => {
      const full = path.join(currentHome, entry);
      return [entry, lstatSync(full).isFile() ? readFileSync(full, "utf8") : "not a file"];
    }),
  );
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
  const login = vi.spyOn(claudeAdapter, "runLogin").mockImplementation(async (configDir) => {
    const name = path.basename(configDir).replace(/^\.claude-/, "");
    writeAccount(configDir, `${name}@example.com`);
    writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: name } }));
    const gate = logins.get(name);
    logins.delete(name);
    gate?.started.resolve();
    await gate?.finish.promise;
    return true;
  });
  // The check after a login is answered here too, not by whatever `claude` is on PATH, which
  // would find no token where the stand-in wrote one.
  vi.spyOn(claudeAdapter, "verifySignIn").mockResolvedValue({ ok: true });

  /** Holds the next login for profile `name` open until `finish` is called. */
  const holdLogin = (name: string) => {
    const gate = { started: deferred(), finish: deferred() };
    logins.set(name, gate);
    return { started: gate.started.promise, finish: gate.finish.resolve };
  };

  return { service, holdLogin, login, primary };
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
    // Another add of the name gets in only once this one's lock has gone stale.
    staleAddLock("x");
    await service.addProfile({ tool: "claude", name: "x", fromPath: elsewhere });
    x.finish();

    // Not the first check's "already exists", which reads as a mistyped name: what was thrown
    // away is the sign-in the user had just finished.
    await expect(addingX).rejects.toThrow(
      `Profile 'claude:x' was registered by another clausona process while this sign-in was in progress, so this sign-in was not saved. ${path.join("~", ".claude-x")} was removed. Run \`clausona list\` to see that profile.`,
    );
    expect(existsSync(path.join(currentHome, ".claude-x"))).toBe(false);
    expect(readRegistry().profiles["claude:x"]?.configDir).toBe(elsewhere);
    expect(existsSync(path.join(elsewhere, ".claude.json"))).toBe(true);
  });

  it("says the directory is still there when that add could not remove it", async () => {
    const { service, holdLogin } = await setup();
    const dir = path.join(currentHome, ".claude-x");
    const elsewhere = path.join(currentHome, "elsewhere");
    writeAccount(elsewhere, "elsewhere@example.com");
    const x = holdLogin("x");

    const addingX = service.addProfile({ tool: "claude", name: "x" });
    await x.started;
    staleAddLock("x");
    await service.addProfile({ tool: "claude", name: "x", fromPath: elsewhere });
    unremovable = dir;
    x.finish();

    // The command that deletes it is the platform's own.
    await expect(addingX).rejects.toThrow(
      `so this sign-in was not saved. ${path.join("~", ".claude-x")} could not be removed: delete it with \``,
    );
    expect(existsSync(dir)).toBe(true);
  });

  // With nothing to set aside, the import leaves the shared backup directory empty and the
  // first add gets as far as registering. With something, the import's backup holds it and
  // the first add's claim on that directory is refused before it registers.
  for (const backup of ["empty", "holding the import's settings"] as const) {
    it(`leaves the directory alone when the add that took the name registered it (backup ${backup})`, async () => {
      const { service, holdLogin, primary } = await setup();
      const dir = path.join(currentHome, ".claude-x");
      const x = holdLogin("x");

      const addingX = service.addProfile({ tool: "claude", name: "x" });
      await x.started;
      if (backup !== "empty") {
        writeFileSync(path.join(primary, "settings.json"), "{}");
        writeFileSync(path.join(dir, "settings.json"), '{"theme":"x"}');
      }
      // The stand-in login has already stored the account, so importing the directory works.
      staleAddLock("x");
      await service.addProfile({ tool: "claude", name: "x", fromPath: dir });
      x.finish();

      await expect(addingX).rejects.toThrow(
        `Profile 'claude:x' was registered by another clausona process while this sign-in was in progress, so this sign-in was not saved. ${path.join("~", ".claude-x")} is now that profile's.`,
      );
      // Deleting it would leave the registered profile pointing at nothing.
      expect(readRegistry().profiles["claude:x"]?.configDir).toBe(dir);
      expect(existsSync(path.join(dir, ".claude.json"))).toBe(true);
    });
  }

  it("leaves the directory alone when the profile that took the name registered it by another path", async () => {
    const { service, holdLogin } = await setup();
    const dir = path.join(currentHome, ".claude-x");
    const link = path.join(currentHome, "link-to-x");
    const x = holdLogin("x");

    const addingX = service.addProfile({ tool: "claude", name: "x" });
    await x.started;
    // Another clausona process registers the directory under the name, spelled another way: a
    // link here, which a case-sensitive filesystem has too; on a case-insensitive one, the same
    // name in another case is such a spelling.
    symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
    const registry = readRegistry();
    registry.profiles["claude:x"] = { tool: "claude", configDir: link, email: "x@example.com" };
    writeFileSync(registryPath(), JSON.stringify(registry));
    x.finish();

    await expect(addingX).rejects.toThrow(`${path.join("~", ".claude-x")} is now that profile's.`);
    expect(existsSync(path.join(dir, ".claude.json"))).toBe(true);
  });

  // Another clausona process registers the name, or one that differs only by case, while the
  // import is being set up: the stand-in writes the registry as that process would. The
  // import's links are undone, but the directory is the user's own and stays.
  for (const { taker, undo } of [
    { taker: "claude:x", undo: "finishes" },
    { taker: "claude:X", undo: "finishes" },
    { taker: "claude:x", undo: "fails" },
  ] as const) {
    it(`rejects an import whose name was taken during its setup as ${taker} and keeps the directory (undo ${undo})`, async () => {
      const { service, primary } = await setup();
      // Something the primary shares, so the import makes a link for the undo to take out.
      writeFileSync(path.join(primary, "settings.json"), "{}");
      const elsewhere = path.join(currentHome, "elsewhere");
      writeAccount(elsewhere, "elsewhere@example.com");
      if (undo === "fails") unremovable = path.join(elsewhere, "settings.json");
      const { claudeAdapter } = await import("../tools/claude.js");
      const skipSet = claudeAdapter.sharedSkipSet.bind(claudeAdapter);
      vi.spyOn(claudeAdapter, "sharedSkipSet").mockImplementationOnce((mergeSessions) => {
        const registry = readRegistry();
        registry.profiles[taker] = {
          tool: "claude",
          configDir: path.join(currentHome, ".claude-x"),
          email: "x@example.com",
        };
        writeFileSync(registryPath(), JSON.stringify(registry));
        return skipSet(mergeSessions);
      });

      const byCase = taker === "claude:x" ? "" : " (names are compared without case)";
      const kept =
        undo === "finishes"
          ? "was kept, and the links this import made in it were undone."
          : "was kept, but undoing this import did not finish, so it may still hold links to the primary: remove them before using it again.";
      await expect(service.addProfile({ tool: "claude", name: "x", fromPath: elsewhere })).rejects.toThrow(
        `Profile '${taker}' was registered by another clausona process while this import was being set up${byCase}, so the import was not saved. ${path.join("~", "elsewhere")} ${kept} Run \`clausona list\` to see that profile.`,
      );
      expect(readRegistry().profiles[taker]?.configDir).toBe(path.join(currentHome, ".claude-x"));
      // It held nothing but its account, so anything more is a link the import left.
      expect(readdirSync(elsewhere).sort()).toEqual(
        undo === "finishes" ? [".claude.json"] : [".claude.json", "settings.json"],
      );
    });
  }

  it("keeps API profiles added and changed while an add is signing in", async () => {
    const { service, holdLogin } = await setup();
    const a = holdLogin("a");

    const addingA = service.addProfile({ tool: "claude", name: "a" });
    await a.started;
    await service.addApiProfile({
      tool: "claude",
      name: "gw",
      baseUrl: "https://gw.example.com",
      authScheme: "bearer",
      secret: { source: "env", name: "GW_KEY" },
    });
    await service.updateProfileApi("claude:gw", { label: "Gateway" });
    await service.updateProfileEnv("claude:gw", { set: { ANTHROPIC_MODEL: "glm-5" } });
    await service.updateProfileSecret("claude:gw", { source: "env", name: "OTHER_KEY" });
    a.finish();
    await addingA;

    const registry = readRegistry();
    expect(registry.profiles["claude:a"]?.email).toBe("a@example.com");
    expect(registry.profiles["claude:gw"]).toMatchObject({
      kind: "api",
      label: "Gateway",
      env: { ANTHROPIC_MODEL: "glm-5" },
      api: { baseUrl: "https://gw.example.com", secret: { source: "env", name: "OTHER_KEY" } },
    });
  });

  it("keeps an API profile changed while init is setting up the accounts", async () => {
    const { service, primary } = await setup();
    const work = path.join(currentHome, ".claude-work");
    await service.addApiProfile({
      tool: "claude",
      name: "gw",
      baseUrl: "https://gw.example.com",
      authScheme: "bearer",
      secret: { source: "env", name: "GW_KEY" },
    });

    // Linking claude:work asks for the skip set after init has read the registry and before
    // it writes. A `config --label` from another terminal lands there: init holds no lock
    // while it sets up, so that process writes the registry as this stand-in does.
    const { claudeAdapter } = await import("../tools/claude.js");
    const skipSet = claudeAdapter.sharedSkipSet.bind(claudeAdapter);
    const setUp = vi.spyOn(claudeAdapter, "sharedSkipSet").mockImplementationOnce((mergeSessions) => {
      const registry = readRegistry();
      registry.profiles["claude:gw"].label = "Gateway";
      writeFileSync(registryPath(), JSON.stringify(registry));
      return skipSet(mergeSessions);
    });

    const account = (configDir: string, email: string, isPrimary: boolean): DiscoveredAccount => ({
      tool: "claude",
      configDir,
      jsonPath: isPrimary ? path.join(currentHome, ".claude.json") : path.join(configDir, ".claude.json"),
      email,
      keychainService: "",
      isPrimary,
    });
    await service.initializeRegistry({
      accounts: [account(primary, "primary@example.com", true), account(work, "work@example.com", false)],
      profileNames: { [primary]: "default", [work]: "work" },
    });

    expect(setUp).toHaveBeenCalled();
    expect(readRegistry().profiles["claude:gw"]).toMatchObject({ kind: "api", label: "Gateway" });
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

describe("adds of one name", { timeout: 30_000 }, () => {
  // Names that differ only by case are one directory on a case-insensitive filesystem, so they
  // are one name here too.
  for (const second of [
    { name: "x", from: false },
    { name: "X", from: false },
    { name: "x", from: true },
  ]) {
    const how = second.from ? " with --from" : "";
    it(`refuses an add of '${second.name}'${how} at once while one of 'x' is signing in, and changes nothing`, async () => {
      const { service, holdLogin, login } = await setup();
      const elsewhere = path.join(currentHome, "elsewhere");
      writeAccount(elsewhere, "elsewhere@example.com");
      const x = holdLogin("x");

      const addingX = service.addProfile({ tool: "claude", name: "x" });
      await x.started;
      const before = homeTree();

      await expect(
        service.addProfile({ tool: "claude", name: second.name, fromPath: second.from ? elsewhere : undefined }),
      ).rejects.toThrow(
        `Another \`clausona add\` of 'claude:${second.name}' (or of the same name in another case) is in progress. Wait for it to finish; if it was interrupted, try again in 30 seconds.`,
      );
      expect(homeTree()).toEqual(before);
      expect(login).toHaveBeenCalledTimes(1);

      x.finish();
      await expect(addingX).resolves.toMatchObject({ email: "x@example.com" });
      expect(readRegistry().profiles["claude:x"]?.configDir).toBe(path.join(currentHome, ".claude-x"));
      expect(existsSync(addLockPath("x"))).toBe(false);
    });
  }

  it("takes over the lock an add that died left behind, once it has gone stale", async () => {
    const { service, login } = await setup();
    // What an add killed mid-sign-in leaves: its directory, still marked, and its lock.
    const dir = path.join(currentHome, ".claude-x");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".clausona-pending"), "");
    mkdirSync(addLockPath("x"), { recursive: true });

    await expect(service.addProfile({ tool: "claude", name: "x" })).rejects.toThrow("is in progress");
    expect(login).not.toHaveBeenCalled();

    staleAddLock("x");
    await service.addProfile({ tool: "claude", name: "x" });

    expect(login).toHaveBeenCalledWith(dir);
    expect(readRegistry().profiles["claude:x"]?.configDir).toBe(dir);
    expect(existsSync(addLockPath("x"))).toBe(false);
  });
});
