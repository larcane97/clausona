import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RoutesFile } from "./route-config.js";
import {
  chooseRule,
  clearDefaultRoute,
  clearDirRoute,
  type PathSystem,
  pathSystem,
  readRules,
  removeReferences,
  renameReferences,
  rulesFor,
  ruleWarnings,
  sameDir,
  setDefaultRoute,
  setDirRoute,
  storedDir,
} from "./route-rules.js";

// Built from pieces so the source never holds a key-shaped string.
const keyShaped = () => ["sk", "ant", "x".repeat(24)].join("-");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Paths as each platform reads them; every path exists and is its own real path. */
const linux: PathSystem = { platform: "linux", home: "/home/u", realpath: (p) => p };
const mac: PathSystem = { platform: "darwin", home: "/Users/u", realpath: (p) => p };
const windows: PathSystem = { platform: "win32", home: "C:\\Users\\u", realpath: (p) => p };

const file = (extra: object = {}): RoutesFile => ({
  version: 1,
  routes: {
    main: { tool: "claude" },
    work: { tool: "claude" },
    app: { tool: "claude" },
    cx: { tool: "codex" },
    any: { tool: "all" },
  },
  ...extra,
});

describe("readRules", () => {
  it("reads dir rules in the file's order, and the defaults", () => {
    const rules = readRules(
      file({
        dirs: { "~/work": { claude: "work", codex: "cx" }, "/srv/app": { claude: "app" } },
        defaults: { claude: "main" },
      }),
      "linux",
    );
    expect(rules).toEqual({
      dirs: [
        { dir: "~/work", slots: { claude: { route: "work" }, codex: { route: "cx" } } },
        { dir: "/srv/app", slots: { claude: { route: "app" } } },
      ],
      defaults: { claude: { route: "main" } },
      problems: [],
    });
  });

  it.each([
    [
      "dirs that is not an object",
      { dirs: [] },
      'dirs: must be an object of directories, such as { "~/work": { "claude": "main" } }',
    ],
    [
      "a relative directory",
      { dirs: { work: { claude: "main" } } },
      'dirs["work"]: must be an absolute path, or start with ~',
    ],
    [
      "a ~user directory",
      { dirs: { "~bob/w": { claude: "main" } } },
      'dirs["~bob/w"]: must be an absolute path, or start with ~',
    ],
    [
      "a rule that is not an object",
      { dirs: { "~/w": "main" } },
      'dirs["~/w"]: must be an object of a route per tool, such as { "claude": "main" }',
    ],
    [
      "an unknown tool",
      { dirs: { "~/w": { gemini: "main" } } },
      `dirs["~/w"]: unknown tool 'gemini'; use claude or codex`,
    ],
    ["an all slot", { dirs: { "~/w": { all: "any" } } }, `dirs["~/w"]: unknown tool 'all'; use claude or codex`],
    ["a slot that is not a name", { dirs: { "~/w": { claude: 5 } } }, `dirs["~/w"].claude: must be a route's name`],
    [
      "a slot that cannot be a name",
      { dirs: { "~/w": { claude: "a b" } } },
      `dirs["~/w"].claude: 'a b' is not a route's name`,
    ],
    [
      "defaults that are not an object",
      { defaults: "main" },
      'defaults: must be an object of a route per tool, such as { "claude": "main" }',
    ],
    ["a default that is not a name", { defaults: { codex: null } }, "defaults.codex: must be a route's name"],
  ])("lists %s as a problem, and reads the rest", (_, extra, problem) => {
    const rules = readRules(file({ defaults: { claude: "main" }, ...extra }), "linux");
    expect(rules.problems).toEqual([problem]);
    if (!("defaults" in extra)) expect(rules.defaults.claude).toEqual({ route: "main" });
  });

  it("never quotes a key, in a slot or as a directory", () => {
    const key = keyShaped();
    const rules = readRules(file({ dirs: { [`/srv/${key}`]: { claude: "main" } }, defaults: { codex: key } }), "linux");
    expect(rules.problems).toEqual([
      "dirs: a directory looks like it holds an API key",
      "defaults.codex: looks like an API key, not a route's name",
    ]);
    expect(JSON.stringify(rules)).not.toContain(key);
  });

  it("reads a Windows path as a directory on Windows only", () => {
    const raw = file({ dirs: { "C:\\work": { claude: "main" }, "~\\app": { claude: "app" } } });
    expect(readRules(raw, "win32").problems).toEqual([]);
    expect(readRules(raw, "linux").problems).toEqual([
      'dirs["C:\\\\work"]: must be an absolute path, or start with ~',
      'dirs["~\\\\app"]: must be an absolute path, or start with ~',
    ]);
  });
});

