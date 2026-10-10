import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireDirLock } from "../core/dir-lock.js";
import { type Action, type ExtensionsCommand, stopText } from "./actions.js";
import {
  apply,
  KEEP_OPERATIONS,
  lastOperation,
  type Manifest,
  OP_ID_RE,
  operationId,
  pruneOperations,
  undo,
  type WriteEnv,
  writeEnvFor,
} from "./apply.js";
import { tagsOf } from "./describe.js";
import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";
import { type Plan, type PlanContext, plan } from "./plan.js";
import { tilde } from "./present.js";
import { hashTree } from "./read.js";
import { type ItemKind, rowsIn, type ScopeId, type ScopeRow, type ToolName } from "./scopes.js";
import { TestHome } from "./test-home.js";

const NOW = Date.UTC(2026, 9, 10, 4, 36, 48);
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const STASH = path.join(".clausona", "extensions", "stash");
const onWindows = process.platform === "win32";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

const SETTINGS = {
  enabledPlugins: { "kit@m": true },
  hooks: {
    Stop: [
      {
        hooks: [
          { type: "command", command: "notify-a" },
          { type: "command", command: "notify-b" },
        ],
      },
    ],
  },
};

type More = (h: TestHome, app: string, web: string) => void;

/**
 * Task 4's fixture: two Claude accounts (default has opened app and web, work only app, where it
 * has turned github off) and a Codex one that trusts app and not web. Global eli5, old-one, a
 * link notes and a broken link lost; app's deploy-check; web's web-only; the Cloud pdf; Codex's
 * eli5 and app's app-lint; the plugin kit@m; two Stop hooks in user settings; github and figma in
 * both accounts; docs-search in app's .mcp.json; Codex's docs.
 */
function home(more?: More): { h: TestHome; app: string; web: string } {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    oauthAccount: { organizationUuid: "org", accountUuid: "one" },
    projects: { [app]: {}, [web]: {} },
    mcpServers: { github: { command: "gh", env: { GITHUB_TOKEN: KEY } }, figma: { command: "figma" } },
  });
  h.claude("work", ".claude-work", {
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: { github: { command: "gh" }, figma: { command: "figma" } },
  });
  h.codex(
    "personal",
    ".codex",
    `[projects.'${app}']\ntrust_level = "trusted"\n\n[projects.'${web}']\ntrust_level = "untrusted"\n\n[mcp_servers.docs]\ncommand = "docs"\n`,
  );
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill(".agents/skills", "eli5");
  h.skill("repos/app/.agents/skills", "app-lint");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".claude/skills/synced/org_one", "pdf");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  h.link(h.path("gone", "lost"), ".claude/skills/lost");
  const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
  h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
  h.write(".claude/plugins/cache/m/kit/1.0.0/hooks/hooks.json", {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "kit-start" }] }] },
  });
  h.write(".claude/settings.json", SETTINGS);
  h.write("repos/app/.mcp.json", { mcpServers: { "docs-search": { command: "ds" } } });
  more?.(h, app, web);
  return { h, app, web };
}

// The managed settings are the home's own, so no test reads this machine's.
function load(h: TestHome, cwd: string): Promise<Inventory> {
  return loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd,
    managedSettings: h.path("managed-settings.json"),
  });
}

function contextFor(h: TestHome, inv: Inventory, project: string | undefined): PlanContext {
  return { inv, project, now: NOW, tracked: new Set(), stashDir: h.path(STASH) };
}

/** The one row named `name` in a scope, seen from `project`. */
function rowIn(
  inv: Inventory,
  project: string | undefined,
  scope: ScopeId,
  name: string,
  tool: ToolName = "claude",
  kind: ItemKind = "skill",
): ScopeRow {
  const found = rowsIn(inv, tool, kind, scope, project, NOW).filter((r) => r.name === name);
  if (found.length !== 1) throw new Error(`${found.length} rows named ${name} in ${tool} ${kind} ${scope}`);
  return found[0] as ScopeRow;
}

function hookRow(inv: Inventory, project: string, command: string): ScopeRow {
  const found = rowsIn(inv, "claude", "hook", "global", project, NOW).filter(
    (r) => r.items[0]?.summary?.command === command,
  );
  if (found.length !== 1) throw new Error(`${found.length} hook rows running ${command}`);
  return found[0] as ScopeRow;
}

const act = (verb: Action["verb"], reach: Action["reach"], rows: ScopeRow[], more: Partial<Action> = {}): Action => ({
  verb,
  reach,
  rows,
  ...more,
});

/** A clock 1000 ms on from the last time at every call. */
function clock(start = NOW): () => number {
  let at = start;
  return () => {
    at += 1000;
    return at;
  };
}

type Pick = (inv: Inventory, project: string) => ScopeRow[];

/** A plan made from what is on disk now, seen from `project`. */
async function planNow(
  h: TestHome,
  project: string,
  command: ExtensionsCommand,
  verb: Action["verb"],
  reach: Action["reach"],
  pick: Pick,
  more: Partial<Action> = {},
): Promise<Plan> {
  const inv = await load(h, project);
  const made = plan(contextFor(h, inv, project), command, act(verb, reach, pick(inv, project), more));
  expect(made.refused).toEqual([]);
  return made;
}

