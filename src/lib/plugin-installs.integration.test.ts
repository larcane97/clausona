import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pluginSyncStampPath, syncWithStamp } from "../core/launch-cache.js";
import { SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import type { DoctorIssue, Registry } from "../types.js";
import { offersRepair } from "./format.js";

/**
 * Each Claude profile keeps its own plugins/installed_plugins.json, with the paths in it under
 * its own config dir. `claude plugin install`, `update` and `uninstall` rewrite only the list of
 * the profile they run in; the plugin sync carries the change to every other profile the next
 * time that profile is synced.
 *
 * ~/.clausona is resolved from homedir() at module load, so the module graph has to see a
 * temporary home. Hoisted, since some of the modules imported below ask for it as they load.
 */
const fakeHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  // Never the real home, even before a test has made one.
  const homedir = () => fakeHome.current || `${actual.tmpdir()}/clausona-installs-no-home`;
  return { ...actual, default: { ...actual, homedir }, homedir };
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
  const currentHome = realpathSync(mkdtempSync(path.join(tmpdir(), "clausona-installs-")));
  fakeHome.current = currentHome;
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
    listPath,
    /** clausona's record of `dir`'s list, beside it. */
    recordPath: (dir: string) => path.join(dir, "plugins", ".clausona-installed-plugins.json"),
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

  /**
   * A version folder can be gone for a while - a cache on a drive that is not there, a version
   * Claude Code cleared before another profile reinstalled it. Claude Code cannot load a record
   * whose folder is gone, so no profile is given it meanwhile; but it is no uninstall, and once
   * the folder is back, so is the plugin, in every profile.
   */
  it("keeps a plugin whose folder is gone for now, and gives it back once the folder is there", async () => {
    const h = await setup();
    const { primary, work, play } = h.dirs;
    h.cache("p", "1.0.0");
    h.cache("q", "1.0.0");
    for (const dir of h.all) {
      h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)], "q@mkt": [h.record(dir, "q", "1.0.0", 0)] });
    }
    for (const dir of h.all) await h.sync(dir);
    const folder = path.join(primary, "plugins", "cache", "mkt", "q", "1.0.0");

    renameSync(folder, `${folder}.away`);
    for (const dir of [work, play, primary]) expect(await h.sync(dir), dir).toMatchObject({ ok: true });
    for (const dir of h.all) expect(Object.keys(h.read(dir)), dir).toEqual(["p@mkt"]);

    renameSync(`${folder}.away`, folder);
    for (const dir of [work, play]) await h.sync(dir);
    for (const dir of h.all) expect(Object.keys(h.read(dir)), dir).toEqual(["p@mkt", "q@mkt"]);
    expect(h.read(play)["q@mkt"]).toEqual([h.record(play, "q", "1.0.0", 0)]);
  });

  /**
   * A profile that had a plugin cache of its own, linked to the primary's at last - what repair
   * does - joins with no record and a list as old as its own last launch. What it changed after
   * the last sync is its own; the rest is an old copy of the shared list, and a plugin that was
   * uninstalled meanwhile stays uninstalled.
   */
  it("takes from a profile joining late only what it changed after the last sync", async () => {
    const h = await setup(["work", "late"], { ownCache: ["late"] });
    const { primary, work, late } = h.dirs;
    for (const plugin of ["p", "q", "r"]) h.cache(plugin, "1.0.0");
    for (const dir of h.all) {
      h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)], "q@mkt": [h.record(dir, "q", "1.0.0", 0)] });
    }
    for (const dir of [primary, work]) await h.sync(dir);
    // `claude plugin uninstall q@mkt` in work, carried to the primary.
    h.write(work, { "p@mkt": [h.record(work, "p", "1.0.0", 0)] }, 30);
    await h.sync(primary);
    expect(Object.keys(h.read(primary))).toEqual(["p@mkt"]);

    // late installs r after that, and then its cache is linked to the primary's.
    const afterTheSync = new Date(Date.now() + 60_000).toISOString();
    h.write(late, {
      "p@mkt": [h.record(late, "p", "1.0.0", 0)],
      "q@mkt": [h.record(late, "q", "1.0.0", 0)],
      "r@mkt": [h.record(late, "r", "1.0.0", 0, { lastUpdated: afterTheSync })],
    });
    rmSync(path.join(late, "plugins", "cache"), { recursive: true });
    symlinkSync(path.join(primary, "plugins", "cache"), path.join(late, "plugins", "cache"), "junction");
    expect(await h.sync(late)).toMatchObject({ ok: true });

    for (const dir of [late, primary]) expect(Object.keys(h.read(dir)), dir).toEqual(["p@mkt", "r@mkt"]);
  });

  describe("gives up, unstamped and writing nothing, on", () => {
    /** Syncs `dir` as a launch does, stamping it only if the sync worked. */
    const launch = (h: Awaited<ReturnType<typeof setup>>, dir: string) => syncWithStamp(dir, () => h.sync(dir));

    async function synced() {
      const h = await setup();
      h.cache("p", "1.0.0");
      h.cache("q", "1.0.0");
      for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
      for (const dir of h.all) await h.sync(dir);
      return h;
    }

    it("the primary's list when it is there but cannot be read", async () => {
      const h = await synced();
      const { primary, work } = h.dirs;
      const list = h.listPath(primary);
      rmSync(list);
      mkdirSync(list);

      expect(await launch(h, work)).toMatchObject({ ok: false });
      expect(existsSync(pluginSyncStampPath(work))).toBe(false);
      expect(lstatSync(list).isDirectory()).toBe(true);
    });

    // As one did with q installed in the primary since the last sync: the list it wrote back
    // over the unreadable one had no q.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "the primary's list when it may not be read",
      async () => {
        const h = await synced();
        const { primary, work } = h.dirs;
        const installed = {
          "p@mkt": [h.record(primary, "p", "1.0.0", 0)],
          "q@mkt": [h.record(primary, "q", "1.0.0", 10)],
        };
        h.write(primary, installed);
        chmodSync(h.listPath(primary), 0o000);
        try {
          expect(await launch(h, work)).toMatchObject({ ok: false });
          expect(existsSync(pluginSyncStampPath(work))).toBe(false);
        } finally {
          chmodSync(h.listPath(primary), 0o644);
        }
        expect(h.read(primary)).toEqual(installed);
        expect(await launch(h, work)).toMatchObject({ ok: true });
        expect(Object.keys(h.read(work))).toEqual(["p@mkt", "q@mkt"]);
      },
    );

    // Taken for none, it would make the profile a new one, whose list counts by its times.
    it("a record that is there but cannot be read", async () => {
      const h = await synced();
      const { work, play } = h.dirs;
      const record = h.recordPath(work);
      rmSync(record);
      mkdirSync(record);

      expect(await launch(h, play)).toMatchObject({ ok: false });
      expect(existsSync(pluginSyncStampPath(play))).toBe(false);
    });

    // Another Claude Code version's list: written over, it would lose what that version keeps.
    it("the launched profile's own list in a form it does not read, and the primary's", async () => {
      const h = await synced();
      const { primary, work } = h.dirs;
      const newer = `${JSON.stringify({ version: 3, plugins: { "p@mkt": { scopes: ["user"] } } })}\n`;
      for (const dir of [work, primary]) {
        const before = readFileSync(h.listPath(dir), "utf8");
        writeFileSync(h.listPath(dir), newer);

        expect(await launch(h, work), dir).toMatchObject({ ok: false });
        expect(readFileSync(h.listPath(dir), "utf8")).toBe(newer);
        expect(existsSync(pluginSyncStampPath(work))).toBe(false);
        writeFileSync(h.listPath(dir), before);
      }
    });

    // The sync holds the lock for milliseconds, so one held longer was most likely left by a
    // process that was killed: a launch waits a moment for it, not seconds on end.
    it("the lists while another sync holds the lock", async () => {
      const h = await synced();
      const { work } = h.dirs;
      const lock = path.join(h.home, ".clausona", "locks", "plugin-installs.lock");
      mkdirSync(path.dirname(lock), { recursive: true });
      writeFileSync(lock, "another sync");

      const started = Date.now();
      const result = await launch(h, work);
      expect(result).toMatchObject({ ok: false });
      expect(result.error).toContain("plugin-installs.lock");
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(existsSync(pluginSyncStampPath(work))).toBe(false);

      rmSync(lock);
      expect(await launch(h, work)).toMatchObject({ ok: true });
      expect(existsSync(pluginSyncStampPath(work))).toBe(true);
    });
  });
});