describe("storedDir", () => {
  it.each([
    ["~ as typed", linux, "/tmp", "~/work", "~/work"],
    ["a relative path", linux, "/home/u", "work", "~/work"],
    ["the current directory", linux, "/home/u/a/b", ".", "~/a/b"],
    ["home itself", linux, "/tmp", "/home/u/", "~"],
    ["a path outside home", linux, "/home/u", "/srv/data/", "/srv/data"],
    ["a sibling of home that starts like it", linux, "/", "/home/user2/x", "/home/user2/x"],
    ["home in another case on Linux", linux, "/", "/Home/u/work", "/Home/u/work"],
    ["home in another case on macOS", mac, "/", "/users/U/work", "~/work"],
    ["a relative path on Windows", windows, "C:\\Users\\u", "work", "~\\work"],
    ["~/ on Windows", windows, "D:\\", "~/work/app", "~\\work\\app"],
    ["home in another case on Windows", windows, "D:\\", "c:\\users\\U\\Work", "~\\Work"],
    ["another drive on Windows", windows, "C:\\Users\\u", "D:/data", "D:\\data"],
  ])("stores %s", (_, sys, cwd, input, stored) => {
    expect(storedDir(input, cwd, sys)).toBe(stored);
  });
});

describe("matching a directory", () => {
  const rules = (dirs: Record<string, object>, sys: PathSystem = linux) => readRules(file({ dirs }), sys.platform).dirs;
  const matched = (dirs: Record<string, object>, cwd: string, sys: PathSystem = linux) =>
    rulesFor(rules(dirs, sys), cwd, sys).map((rule) => rule.dir);

  it.each([
    ["the directory itself", "/home/u/work", ["~/work", "~"]],
    ["below it", "/home/u/work/app/src", ["~/work/app", "~/work", "~"]],
    ["a sibling that starts like it", "/home/u/workshop", ["~"]],
    ["outside home", "/srv", []],
  ])("holds in %s, deepest first", (_, cwd, expected) => {
    expect(
      matched({ "~": { claude: "main" }, "~/work": { claude: "work" }, "~/work/app": { claude: "app" } }, cwd),
    ).toEqual(expected);
  });

  it.each([
    ["macOS", mac, "/Users/u/WORK/app", ["~/work"]],
    ["Windows", windows, "c:\\users\\U\\WORK\\app", ["~\\work"]],
    ["Linux, where case counts", { ...linux, home: "/Users/u" }, "/Users/u/WORK/app", []],
  ])("compares case as %s does", (_, sys, cwd, expected) => {
    const dir = sys.platform === "win32" ? "~\\work" : "~/work";
    expect(matched({ [dir]: { claude: "work" } }, cwd, sys)).toEqual(expected);
  });

  it("reads ~/ and either separator on Windows, and a drive letter in either case", () => {
    expect(matched({ "~/work": { claude: "work" }, "c:/srv": { claude: "app" } }, "C:\\srv\\x", windows)).toEqual([
      "c:/srv",
    ]);
    expect(matched({ "~/work": { claude: "work" } }, "C:\\Users\\u\\work", windows)).toEqual(["~/work"]);
  });

  it("matches through a symlink, either way round", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "clausona-rules-")));
    temps.push(root);
    mkdirSync(path.join(root, "real", "work", "app"), { recursive: true });
    // A junction on Windows, which needs no special rights; the type is ignored elsewhere.
    symlinkSync(path.join(root, "real"), path.join(root, "link"), "junction");
    const sys = pathSystem(root);
    const viaLink = path.join(root, "link", "work");
    const real = path.join(root, "real", "work");
    expect(matched({ [viaLink]: { claude: "work" } }, path.join(real, "app"), sys)).toEqual([viaLink]);
    expect(matched({ [real]: { claude: "work" } }, path.join(viaLink, "app"), sys)).toEqual([real]);
    expect(sameDir(viaLink, storedDir(real, root, sys), root, sys)).toBe(true);
  });

  it("compares a directory that does not exist as it is written", () => {
    const missing: PathSystem = {
      ...linux,
      realpath: (p) => {
        if (p.startsWith("/home/u/gone")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return p;
      },
    };
    expect(matched({ "~/gone": { claude: "work" }, "~": { claude: "main" } }, "/home/u/x", missing)).toEqual(["~"]);
    expect(sameDir("~/gone", "/home/u/gone/", "/", missing)).toBe(true);
  });

  it("keeps the file's order between two rules for one directory", () => {
    expect(matched({ "/home/u/work": { claude: "app" }, "~/work": { claude: "work" } }, "/home/u/work")).toEqual([
      "/home/u/work",
      "~/work",
    ]);
  });
});

