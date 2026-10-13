import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import { apply, undo, writeEnvFor } from "./apply.js";
import { planChecked, trackedPaths } from "./git-tracked.js";
import { loadInventory } from "./inventory.js";
import { localSettingsFile as local } from "./places.js";
import { plan } from "./plan.js";
import { pathKey } from "./read.js";
import { rowsIn } from "./scopes.js";
import { TestHome } from "./test-home.js";

// Every case starts git, some of them a dozen times.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

const NOW = Date.UTC(2026, 9, 10);

/** The test's own git runs: not told where a repo is by a hook's environment (spawn leaves undefined out). */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

const hasGit = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

/**
 * git as planChecked runs it in these tests: the home's own global config and ignore file, none
 * of this machine's. planChecked sets HOME to the inventory's home itself.
 */
const IGNORE_ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  XDG_CONFIG_HOME: undefined,
  GIT_CONFIG_GLOBAL: undefined,
  GIT_CONFIG_NOSYSTEM: "1",
};

/** `git check-ignore -q` of app's settings.local.json, with the home as HOME: 0 ignored, 1 not. */
function checkIgnore(app: string, env: NodeJS.ProcessEnv): number | null {
  const home = path.dirname(path.dirname(app));
  return spawnSync("git", ["-C", app, "check-ignore", "-q", "--", path.join(".claude", "settings.local.json")], {
    env: { ...env, HOME: home },
  }).status;
}

/**
 * repos/app, a real repo unless `repo` is false (then a .git folder that holds none), seen by
 * one account, and a Global eli5; `check` plans eli5 off here, which makes app's first
 * settings.local.json, as planChecked shows it.
 */
function ignoring(more?: (h: TestHome, app: string) => void, repo = true) {
  const h = new TestHome();
  homes.push(h);
  const app = repo ? h.path("repos", "app") : h.project("repos/app");
  if (repo) {
    mkdirSync(app, { recursive: true });
    git(app, ["init", "-q"]);
  }
  h.claude("default", ".claude", { projects: { [app]: {} } });
  h.skill(".claude/skills", "eli5");
  more?.(h, app);
  const check = async (env: NodeJS.ProcessEnv = IGNORE_ENV, gitBinary?: string) => {
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("managed.json"),
    });
    const row = rowsIn(inv, "claude", "skill", "global", app, NOW).find((r) => r.name === "eli5");
    if (!row) throw new Error("no eli5 row");
    const ctx = { inv, project: app, now: NOW, stashDir: h.path(".clausona", "extensions", "stash") };
    return planChecked(
      ctx,
      "skills",
      { verb: "off", reach: "here", rows: [row] },
      {
        env,
        ...(gitBinary !== undefined ? { git: gitBinary } : {}),
      },
    );
  };
  return { h, app, check, env: IGNORE_ENV };
}

/** repos/app as a real repo, with tracked-one added to git (not committed) and loose left out. */
function repo() {
  const h = new TestHome();
  homes.push(h);
  const app = h.path("repos", "app");
  mkdirSync(app, { recursive: true });
  git(app, ["init", "-q"]);
  const tracked = h.skill("repos/app/.claude/skills", "tracked-one");
  const loose = h.skill("repos/app/.claude/skills", "loose");
  git(app, ["add", path.join(".claude", "skills", "tracked-one", "SKILL.md")]);
  return { h, app, tracked, loose };
}

