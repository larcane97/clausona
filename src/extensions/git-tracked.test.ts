import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planChecked, trackedPaths } from "./git-tracked.js";
import { loadInventory } from "./inventory.js";
import { plan } from "./plan.js";
import { pathKey } from "./read.js";
import { rowsIn } from "./scopes.js";
import { TestHome } from "./test-home.js";

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
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

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
    const load = () =>
      loadInventory({ homeDir: h.home, registry: h.registry, cwd: app, managedSettings: h.path("managed.json") });
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

  it.skipIf(!hasGit)("plans again with what git tracks, so a tracked folder is refused", async () => {
    const { h, app, tracked } = repo();
    h.claude("default", ".claude", { projects: { [app]: {} } });
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("managed-settings.json"),
    });
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