describe("doctor and a profile's plugin list", () => {
  const PLUGIN_KINDS = ["installed_plugins_differ", "plugins_cache_not_shared", "plugin_sync_blocked"];
  const pluginIssues = (issues: DoctorIssue[]) => issues.filter((issue) => PLUGIN_KINDS.includes(issue.kind));
  const issuesOf = async (h: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await h.service.doctorProfiles()).find((result) => result.name === id)?.issues ?? [];

  async function synced(options?: Parameters<typeof setup>[1]) {
    const h = await setup(["work", "play"], options);
    h.cache("p", "1.0.0");
    h.cache("p", "1.1.0");
    for (const dir of h.all) h.write(dir, { "p@mkt": [h.record(dir, "p", "1.0.0", 0)] });
    for (const dir of h.all) await h.sync(dir);
    return h;
  }

  /**
   * After every `claude plugin update` each profile but one is behind until it is next launched,
   * which brings it in step. Warning about that, and offering repair, would be noise each time.
   */
  it("says nothing of a list that is only behind", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const h = await synced();
    const { work } = h.dirs;
    // Synced since by a launch, then `claude plugin update p@mkt` there.
    await syncWithStamp(work, () => h.sync(work));
    h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", 10)] });

    expect(pluginIssues(await issuesOf(h, "claude:work"))).toEqual([]);
    expect(pluginIssues(await issuesOf(h, "claude:play"))).toEqual([]);
  });

  it("warns about a list that still differs after its sync, and repair brings it in line", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const h = await synced();
    const { primary, work } = h.dirs;
    h.write(work, { "p@mkt": [h.record(work, "p", "1.1.0", 10)] });
    // Stamped by a sync that ran after both lists and the record last changed.
    const earlier = new Date(Date.now() - 60_000);
    for (const file of [h.listPath(work), h.listPath(primary), h.recordPath(work)]) utimesSync(file, earlier, earlier);
    writeFileSync(pluginSyncStampPath(work), "");

    const issues = pluginIssues(await issuesOf(h, "claude:work"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "installed_plugins_differ", severity: "warning" });
    expect(issues[0]?.message).toContain("p@mkt 1.1.0 here, 1.0.0 in the primary");
    expect(offersRepair(issues)).toBe(true);

    await h.service.repairProfile("claude:work");

    expect(pluginIssues(await issuesOf(h, "claude:work"))).toEqual([]);
    // The sync repair ends with takes work's own update, newer than the shared record.
    expect(h.read(work)).toEqual({ "p@mkt": [h.record(work, "p", "1.1.0", 10)] });
    expect(h.read(primary)).toEqual({ "p@mkt": [h.record(primary, "p", "1.1.0", 10)] });
    // repair links the primary's plugins/ entries into the profile, but not clausona's own
    // record of the primary's list: each profile keeps its own.
    for (const name of readdirSync(path.join(work, "plugins")).filter((n) => n.startsWith(".clausona"))) {
      expect(lstatSync(path.join(work, "plugins", name)).isSymbolicLink(), name).toBe(false);
    }
  });

  it("warns about a profile that does not reach the primary's plugin cache", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const h = await synced({ ownCache: ["work"] });
    const { primary } = h.dirs;
    h.write(primary, { "p@mkt": [h.record(primary, "p", "1.1.0", 10)] });

    const issues = pluginIssues(await issuesOf(h, "claude:work"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "plugins_cache_not_shared", severity: "warning" });
    expect(issues[0]?.message).toContain("a plugin only that cache held has to be installed again");
    expect(offersRepair(issues)).toBe(true);
  });

  // repair would run into the same file, so doctor names it and offers no repair, and a repair
  // run anyway says the plugin list was not synced rather than report success.
  it("names a file the sync cannot read, and repair says it could not sync", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const h = await synced();
    const { work } = h.dirs;
    rmSync(h.recordPath(work));
    mkdirSync(h.recordPath(work));

    const issues = pluginIssues(await issuesOf(h, "claude:work"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "plugin_sync_blocked", severity: "warning" });
    expect(issues[0]?.message).toContain(".clausona-installed-plugins.json cannot be read");
    expect(offersRepair(issues)).toBe(false);

    await expect(h.service.repairProfile("claude:work")).rejects.toThrow(/plugin list could not be synced/);
  });
});
