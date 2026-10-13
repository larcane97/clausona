import { execFile } from "node:child_process";
import path from "node:path";

import type { Action, ExtensionsCommand } from "./actions.js";
import { type Plan, type PlanContext, type PlanLine, plan, trackCandidates } from "./plan.js";
import { entryInfo, gitRoot, isWithin, pathKey, samePath } from "./read.js";

/**
 * The plan as the confirm dialog and `--dry-run` show it: which of the paths it touches git
 * tracks, so a change to the repo asks first (rule A), and which of its files are there yet. The
 * one module that starts a process: `git ls-files`, which only reads. No git, a dir that is no
 * repo, git failing or running out of time: nothing there is tracked, and the change is still
 * backed up.
 */

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** The environment, without what would point git at another repo than the one `-C` names (a git hook sets these). */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
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

/** plan with an empty tracked set, trackedPaths of its trackCandidates, then plan again with them; each file looked at. */
export async function planChecked(
  ctx: Omit<PlanContext, "tracked">,
  command: ExtensionsCommand,
  action: Action,
  options: { git?: string } = {},
): Promise<{ plan: Plan; tracked: ReadonlySet<string> }> {
  const first = plan({ ...ctx, tracked: new Set() }, command, action);
  const candidates = trackCandidates(first, ctx.inv);
  const tracked =
    candidates.length === 0
      ? new Set<string>()
      : await trackedPaths(candidates, {
          projects: ctx.inv.projects.map((p) => p.path),
          ...(options.git !== undefined ? { git: options.git } : {}),
        });
  const checked = tracked.size === 0 ? first : plan({ ...ctx, tracked }, command, action);
  return { plan: await filesLookedAt(checked), tracked };
}
