import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../test-timeouts.js";
import { isWithin } from "../read.js";
import { TestHome } from "../test-home.js";
import { codexTrustFolders } from "./codex-trust.js";

// Most cases start git.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

/** The test's own git runs: no repo a hook's environment points at, no user or system config. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_CONFIG_GLOBAL: undefined,
  GIT_CONFIG_NOSYSTEM: "1",
};

const hasGit = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: GIT_ENV, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

function home(): TestHome {
  const h = new TestHome();
  homes.push(h);
  return h;
}

/** A real repo at `dir` (relative to the home), with one commit. */
function repo(h: TestHome, dir: string): string {
  const at = h.path(dir);
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q");
  h.write(path.join(dir, "README.md"), "x\n");
  git(at, "add", ".");
  git(at, "commit", "-q", "-m", "init");
  return at;
}

/**
 * The folders in the home, each once by its real path: which folders Codex looks in, in order.
 * One above the home, a repo the temp dir is in, is not this test's.
 */
const real = (folders: string[]) =>
  [...new Set(folders.map((f) => realpathSync(f)))].filter((f) => homes.some((h) => isWithin(f, realpathSync(h.home))));

describe.skipIf(!hasGit)("codexTrustFolders", () => {
  it("looks in a folder inside a repo, then the repo's root, each by its real path first", async () => {
    const h = home();
    const mono = repo(h, "repos/mono");
    const pkg = h.path("repos", "mono", "pkg");
    mkdirSync(pkg);
    const folders = await codexTrustFolders(pkg, [".git"]);
    expect(real(folders)).toEqual([realpathSync(pkg), realpathSync(mono)]);
    expect(folders[0]).toBe(realpathSync(pkg));
    expect(folders).toContain(pkg);
    expect(folders).toContain(mono);
  });

  it("looks in a linked worktree, then its main checkout", async () => {
    const h = home();
    const app = repo(h, "repos/app");
    const wt = h.path("repos", "app-wt");
    git(app, "worktree", "add", "-q", wt);
    expect(real(await codexTrustFolders(wt, [".git"]))).toEqual([realpathSync(wt), realpathSync(app)]);
    // And from a folder inside the worktree: the folder, the worktree, the main checkout.
    const sub = path.join(wt, "sub");
    mkdirSync(sub);
    expect(real(await codexTrustFolders(sub, [".git"]))).toEqual([
      realpathSync(sub),
      realpathSync(wt),
      realpathSync(app),
    ]);
  });

  it("takes no .git folder without a HEAD for a root, and no repository for a submodule's .git file", async () => {
    const h = home();
    // TestHome's project: a .git folder with nothing in it.
    const bare = h.project("repos/bare");
    const inBare = h.path("repos", "bare", "pkg");
    mkdirSync(inBare);
    expect(real(await codexTrustFolders(inBare, [".git"]))).toEqual([realpathSync(inBare)]);
    // A submodule's .git file names the superproject's .git/modules: Codex finds no repository
    // root, so the superproject's trust is not the submodule's.
    const outer = repo(h, "repos/outer");
    mkdirSync(path.join(outer, ".git", "modules", "lib"), { recursive: true });
    h.write("repos/outer/.git/modules/lib/HEAD", "ref: refs/heads/main\n");
    h.write("repos/outer/lib/.git", "gitdir: ../.git/modules/lib\n");
    const lib = h.path("repos", "outer", "lib");
    expect(real(await codexTrustFolders(lib, [".git"]))).toEqual([realpathSync(lib)]);
    expect(bare).toBe(h.path("repos", "bare"));
  });

  it("finds the project root by the markers config.toml names, and the repository's root by .git all the same", async () => {
    const h = home();
    const mono = repo(h, "repos/mono");
    const pkg = h.path("repos", "mono", "lib", "pkg");
    mkdirSync(pkg, { recursive: true });
    h.write("repos/mono/lib/.root", "");
    const lib = h.path("repos", "mono", "lib");
    expect(real(await codexTrustFolders(pkg, [".root"]))).toEqual([
      realpathSync(pkg),
      realpathSync(lib),
      realpathSync(mono),
    ]);
    // No markers: no project root, and the repository's root still.
    expect(real(await codexTrustFolders(pkg, []))).toEqual([realpathSync(pkg), realpathSync(mono)]);
  });

  it("looks in a folder outside any repo by its own path alone", async () => {
    const h = home();
    const loose = h.path("loose");
    mkdirSync(loose);
    expect(real(await codexTrustFolders(loose, [".git"]))).toEqual([realpathSync(loose)]);
  });
});
