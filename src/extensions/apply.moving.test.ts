import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Seams into `rename`, `cp` and `rm`, as a backup on another volume and a process cut short
 * would leave things: `exdev` names the renames that fail as one across file systems does,
 * `failRename` the ones that fail as a killed process never makes them, `cpFails` a copy that
 * runs, then fails as a disk that filled up would, and `failRm` the removals that fail.
 */
const fsHooks = vi.hoisted(() => ({
  exdev: undefined as ((from: string, to: string) => boolean) | undefined,
  failRename: undefined as ((from: string, to: string) => boolean) | undefined,
  cpFails: false,
  failRm: undefined as ((p: string) => boolean) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const rename: typeof actual.rename = async (from, to) => {
    if (fsHooks.exdev?.(String(from), String(to))) throw fail("EXDEV");
    if (fsHooks.failRename?.(String(from), String(to))) throw fail("EIO");
    return actual.rename(from, to);
  };
  const cp: typeof actual.cp = async (from, to, options) => {
    await actual.cp(from, to, options);
    if (!fsHooks.cpFails) return;
    fsHooks.cpFails = false;
    throw fail("ENOSPC");
  };
  const rm: typeof actual.rm = async (p, options) => {
    if (fsHooks.failRm?.(String(p))) throw fail("EACCES");
    return actual.rm(p, options);
  };
  return { ...actual, default: { ...actual, rename, cp, rm }, rename, cp, rm };
});

import type { Action } from "./actions.js";
import { apply, lastOperation, type Manifest, undo, type WriteEnv, writeEnvFor } from "./apply.js";
import { loadInventory } from "./inventory.js";
import { type Plan, plan } from "./plan.js";
import { hashTree } from "./read.js";
import { rowsIn } from "./scopes.js";
import { TestHome } from "./test-home.js";

const NOW = Date.UTC(2026, 9, 10, 4, 36, 48);
const homes: TestHome[] = [];
afterEach(() => {
  fsHooks.exdev = undefined;
  fsHooks.failRename = undefined;
  fsHooks.cpFails = false;
  fsHooks.failRm = undefined;
  for (const home of homes.splice(0)) home.dispose();
});

/** A clock 1000 ms on from the last time at every call. */
function clock(): () => number {
  let at = NOW;
  return () => {
    at += 1000;
    return at;
  };
}

/** One account with the Global skills old-one (a folder with a file in it) and eli5, seen from app. */
async function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", { projects: { [app]: {} } });
  h.skill(".claude/skills", "old-one");
  h.write(".claude/skills/old-one/notes/a.txt", "a");
  h.skill(".claude/skills", "eli5");
  const env = writeEnvFor(h.home, clock());
  return {
    h,
    app,
    env,
    // Its real path, as the plan deletes it: the temp dir is reached through a link on macOS.
    folder: realpathSync.native(h.path(".claude", "skills", "old-one")),
    before: await hashTree(h.path(".claude", "skills", "old-one")),
  };
}

async function planFor(h: TestHome, app: string, verb: Action["verb"], name: string): Promise<Plan> {
  const inv = await loadInventory(h.inventoryOptions(app, h.path("managed-settings.json")));
  const row = rowsIn(inv, "claude", "skill", "global", app, NOW).find((r) => r.name === name);
  if (!row) throw new Error(`no ${name} row`);
  const ctx = {
    inv,
    project: app,
    now: NOW,
    tracked: new Set<string>(),
    stashDir: h.path(".clausona", "extensions", "stash"),
  };
  return plan(ctx, "skills", { verb, reach: "here", rows: [row] });
}

const manifestOf = (env: WriteEnv, id: string): Manifest =>
  JSON.parse(readFileSync(path.join(env.backupRoot, id, "manifest.json"), "utf8"));

/** What clausona set aside under ~/.claude, the folder above the skills folder. */
const asides = (h: TestHome) => readdirSync(h.path(".claude")).filter((name) => name.startsWith(".clausona-"));

/**
 * `rm old-one`, its backup on another volume, cut short between the set-aside and the copy: the
 * copy fails, and so does putting the folder back, as when the process is killed there.
 */
async function cutShort(): Promise<Awaited<ReturnType<typeof seed>> & { id: string }> {
  const seeded = await seed();
  const { h, app, env, folder } = seeded;
  const p = await planFor(h, app, "rm", "old-one");
  fsHooks.exdev = (from, to) => from === folder && to.startsWith(env.backupRoot);
  fsHooks.cpFails = true;
  fsHooks.failRename = (from, to) => to === folder && path.basename(from).endsWith(".moving");
  const result = await apply(p, env);
  expect(result).toMatchObject({ status: "stopped", stop: { reason: "failed", detail: "ENOSPC" } });
  fsHooks.exdev = undefined;
  fsHooks.failRename = undefined;
  if (result.status !== "stopped") throw new Error(result.status);
  return { ...seeded, id: result.operation.id };
}

