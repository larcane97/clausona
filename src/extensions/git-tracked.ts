import { execFile } from "node:child_process";
import path from "node:path";

import type { Action, ExtensionsCommand } from "./actions.js";
import type { Warning } from "./model.js";
import { localSettingsFile } from "./places.js";
import {
  type IgnoreFacts,
  LOCAL_SETTINGS_IGNORE,
  type Plan,
  type PlanContext,
  type PlanLine,
  plan,
  trackCandidates,
} from "./plan.js";
import { entryInfo, gitRoot, isWithin, pathKey, readText, samePath } from "./read.js";

/**
 * The plan as the confirm dialog and `--dry-run` show it: which of the paths it touches git
 * tracks, so a change to the repo asks first (rule A); which of its files are there yet; and
 * whether a project's first settings.local.json it makes is one git would not ignore. The one
 * module that starts a process: `git ls-files`, `git check-ignore` and `git config --get`, which
 * only read. No git, a dir that is no repo, git failing or running out of time: nothing there is
 * tracked, nothing is to be ignored, and the change is still backed up.
 */

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** The environment, without what would point git at another repo than the one `-C` names (a git hook sets these). */
function gitEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

/** git's exit code and output, null for a git that could not run or ran out of time. */
function runGit(
  git: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    try {
      execFile(git, args, { timeout: timeoutMs, env, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === "number" && !error.killed ? { code, stdout } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The files git's index holds at or under `rels` in `root`, `/`-separated; [] on any failure. */
function lsFiles(git: string, root: string, rels: string[], timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile(
        git,
        // Literal pathspecs: a folder named with * or [ is that folder, not a pattern.
        ["--literal-pathspecs", "-C", root, "ls-files", "-z", "--", ...rels],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: gitEnv(), windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve(error ? [] : stdout.split("\0").filter(Boolean)),
      );
    } catch {
      resolve([]);
    }
  });
}

/** A path as git prints it relative to `root`, compared the way the platform compares paths. */
function gitForm(root: string, p: string): string {
  const rel = path.relative(root, p).split(path.sep).join("/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
}

/** The deepest of `projects` that holds `p`. */
function projectOf(p: string, projects: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const dir of projects) if (isWithin(p, dir) && (found === undefined || isWithin(dir, found))) found = dir;
  return found;
}

/**
 * Where to ask whether a change to `p` changes a repo, and what to ask for: the repo of
 * `project`, the project `p` is in, and `p`. Or, for a `p` in a repo of its own inside the
 * project - a skills pack, a `.claude` or a `.claude/skills` cloned into place - that repo's
 * folder, which the project's repo holds only as a submodule: the clone's files are its own, not
 * the project's. Without a project, the repo `p` is in. Undefined where no repo can hold it.
 */
async function askAt(p: string, project: string | undefined): Promise<{ root: string; path: string } | undefined> {
  const own = await gitRoot(p);
  if (own === undefined) return undefined;
  if (project === undefined) return { root: own, path: p };
  const outer = await gitRoot(project);
  if (outer !== undefined && samePath(own, outer)) return { root: own, path: p };
  return outer === undefined ? undefined : { root: outer, path: own };
}

/**
 * pathKeys of the paths git tracks: one `git -C <root> ls-files -z -- <rel…>` per repo, 5 s
 * timeout, where each path is asked as askAt says, in the deepest of `projects` holding it. A
 * folder is tracked when any file under it is. Any failure: none from that root.
 */
export async function trackedPaths(
  paths: readonly string[],
  options: { git?: string; timeoutMs?: number; projects?: readonly string[] } = {},
): Promise<Set<string>> {
  const asks = await Promise.all(paths.map((p) => askAt(p, projectOf(p, options.projects ?? []))));
  const byRoot = new Map<string, { root: string; asks: { path: string; asked: string }[] }>();
  paths.forEach((p, at) => {
    const ask = asks[at];
    if (ask === undefined) return;
    const group = byRoot.get(pathKey(ask.root)) ?? { root: ask.root, asks: [] };
    group.asks.push({ path: p, asked: ask.path });
    byRoot.set(pathKey(ask.root), group);
  });
  const tracked = new Set<string>();
  await Promise.all(
    [...byRoot.values()].map(async ({ root, asks: inRoot }) => {
      const rels = inRoot.map((ask) => path.relative(root, ask.asked) || ".");
      const listed = await lsFiles(options.git ?? "git", root, rels, options.timeoutMs ?? TIMEOUT_MS);
      const files = process.platform === "win32" ? listed.map((f) => f.toLowerCase()) : listed;
      for (const ask of inRoot) {
        const rel = gitForm(root, ask.asked);
        if (files.some((file) => rel === "" || file === rel || file.startsWith(`${rel}/`))) {
          tracked.add(pathKey(ask.path));
        }
      }
    }),
  );
  return tracked;
}

/**
 * Each edited file's line said as what it is on disk: "create" where the file is not there yet
 * and the change may make it, else "edit". plan() is pure and can only tell from what the
 * inventory read.
 */
async function filesLookedAt(plan: Plan): Promise<Plan> {
  const changes = await Promise.all(
    plan.changes.map(async (change) => {
      if (change.kind === "remove") return change;
      const there = (await entryInfo(change.file)).kind !== "missing";
      const made: PlanLine["change"] = there || !change.create ? "edit" : "create";
      return { ...change, lines: change.lines.map((line) => ({ ...line, change: made })) };
    }),
  );
  return { ...plan, changes };
}

/**
 * The global ignore file git reads, found as Claude Code finds it: `core.excludesFile` from the
 * global config when it is absolute or starts with `~/`, else `$XDG_CONFIG_HOME/git/ignore` when
 * that is absolute, else `~/.config/git/ignore`.
 */
async function globalIgnoreFile(git: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const read = await runGit(git, ["config", "--global", "--get", "core.excludesFile"], env, TIMEOUT_MS);
  const named = read?.code === 0 ? read.stdout.trim() : "";
  if (named.startsWith("~/")) return path.join(homeDir, named.slice(2));
  if (named !== "" && path.isAbsolute(named)) return named;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "" && path.isAbsolute(xdg)) return path.join(xdg, "git", "ignore");
  return path.join(homeDir, ".config", "git", "ignore");
}

