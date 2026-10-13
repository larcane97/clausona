import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../test-timeouts.js";
import { isWithin } from "../read.js";
import { TestHome } from "../test-home.js";
import { codexCanonical, codexRoots, codexTrustFolders } from "./codex-trust.js";

// Most cases start git.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

const hasGit = spawnSync("git", ["--version"]).status === 0;

/** The test's own git run in `h`, with none of the user's git config (TestHome.gitEnv). */
function git(h: TestHome, cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, ...h.gitEnv() }, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
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
  git(h, at, "init", "-q");
  h.write(path.join(dir, "README.md"), "x\n");
  git(h, at, "add", ".");
  git(h, at, "commit", "-q", "-m", "init");
  return at;
}

/**
 * The folders in the home, each once by its real path: which folders Codex looks in, in order.
 * One above the home, a repo the temp dir is in, is not this test's. realpath's own, which on
 * Windows makes an 8.3 short name long, as Codex's canonicalize and git do.
 */
const real = (folders: string[]) =>
  [...new Set(folders.map((f) => realpathSync.native(f)))].filter((f) =>
    homes.some((h) => isWithin(f, realpathSync.native(h.home))),
  );

describe.skipIf(!hasGit)("codexTrustFolders", () => {
  it("looks in a folder inside a repo, then the repo's root, each by its real path first", async () => {
    const h = home();
    const mono = repo(h, "repos/mono");
    const pkg = h.path("repos", "mono", "pkg");
    mkdirSync(pkg);
    const folders = await codexTrustFolders(pkg, [".git"]);
    expect(real(folders)).toEqual([realpathSync.native(pkg), realpathSync.native(mono)]);
    expect(folders[0]).toBe(realpathSync.native(pkg));
    expect(folders).toContain(pkg);
    expect(folders).toContain(mono);
  });

  it("looks in a linked worktree, then its main checkout", async () => {
    const h = home();
    const app = repo(h, "repos/app");
    const wt = h.path("repos", "app-wt");
    git(h, app, "worktree", "add", "-q", wt);
    expect(real(await codexTrustFolders(wt, [".git"]))).toEqual([realpathSync.native(wt), realpathSync.native(app)]);
    // And from a folder inside the worktree: the folder, the worktree, the main checkout.
    const sub = path.join(wt, "sub");
    mkdirSync(sub);
    expect(real(await codexTrustFolders(sub, [".git"]))).toEqual([
      realpathSync.native(sub),
      realpathSync.native(wt),
      realpathSync.native(app),
    ]);
  });

  it("gives a linked worktree's main checkout, and the .codex folder at the project's place there", async () => {
    const h = home();
    const app = repo(h, "repos/app");
    const wt = h.path("repos", "app-wt");
    git(h, app, "worktree", "add", "-q", wt);
    const sub = path.join(wt, "sub");
    mkdirSync(sub);
    // As the worktree's .git file names it: by its real path, as git writes it.
    const main = realpathSync.native(app);
    expect((await codexRoots(wt, [".git"])).worktree).toEqual({ main, hooks: path.join(main, ".codex") });
    expect((await codexRoots(sub, [".git"])).worktree).toEqual({ main, hooks: path.join(main, "sub", ".codex") });
    // The main checkout itself is no worktree.
    expect((await codexRoots(app, [".git"])).worktree).toBeUndefined();
  });

  it("takes no .git folder without a HEAD for a root, and no repository for a submodule's .git file", async () => {
    const h = home();
    // TestHome's project: a .git folder with nothing in it.
    const bare = h.project("repos/bare");
    const inBare = h.path("repos", "bare", "pkg");
    mkdirSync(inBare);
    expect(real(await codexTrustFolders(inBare, [".git"]))).toEqual([realpathSync.native(inBare)]);
    // A submodule's .git file names the superproject's .git/modules: Codex finds no repository
    // root, so the superproject's trust is not the submodule's.
    const outer = repo(h, "repos/outer");
    mkdirSync(path.join(outer, ".git", "modules", "lib"), { recursive: true });
    h.write("repos/outer/.git/modules/lib/HEAD", "ref: refs/heads/main\n");
    h.write("repos/outer/lib/.git", "gitdir: ../.git/modules/lib\n");
    const lib = h.path("repos", "outer", "lib");
    expect(real(await codexTrustFolders(lib, [".git"]))).toEqual([realpathSync.native(lib)]);
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
      realpathSync.native(pkg),
      realpathSync.native(lib),
      realpathSync.native(mono),
    ]);
    // No markers: no project root, and the repository's root still.
    expect(real(await codexTrustFolders(pkg, []))).toEqual([realpathSync.native(pkg), realpathSync.native(mono)]);
  });

  it("looks in a folder outside any repo by its own path alone", async () => {
    const h = home();
    const loose = h.path("loose");
    mkdirSync(loose);
    expect(real(await codexTrustFolders(loose, [".git"]))).toEqual([realpathSync.native(loose)]);
  });
});

describe("codexCanonical", () => {
  // What realpath gives on Windows, which always drops the \\?\ that Windows gives a real path.
  const share = "\\\\server\\share\\repos\\app";
  const local = "C:\\Users\\runneradmin\\repos\\app";

  it("spells a real path as Codex's dunce::canonicalize does on Windows, keeping its verbatim prefix where dropping it could change the path", () => {
    expect(codexCanonical(local, "win32")).toBe(local);
    expect(codexCanonical("C:\\", "win32")).toBe("C:\\");
    // A network share, a mapped drive's among them: Windows names it \\?\UNC\server\share.
    expect(codexCanonical(share, "win32")).toBe("\\\\?\\UNC\\server\\share\\repos\\app");
    // Over 260 characters with the \\?\.
    const fits = path.win32.join("C:\\", "a".repeat(253));
    expect(`\\\\?\\${fits}`).toHaveLength(260);
    expect(codexCanonical(fits, "win32")).toBe(fits);
    expect(codexCanonical(`${fits}b`, "win32")).toBe(`\\\\?\\${fits}b`);
    // A part that is a device name, or ends in a dot or a space; a name like one is fine.
    for (const part of ["con", "COM1.txt", "aux .log", "dot.", "space "]) {
      expect(codexCanonical(path.win32.join(local, part), "win32")).toBe(`\\\\?\\${path.win32.join(local, part)}`);
    }
    for (const part of ["console", ".con", "com0", "con.d.txt"]) {
      expect(codexCanonical(path.win32.join(local, part), "win32")).toBe(path.win32.join(local, part));
    }
  });

  it("is the real path itself anywhere but Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(codexCanonical("/private/var/folders/app", platform)).toBe("/private/var/folders/app");
      expect(codexCanonical(share, platform)).toBe(share);
    }
  });
});
