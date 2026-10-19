import path from "node:path";
import { describe, expect, it } from "vitest";

import { describeDifferences, mergeInstalls, parseInstalls, relocateInstallPath } from "./plugin-installs.js";

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
  const always = () => true;

  it("keeps the shared record where no profile changed anything", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    const stale = { current: { "p@m": [record("0.9.0", 0)] }, base: { "p@m": [record("0.9.0", 0)] }, changedAt: 0 };
    expect(mergeInstalls(shared, [stale], always)).toEqual(shared);
  });

  it("passes over a record that is not on disk for one that is", () => {
    const shared = { "p@m": [record("1.0.0", 0)] };
    const newer = { current: { "p@m": [record("2.0.0", 9)] }, base: shared, changedAt: 0 };
    expect(mergeInstalls(shared, [newer], (r) => r.version !== "2.0.0")).toEqual(shared);
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