describe("a move across volumes cut short", () => {
  it("keeps the folder out of the skills folder and records where, and undo puts it back", async () => {
    const { h, env, folder, before, id } = await cutShort();
    expect(existsSync(folder)).toBe(false);
    // Neither tool would list it: it waits in ~/.claude, under a dot name.
    expect(readdirSync(h.path(".claude", "skills")).sort()).toEqual(["eli5"]);
    const [aside] = asides(h);
    expect(aside).toMatch(/^\.clausona-old-one-\d+-[0-9a-f]{12}\.moving$/);
    expect(manifestOf(env, id).entries[0]).toMatchObject({
      what: "folder",
      done: false,
      moving: {
        from: folder,
        aside: path.join(realpathSync.native(h.path(".claude")), aside ?? ""),
        landed: false,
        pid: process.pid,
      },
    });

    expect((await lastOperation(env))?.files).toEqual([{ path: folder, action: "put back" }]);
    expect(await undo(env)).toMatchObject({ restored: [folder], skipped: [] });
    expect(await hashTree(folder)).toBe(before);
    expect(asides(h)).toEqual([]);
    expect(manifestOf(env, id).entries[0]?.moving).toBeUndefined();
  });

  it("is rolled back by the next change, as the move never happened", async () => {
    const { h, app, env, folder, before, id } = await cutShort();
    const next = await apply(await planFor(h, app, "off", "eli5"), env);
    expect(next.status).toBe("applied");
    expect(await hashTree(folder)).toBe(before);
    expect(asides(h)).toEqual([]);
    expect(manifestOf(env, id).entries[0]?.moving).toBeUndefined();
    // The newest change is the one undo takes, and the delete has nothing left to undo.
    expect((await lastOperation(env))?.operation.summary).toBe("Turned off eli5 in this project");
    await undo(env);
    expect(await lastOperation(env)).toBeNull();
  });

  it("is finished by the next change once the copy landed, and undo puts it back from the backup", async () => {
    const { h, app, env, folder, before } = await seed();
    const p = await planFor(h, app, "rm", "old-one");
    fsHooks.exdev = (from, to) => from === folder && to.startsWith(env.backupRoot);
    // The copy landed; removing what was set aside fails.
    fsHooks.failRm = (p) => path.basename(p).endsWith(".moving");
    const result = await apply(p, env);
    expect(result).toMatchObject({ status: "stopped", stop: { reason: "failed", detail: "EACCES" } });
    if (result.status !== "stopped") throw new Error(result.status);
    expect(manifestOf(env, result.operation.id).entries[0]?.moving).toMatchObject({ landed: true });
    fsHooks.exdev = undefined;
    fsHooks.failRm = undefined;
    expect(asides(h)).toHaveLength(1);

    await apply(await planFor(h, app, "off", "eli5"), env);
    expect(asides(h)).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    await undo(env);
    expect(await undo(env)).toMatchObject({ restored: [folder], skipped: [] });
    expect(await hashTree(folder)).toBe(before);
  });

  it("puts a folder back that an undo across volumes left part way, on the next undo", async () => {
    const { h, app, env, folder, before } = await seed();
    const result = await apply(await planFor(h, app, "rm", "old-one"), env);
    if (result.status !== "applied") throw new Error(result.status);
    const backup = path.join(result.operation.dir, "files", "1");
    // Undo's move back is the one across volumes, and the process is killed before the copy
    // lands: neither the backup going back nor any save after the copy is made.
    fsHooks.exdev = (from, to) => from === backup && to === folder;
    fsHooks.cpFails = true;
    fsHooks.failRename = (_from, to) => to === backup || (!fsHooks.cpFails && to.endsWith("manifest.json"));
    await expect(undo(env)).rejects.toMatchObject({ code: "EIO" });
    fsHooks.failRename = undefined;
    // Not in the skills folder, part copied or whole.
    expect(readdirSync(h.path(".claude", "skills")).sort()).toEqual(["eli5"]);
    expect(existsSync(backup)).toBe(false);

    // The next undo takes the backup back from where it waited, then moves it as it should.
    expect((await lastOperation(env))?.files).toEqual([{ path: folder, action: "put back" }]);
    expect(await undo(env)).toMatchObject({ restored: [folder], skipped: [] });
    expect(await hashTree(folder)).toBe(before);
    expect(readdirSync(result.operation.dir).filter((name) => name.startsWith(".clausona-"))).toEqual([]);
    expect(asides(h)).toEqual([]);
  });
});