/** Whether `text` has `line` as one of its lines. */
function hasLine(text: string, line: string): boolean {
  return text.split(/\r?\n/).some((each) => each.trim() === line);
}

/** git's environment for what it reads of the user's setup: the inventory's home as HOME, so its global config and ignore file are that home's. */
function homeGitEnv(homeDir: string, from: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...gitEnv(from), HOME: homeDir };
}

/**
 * The pathKeys of the project settings.local.json files the plan makes, not there yet, that git
 * would not ignore: `git -C <project> check-ignore -q`, whose exit 1 says so. Any other answer,
 * no repo or no git among them, is none.
 */
async function unignoredFiles(made: Plan, git: string, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const files = made.changes.flatMap((change) =>
    change.kind === "json" &&
    change.create &&
    samePath(change.file, localSettingsFile(path.dirname(path.dirname(change.file))))
      ? [change.file]
      : [],
  );
  const unignored = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      if ((await entryInfo(file)).kind !== "missing") return;
      const project = path.dirname(path.dirname(file));
      const asked = await runGit(
        git,
        ["-C", project, "check-ignore", "-q", "--", path.relative(project, file)],
        env,
        TIMEOUT_MS,
      );
      if (asked?.code === 1) unignored.add(pathKey(file));
    }),
  );
  return unignored;
}

/**
 * The global ignore file the line goes into for `unignored`, and whether it is there; undefined
 * when it holds LOCAL_SETTINGS_IGNORE already or cannot be read, so there is nothing to add.
 */
async function ignoreFacts(
  unignored: ReadonlySet<string>,
  homeDir: string,
  git: string,
  env: NodeJS.ProcessEnv,
): Promise<IgnoreFacts | undefined> {
  const file = await globalIgnoreFile(git, homeDir, env);
  const info = await entryInfo(file);
  if (info.kind === "missing") return { file, exists: false, unignored };
  const warnings: Warning[] = [];
  const text = info.kind === "file" ? await readText(file, warnings) : undefined;
  if (text === undefined || hasLine(text, LOCAL_SETTINGS_IGNORE)) return undefined;
  return { file, exists: true, unignored };
}

/**
 * plan with an empty tracked set, trackedPaths of its trackCandidates, then plan again with them
 * and with what git's global ignore file needs; each file looked at. `env` is where git's comes
 * from, process.env by default; tests hand in one without this machine's git settings.
 */
export async function planChecked(
  ctx: Omit<PlanContext, "tracked" | "ignore">,
  command: ExtensionsCommand,
  action: Action,
  options: { git?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ plan: Plan; tracked: ReadonlySet<string>; ignore?: IgnoreFacts }> {
  const first = plan({ ...ctx, tracked: new Set() }, command, action);
  const candidates = trackCandidates(first, ctx.inv);
  const git = options.git ?? "git";
  const env = homeGitEnv(ctx.inv.homeDir, options.env);
  // Both asked at once: a git run is the slow part. A file git tracks is no file it ignores.
  const [tracked, unignored] = await Promise.all([
    candidates.length === 0
      ? new Set<string>()
      : trackedPaths(candidates, {
          projects: ctx.inv.projects.map((p) => p.path),
          ...(options.git !== undefined ? { git: options.git } : {}),
        }),
    unignoredFiles(first, git, env),
  ]);
  for (const key of tracked) unignored.delete(key);
  const ignore = unignored.size === 0 ? undefined : await ignoreFacts(unignored, ctx.inv.homeDir, git, env);
  const checked =
    tracked.size === 0 && ignore === undefined
      ? first
      : plan({ ...ctx, tracked, ...(ignore !== undefined ? { ignore } : {}) }, command, action);
  return { plan: await filesLookedAt(checked), tracked, ...(ignore !== undefined ? { ignore } : {}) };
}
