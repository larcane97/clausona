import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import type { DoctorIssue, Registry } from "../types.js";

/**
 * Each Claude profile keeps its own plugins/installed_plugins.json, with the paths in it under
 * its own config dir. `claude plugin install`, `update` and `uninstall` rewrite only the list of
 * the profile they run in; the plugin sync carries the change to every other profile the next
 * time that profile is synced.
 *
 * ~/.clausona is resolved from homedir() at module load, so the module graph has to see a
 * temporary home.
 */
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

/**
 * A seam into every file read: `afterRead` runs once a read has finished, before the reader
 * sees the result, which lets a test do what Claude Code could do at that moment.
 */
const fsHooks = vi.hoisted(() => ({ afterRead: undefined as ((target: string) => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    fsHooks.afterRead?.(String(args[0]));
    return content;
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const temps: string[] = [];
afterEach(() => {
  fsHooks.afterRead = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

type Record_ = Record<string, unknown>;
type Installs = Record<string, Record_[]>;

/** A time on one day, `minute` minutes past noon: the order of changes is all a test needs. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();

/** `ownCache` names the profiles whose plugin cache is a directory of their own, not a link. */
async function setup(names: string[] = ["work", "play"], { ownCache = [] as string[] } = {}) {
  currentHome = realpathSync(mkdtempSync(path.join(tmpdir(), "clausona-installs-")));
  temps.push(currentHome);
  const primary = path.join(currentHome, ".claude");
  const dirs: Record<string, string> = { primary };
  for (const name of names) dirs[name] = path.join(currentHome, `.claude-${name}`);
  for (const dir of Object.values(dirs)) mkdirSync(path.join(dir, "plugins"), { recursive: true });
  // Each profile reaches the primary's plugin cache through a link, as setupPluginsDir makes it.
  const primaryCache = path.join(primary, "plugins", "cache");
  mkdirSync(primaryCache);
  for (const name of names) {
    const cache = path.join(dirs[name] as string, "plugins", "cache");
    if (ownCache.includes(name)) mkdirSync(cache);
    else symlinkSync(primaryCache, cache, "junction");
  }

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "p@example.com", isPrimary: true },
      ...Object.fromEntries(
        names.map((name) => [
          `claude:${name}`,
          { tool: "claude", configDir: dirs[name], email: `${name}@example.com` },
        ]),
      ),
    },
  };
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  vi.resetModules();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const service = await import("./service.js");
  const listPath = (dir: string) => path.join(dir, "plugins", "installed_plugins.json");

  return {
    home: currentHome,
    dirs,
    all: Object.values(dirs),
    service,
    /** What `claude plugin install` leaves in `dir`'s list: a path under that config dir. */
    record(dir: string, plugin: string, version: string, minute: number, extra: Record_ = {}): Record_ {
      return {
        scope: "user",
        installPath: path.join(dir, "plugins", "cache", "mkt", plugin, version),
        version,
        installedAt: at(0),
        lastUpdated: at(minute),
        ...extra,
      };
    },
    /** A version in the shared plugin cache, which every profile reaches through its link. */
    cache(plugin: string, version: string) {
      mkdirSync(path.join(primary, "plugins", "cache", "mkt", plugin, version), { recursive: true });
    },
    /** Writes `dir`'s list as Claude Code does, last changed at `minute` when given. */
    write(dir: string, plugins: Installs, minute?: number) {
      writeFileSync(listPath(dir), JSON.stringify({ version: 2, plugins }, null, 2));
      if (minute !== undefined) {
        const time = new Date(at(minute));
        utimesSync(listPath(dir), time, time);
      }
    },
    read(dir: string): Installs {
      return JSON.parse(readFileSync(listPath(dir), "utf8")).plugins;
    },
    sync: (dir: string) => service.syncPluginsJson(dir, primary),
  };
}

describe("installed_plugins.json across Claude profiles", () => {
  it("brings an update made in one profile to another the next time that one is synced", async () => {
    const h = await setup();
    const { primary, work, play } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("p", "1.1.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) expect(await h.sync(dir)).toMatchObject({ ok: true });

    // `claude plugin update p@mkt` in work.
    h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", 10)] });
    expect(await h.sync(play)).toMatchObject({ ok: true });

    expect(h.read(play)).toEqual({ "p@mkt": [h.record(play, "p", "1.1.0", 10)] });
    expect(h.read(primary)).toEqual({ "p@mkt": [h.record(primary, "p", "1.1.0", 10)] });
    // work keeps what it installed.
    await h.sync(work);
    expect(h.read(work)).toEqual({ "p@mkt": [h.record(work, "p", "1.1.0", 10)] });
  });

  it("brings an install made in the primary to a profile", async () => {
    const h = await setup();
    const { primary, work } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("q", "1.0.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);

    h.write(primary, { "p@mkt": [h.record(primary, "p", "1.0.0", 0)], "q@mkt": [h.record(primary, "q", "1.0.0", 5)] });
    await h.sync(work);

    expect(Object.keys(h.read(work))).toEqual(["p@mkt", "q@mkt"]);
    expect(h.read(work)["q@mkt"]).toEqual([h.record(work, "q", "1.0.0", 5)]);
  });

  it("carries an uninstall to the others, and no profile's older copy brings it back", async () => {
    const h = await setup(["work", "play", "solo"]);
    const { primary, work, play, solo } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("q", "1.0.0");
    for (const dir of h.all) {
      h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)], "q@mkt": [h.record(dir, "q", "1.0.0", 0)] });
    }
    for (const dir of h.all) await h.sync(dir);

    // `claude plugin uninstall q@mkt` in work.
    h.write(work, { "p@mkt": [h.record(work, "p", "1.0.0", 0)] }, 30);
    await h.sync(play);

    expect(Object.keys(h.read(play))).toEqual(["p@mkt"]);
    expect(Object.keys(h.read(primary))).toEqual(["p@mkt"]);
    // solo has not been synced since, so it still lists q, as it did after its last sync.
    // That is no install of its own, and it must not undo the uninstall.
    expect(Object.keys(h.read(solo))).toEqual(["p@mkt", "q@mkt"]);
    for (const dir of [solo, primary, play, work, solo]) await h.sync(dir);
    for (const dir of h.all) expect(Object.keys(h.read(dir)), dir).toEqual(["p@mkt"]);
  });

  it("takes every profile's plugins on the first sync, the newest of each, without those no longer on disk", async () => {
    const h = await setup();
    const { primary, work, play } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("p", "1.1.0");
    h.cache("q", "2.0.0");
    // Lists from before this sync existed: each profile installed on its own.
    h.write(primary, {
      "p@mkt": [h.record(primary, "p", "1.0.0", 0)],
      "gone@mkt": [h.record(primary, "gone", "1.0.0", 0)],
    });
    h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", 10)] });
    h.write(play, { "q@mkt": [h.record(play, "q", "2.0.0", 5)] });

    await h.sync(play);

    const expected = (dir: string) => ({
      "p@mkt": [h.record(dir, "p", "1.1.0", 10)],
      "q@mkt": [h.record(dir, "q", "2.0.0", 5)],
    });
    expect(h.read(play)).toEqual(expected(play));
    expect(h.read(primary)).toEqual(expected(primary));
    await h.sync(work);
    expect(h.read(work)).toEqual(expected(work));
  });

  it("carries an install for one project with its project path, apart from the user's", async () => {
    const h = await setup();
    const { primary, work, play } = h.dirs;
    const project = path.join(h.home, "app");
    h.cache("p", "1.0.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);

    // `claude plugin install p@mkt --scope project`, run in ~/app under work.
    const forProject = { scope: "project", projectPath: project };
    h.write(work, { "p@mkt": [h.record(work, "p", "1.0.0", 0), h.record(work, "p", "1.0.0", 20, forProject)] });
    await h.sync(play);

    expect(h.read(play)).toEqual({
      "p@mkt": [h.record(play, "p", "1.0.0", 0), h.record(play, "p", "1.0.0", 20, forProject)],
    });

    // Uninstalling it from the project, in play, leaves the user's install alone.
    h.write(play, { "p@mkt": [h.record(play, "p", "1.0.0", 0)] }, 40);
    await h.sync(primary);
    await h.sync(work);
    expect(h.read(work)).toEqual({ "p@mkt": [h.record(work, "p", "1.0.0", 0)] });
  });

  describe("when two profiles changed the same plugin", () => {
    async function changedTwice(updatedAt: number, uninstalledAt: number) {
      const h = await setup();
      const { primary, work, play } = h.dirs;
      h.cache("p", "1.0.0");
      h.cache("p", "1.1.0");
      for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
      for (const dir of h.all) await h.sync(dir);

      h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", updatedAt)] }, updatedAt);
      h.write(play, {}, uninstalledAt);
      await h.sync(primary);
      return h;
    }

    it("keeps an update made after the uninstall", async () => {
      const h = await changedTwice(20, 10);
      expect(h.read(h.dirs.primary)).toEqual({ "p@mkt": [h.record(h.dirs.primary, "p", "1.1.0", 20)] });
    });

    it("drops the plugin when the uninstall came after the update", async () => {
      const h = await changedTwice(10, 20);
      expect(h.read(h.dirs.primary)).toEqual({});
    });
  });

  it("leaves every list alone when nothing changed since the last sync", async () => {
    const h = await setup();
    h.cache("p", "1.0.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);

    for (const dir of h.all) expect(await h.sync(dir), dir).toEqual({ ok: true, changed: false });
  });

  /**
   * A profile set up while the primary had no plugin cache keeps a cache of its own: what it
   * installs is in no other profile's reach, and the others' installs in none of its. Its list
   * stays its own, as it was before lists were shared, rather than losing what only it has.
   */
  it("leaves a profile with a plugin cache of its own to its own list", async () => {
    const h = await setup(["work", "play"], { ownCache: ["work"] });
    const { primary, work, play } = h.dirs;
    mkdirSync(path.join(work, "plugins", "cache", "mkt", "own", "1.0.0"), { recursive: true });
    h.cache("p", "1.0.0");
    h.write(primary, { "p@mkt": [h.record(primary, "p", "1.0.0", 0)] });
    h.write(work, { "own@mkt": [h.record(work, "own", "1.0.0", 0)] });

    await h.sync(work);
    await h.sync(play);

    expect(h.read(work)).toEqual({ "own@mkt": [h.record(work, "own", "1.0.0", 0)] });
    expect(h.read(play)).toEqual({ "p@mkt": [h.record(play, "p", "1.0.0", 0)] });
    expect(h.read(primary)).toEqual({ "p@mkt": [h.record(primary, "p", "1.0.0", 0)] });
  });

  /**
   * Another profile's sync writes the primary's list, where Claude Code may be running. An
   * install it writes there while the sync is merging must not be written over: the sync gives
   * up, and the next one takes it in.
   */
  it("gives up rather than write over a list Claude Code rewrote while it was merging", async () => {
    const h = await setup();
    const { primary, play } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("q", "1.0.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);
    const installedInPrimary = {
      "p@mkt": [h.record(primary, "p", "1.0.0", 0)],
      "q@mkt": [h.record(primary, "q", "1.0.0", 30)],
    };
    const primaryList = path.join(primary, "plugins", "installed_plugins.json");
    let installed = false;
    fsHooks.afterRead = (target) => {
      if (target !== primaryList || installed) return;
      installed = true;
      h.write(primary, installedInPrimary);
    };

    expect(await h.sync(play)).toMatchObject({ ok: false });
    expect(h.read(primary)).toEqual(installedInPrimary);

    fsHooks.afterRead = undefined;
    expect(await h.sync(play)).toMatchObject({ ok: true });
    expect(Object.keys(h.read(play))).toEqual(["p@mkt", "q@mkt"]);
  });

  it("does not take a profile's missing list for an uninstall of everything", async () => {
    const h = await setup();
    const { primary, work } = h.dirs;
    h.cache("p", "1.0.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);

    rmSync(path.join(work, "plugins", "installed_plugins.json"));
    await h.sync(primary);

    expect(Object.keys(h.read(primary))).toEqual(["p@mkt"]);
  });
});

describe("doctor and a profile's plugin list", () => {
  const differs = (issues: DoctorIssue[]) => issues.filter((issue) => issue.kind === "installed_plugins_differ");

  it("warns about a profile whose list differs from the primary's, and repair brings it in line", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const h = await setup();
    const { work } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("p", "1.1.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);
    const issuesOf = async (id: string) =>
      (await h.service.doctorProfiles()).find((result) => result.name === id)?.issues ?? [];

    expect(differs(await issuesOf("claude:work"))).toEqual([]);

    h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", 10)] });

    const [issue] = differs(await issuesOf("claude:work"));
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("p@mkt 1.1.0 here, 1.0.0 in the primary");
    expect(differs(await issuesOf("claude:play"))).toEqual([]);

    await h.service.repairProfile("claude:work");

    expect(differs(await issuesOf("claude:work"))).toEqual([]);
    // The primary has 1.1.0 now, and play has not been synced since.
    expect(differs(await issuesOf("claude:play"))).toHaveLength(1);
    // repair links the primary's plugins/ entries into the profile, but not clausona's own
    // record of the primary's list: each profile keeps its own.
    for (const name of readdirSync(path.join(work, "plugins")).filter((n) => n.startsWith(".clausona"))) {
      expect(lstatSync(path.join(work, "plugins", name)).isSymbolicLink(), name).toBe(false);
    }
    expect(readdirSync(path.join(work, "plugins")).some((n) => n.startsWith(".clausona-installed"))).toBe(true);
  });
});
