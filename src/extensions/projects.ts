import path from "node:path";

import type { ToolName } from "../types.js";
import type { Project } from "./model.js";
import { entryInfo, gitRoot, isRecord, pathKey } from "./read.js";

/** The project paths one profile's tool has recorded. */
export type ProjectRecord = { tool: ToolName; profile: string; paths: string[] };

/**
 * The project clausona treats as "here": the git root (a repo's or a worktree's) holding `cwd`,
 * else `cwd` itself. Claude Code reads `.claude/settings*.json` from the git root wherever in
 * the repo it starts, and records its projects under it (spec, Spike 2). The home dir is one
 * too, for what Claude Code keys by the dir it starts in - see `isHomeProject`. None at the
 * filesystem root.
 */
export async function resolveCurrentProject(cwd: string): Promise<string | undefined> {
  const dir = (await gitRoot(cwd)) ?? path.resolve(cwd);
  if (path.dirname(dir) === dir) return undefined;
  return dir;
}

/**
 * Whether `project` is the home dir. Claude Code started there keys its local MCP servers, their
 * switches and its `.mcp.json` approvals by it (`.claude.json` -> projects[<home>]), reads
 * `~/.mcp.json`, and reads `~/.claude/settings.local.json` as its local settings - so the home
 * dir is a project for those. Its `.claude/settings.json`, `.claude/skills`, `.claude/commands`,
 * `.agents/skills` and `.codex/` are the user's own config, already read as that, and the
 * sources never read them a second time as the home project's.
 */
export function isHomeProject(project: Project, homeDir: string): boolean {
  return pathKey(project.path) === pathKey(homeDir);
}

/** Every recorded project that still exists, plus the current one, sorted by path. */
export async function collectProjects(records: ProjectRecord[], current?: string): Promise<Project[]> {
  const byKey = new Map<string, Project>();
  const add = (p: string, tool?: ToolName, profile?: string) => {
    const resolved = path.resolve(p);
    const key = pathKey(resolved);
    const project = byKey.get(key) ?? { path: resolved, tools: [], profiles: [] };
    if (tool && !project.tools.includes(tool)) project.tools.push(tool);
    if (profile && !project.profiles.includes(profile)) project.profiles.push(profile);
    byKey.set(key, project);
  };
  for (const record of records) for (const p of record.paths) add(p, record.tool, record.profile);
  if (current) add(current);
  const kept = await Promise.all(
    [...byKey.values()].map(async (project) => ((await entryInfo(project.path)).kind === "dir" ? project : undefined)),
  );
  return kept.filter((p): p is Project => p !== undefined).sort((a, b) => a.path.localeCompare(b.path));
}

/** The keys of a recorded `projects` object, or none. */
export function recordedPaths(container: unknown): string[] {
  return isRecord(container) ? Object.keys(container) : [];
}