describe("chooseRule", () => {
  const choose = (extra: object, tool: "claude" | "codex", cwd: string) => {
    const raw = file(extra);
    return chooseRule(
      raw,
      [{ name: "bad", spec: {}, problems: ["routes.bad: must be an object"] }],
      readRules(raw, "linux"),
      tool,
      cwd,
      linux,
    );
  };

  it("takes the deepest rule with a slot for the tool, then the default", () => {
    const extra = {
      dirs: { "~/work": { claude: "work", codex: "cx" }, "~/work/app": { codex: "any" } },
      defaults: { claude: "main" },
    };
    expect(choose(extra, "claude", "/home/u/work/app")).toEqual({
      chosen: { dir: "~/work", tool: "claude", route: "work" },
      skipped: [],
    });
    expect(choose(extra, "codex", "/home/u/work/app")).toEqual({
      chosen: { dir: "~/work/app", tool: "codex", route: "any" },
      skipped: [],
    });
    expect(choose(extra, "claude", "/srv")).toEqual({ chosen: { tool: "claude", route: "main" }, skipped: [] });
    expect(choose(extra, "codex", "/srv")).toEqual({ skipped: [] });
  });

  it.each([
    ["a route that does not exist", "gone", "route 'gone' does not exist"],
    ["a route that cannot be used", "bad", "route 'bad' cannot be used"],
    ["a route for the other tool", "cx", "route 'cx' is for codex"],
  ])("passes over %s for the next rule, and says why", (_, route, why) => {
    const extra = {
      dirs: { "~/work": { claude: "work" }, "~/work/app": { claude: route } },
      defaults: { claude: route },
    };
    expect(choose(extra, "claude", "/home/u/work/app")).toEqual({
      chosen: { dir: "~/work", tool: "claude", route: "work" },
      skipped: [{ dir: "~/work/app", tool: "claude", why }],
    });
    expect(choose(extra, "claude", "/srv")).toEqual({ skipped: [{ tool: "claude", why }] });
  });

  it("passes over a slot that cannot be read, naming where it is", () => {
    expect(
      choose({ dirs: { "~/work": { claude: 5 } }, defaults: { claude: "main" } }, "claude", "/home/u/work"),
    ).toEqual({
      chosen: { tool: "claude", route: "main" },
      skipped: [{ dir: "~/work", tool: "claude", why: `dirs["~/work"].claude: must be a route's name` }],
    });
  });
});

describe("ruleWarnings", () => {
  it("names each slot whose route is missing, cannot be used or is for the other tool", () => {
    const raw = file({
      dirs: { "~/work": { claude: "gone", codex: "any" }, "/srv": { codex: "main" } },
      defaults: { claude: "bad", codex: "cx" },
    });
    expect(ruleWarnings(raw, [{ name: "bad", spec: {}, problems: [] }], readRules(raw, "linux"))).toEqual([
      "~/work names route 'gone' for claude, which does not exist.",
      "/srv names route 'main' for codex, which is for claude.",
      "The claude default names route 'bad', which cannot be used.",
    ]);
  });
});

