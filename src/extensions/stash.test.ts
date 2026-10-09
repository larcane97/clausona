import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseStash, type StashFile, stashFileName, stashIdFor, stashItem, stashText } from "./stash.js";

// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const HOME = path.join(path.sep, "home", "me");
const STASH_DIR = path.join(HOME, ".clausona", "extensions", "stash");
const NOW = 1_700_000_000_000;
const ITEM = "mcp:claude:account:claude:work:stitch";

const server: StashFile = {
  version: 1,
  id: stashIdFor(ITEM, NOW),
  kind: "mcp",
  tool: "claude",
  name: "stitch",
  file: path.join(HOME, ".claude-work", ".claude.json"),
  path: ["mcpServers", "stitch"],
  scope: "account",
  profile: "claude:work",
  entry: { command: "stitch", env: { TOKEN: KEY } },
  stashedAt: new Date(NOW).toISOString(),
};

const hook: StashFile = {
  version: 1,
  id: stashIdFor("hook:claude:global:user:x:Stop#0.0", NOW),
  kind: "hook",
  tool: "claude",
  name: "Stop",
  file: path.join(HOME, ".claude", "settings.json"),
  path: ["hooks", "Stop"],
  scope: "global",
  hook: { base: "hooks", event: "Stop", group: 0, index: 0 },
  entry: { type: "command", command: `notify --token ${KEY}` },
  stashedAt: new Date(NOW).toISOString(),
};

describe("stashIdFor", () => {
  it("is the time in base 36 and a short hash of the item id: stable, a file name anywhere", () => {
    const id = stashIdFor(ITEM, NOW);
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
    expect(stashIdFor(ITEM, NOW)).toBe(id);
    expect(id.startsWith(`${NOW.toString(36)}-`)).toBe(true);
    // Unique per item and per moment.
    expect(stashIdFor("mcp:claude:account:claude:default:stitch", NOW)).not.toBe(id);
    expect(stashIdFor(ITEM, NOW + 1)).not.toBe(id);
  });

  it("names its file", () => {
    expect(stashFileName("abc-0123abcd")).toBe("abc-0123abcd.json");
  });
});

describe("stashText and parseStash", () => {
  it("writes indented JSON with a trailing newline that reads back the same", () => {
    expect(stashText(server)).toBe(`${JSON.stringify(server, null, 2)}\n`);
    expect(parseStash(JSON.parse(stashText(server)))).toEqual(server);
    expect(parseStash(JSON.parse(stashText(hook)))).toEqual(hook);
    const local: StashFile = {
      ...server,
      path: ["projects", path.join(HOME, "app"), "mcpServers", "stitch"],
      scope: "local",
      project: path.join(HOME, "app"),
    };
    expect(parseStash(JSON.parse(stashText(local)))).toEqual(local);
  });

  it("refuses another version, a field of the wrong type or a missing one, and never throws", () => {
    expect(parseStash({ ...server, version: 2 })).toBeUndefined();
    expect(parseStash({ ...server, file: 3 })).toBeUndefined();
    const { entry: _entry, ...noEntry } = server;
    expect(parseStash(noEntry)).toBeUndefined();
    expect(parseStash({ ...server, kind: "skill" })).toBeUndefined();
    expect(parseStash({ ...server, tool: "gemini" })).toBeUndefined();
    expect(parseStash({ ...server, scope: "everywhere" })).toBeUndefined();
    expect(parseStash({ ...server, path: ["mcpServers", null] })).toBeUndefined();
    expect(parseStash({ ...server, profile: 7 })).toBeUndefined();
    expect(parseStash({ ...server, stashedAt: "yesterday" })).toBeUndefined();
    // A hook goes back to its place in its file, so it needs one.
    const { hook: _place, ...noPlace } = hook;
    expect(parseStash(noPlace)).toBeUndefined();
    expect(parseStash({ ...hook, hook: { ...hook.hook, group: -1 } })).toBeUndefined();
    for (const value of [undefined, null, 1, "x", [], [server]]) expect(parseStash(value)).toBeUndefined();
  });
});

describe("stashItem", () => {
  const stashPath = path.join(STASH_DIR, stashFileName(server.id));

  it("lists a server where it came from, off, with env names only", () => {
    const item = stashItem(server, stashPath);
    expect(item).toEqual({
      id: `mcp:claude:account:stash-${server.id}:stitch`,
      kind: "mcp",
      name: "stitch",
      location: { tool: "claude", scope: "account", file: server.file, profile: "claude:work" },
      summary: { transport: "stdio", command: "stitch", env: "TOKEN" },
      stashed: { file: stashPath, id: server.id, at: NOW },
    });
    expect(JSON.stringify(item)).not.toContain(KEY);
  });

  it("keeps a local server's project", () => {
    const project = path.join(HOME, "app");
    const item = stashItem({ ...server, scope: "local", project }, stashPath);
    expect(item.id).toBe(`mcp:claude:local:stash-${server.id}:stitch`);
    expect(item.location).toEqual({
      tool: "claude",
      scope: "local",
      file: server.file,
      profile: "claude:work",
      project,
    });
  });

  it("lists a hook with its place and a redacted summary", () => {
    const item = stashItem(hook, stashPath);
    expect(item.id).toBe(`hook:claude:global:stash-${hook.id}:Stop`);
    expect(item.hook).toEqual({ base: "hooks", event: "Stop", group: 0, index: 0 });
    expect(item.location).toEqual({ tool: "claude", scope: "global", file: hook.file });
    expect(item.summary).toEqual({ event: "Stop", type: "command", command: "notify --token <hidden>" });
    expect(JSON.stringify(item)).not.toContain(KEY);
  });
});
