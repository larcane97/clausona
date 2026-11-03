import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import type { DiscoveredAccount, QuotaSnapshot, Registry } from "../types.js";

// service.ts and quota-store.ts resolve ~/.clausona at module load, so the whole module graph has
// to see a temporary home. The mock reads `currentHome`, which each case sets before re-importing.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // As in api-profile.integration.test.ts: the graph's dir-lock exit listener goes with it.
  process.off("exit", (await import("../core/dir-lock.js")).removeHeldDirLocks);
  vi.resetModules();
});
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const writeAccount = (configDir: string, email: string) =>
  writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));

/**
 * A throwaway home with the primary and `claude:work` on ~/.claude-work, registered to
 * first@example.com. `profiles` adds to those entries.
 */
function seedHome(profiles: (home: string) => Registry["profiles"] = () => ({})) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-reregister-"));
  temps.push(home);
  const primary = path.join(home, ".claude");
  const work = path.join(home, ".claude-work");
  mkdirSync(primary);
  mkdirSync(work);
  writeAccount(work, "first@example.com");
  mkdirSync(path.join(home, ".clausona"));
  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "first@example.com" },
      ...profiles(home),
    },
  };
  writeFileSync(path.join(home, ".clausona", "profiles.json"), JSON.stringify(registry));
  return { home, primary, work };
}

const quotaPath = (home: string) => path.join(home, ".clausona", "quota.json");

function seedReadings(home: string, profiles: Record<string, unknown>) {
  writeFileSync(quotaPath(home), JSON.stringify({ version: 1, cooldowns: {}, profiles }));
}

const readings = (home: string): Record<string, QuotaSnapshot> =>
  JSON.parse(readFileSync(quotaPath(home), "utf8")).profiles;

const NEW_NUMBERS = { session: { usedPercent: 12, resetsAt: null }, weekly: { usedPercent: 34, resetsAt: null } };

/**
 * Loads the real service against `home`, with the sign-in and the usage endpoint replaced:
 * adapter stubs rather than a binary on PATH, so the cases stay off the PowerShell shim that
 * `claude.cmd` resolves through on Windows. The login lands on `signInAs`, and the endpoint
 * answers with NEW_NUMBERS for that account.
 */
async function loadService(home: string, signInAs = "second@example.com") {
  currentHome = home;
  vi.resetModules();
  const { getAdapter } = await import("../tools/registry.js");
  const service = await import("./service.js");
  const adapter = getAdapter("claude");
  vi.spyOn(adapter, "runLogin").mockImplementation(async (configDir) => {
    writeAccount(configDir, signInAs);
    return true;
  });
  // The check after a login is answered here too, not by whatever `claude` is on PATH.
  vi.spyOn(adapter, "verifySignIn").mockResolvedValue({ ok: true });
  vi.spyOn(adapter, "readCredential").mockResolvedValue({ accessToken: "new-sign-in", refreshToken: "r" });
  vi.spyOn(adapter, "fetchQuota").mockResolvedValue(NEW_NUMBERS);
  vi.spyOn(adapter, "credentialAccount").mockResolvedValue(signInAs);
  return { ...service, adapter };
}

// A minute old, so that a served reading is one the five minutes would keep.
const fresh = () => Date.now() - 60_000;
const okReading = () => ({ state: "ok", fetchedAt: fresh(), weekly: { usedPercent: 99, resetsAt: null } });
const verdict = (signedInAs: string) => ({ state: "other_account", fetchedAt: fresh(), signedInAs });

describe("removing a profile", () => {
  it("forgets its reading and leaves the others'", async () => {
    const { home } = seedHome();
    const { removeProfile } = await loadService(home);
    const kept = okReading();
    seedReadings(home, { "claude:work": okReading(), "claude:default": kept });

    await removeProfile("claude:work");

    expect(readings(home)).toEqual({ "claude:default": kept });
  });

  it("keeps whose sign-in a token was found to be, which only ever answers for that token", async () => {
    const { home } = seedHome();
    const { removeProfile } = await loadService(home);
    const identities = { "claude:work": { token: "0123456789abcdef", account: "first@example.com" } };
    writeFileSync(
      quotaPath(home),
      JSON.stringify({ version: 1, cooldowns: {}, profiles: { "claude:work": okReading() }, identities }),
    );

    await removeProfile("claude:work");

    expect(JSON.parse(readFileSync(quotaPath(home), "utf8")).identities).toEqual(identities);
  });
});

describe("removing a profile and adding the name again", () => {
  // The first is what happened: the store had held another account's sign-in, and that account
  // is what the profile was added back as. The second is the same hole showing no warning at all.
  it.each([
    ["the other-account verdict it had", () => verdict("second@example.com")],
    ["the previous account's numbers", okReading],
  ])("shows the new sign-in's reading, not %s", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async (_label, previous) => {
    const { home, work } = seedHome();
    const { addProfile, adapter, listProfiles, removeProfile } = await loadService(home);
    seedReadings(home, { "claude:work": previous(), "claude:default": okReading() });

    await removeProfile("claude:work");
    rmSync(work, { recursive: true, force: true });
    await addProfile({ tool: "claude", name: "work" });
    const row = (await listProfiles({ quota: true })).find((item) => item.name === "claude:work");

    expect(row?.email).toBe("second@example.com");
    expect(row?.quota).toMatchObject({ state: "ok", ...NEW_NUMBERS });
    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
  });
});