const eli5: Pick = (inv, project) => [rowIn(inv, project, "global", "eli5")];
const github: Pick = (inv, project) => [rowIn(inv, project, "global", "github", "claude", "mcp")];
const figma: Pick = (inv, project) => [rowIn(inv, project, "global", "figma", "claude", "mcp")];
const notifyA: Pick = (inv, project) => [hookRow(inv, project, "notify-a")];

const json = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8"));
const mode = (p: string) => statSync(p).mode & 0o777;
const manifestOf = (dir: string): Manifest => json(path.join(dir, "manifest.json")) as Manifest;
const opDirs = (env: WriteEnv) => (existsSync(env.backupRoot) ? readdirSync(env.backupRoot).sort() : []);
const stashFiles = (h: TestHome) =>
  existsSync(h.path(STASH))
    ? readdirSync(h.path(STASH))
        .sort()
        .map((name) => h.path(STASH, name))
    : [];

function setIn(file: string, change: (value: Record<string, any>) => void): void {
  const value = json(file);
  change(value);
  writeFileSync(file, JSON.stringify(value));
}

describe("apply", () => {
  it("does nothing, and makes nothing, for a plan without changes", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const p = await planNow(h, app, "mcp", "on", "here", github, { accounts: ["claude:default"] });
    expect(p.changes).toEqual([]);
    expect(await apply(p, env)).toEqual({ status: "nothing" });
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("creates a file for a change, behind a manifest only you can read, and undoes it with the folder it made", async () => {
    const { h } = home();
    const bare = h.project("repos/bare");
    const env = writeEnvFor(h.home, clock());
    const file = path.join(bare, ".claude", "settings.local.json");

    const result = await apply(await planNow(h, bare, "skills", "off", "here", eli5), env);

    expect(result).toMatchObject({ status: "applied", done: 1 });
    expect(readFileSync(file, "utf8")).toBe('{\n  "skillOverrides": {\n    "eli5": "off"\n  }\n}\n');
    if (result.status !== "applied") throw new Error(result.status);
    const { operation } = result;
    expect(operation.id).toMatch(OP_ID_RE);
    expect(operation.id.endsWith("-skills-off")).toBe(true);
    expect(operation).toMatchObject({ dir: path.join(env.backupRoot, operation.id), command: "skills" });
    expect(operation.summary).toBe("Turned off eli5 in this project");
    const manifest = manifestOf(operation.dir);
    expect(manifest).toMatchObject({ version: 1, id: operation.id, status: "applied", undoneAt: null });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      what: "json",
      change: "created",
      backup: null,
      hashBefore: null,
      done: true,
      createdDirs: [path.join(bare, ".claude")],
    });
    if (!onWindows) {
      expect(mode(file)).toBe(0o644);
      expect(mode(operation.dir)).toBe(0o700);
      expect(mode(path.join(operation.dir, "manifest.json"))).toBe(0o600);
    }

    expect(await lastOperation(env)).toEqual({
      operation,
      files: [{ path: manifest.entries[0]?.path, action: "remove" }],
    });
    const undone = await undo(env);
    expect(undone).toMatchObject({ operation: { id: operation.id }, skipped: [] });
    expect(undone?.restored).toHaveLength(1);
    // The change made the file: undo took it away again.
    expect(undone?.removed).toEqual(undone?.restored);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(bare, ".claude"))).toBe(false);
    expect(manifestOf(operation.dir).undoneAt).toEqual(expect.any(String));
    expect(await undo(env)).toBeNull();
    expect(await lastOperation(env)).toBeNull();
  });

  it("makes nothing, and offers no undo, when what it would write is there already", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const work = h.path(".claude-work", ".claude.json");
    const older = await apply(await planNow(h, app, "mcp", "off", "here", github), env);
    if (older.status !== "applied") throw new Error(older.status);
    const p = await planNow(h, app, "mcp", "off", "here", figma, { accounts: ["claude:work"] });
    expect(p.changes.map((c) => c.file)).toEqual([work]);
    // `/mcp disable figma` in Claude Code, between the plan and the apply.
    setIn(work, (value) => {
      value.projects[app].disabledMcpServers.push("figma");
    });
    const left = readFileSync(work, "utf8");

    expect(await apply(p, env)).toEqual({ status: "nothing" });

    expect(readFileSync(work, "utf8")).toBe(left);
    expect(opDirs(env)).toEqual([older.operation.id]);
    expect((await lastOperation(env))?.operation).toEqual(older.operation);
    expect((await lastOperation(env, "mcp"))?.operation).toEqual(older.operation);
  });

  it("counts only the changes it made when it stops", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const [mine, work] = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    const p = await planNow(h, app, "mcp", "off", "here", figma);
    expect(p.changes.map((c) => c.file)).toEqual([mine, work]);
    // Default's is there already, and work's project entry went.
    setIn(mine, (value) => {
      value.projects[app].disabledMcpServers = ["figma"];
    });
    setIn(work, (value) => {
      delete value.projects[app];
    });

    const result = await apply(p, env);

    expect(result).toMatchObject({ status: "stopped", done: 0, total: 2, stop: { reason: "changed", file: work } });
    expect(await lastOperation(env)).toBeNull();
  });

  it("names an operation by its time, command and verb", () => {
    const at = Date.UTC(2026, 9, 10, 4, 36, 48, 123);
    const id = (command: ExtensionsCommand, verb: Plan["verb"], reach: Plan["reach"]) =>
      operationId(at, { command, verb, reach } as Plan);
    expect(id("skills", "rm", "here")).toBe("20261010T043648123Z-skills-rm");
    expect(id("mcp", "off", "everywhere")).toBe("20261010T043648123Z-mcp-off-everywhere");
    expect(id("skills", "visibility", "here")).toBe("20261010T043648123Z-skills-visibility");
    expect(OP_ID_RE.test(`${id("hooks", "on", "everywhere")}-2`)).toBe(true);
    expect(OP_ID_RE.test("20261010T043648Z-skills-rm")).toBe(false);
  });
});