describe("trackedPaths", () => {
  it.skipIf(!hasGit)("finds the folders git tracks a file in, and nothing else", async () => {
    const { h, tracked, loose } = repo();
    h.write("outside.txt", "x");
    expect(await trackedPaths([tracked, loose, h.path("outside.txt")])).toEqual(new Set([pathKey(tracked)]));
    expect(await trackedPaths([path.join(tracked, "SKILL.md")])).toEqual(
      new Set([pathKey(path.join(tracked, "SKILL.md"))]),
    );
  });

  it.skipIf(!hasGit)(
    "asks the project's repo about a folder that is a clone of its own, and what is in it",
    async () => {
      const { h, app } = repo();
      const projects = [app];
      const commit = (dir: string) =>
        git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "x"]);
      // A skills pack cloned into the project, which the project's git does not hold: the clone's
      // files are its own, and deleting it leaves the project's repo as it was.
      const pack = h.skill("repos/app/.claude/skills", "pack");
      git(pack, ["init", "-q"]);
      git(pack, ["add", "SKILL.md"]);
      expect(await trackedPaths([pack], { projects })).toEqual(new Set());
      // A whole skills folder cloned into place: a skill in it is the clone's too.
      const team = h.path("repos", "app", ".agents", "skills");
      const inTeam = h.skill("repos/app/.agents/skills", "team-one");
      git(team, ["init", "-q"]);
      git(team, ["add", "."]);
      expect(await trackedPaths([inTeam, path.join(inTeam, "SKILL.md")], { projects })).toEqual(new Set());
      // One the project's repo holds, as a submodule's gitlink, is the project's, and so is what is in it.
      const held = h.skill("repos/app/.claude/skills", "held");
      git(held, ["init", "-q"]);
      git(held, ["add", "SKILL.md"]);
      commit(held);
      git(app, ["add", path.join(".claude", "skills", "held")]);
      expect(await trackedPaths([pack, held, path.join(held, "SKILL.md")], { projects })).toEqual(
        new Set([pathKey(held), pathKey(path.join(held, "SKILL.md"))]),
      );
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "finds nothing tracked in a project that is no repo, a clone inside it aside",
    async () => {
      const h = new TestHome();
      homes.push(h);
      const site = h.path("repos", "site");
      const pack = h.skill("repos/site/.claude/skills", "pack");
      git(pack, ["init", "-q"]);
      git(pack, ["add", "SKILL.md"]);
      expect(await trackedPaths([pack, path.join(pack, "SKILL.md")], { projects: [site] })).toEqual(new Set());
      // Asked with no project, a path is asked of the repo it is in.
      expect(await trackedPaths([path.join(pack, "SKILL.md")])).toEqual(
        new Set([pathKey(path.join(pack, "SKILL.md"))]),
      );
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it("finds nothing outside a repo, or when git cannot be run", async () => {
    const h = new TestHome();
    homes.push(h);
    h.skill("plain", "skill-one");
    expect(await trackedPaths([h.path("plain", "skill-one")])).toEqual(new Set());
    expect(await trackedPaths([])).toEqual(new Set());
    if (hasGit) {
      const { tracked } = repo();
      expect(await trackedPaths([tracked], { git: h.path("no-such-git") })).toEqual(new Set());
    }
  });
});

describe("planChecked", () => {
  it("says a file is edited where it is there, though the inventory read nothing from it", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: {} } });
    h.skill(".claude/skills", "eli5");
    const load = () => loadInventory(h.inventoryOptions(app, h.path("managed.json")));
    const checkedChange = async () => {
      const inv = await load();
      const row = rowsIn(inv, "claude", "skill", "global", app, NOW).find((r) => r.name === "eli5");
      if (!row) throw new Error("no eli5 row");
      const ctx = { inv, project: app, now: NOW, stashDir: h.path(".clausona", "extensions", "stash") };
      const action = { verb: "off" as const, reach: "here" as const, rows: [row] };
      return {
        planned: plan({ ...ctx, tracked: new Set() }, "skills", action).changes[0]?.lines[0]?.change,
        checked: (await planChecked(ctx, "skills", action)).plan.changes[0]?.lines[0]?.change,
      };
    };
    expect(await checkedChange()).toEqual({ planned: "create", checked: "create" });
    // Permissions only: nothing the inventory lists, so the pure plan cannot tell it is there.
    h.write("repos/app/.claude/settings.local.json", { permissions: { allow: [] } });
    expect(await checkedChange()).toEqual({ planned: "create", checked: "edit" });
  });

  it.skipIf(!hasGit)(
    "adds Claude Code's line to git's global ignore file with a project's first settings.local.json, and undo takes it out",
    async () => {
      const { h, app, check, env } = ignoring();
      const ignore = h.path(".config", "git", "ignore");
      const { plan, ignore: facts } = await check();
      expect(plan.changes.map((c) => [c.kind, c.file])).toEqual([
        ["json", path.join(app, ".claude", "settings.local.json")],
        ["text", ignore],
      ]);
      expect(plan.changes[1]?.lines).toEqual([
        {
          file: ignore,
          change: "create",
          what: "adds **/.claude/settings.local.json",
          note: "as Claude Code does",
          tracked: false,
          rows: ["skill:claude:global:-:eli5"],
        },
      ]);
      expect(facts).toEqual({ file: ignore, exists: false, unignored: new Set([pathKey(local(app))]) });

      const writes = writeEnvFor(h.home, () => NOW);
      expect(await apply(plan, writes)).toMatchObject({ status: "applied", done: 2 });
      expect(readFileSync(ignore, "utf8")).toBe("**/.claude/settings.local.json\n");
      expect(checkIgnore(app, env)).toBe(0);
      expect(await undo(writes)).toMatchObject({ skipped: [] });
      expect(existsSync(ignore)).toBe(false);
      expect(existsSync(h.path(".config"))).toBe(false);
      expect(existsSync(local(app))).toBe(false);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "adds it after the last line of the file core.excludesFile names, or under XDG_CONFIG_HOME",
    async () => {
      const named = ignoring((h) => {
        h.write(".gitconfig", "[core]\n\texcludesFile = ~/dotfiles/gitignore\n");
        h.write("dotfiles/gitignore", "node_modules");
      });
      const file = named.h.path("dotfiles", "gitignore");
      const { plan } = await named.check();
      expect(plan.changes[1]).toMatchObject({ kind: "text", file, lines: [{ file, change: "edit" }] });
      await apply(
        plan,
        writeEnvFor(named.h.home, () => NOW),
      );
      expect(readFileSync(file, "utf8")).toBe("node_modules\n**/.claude/settings.local.json\n");
      expect(checkIgnore(named.app, named.env)).toBe(0);

      const xdg = ignoring();
      const env = { ...xdg.env, XDG_CONFIG_HOME: xdg.h.path("xdg") };
      const { plan: inXdg } = await xdg.check(env);
      expect(inXdg.changes[1]?.file).toBe(xdg.h.path("xdg", "git", "ignore"));
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "adds nothing where git ignores it already, the file is there, the line is, or no repo or git",
    async () => {
      const kinds = async (check: () => Promise<{ plan: { changes: { kind: string }[] } }>) =>
        (await check()).plan.changes.map((c) => c.kind);
      const ignored = ignoring((h, app) => h.write(path.join(path.relative(h.home, app), ".gitignore"), ".claude/\n"));
      expect(await kinds(ignored.check)).toEqual(["json"]);
      // Permissions only: the file is there, though the inventory lists nothing from it.
      const there = ignoring((h, app) => h.write(path.relative(h.home, local(app)), { permissions: { allow: [] } }));
      expect(await kinds(there.check)).toEqual(["json"]);
      // The line is in the file already, though git reads another: a relative core.excludesFile,
      // which Claude Code passes over too.
      const listed = ignoring((h) => {
        h.write(".gitconfig", "[core]\n\texcludesFile = relative-ignore\n");
        h.write(".config/git/ignore", "x\n**/.claude/settings.local.json\n");
      });
      expect(checkIgnore(listed.app, listed.env)).toBe(1);
      expect(await kinds(listed.check)).toEqual(["json"]);
      const noGit = ignoring();
      expect(await kinds(() => noGit.check(noGit.env, noGit.h.path("no-such-git")))).toEqual(["json"]);
      // A folder with a .git folder that holds no repo: git says it is none.
      const notRepo = ignoring(undefined, false);
      expect(await kinds(notRepo.check)).toEqual(["json"]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)("plans again with what git tracks, so a tracked folder is refused", async () => {
    const { h, app, tracked } = repo();
    h.claude("default", ".claude", { projects: { [app]: {} } });
    const inv = await loadInventory(h.inventoryOptions(app, h.path("managed-settings.json")));
    const row = rowsIn(inv, "claude", "skill", "project", app, NOW).find((r) => r.name === "tracked-one");
    if (!row) throw new Error("no tracked-one row");
    const ctx = { inv, project: app, now: NOW, stashDir: h.path(".clausona", "extensions", "stash") };
    const checked = await planChecked(ctx, "skills", { verb: "rm", reach: "here", rows: [row] });
    expect(checked.plan.changes).toEqual([]);
    expect(checked.plan.refused.map((r) => [r.code, r.reason])).toEqual([
      ["tracked", "Git tracks it in app, so this changes the repo."],
    ]);
    expect(checked.tracked.has(pathKey(tracked))).toBe(true);
    const allowed = await planChecked(ctx, "skills", { verb: "rm", reach: "here", rows: [row], tracked: true });
    expect(allowed.plan.changes).toMatchObject([{ kind: "remove", lines: [{ tracked: true }] }]);
  });
});