// With nothing removed first: an entry taken out of profiles.json by hand leaves its reading
// behind, and so does a read that was under way during the remove and wrote it back afterwards.
describe("adding a name the cache still has a reading for", () => {
  it("forgets it on a new sign-in", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { home } = seedHome();
    const { addProfile } = await loadService(home);
    const kept = okReading();
    seedReadings(home, { "claude:fresh": okReading(), "claude:default": kept });

    await addProfile({ tool: "claude", name: "fresh" });

    expect(readings(home)).toEqual({ "claude:default": kept });
  });

  it("forgets it on an import", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { home } = seedHome();
    const imported = path.join(home, ".claude-elsewhere");
    mkdirSync(imported);
    writeAccount(imported, "imported@example.com");
    const { addProfile } = await loadService(home);
    const kept = okReading();
    seedReadings(home, { "claude:imported": okReading(), "claude:default": kept });

    await addProfile({ tool: "claude", name: "imported", fromPath: imported });

    expect(readings(home)).toEqual({ "claude:default": kept });
  });

  it("forgets it for an API profile, and the spend it held", async () => {
    const { home } = seedHome();
    const { addApiProfile } = await loadService(home);
    const kept = okReading();
    seedReadings(home, {
      "claude:gw": { state: "ok", fetchedAt: fresh(), spend: { totalUsd: 107 } },
      "claude:default": kept,
    });

    await addApiProfile({
      tool: "claude",
      name: "gw",
      baseUrl: "https://gw.example.com",
      authScheme: "bearer",
      secret: { source: "env", name: "GW_KEY" },
    });

    expect(readings(home)).toEqual({ "claude:default": kept });
  });
});

describe("a quota cache that cannot be written", () => {
  it("fails neither a remove nor the add after it", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { home, work } = seedHome();
    const { addProfile, loadRegistry, removeProfile } = await loadService(home);
    seedReadings(home, { "claude:work": okReading() });
    // Where writeCache puts the new contents before renaming them into place.
    mkdirSync(`${quotaPath(home)}.tmp.${process.pid}`);

    await removeProfile("claude:work");
    expect((await loadRegistry())?.profiles["claude:work"]).toBeUndefined();

    rmSync(work, { recursive: true, force: true });
    await addProfile({ tool: "claude", name: "work" });
    expect((await loadRegistry())?.profiles["claude:work"]?.email).toBe("second@example.com");
  });
});

describe("init", () => {
  const found = (configDir: string, email: string, isPrimary = false): DiscoveredAccount => ({
    tool: "claude",
    configDir,
    jsonPath: path.join(configDir, ".claude.json"),
    email,
    keychainService: "unused",
    isPrimary,
  });

  it("forgets the reading of a name that now means something else, and keeps the rest", async () => {
    const { home, primary, work } = seedHome((dir) => ({
      "claude:changed": { tool: "claude", configDir: path.join(dir, ".claude-changed"), email: "old@example.com" },
      "claude:moved": { tool: "claude", configDir: path.join(dir, ".claude-old"), email: "same@example.com" },
      "claude:gone": { tool: "claude", configDir: path.join(dir, ".claude-gone"), email: "gone@example.com" },
      "claude:gw": {
        tool: "claude",
        kind: "api",
        configDir: path.join(dir, ".claude-gw"),
        email: "",
        api: { baseUrl: "https://gw.example.com", authScheme: "bearer", secret: { source: "env", name: "GW_KEY" } },
      },
    }));
    const changed = path.join(home, ".claude-changed");
    const moved = path.join(home, ".claude-new");
    for (const dir of [changed, moved, path.join(home, ".claude-old"), path.join(home, ".claude-gone")]) mkdirSync(dir);
    const { initializeRegistry } = await loadService(home);
    // Nothing about these changed: running init again is no reason to ask every usage endpoint
    // over, and an API profile's reading holds what its budget counts from.
    const kept = {
      "claude:default": okReading(),
      "claude:work": okReading(),
      "claude:gw": { state: "ok", fetchedAt: fresh(), spend: { totalUsd: 107 } },
    };
    seedReadings(home, {
      ...kept,
      "claude:changed": okReading(),
      "claude:moved": okReading(),
      "claude:gone": okReading(),
    });

    await initializeRegistry({
      accounts: [
        found(primary, "primary@example.com", true),
        found(work, "first@example.com"),
        found(changed, "new@example.com"),
        found(moved, "same@example.com"),
      ],
      profileNames: { [primary]: "default", [work]: "work", [changed]: "changed", [moved]: "moved" },
    });

    expect(readings(home)).toEqual(kept);
  });
});
