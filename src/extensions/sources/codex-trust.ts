import path from "node:path";

import { entryInfo, isRecord, readText, realPath } from "../read.js";

/**
 * Where Codex 0.159.3 looks for a project's trust. `ProjectTrustContext::decision_for_dir`
 * (config/src/loader/mod.rs) takes the first `[projects."<folder>"]` with a `trust_level` among
 * the folder that holds a `.codex`, the project root, and the repository's root - for a linked
 * worktree, its main checkout (`resolve_root_git_project_for_trust`, git-utils/src/trust.rs).
 * Each folder by its real path first, then as spelled (`normalized_project_trust_keys`). It reads
 * the files git keeps and runs no git, and so does this.
 */

/** Codex's project root markers when the user config.toml names none. */
const DEFAULT_MARKERS = [".git"];

/** The most of a `.git` file, or of a worktree's `gitdir` and `commondir`, that Codex reads. */
const MAX_GIT_FILE = 64 * 1024;

/**
 * The markers Codex finds a project root by: `project_root_markers` in the user config.toml,
 * an empty list for none, or `.git`. A value Codex cannot read stops Codex loading its config at
 * all; `.git` is kept then.
 */
export function projectRootMarkers(config: Record<string, unknown> | undefined): string[] {
  const markers = isRecord(config) ? config.project_root_markers : undefined;
  return Array.isArray(markers) && markers.every((m) => typeof m === "string") ? markers : DEFAULT_MARKERS;
}

/**
 * The folders whose trust Codex takes for a `.codex` folder in `project`, run from there, in the
 * order it looks: `project`, then its project root - the nearest folder at or above it with one
 * of `markers` - then its repository's root (`repositoryRoot`). Each by its real path, then as
 * spelled; each once.
 */
export async function codexTrustFolders(project: string, markers: readonly string[]): Promise<string[]> {
  const dir = path.resolve(project);
  const byGit = markers.length === 1 && markers[0] === ".git";
  const [checkout, other] = await Promise.all([
    nearestWith(dir, [".git"]),
    byGit ? undefined : nearestWith(dir, markers),
  ]);
  const root = byGit ? checkout : other;
  const repository = checkout === undefined ? undefined : await repositoryRoot(checkout);
  const folders = [dir, root, repository].filter((folder): folder is string => folder !== undefined);
  const spelled = await Promise.all(
    folders.map(async (folder) => [await realPath(folder).catch(() => folder), folder]),
  );
  return [...new Set(spelled.flat())];
}

/**
 * The nearest folder at or above `dir` with one of `markers` in it, as Codex's
 * `discover_project_root` finds it: a `.git` folder counts only with a HEAD in it.
 */
async function nearestWith(dir: string, markers: readonly string[]): Promise<string | undefined> {
  if (markers.length === 0) return undefined;
  for (let folder = dir; ; folder = path.dirname(folder)) {
    for (const marker of markers) if (await hasMarker(folder, marker)) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
}

async function hasMarker(folder: string, marker: string): Promise<boolean> {
  const at = path.join(folder, marker);
  const info = await entryInfo(at);
  if (info.kind === "missing") return false;
  return marker !== ".git" || info.kind !== "dir" || (await entryInfo(path.join(at, "HEAD"))).kind !== "missing";
}

/**
 * The repository's root, as `resolve_root_git_project_for_trust` finds it from `checkout`, the
 * nearest folder with a `.git`. A `.git` folder makes it the root. A `.git` file makes it a linked
 * worktree only when what git keeps for one agrees: its `gitdir:` names a folder in a
 * `.git/worktrees`, whose `gitdir` names this checkout's `.git` and whose `commondir` names that
 * `.git` - and the root is then the main checkout that holds it, as the `gitdir:` spells it.
 * Undefined for any other `.git` file, a submodule's among them, and where a check fails.
 */
async function repositoryRoot(checkout: string): Promise<string | undefined> {
  const dotGit = path.join(checkout, ".git");
  const info = await entryInfo(dotGit);
  if (info.kind === "dir") return checkout;
  const gitDir = await gitdirOf(dotGit);
  if (gitDir === undefined || (await plainEntry(gitDir)) !== "dir") return undefined;
  const realGitDir = await realPath(gitDir).catch(() => undefined);
  if (realGitDir === undefined || path.basename(path.dirname(realGitDir)) !== "worktrees") return undefined;
  const commonDir = path.dirname(path.dirname(realGitDir));
  const [registered, common] = await Promise.all([
    gitFile(path.join(realGitDir, "gitdir")),
    gitFile(path.join(realGitDir, "commondir")),
  ]);
  if (registered === undefined || common === undefined) return undefined;
  const registeredGit = path.resolve(realGitDir, registered);
  if (path.basename(registeredGit) !== ".git") return undefined;
  const [registeredCheckout, thisCheckout, linkedCommon] = await Promise.all(
    [path.dirname(registeredGit), checkout, path.resolve(realGitDir, common)].map((p) =>
      realPath(p).catch(() => undefined),
    ),
  );
  if (registeredCheckout === undefined || registeredCheckout !== thisCheckout || linkedCommon !== commonDir) {
    return undefined;
  }
  // `<main>/.git/worktrees/<name>`, as the worktree's .git file names it.
  const main = path.dirname(path.dirname(path.dirname(gitDir)));
  const mainGit = path.join(main, ".git");
  const mainGitDir = (await entryInfo(mainGit)).kind === "dir" ? mainGit : await gitdirOf(mainGit);
  if (mainGitDir === undefined || (await realPath(mainGitDir).catch(() => undefined)) !== commonDir) return undefined;
  return main;
}

/** A file or folder's kind, `link` for a link, as Codex's checks tell them apart. */
async function plainEntry(p: string): Promise<"dir" | "file" | "link" | "other"> {
  const info = await entryInfo(p);
  if (info.link) return "link";
  return info.kind === "dir" || info.kind === "file" ? info.kind : "other";
}

/** The folder a `.git` file's `gitdir:` line names, from the folder that holds the file. */
async function gitdirOf(dotGit: string): Promise<string | undefined> {
  const text = await gitFile(dotGit);
  const target = text?.startsWith("gitdir:") ? text.slice("gitdir:".length).trim() : "";
  return target === "" ? undefined : path.resolve(path.dirname(dotGit), target);
}

/** A file git keeps, trimmed: a plain file, no link, of at most MAX_GIT_FILE, and not blank. */
async function gitFile(file: string): Promise<string | undefined> {
  if ((await plainEntry(file)) !== "file") return undefined;
  const text = await readText(file, []);
  if (text === undefined || Buffer.byteLength(text) > MAX_GIT_FILE) return undefined;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}