describe("apply: .claude.json under Claude Code's lock", () => {
  it("waits for Claude Code's lock and keeps what it wrote meanwhile", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const claudeJson = h.path(".claude.json");
    const p = await planNow(h, app, "mcp", "off", "here", github);
    expect(p.changes.map((c) => c.file)).toEqual([claudeJson]);

    const release = await acquireDirLock(`${claudeJson}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    let settled = false;
    const applying = apply(p, env).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Still waiting, and nothing written: Claude Code holds the lock.
    expect(settled).toBe(false);
    expect(json(claudeJson).projects[app].disabledMcpServers).toBeUndefined();
    setIn(claudeJson, (value) => {
      value.numStartups = 7;
    });
    await release();

    expect(await applying).toMatchObject({ status: "applied", done: 1 });
    const after = json(claudeJson);
    expect(after.numStartups).toBe(7);
    expect(after.projects[app].disabledMcpServers).toContain("github");
  });

  it("stops when the lock is not won in time, and changes nothing", async () => {
    const { h, app } = home();
    const env: WriteEnv = { ...writeEnvFor(h.home, clock()), lockWaitMs: 300 };
    const claudeJson = h.path(".claude.json");
    const p = await planNow(h, app, "mcp", "off", "here", github);
    const before = readFileSync(claudeJson, "utf8");

    const release = await acquireDirLock(`${claudeJson}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    try {
      const result = await apply(p, env);
      expect(result).toMatchObject({ status: "stopped", done: 0, total: 1, stop: { reason: "locked" } });
      if (result.status !== "stopped") throw new Error(result.status);
      expect(stopText(result.stop, "flags", h.home, "mcp")).toBe(
        `Claude Code is saving ${tilde(claudeJson, h.home)}. Try again in a moment.`,
      );
      expect(manifestOf(result.operation.dir)).toMatchObject({ status: "stopped", stop: { reason: "locked" } });
    } finally {
      await release();
    }
    expect(readFileSync(claudeJson, "utf8")).toBe(before);
  });

  it("stops before anything when the first file changed since the plan", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const work = h.path(".claude-work", ".claude.json");
    const p = await planNow(h, app, "mcp", "off", "everywhere", figma);
    expect(p.changes.map((c) => c.file)).toEqual([h.path(".claude.json"), work]);
    const workBefore = readFileSync(work, "utf8");
    setIn(h.path(".claude.json"), (value) => {
      value.mcpServers.figma = { command: "figma2" };
    });

    const result = await apply(p, env);

    expect(result).toMatchObject({ status: "stopped", done: 0, total: 2, stop: { reason: "changed" } });
    expect(result.status === "stopped" && result.stop.file).toBe(h.path(".claude.json"));
    expect(stashFiles(h)).toEqual([]);
    expect(json(h.path(".claude.json")).mcpServers.figma).toEqual({ command: "figma2" });
    expect(readFileSync(work, "utf8")).toBe(workBefore);
  });

  it("undoes only the paths it changed, keeping what Claude Code wrote since", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const claudeJson = h.path(".claude.json");
    await apply(await planNow(h, app, "mcp", "off", "here", github), env);
    setIn(claudeJson, (value) => {
      value.lastSessionId = "x";
    });

    const undone = await undo(env);

    expect(undone).toMatchObject({ restored: [claudeJson], removed: [], skipped: [] });
    const after = json(claudeJson);
    expect(after.projects[app].disabledMcpServers ?? []).not.toContain("github");
    expect(after.lastSessionId).toBe("x");
  });

  it.skipIf(onWindows)(
    "edits a linked .claude.json through its link, under the lock at the path it is named by",
    async () => {
      const { h, app } = home((h) => {
        // ~/.claude.json kept in a dotfiles folder.
        mkdirSync(h.path("dotfiles"));
        renameSync(h.path(".claude.json"), h.path("dotfiles", "claude.json"));
        symlinkSync(h.path("dotfiles", "claude.json"), h.path(".claude.json"));
      });
      const env: WriteEnv = { ...writeEnvFor(h.home, clock()), lockWaitMs: 300 };
      const link = h.path(".claude.json");
      const real = realpathSync.native(h.path("dotfiles", "claude.json"));
      const before = readFileSync(real, "utf8");
      const p = await planNow(h, app, "mcp", "off", "here", github);
      expect(p.changes.map((c) => c.file)).toEqual([link]);
      const holding = async <T>(run: () => Promise<T>): Promise<T> => {
        const release = await acquireDirLock(`${link}.lock`, { staleMs: 10_000, updateMs: 5_000 });
        if (!release) throw new Error("lock not taken");
        try {
          return await run();
        } finally {
          await release();
        }
      };

      expect(await holding(() => apply(p, env))).toMatchObject({ status: "stopped", stop: { reason: "locked" } });
      expect(readFileSync(real, "utf8")).toBe(before);
      const applied = await apply(p, env);

      if (applied.status !== "applied") throw new Error(applied.status);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(json(real).projects[app].disabledMcpServers).toEqual(["github"]);
      expect(manifestOf(applied.operation.dir).entries).toMatchObject([{ path: real, named: link, lock: true }]);
      expect(await holding(() => undo(env))).toMatchObject({ skipped: [{ file: link, reason: "locked" }] });
      expect(await undo(env)).toMatchObject({ restored: [link], skipped: [] });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe(before);
    },
  );

  it("leaves an undo it could not lock to try again, rather than walk past it", async () => {
    const { h, app } = home();
    const env: WriteEnv = { ...writeEnvFor(h.home, clock()), lockWaitMs: 300 };
    const claudeJson = h.path(".claude.json");
    const before = readFileSync(claudeJson, "utf8");
    const applied = await apply(await planNow(h, app, "mcp", "off", "here", github), env);
    const after = readFileSync(claudeJson, "utf8");

    const release = await acquireDirLock(`${claudeJson}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    try {
      expect(await undo(env)).toMatchObject({ restored: [], skipped: [{ file: claudeJson, reason: "locked" }] });
    } finally {
      await release();
    }
    expect(readFileSync(claudeJson, "utf8")).toBe(after);

    const again = await undo(env);
    expect(again?.operation.id).toBe(applied.status === "applied" ? applied.operation.id : "");
    expect(again).toMatchObject({ restored: [claudeJson], skipped: [] });
    expect(readFileSync(claudeJson, "utf8")).toBe(before);
  });

  it("leaves a file alone when a path it changed holds something else now", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const claudeJson = h.path(".claude.json");
    await apply(await planNow(h, app, "mcp", "off", "here", github), env);
    setIn(claudeJson, (value) => {
      value.projects[app].disabledMcpServers = ["other"];
    });
    const left = readFileSync(claudeJson, "utf8");

    expect(await undo(env)).toMatchObject({ restored: [], skipped: [{ file: claudeJson, reason: "changed" }] });
    expect(readFileSync(claudeJson, "utf8")).toBe(left);
  });
});

describe("apply: folders and links", () => {
  it("moves a skill folder into the backup, and back", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const folder = h.path(".claude", "skills", "old-one");
    const before = await hashTree(folder);

    const result = await apply(
      await planNow(h, app, "skills", "rm", "here", (inv) => [rowIn(inv, app, "global", "old-one")]),
      env,
    );

    if (result.status !== "applied") throw new Error(result.status);
    expect(existsSync(folder)).toBe(false);
    const backup = path.join(result.operation.dir, "files", "1");
    expect(existsSync(path.join(backup, "SKILL.md"))).toBe(true);
    expect(manifestOf(result.operation.dir).entries).toMatchObject([
      { what: "folder", change: "removed", backup: "files/1", hashBefore: before, hashAfter: null, done: true },
    ]);

    const undone = await undo(env);
    expect(undone).toMatchObject({ restored: [realpathSync.native(folder)], skipped: [] });
    expect(await hashTree(folder)).toBe(before);
    expect(existsSync(backup)).toBe(false);
  });

  it("removes a linked skill's link, never its folder, and makes the link again", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const link = h.path(".claude", "skills", "notes");

    const result = await apply(
      await planNow(h, app, "skills", "rm", "here", (inv) => [rowIn(inv, app, "global", "notes")]),
      env,
    );

    expect(result).toMatchObject({ status: "applied", done: 1 });
    expect(existsSync(link)).toBe(false);
    expect(existsSync(h.path("shared", "notes", "SKILL.md"))).toBe(true);
    await undo(env);
    expect(realpathSync.native(link)).toBe(realpathSync.native(h.path("shared", "notes")));
  });

  it("leaves the backup where it is when something is at the folder's place again", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const result = await apply(
      await planNow(h, app, "skills", "rm", "here", (inv) => [rowIn(inv, app, "global", "old-one")]),
      env,
    );
    if (result.status !== "applied") throw new Error(result.status);
    h.skill(".claude/skills", "old-one", "a new one");

    const undone = await undo(env);

    expect(undone?.restored).toEqual([]);
    expect(undone?.skipped).toMatchObject([{ reason: "occupied" }]);
    expect(existsSync(path.join(result.operation.dir, "files", "1", "SKILL.md"))).toBe(true);
    expect(readFileSync(h.path(".claude", "skills", "old-one", "SKILL.md"), "utf8")).toContain("a new one");
  });

  it("puts back a folder an apply moved without recording it done", async () => {
    const { h } = home();
    const env = writeEnvFor(h.home, clock());
    const folder = h.path(".claude", "skills", "old-one");
    const id = "20261010T043000000Z-skills-rm";
    const dir = path.join(env.backupRoot, id);
    mkdirSync(path.join(dir, "files"), { recursive: true });
    const before = await hashTree(folder);
    // What a crash between the move and the manifest's save leaves.
    renameSync(folder, path.join(dir, "files", "1"));
    const manifest: Manifest = {
      version: 1,
      id,
      command: "skills",
      verb: "rm",
      reach: "here",
      summary: "Deleted old-one",
      project: null,
      createdAt: new Date(NOW).toISOString(),
      status: "applying",
      undoneAt: null,
      entries: [
        {
          path: folder,
          what: "folder",
          change: "removed",
          backup: "files/1",
          hashBefore: before,
          hashAfter: null,
          done: false,
        },
      ],
    };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));

    expect(await lastOperation(env)).toMatchObject({ files: [{ path: folder, action: "put back" }] });
    expect(await undo(env)).toMatchObject({ restored: [folder], skipped: [] });
    expect(await hashTree(folder)).toBe(before);
  });
});

describe("apply: what clausona keeps aside", () => {
  it("takes a server out of every account into files only you can read, lists it off, and puts it back", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const files = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    const before = files.map((file) => json(file).mcpServers.figma);

    expect(await apply(await planNow(h, app, "mcp", "off", "everywhere", figma), env)).toMatchObject({
      status: "applied",
      done: 2,
    });

    for (const file of files) expect(json(file).mcpServers).not.toHaveProperty("figma");
    const kept = stashFiles(h);
    expect(kept).toHaveLength(2);
    for (const file of kept) {
      expect(json(file)).toMatchObject({ version: 1, kind: "mcp", name: "figma", entry: { command: "figma" } });
      if (!onWindows) expect(mode(file)).toBe(0o600);
    }
    if (!onWindows) expect(mode(h.path(STASH))).toBe(0o700);
    const inv = await load(h, app);
    expect(tagsOf(inv, rowIn(inv, app, "global", "figma", "claude", "mcp"), app, NOW)).toContain("off");

    const on = await apply(await planNow(h, app, "mcp", "on", "everywhere", figma), env);

    expect(on).toMatchObject({ status: "applied", done: 2 });
    expect(files.map((file) => json(file).mcpServers.figma)).toEqual(before);
    expect(stashFiles(h)).toEqual([]);
    if (on.status !== "applied") throw new Error(on.status);
    const moved = manifestOf(on.operation.dir).entries.filter((e) => e.what === "stash");
    expect(moved.map((e) => e.path).sort()).toEqual(kept);
    expect(moved.every((e) => e.change === "removed" && e.done)).toBe(true);
    for (const entry of moved) {
      expect(json(path.join(on.operation.dir, ...(entry.backup ?? "").split("/")))).toMatchObject({ name: "figma" });
    }
  });

  it("stops with a conflict when the server is back already, and keeps what it kept", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    await apply(await planNow(h, app, "mcp", "off", "everywhere", figma), env);
    const kept = stashFiles(h);
    const inv = await load(h, app);
    const row = rowIn(inv, app, "global", "figma", "claude", "mcp");
    const keptForDefault = row.items.find((item) => item.location.profile === "claude:default");
    const p = plan(contextFor(h, inv, app), "mcp", act("on", "everywhere", [row]));
    setIn(h.path(".claude.json"), (value) => {
      value.mcpServers.figma = { command: "figma-new" };
    });

    const result = await apply(p, env);

    expect(result).toMatchObject({
      status: "stopped",
      stop: { reason: "conflict", file: h.path(".claude.json"), name: "figma", rowKey: keptForDefault?.id },
    });
    expect(kept).toContain(keptForDefault?.stashed?.file);
    expect(stashFiles(h)).toContain(keptForDefault?.stashed?.file);
    expect(json(h.path(".claude.json")).mcpServers.figma).toEqual({ command: "figma-new" });
  });

  it("takes a hook out and puts it back in its place", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    const commands = () => json(settings).hooks.Stop[0].hooks.map((hook: { command: string }) => hook.command);

    await apply(await planNow(h, app, "hooks", "off", "everywhere", notifyA), env);
    expect(commands()).toEqual(["notify-b"]);
    expect(stashFiles(h)).toHaveLength(1);

    await apply(await planNow(h, app, "hooks", "on", "everywhere", notifyA), env);
    expect(commands()).toEqual(["notify-a", "notify-b"]);
    expect(stashFiles(h)).toEqual([]);
  });

  it("stops with a conflict when the hook is back already, and keeps what it kept", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    await apply(await planNow(h, app, "hooks", "off", "everywhere", notifyA), env);
    const kept = stashFiles(h);
    expect(kept).toHaveLength(1);
    // The same hook, added back by hand.
    setIn(settings, (value) => {
      value.hooks.Stop[0].hooks.unshift({ type: "command", command: "notify-a" });
    });
    const left = readFileSync(settings, "utf8");
    const inv = await load(h, app);
    const rows = rowsIn(inv, "claude", "hook", "global", app, NOW).filter(
      (r) => r.items[0]?.summary?.command === "notify-a",
    );
    expect(rows).toHaveLength(2);
    const keptRow = rows.find((r) => r.items[0]?.stashed) as ScopeRow;
    const p = plan(contextFor(h, inv, app), "hooks", act("on", "everywhere", [keptRow]));
    expect(p.refused).toEqual([]);
    expect(p.changes).toHaveLength(1);

    const result = await apply(p, env);

    expect(result).toMatchObject({
      status: "stopped",
      done: 0,
      stop: { reason: "conflict", file: settings, rowKey: keptRow.items[0]?.id },
    });
    if (result.status !== "stopped") throw new Error(result.status);
    expect(stopText(result.stop, "flags", h.home, "hooks")).toBe(
      `${result.stop.name} is back in ${tilde(settings, h.home)} already. ` +
        `Delete the copy clausona kept: clausona hooks rm --id ${keptRow.items[0]?.id}.`,
    );
    expect(readFileSync(settings, "utf8")).toBe(left);
    expect(stashFiles(h)).toEqual(kept);
  });

  it("puts a hook back beside the same command under another matcher, which is another hook", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    const before = readFileSync(settings, "utf8");
    await apply(await planNow(h, app, "hooks", "off", "everywhere", notifyA), env);
    const bash = { matcher: "Bash", hooks: [{ type: "command", command: "notify-a" }] };
    setIn(settings, (value) => {
      value.hooks.Stop.push(bash);
    });
    const inv = await load(h, app);
    const keptRow = rowsIn(inv, "claude", "hook", "global", app, NOW).find(
      (r) => r.items[0]?.summary?.command === "notify-a" && r.items[0]?.stashed,
    ) as ScopeRow;
    const p = plan(contextFor(h, inv, app), "hooks", act("on", "everywhere", [keptRow]));

    expect(await apply(p, env)).toMatchObject({ status: "applied", done: 1 });

    expect(json(settings).hooks.Stop).toEqual([...JSON.parse(before).hooks.Stop, bash]);
    expect(stashFiles(h)).toEqual([]);
  });

  it("stops when a hook was put above the one it takes out, and takes nothing out", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    const p = await planNow(h, app, "hooks", "off", "everywhere", notifyA);
    setIn(settings, (value) => {
      value.hooks.Stop[0].hooks.unshift({ type: "command", command: "notify-z" });
    });
    const left = readFileSync(settings, "utf8");

    expect(await apply(p, env)).toMatchObject({ status: "stopped", stop: { reason: "changed", file: settings } });
    expect(readFileSync(settings, "utf8")).toBe(left);
    expect(stashFiles(h)).toEqual([]);
  });
});

describe("undo: what clausona keeps aside goes with its edit", () => {
  it("keeps what it kept when the edit it goes with cannot be undone", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    await apply(await planNow(h, app, "hooks", "off", "everywhere", notifyA), env);
    const kept = stashFiles(h);
    expect(kept).toHaveLength(1);
    setIn(settings, (value) => {
      value.hooks.Stop[0].hooks.push({ type: "command", command: "notify-c" });
    });

    const undone = await undo(env);

    expect(undone?.restored).toEqual([]);
    expect(undone?.skipped).toEqual([
      { file: settings, reason: "changed" },
      { file: kept[0], reason: "changed" },
    ]);
    expect(stashFiles(h)).toEqual(kept);
    const inv = await load(h, app);
    expect(tagsOf(inv, hookRow(inv, app, "notify-a"), app, NOW)).toContain("off");
    expect(await lastOperation(env)).toBeNull();
  });

  it("leaves what it kept for the next undo while Claude Code holds the lock of its edit", async () => {
    const { h, app } = home();
    const env: WriteEnv = { ...writeEnvFor(h.home, clock()), lockWaitMs: 300 };
    const [mine, work] = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    const before = [mine, work].map((file) => readFileSync(file, "utf8"));
    const applied = await apply(await planNow(h, app, "mcp", "off", "everywhere", figma), env);
    if (applied.status !== "applied") throw new Error(applied.status);
    const [keptMine, keptWork] = manifestOf(applied.operation.dir)
      .entries.filter((entry) => entry.what === "stash")
      .map((entry) => entry.path);

    const release = await acquireDirLock(`${mine}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    const first = await undo(env).finally(release);

    expect(first?.restored).toEqual([work, keptWork]);
    expect(first?.skipped).toEqual([
      { file: mine, reason: "locked" },
      { file: keptMine, reason: "locked" },
    ]);
    expect(readFileSync(work, "utf8")).toBe(before[1]);
    expect(json(mine).mcpServers).not.toHaveProperty("figma");
    expect(stashFiles(h)).toEqual([keptMine]);
    expect(await lastOperation(env)).toEqual({
      operation: applied.operation,
      files: [
        { path: keptMine, action: "remove" },
        { path: mine, action: "edit back" },
      ],
    });

    expect(await undo(env)).toMatchObject({
      operation: { id: applied.operation.id },
      restored: [mine, keptMine],
      skipped: [],
    });
    expect(readFileSync(mine, "utf8")).toBe(before[0]);
    expect(stashFiles(h)).toEqual([]);
    expect(await lastOperation(env)).toBeNull();
  });

  it("puts a kept copy back only once the edit that took it out of the backup is undone", async () => {
    const { h, app } = home();
    const env: WriteEnv = { ...writeEnvFor(h.home, clock()), lockWaitMs: 300 };
    const [mine, work] = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    await apply(await planNow(h, app, "mcp", "off", "everywhere", figma), env);
    const kept = stashFiles(h);
    const keptText = kept.map((file) => readFileSync(file, "utf8"));
    const offText = [mine, work].map((file) => readFileSync(file, "utf8"));
    const on = await apply(await planNow(h, app, "mcp", "on", "everywhere", figma), env);
    if (on.status !== "applied") throw new Error(on.status);
    expect(stashFiles(h)).toEqual([]);
    const keptMine = manifestOf(on.operation.dir).entries.find((e) => e.what === "stash")?.path;

    const release = await acquireDirLock(`${mine}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    const first = await undo(env).finally(release);

    // Never both live and kept: mine stays put back, and its kept copy stays in the backup.
    expect(first?.skipped).toEqual([
      { file: mine, reason: "locked" },
      { file: keptMine, reason: "locked" },
    ]);
    expect(json(mine).mcpServers.figma).toEqual({ command: "figma" });
    expect(json(work).mcpServers).not.toHaveProperty("figma");
    expect(stashFiles(h)).toEqual(kept.filter((file) => file !== keptMine));

    expect(await undo(env)).toMatchObject({ operation: { id: on.operation.id }, skipped: [] });
    expect([mine, work].map((file) => readFileSync(file, "utf8"))).toEqual(offText);
    expect(stashFiles(h)).toEqual(kept);
    expect(kept.map((file) => readFileSync(file, "utf8"))).toEqual(keptText);
    const inv = await load(h, app);
    expect(tagsOf(inv, rowIn(inv, app, "global", "figma", "claude", "mcp"), app, NOW)).toContain("off");
  });

  it("undoes two changes to one file last first, so the file ends as it was", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const settings = h.path(".claude", "settings.json");
    const before = readFileSync(settings, "utf8");
    const p = await planNow(h, app, "hooks", "off", "everywhere", (inv, project) => [
      hookRow(inv, project, "notify-a"),
      hookRow(inv, project, "notify-b"),
    ]);
    expect(p.changes.map((c) => c.file)).toEqual([settings, settings]);

    expect(await apply(p, env)).toMatchObject({ status: "applied", done: 2 });
    expect(json(settings).hooks).not.toHaveProperty("Stop");
    expect(stashFiles(h)).toHaveLength(2);

    expect(await undo(env)).toMatchObject({ skipped: [] });
    expect(readFileSync(settings, "utf8")).toBe(before);
    expect(stashFiles(h)).toEqual([]);
  });
});

describe("undo in real life", () => {
  it("stops at the first change that cannot go ahead, and undo puts back what was done", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const [first, second] = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    const firstBefore = readFileSync(first, "utf8");
    const p = await planNow(h, app, "mcp", "off", "everywhere", figma);
    setIn(second, (value) => {
      value.mcpServers.figma = { command: "figma2" };
    });

    const result = await apply(p, env);

    expect(result).toMatchObject({ status: "stopped", done: 1, total: 2, stop: { reason: "changed", file: second } });
    if (result.status !== "stopped") throw new Error(result.status);
    expect(manifestOf(result.operation.dir).status).toBe("stopped");
    expect(json(first).mcpServers).not.toHaveProperty("figma");
    expect(stashFiles(h)).toHaveLength(1);

    const undone = await undo(env);
    expect(undone?.skipped).toEqual([]);
    expect(readFileSync(first, "utf8")).toBe(firstBefore);
    expect(stashFiles(h)).toEqual([]);
  });

  it("keeps the last 50 operations", { timeout: 30_000 }, async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const off = await planNow(h, app, "skills", "off", "here", eli5);
    const first = await apply(off, env);
    const on = await planNow(h, app, "skills", "on", "here", eli5);
    const ids: string[] = [first.status === "applied" ? first.operation.id : ""];
    for (let n = 1; n < KEEP_OPERATIONS + 2; n++) {
      const result = await apply(n % 2 === 1 ? on : off, env);
      if (result.status !== "applied") throw new Error(`apply ${n}: ${result.status}`);
      ids.push(result.operation.id);
    }

    expect(ids).toHaveLength(52);
    expect(opDirs(env)).toEqual(ids.slice(2).sort());
    expect((await lastOperation(env))?.operation.id).toBe(ids.at(-1));
    expect(await pruneOperations(env)).toEqual([]);
  });

  it("undoes from what is on disk alone, with a new env", async () => {
    const { h, app } = home();
    const file = path.join(app, ".claude", "settings.local.json");
    await apply(await planNow(h, app, "skills", "off", "here", eli5), writeEnvFor(h.home, clock()));
    expect(existsSync(file)).toBe(true);

    expect(await undo(writeEnvFor(h.home))).toMatchObject({ skipped: [] });
    expect(existsSync(file)).toBe(false);
  });

  it("walks back one operation at a time", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const file = path.join(app, ".claude", "settings.local.json");
    const a = await apply(await planNow(h, app, "skills", "off", "here", eli5), env);
    const b = await apply(
      await planNow(h, app, "skills", "off", "here", (inv) => [rowIn(inv, app, "global", "old-one")]),
      env,
    );
    expect(json(file).skillOverrides).toEqual({ eli5: "off", "old-one": "off" });

    expect((await undo(env))?.operation.id).toBe(b.status === "applied" ? b.operation.id : "");
    expect(json(file).skillOverrides).toEqual({ eli5: "off" });
    expect((await undo(env))?.operation.id).toBe(a.status === "applied" ? a.operation.id : "");
    expect(existsSync(file)).toBe(false);
    expect(await undo(env)).toBeNull();
  });

  it("takes a write that was made but never recorded done as made", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const file = path.join(app, ".claude", "settings.local.json");
    const applied = await apply(await planNow(h, app, "skills", "off", "here", eli5), env);
    if (applied.status !== "applied") throw new Error(applied.status);
    // What a crash between the write and the manifest's last save leaves.
    const manifest = manifestOf(applied.operation.dir);
    for (const entry of manifest.entries) entry.done = false;
    writeFileSync(path.join(applied.operation.dir, "manifest.json"), JSON.stringify(manifest));

    expect(await lastOperation(env)).toMatchObject({ files: [{ path: file, action: "remove" }] });
    expect(await undo(env)).toMatchObject({ restored: [file], skipped: [] });
    expect(existsSync(file)).toBe(false);

    // Not done, and the file does not hold what the write was to leave: never made.
    const again = await apply(await planNow(h, app, "skills", "off", "here", eli5), env);
    if (again.status !== "applied") throw new Error(again.status);
    const notMade = manifestOf(again.operation.dir);
    for (const entry of notMade.entries) entry.done = false;
    writeFileSync(path.join(again.operation.dir, "manifest.json"), JSON.stringify(notMade));
    writeFileSync(file, "{}\n");
    expect(await lastOperation(env)).toBeNull();
  });

  it.skipIf(onWindows || process.getuid?.() === 0)(
    "records what it put back when a later step fails, and says which failed",
    async () => {
      const { h, app } = home();
      const env = writeEnvFor(h.home, clock());
      const skills = h.path(".claude", "skills");
      const [oldOne, deploy] = [path.join(skills, "old-one"), path.join(app, ".claude", "skills", "deploy-check")];
      const applied = await apply(
        await planNow(h, app, "skills", "rm", "here", (inv) => [
          rowIn(inv, app, "global", "old-one"),
          rowIn(inv, app, "project", "deploy-check"),
        ]),
        env,
      );
      if (applied.status !== "applied") throw new Error(applied.status);
      const entries = manifestOf(applied.operation.dir).entries;
      expect(entries.map((e) => e.what)).toEqual(["folder", "folder"]);

      chmodSync(skills, 0o500);
      let undone: Awaited<ReturnType<typeof undo>>;
      try {
        undone = await undo(env);
      } finally {
        chmodSync(skills, 0o755);
      }

      expect(undone).toMatchObject({
        restored: [entries[1]?.path],
        skipped: [{ file: entries[0]?.path, reason: "failed" }],
      });
      expect(existsSync(path.join(deploy, "SKILL.md"))).toBe(true);
      expect(existsSync(oldOne)).toBe(false);
      expect(existsSync(path.join(applied.operation.dir, "files", "1", "SKILL.md"))).toBe(true);
      expect(manifestOf(applied.operation.dir).undo).toEqual({
        restored: [entries[1]?.path],
        skipped: [{ file: entries[0]?.path, reason: "failed" }],
      });
    },
  );

  it("passes over a damaged manifest as no operation, never tripping on it", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const good = await apply(await planNow(h, app, "skills", "off", "here", eli5), env);
    if (good.status !== "applied") throw new Error(good.status);
    const entry = {
      path: h.path("x.json"),
      what: "json",
      change: "edited",
      backup: "files/1",
      hashBefore: "a",
      hashAfter: "b",
      done: true,
    };
    const damages: Record<string, unknown>[] = [
      { touched: "x" },
      { touched: [{ path: [{}], hash: null }] },
      { link: { target: "/x", type: "hardlink" } },
      { createdDirs: [1] },
      { named: 5 },
      { with: 7 },
      { with: 0 },
      { undone: "maybe" },
      { hashAfter: 3 },
      { lock: "yes" },
    ];
    for (const [n, damage] of damages.entries()) {
      const id = `29991231T000000${String(n).padStart(3, "0")}Z-mcp-off`;
      const dir = path.join(env.backupRoot, id);
      mkdirSync(dir, { recursive: true });
      const manifest = { ...manifestOf(good.operation.dir), id, command: "mcp", entries: [{ ...entry, ...damage }] };
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    }

    expect((await lastOperation(env))?.operation.id).toBe(good.operation.id);
    expect(await lastOperation(env, "mcp")).toBeNull();
    expect(await undo(env, "mcp")).toBeNull();
    expect((await undo(env))?.operation.id).toBe(good.operation.id);
  });

  it("finds the newest operation of one command", async () => {
    const { h, app } = home();
    const env = writeEnvFor(h.home, clock());
    const mcp = await apply(await planNow(h, app, "mcp", "off", "here", github), env);
    await apply(await planNow(h, app, "skills", "off", "here", eli5), env);

    expect((await lastOperation(env))?.operation.command).toBe("skills");
    const found = await lastOperation(env, "mcp");
    expect(found?.operation.id).toBe(mcp.status === "applied" ? mcp.operation.id : "");
    expect(found?.files).toEqual([{ path: h.path(".claude.json"), action: "edit back" }]);
    expect(await lastOperation(env, "hooks")).toBeNull();
  });
});
