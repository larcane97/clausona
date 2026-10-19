import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeDifferences,
  loadableInstalls,
  mergeInstalls,
  parseInstalls,
  relocateInstallPath,
} from "./plugin-installs.js";

describe("relocateInstallPath", () => {
  it("moves a path into another config dir's plugins/, whichever separator it was written with", () => {
    const to = path.join("/home", "u", ".claude");
    expect(relocateInstallPath("/home/u/.claude-work/plugins/cache/mkt/p/1.0.0", to)).toBe(
      path.join(to, "plugins", "cache", "mkt", "p", "1.0.0"),
    );
    expect(relocateInstallPath("C:\\Users\\u\\.claude-work\\plugins\\cache\\mkt\\p\\1.0.0", to)).toBe(
      path.join(to, "plugins", "cache", "mkt", "p", "1.0.0"),
    );
  });

  // Claude Code's own rule: the config dir's plugins/ is the one holding cache or marketplaces.
  it("is not misled by a home, a plugin or a version named plugins", () => {
    const to = path.join("/x", ".claude");
    expect(relocateInstallPath("/plugins/u/.claude-work/plugins/cache/mkt/plugins/1.0.0", to)).toBe(
      path.join(to, "plugins", "cache", "mkt", "plugins", "1.0.0"),
    );
  });

  it("leaves a path with no plugins/ in it as it is", () => {
    expect(relocateInstallPath("/opt/my-plugin", "/x/.claude")).toBe("/opt/my-plugin");
  });
});

describe("parseInstalls", () => {
  it("reads a version 2 list, and nothing else as one", () => {
    const record = { scope: "user", installPath: "/a" };
    expect(parseInstalls({ version: 2, plugins: { "p@m": [record] } })).toEqual({ "p@m": [record] });
    expect(parseInstalls({ version: 2 })).toEqual({});
    // Version 1 keeps one object per plugin; Claude Code converts it on its next start.
    expect(parseInstalls({ version: 1, plugins: { "p@m": record } })).toBeNull();
    expect(parseInstalls({ plugins: {} })).toBeNull();
    expect(parseInstalls({ version: 2, plugins: { "p@m": ["not a record"] } })).toBeNull();
    expect(parseInstalls(null)).toBeNull();
  });
});

describe("mergeInstalls", () => {
  const on = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
  const record = (version: string, minute: number) => ({ scope: "user", version, lastUpdated: on(minute) });
  const loads = () => true;

  it("keeps the shared record where no profile changed anything", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    const stale = { current: { "p@m": [record("0.9.0", 0)] }, base: { "p@m": [record("0.9.0", 0)] }, changedAt: 0 };
    expect(mergeInstalls(shared, [stale], { loads })).toEqual(shared);
  });

  it("prefers a record that loads to a newer one whose folder is gone", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    const newer = { current: { "p@m": [record("2.0.0", 9)] }, base: shared, changedAt: 0 };
    expect(mergeInstalls(shared, [newer], { loads: (r) => r.version !== "2.0.0" })).toEqual(shared);
  });

  it("keeps a record whose folder is gone when no record of the plugin loads", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    expect(mergeInstalls(shared, [], { loads: () => false })).toEqual(shared);
  });

  /**
   * A profile with no record joining lists that already have one - its cache only just linked,
   * say - holds mostly an old copy of the shared list. What it changed after the last sync is
   * its own; the rest is not, and must not bring back what was uninstalled meanwhile.
   */
  it("takes from a profile without a record only what it changed after the last sync", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    const late = {
      current: { "p@m": [record("1.0.0", 0)], "gone@m": [record("1.0.0", 5)], "new@m": [record("1.0.0", 30)] },
      base: null,
      changedAt: 0,
    };
    const lastSync = Date.parse(on(20));

    expect(mergeInstalls(shared, [late], { loads, joinedAfter: lastSync })).toEqual({
      "p@m": [record("1.0.0", 0)],
      "new@m": [record("1.0.0", 30)],
    });
    // The very first sync has nothing to go by, and takes it all.
    expect(Object.keys(mergeInstalls(null, [late], { loads }))).toEqual(["p@m", "gone@m", "new@m"]);
  });
});

describe("loadableInstalls", () => {
  it("leaves out each record whose folder is gone, and a plugin left with none", () => {
    const installs = {
      "a@m": [
        { scope: "user", installPath: "/here" },
        { scope: "local", installPath: "/gone" },
      ],
      "b@m": [{ scope: "user", installPath: "/gone" }],
    };
    expect(loadableInstalls(installs, (r) => r.installPath !== "/gone")).toEqual({
      "a@m": [{ scope: "user", installPath: "/here" }],
    });
  });
});

describe("describeDifferences", () => {
  it("names each plugin that differs, with the version on each side", () => {
    const here = {
      "a@m": [{ scope: "user", version: "1.1.0" }],
      "b@m": [{ scope: "user", version: "1.0.0" }],
      "c@m": [{ scope: "project", projectPath: "/home/u/app", version: "1.0.0" }],
    };
    const there = { "a@m": [{ scope: "user", version: "1.0.0" }], "d@m": [{ scope: "user", version: "1.0.0" }] };
    expect(describeDifferences(here, there, "/home/u")).toEqual([
      "a@m 1.1.0 here, 1.0.0 in the primary",
      "b@m only here",
      "c@m (project, ~/app) only here",
      "d@m missing here",
    ]);
  });
});