describe("editing rules", () => {
  const isWork = (stored: string) => sameDir(stored, "~/work", "/", linux);

  it("sets a slot, keeping the directory's other slots, where the first entry for it was", () => {
    const raw = file({
      dirs: { "/srv": { claude: "main" }, "/home/u/work": { codex: "cx" }, "~/work": { claude: "app" } },
    });
    setDirRoute(raw, "~/work", ["claude"], "work", isWork);
    expect(raw.dirs).toEqual({ "/srv": { claude: "main" }, "~/work": { codex: "cx", claude: "work" } });
    expect(Object.keys(raw.dirs as object)).toEqual(["/srv", "~/work"]);
  });

  it("sets both slots for an all route, and replaces an entry that cannot be read", () => {
    const raw = file({ dirs: { "~/work": "main" } });
    setDirRoute(raw, "~/work", ["claude", "codex"], "any", isWork);
    expect(raw.dirs).toEqual({ "~/work": { claude: "any", codex: "any" } });
  });

  it("refuses to change dirs that are not an object", () => {
    const raw = file({ dirs: ["~/work"] });
    expect(() => setDirRoute(raw, "~/work", ["claude"], "work", isWork)).toThrow(
      "dirs in routes.json is not an object, so it cannot be changed. Fix it with clausona route edit.",
    );
  });

  it("clears one slot, or the whole rule, and leaves no empty rule or dirs behind", () => {
    const raw = file({ dirs: { "~/work": { claude: "work", codex: "cx" }, "/srv": { claude: "main" } } });
    expect(clearDirRoute(raw, ["codex"], isWork)).toEqual(["~/work"]);
    expect(raw.dirs).toEqual({ "~/work": { claude: "work" }, "/srv": { claude: "main" } });
    expect(clearDirRoute(raw, ["codex"], isWork)).toEqual([]);
    expect(clearDirRoute(raw, ["claude"], isWork)).toEqual(["~/work"]);
    expect(raw.dirs).toEqual({ "/srv": { claude: "main" } });
    expect(clearDirRoute(raw, undefined, (stored) => stored === "/srv")).toEqual(["/srv"]);
    expect(raw).not.toHaveProperty("dirs");
  });

  it("sets and clears defaults", () => {
    const raw = file();
    setDefaultRoute(raw, ["claude", "codex"], "any");
    expect(raw.defaults).toEqual({ claude: "any", codex: "any" });
    expect(clearDefaultRoute(raw, ["codex"])).toEqual(["codex"]);
    expect(clearDefaultRoute(raw, ["codex"])).toEqual([]);
    expect(clearDefaultRoute(raw, ["claude"])).toEqual(["claude"]);
    expect(raw).not.toHaveProperty("defaults");
  });

  it("points every rule that names a route at its new name", () => {
    const raw = file({
      dirs: { "~/work": { claude: "work", codex: "cx" }, "/srv": { claude: "work" }, "/odd": "work" },
      defaults: { claude: "work" },
    });
    expect(renameReferences(raw, "work", "office")).toEqual([
      { dir: "~/work", tool: "claude" },
      { dir: "/srv", tool: "claude" },
      { tool: "claude" },
    ]);
    expect(raw.dirs).toEqual({
      "~/work": { claude: "office", codex: "cx" },
      "/srv": { claude: "office" },
      "/odd": "work",
    });
    expect(raw.defaults).toEqual({ claude: "office" });
  });

  it("clears every rule that names a removed route, and a rule left with no slot", () => {
    const raw = file({
      dirs: { "~/work": { claude: "work", codex: "cx" }, "/srv": { claude: "work" }, "/empty": {} },
      defaults: { claude: "work", codex: "cx" },
    });
    expect(removeReferences(raw, "work")).toEqual([
      { dir: "~/work", tool: "claude" },
      { dir: "/srv", tool: "claude" },
      { tool: "claude" },
    ]);
    expect(raw.dirs).toEqual({ "~/work": { codex: "cx" }, "/empty": {} });
    expect(raw.defaults).toEqual({ codex: "cx" });
    expect(removeReferences(raw, "nothing")).toEqual([]);
    expect(raw.dirs).toEqual({ "~/work": { codex: "cx" }, "/empty": {} });
  });
});
