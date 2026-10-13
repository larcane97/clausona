import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ToolName } from "../types.js";
import { carriesCredentialToken } from "./credential-token.js";
import { foldProfileName } from "./profile-name.js";
import {
  type BrokenRoute,
  checkRouteName,
  holdsKey,
  type RoutesFile,
  type RouteTool,
  storedRoute,
  toolsOf,
} from "./route-config.js";

/**
 * Dir rules and defaults: the route a `clausona run claude|codex` takes when it names none.
 * routes.json maps a directory to a route per tool, and a tool to its default route:
 *
 *   "dirs": { "~/work": { "claude": "work", "codex": "cx" } },
 *   "defaults": { "claude": "main" }
 *
 * Both are read leniently. An entry that cannot be read is a problem that `route list` shows,
 * and the rest still apply; a slot that names a route that is not there, or one for the other
 * tool, is a warning, and a run skips it for the next rule. This module reads, matches and
 * edits them; it writes nothing.
 */

export const SLOT_TOOLS: readonly ToolName[] = ["claude", "codex"];

/** A tool's slot as read: the route it names, or why it cannot be read (`at` says where). */
export type Slot = { route: string } | { problem: string; at: string };

export type Slots = Partial<Record<ToolName, Slot>>;

/** A dir rule as read: its directory as stored (`~/work`), and its slots. */
export type DirRule = { dir: string; slots: Slots };

export type RouteRules = {
  /** In the file's order. One whose directory cannot be read is left out: it is in `problems`. */
  dirs: DirRule[];
  defaults: Slots;
  /** Every entry that cannot be read, each prefixed with where it is: `dirs["~/work"].claude`. */
  problems: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isSlotTool = (tool: string): tool is ToolName => (SLOT_TOOLS as readonly string[]).includes(tool);

const SLOTS_SHAPE = 'must be an object of a route per tool, such as { "claude": "main" }';

function readSlots(raw: unknown, at: string): { slots: Slots; problems: string[] } {
  if (!isRecord(raw)) {
    return {
      slots: Object.fromEntries(SLOT_TOOLS.map((tool) => [tool, { problem: SLOTS_SHAPE, at }])),
      problems: [`${at}: ${SLOTS_SHAPE}`],
    };
  }
  const slots: Slots = {};
  const problems: string[] = [];
  for (const [tool, value] of Object.entries(raw)) {
    if (!isSlotTool(tool)) {
      // The key is quoted below, so a key-shaped one is not.
      problems.push(
        holdsKey(tool) ? `${at}: a tool looks like an API key` : `${at}: unknown tool '${tool}'; use claude or codex`,
      );
      continue;
    }
    let problem: string | null = null;
    if (typeof value !== "string") problem = "must be a route's name";
    else if (holdsKey(value)) problem = "looks like an API key, not a route's name";
    else if (checkRouteName(value) !== null) problem = `'${value}' is not a route's name`;
    if (problem === null) {
      slots[tool] = { route: value as string };
    } else {
      slots[tool] = { problem, at: `${at}.${tool}` };
      problems.push(`${at}.${tool}: ${problem}`);
    }
  }
  return { slots, problems };
}

/**
 * `~`, or a path under it. `~/` is what clausona writes; `~\`, which an earlier build wrote on
 * Windows, is read the same way on every platform, so a file shared between machines still reads.
 */
const isTildePath = (dir: string) => dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\");

/** A directory as routes.json may store it: `~`, under `~`, or absolute. */
function isStoredDir(dir: string, platform: NodeJS.Platform): boolean {
  return isTildePath(dir) || (platform === "win32" ? path.win32 : path.posix).isAbsolute(dir);
}

/**
 * `dirs` and `defaults` as read. `platform` says which paths are absolute; the one clausona runs
 * on, but for a test.
 */
export function readRules(file: RoutesFile, platform: NodeJS.Platform = process.platform): RouteRules {
  const problems: string[] = [];
  const dirs: DirRule[] = [];
  if (file.dirs !== undefined) {
    if (!isRecord(file.dirs)) {
      problems.push('dirs: must be an object of directories, such as { "~/work": { "claude": "main" } }');
    } else {
      for (const [dir, raw] of Object.entries(file.dirs)) {
        // A directory is quoted wherever it is shown, so one that carries a key is never shown.
        if (carriesCredentialToken(dir)) {
          problems.push("dirs: a directory looks like it holds an API key");
          continue;
        }
        const at = `dirs[${JSON.stringify(dir)}]`;
        if (!isStoredDir(dir, platform)) {
          problems.push(`${at}: must be an absolute path, or start with ~`);
          continue;
        }
        const read = readSlots(raw, at);
        problems.push(...read.problems);
        dirs.push({ dir, slots: read.slots });
      }
    }
  }
  const defaults = file.defaults === undefined ? { slots: {}, problems: [] } : readSlots(file.defaults, "defaults");
  problems.push(...defaults.problems);
  return { dirs, defaults: defaults.slots, problems };
}

// ─── Paths ──────────────────────────────────────────────────────────

/** How paths are read where clausona runs: injectable, so a test can be Linux or Windows anywhere. */
export type PathSystem = {
  platform: NodeJS.Platform;
  home: string;
  /** The path with every link in it resolved; throws when it does not exist. */
  realpath: (p: string) => string;
};

export function pathSystem(home: string = homedir()): PathSystem {
  return { platform: process.platform, home, realpath: (p) => realpathSync(p) };
}

/**
 * The directory clausona runs in. process.cwd() throws once that directory has been deleted
 * under the shell; the shell's PWD still names it, which is what a dir rule would match.
 */
export function currentDir(): string {
  try {
    return process.cwd();
  } catch {
    return process.env.PWD ?? homedir();
  }
}

const pathsOf = (sys: PathSystem) => (sys.platform === "win32" ? path.win32 : path.posix);

/** macOS and Windows compare paths without regard to case, as their file systems do by default. */
const fold = (text: string, sys: PathSystem) =>
  sys.platform === "darwin" || sys.platform === "win32" ? foldProfileName(text) : text;

/** A directory as given or stored, made absolute: `~` is home, and a relative one is read from `cwd`. */
export function expandDir(dir: string, cwd: string, sys: PathSystem): string {
  const paths = pathsOf(sys);
  // Either separator after `~`, and in what follows it: a `~` path is clausona's own form.
  if (isTildePath(dir)) return paths.resolve(sys.home, ...dir.slice(2).split(/[\\/]/));
  return paths.resolve(cwd, dir);
}

/**
 * The path with every link resolved. One that does not exist (a rule's directory not made yet,
 * or a cwd deleted under the shell) has its deepest existing ancestor resolved and the rest put
 * back, so that it compares with the paths around it however links lead to them.
 */
function realOf(absolute: string, sys: PathSystem): string {
  const paths = pathsOf(sys);
  const rest: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return paths.join(paths.resolve(sys.realpath(head)), ...rest);
    } catch {
      const parent = paths.dirname(head);
      if (parent === head) return absolute;
      rest.unshift(paths.basename(head));
      head = parent;
    }
  }
}

/**
 * A directory as routes.json stores it: absolute, with `~/` for home when it is under it, on every
 * platform. Home counts as it is named and as it really is, since the current directory comes
 * with its links resolved: `/tmp/home` and `/private/tmp/home` on macOS are one home.
 */
export function storedDir(dir: string, cwd: string, sys: PathSystem): string {
  const paths = pathsOf(sys);
  const absolute = expandDir(dir, cwd, sys);
  const named = paths.resolve(sys.home);
  for (const home of new Set([named, realOf(named, sys)])) {
    if (fold(absolute, sys) === fold(home, sys)) return "~";
    const under = home.endsWith(paths.sep) ? home : `${home}${paths.sep}`;
    if (fold(absolute, sys).startsWith(fold(under, sys))) {
      return `~/${absolute.slice(under.length).split(paths.sep).join("/")}`;
    }
  }
  return absolute;
}

/** A directory as two are compared: every link resolved (realOf), and folded where case does not count. */
function comparable(dir: string, cwd: string, sys: PathSystem): string {
  return fold(realOf(expandDir(dir, cwd, sys), sys), sys);
}

function contains(parent: string, child: string, sys: PathSystem): boolean {
  if (child === parent) return true;
  const sep = pathsOf(sys).sep;
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Whether two directories, as given or stored, are one. */
export function sameDir(a: string, b: string, cwd: string, sys: PathSystem): boolean {
  return comparable(a, cwd, sys) === comparable(b, cwd, sys);
}

/**
 * The dir rules that hold for `cwd`, deepest first: each one's directory is `cwd` or above it.
 * Two that name one directory keep the file's order.
 */
export function rulesFor(dirs: DirRule[], cwd: string, sys: PathSystem): DirRule[] {
  const here = comparable(cwd, cwd, sys);
  return dirs
    .map((rule, index) => ({ rule, index, real: comparable(rule.dir, cwd, sys) }))
    .filter((entry) => contains(entry.real, here, sys))
    .sort((a, b) => b.real.length - a.real.length || a.index - b.index)
    .map((entry) => entry.rule);
}

// ─── Which rule a run takes ────────────────────────────────────────

/**
 * Why the route a slot names cannot be used for `tool`, finishing "route 'x' …", or null. A route
 * of the other tool cannot; an `all` route can fill either slot.
 */
export function routeProblem(
  file: RoutesFile,
  broken: readonly BrokenRoute[],
  tool: ToolName,
  name: string,
): string | null {
  const route = storedRoute(file, name);
  if (!route) return broken.some((entry) => entry.name === name) ? "cannot be used" : "does not exist";
  if (route.tool !== "all" && route.tool !== tool) return `is for ${route.tool}`;
  return null;
}

/** A rule: a directory's (`dir`), or the tool's default (no `dir`). */
export type RuleRef = { dir?: string; tool: ToolName };

/** A rule a run passed over, and why, as a sentence's end: "route 'x' does not exist". */
export type SkippedRule = RuleRef & { why: string };

export type RuleChoice = {
  /** The route the first usable rule names; none when no rule holds, or none can be used. */
  chosen?: RuleRef & { route: string };
  skipped: SkippedRule[];
};

/**
 * The route `clausona run <tool>` takes in `cwd` when it names none: the deepest dir rule with a
 * slot for the tool, then the next one up, then the tool's default. A rule that cannot be used
 * is passed over, and said why.
 */
export function chooseRule(
  file: RoutesFile,
  broken: readonly BrokenRoute[],
  rules: RouteRules,
  tool: ToolName,
  cwd: string,
  sys: PathSystem,
): RuleChoice {
  const candidates: Array<{ dir?: string; slot: Slot }> = [];
  for (const rule of rulesFor(rules.dirs, cwd, sys)) {
    const slot = rule.slots[tool];
    if (slot) candidates.push({ dir: rule.dir, slot });
  }
  if (rules.defaults[tool]) candidates.push({ slot: rules.defaults[tool] });
  const skipped: SkippedRule[] = [];
  for (const { dir, slot } of candidates) {
    const ref = dir === undefined ? { tool } : { dir, tool };
    if ("problem" in slot) {
      skipped.push({ ...ref, why: `${slot.at}: ${slot.problem}` });
      continue;
    }
    const problem = routeProblem(file, broken, tool, slot.route);
    if (problem) {
      skipped.push({ ...ref, why: `route '${slot.route}' ${problem}` });
      continue;
    }
    return { chosen: { ...ref, route: slot.route }, skipped };
  }
  return { skipped };
}

/**
 * The slots that name a route that cannot be used for them, as `route list` warns about them:
 * `~/work names route 'gone' for claude, which does not exist.`
 */
export function ruleWarnings(file: RoutesFile, broken: readonly BrokenRoute[], rules: RouteRules): string[] {
  const warnings: string[] = [];
  const check = (slots: Slots, say: (tool: ToolName, route: string, problem: string) => string) => {
    for (const tool of SLOT_TOOLS) {
      const slot = slots[tool];
      if (!slot || "problem" in slot) continue;
      const problem = routeProblem(file, broken, tool, slot.route);
      if (problem) warnings.push(say(tool, slot.route, problem));
    }
  };
  for (const rule of rules.dirs) {
    check(rule.slots, (tool, route, problem) => `${rule.dir} names route '${route}' for ${tool}, which ${problem}.`);
  }
  check(rules.defaults, (tool, route, problem) => `The ${tool} default names route '${route}', which ${problem}.`);
  return warnings;
}

// ─── Edits ──────────────────────────────────────────────────────────
//
// Each changes the copy of routes.json that updateRoutes hands it. Entries it does not touch stay
// as they are stored, problems and all; updateRoutes refuses to write a file that still has any.

/** `dirs` or `defaults` as an object to change: a new one when there is none. */
function recordAt(file: RoutesFile, key: "dirs" | "defaults"): Record<string, unknown> {
  const value = file[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(
      `${key} in routes.json is not an object, so it cannot be changed. Fix it with clausona route edit.`,
    );
  }
  return value;
}

/** Puts `record` back as `key`, or leaves the key out once it is empty. */
function putRecord(file: RoutesFile, key: "dirs" | "defaults", record: Record<string, unknown>): void {
  if (Object.keys(record).length === 0) delete file[key];
  else file[key] = record;
}

/**
 * Points each of `tools` at `route` in the directory `dir` (as stored). Entries that name the same
 * directory (`isDir`), however they are spelled, become one, stored as `dir` where the first of
 * them was, with the slots they had.
 */
export function setDirRoute(
  file: RoutesFile,
  dir: string,
  tools: readonly ToolName[],
  route: string,
  isDir: (stored: string) => boolean,
): void {
  const entries = Object.entries(recordAt(file, "dirs"));
  const at = entries.findIndex(([stored]) => isDir(stored));
  // Built from entries rather than assigned, here and below: a hand edit can hold any key,
  // `__proto__` too, which assignment would take for the object's prototype.
  const merged = Object.fromEntries([
    ...entries.flatMap(([stored, slots]) => (isDir(stored) && isRecord(slots) ? Object.entries(slots) : [])),
    ...tools.map((tool) => [tool, route]),
  ]);
  const kept = entries.filter(([stored]) => !isDir(stored));
  kept.splice(at === -1 ? kept.length : at, 0, [dir, merged]);
  putRecord(file, "dirs", Object.fromEntries(kept));
}

/**
 * Clears `tools` (every tool when not given) from the rules of the directory `isDir` names.
 * Returns the directories, as stored, it cleared something from.
 */
export function clearDirRoute(
  file: RoutesFile,
  tools: readonly ToolName[] | undefined,
  isDir: (stored: string) => boolean,
): string[] {
  const cleared: string[] = [];
  const next: Array<[string, unknown]> = [];
  for (const [stored, slots] of Object.entries(recordAt(file, "dirs"))) {
    if (!isDir(stored)) {
      next.push([stored, slots]);
      continue;
    }
    if (tools === undefined || !isRecord(slots)) {
      cleared.push(stored);
      continue;
    }
    const left = Object.fromEntries(Object.entries(slots).filter(([tool]) => !tools.includes(tool as ToolName)));
    if (Object.keys(left).length < Object.keys(slots).length) cleared.push(stored);
    if (Object.keys(left).length > 0) next.push([stored, left]);
  }
  putRecord(file, "dirs", Object.fromEntries(next));
  return cleared;
}

export function setDefaultRoute(file: RoutesFile, tools: readonly ToolName[], route: string): void {
  const defaults = { ...recordAt(file, "defaults") };
  for (const tool of tools) defaults[tool] = route;
  putRecord(file, "defaults", defaults);
}

/** Clears the defaults of `tools`; returns the tools that had one. */
export function clearDefaultRoute(file: RoutesFile, tools: readonly ToolName[]): ToolName[] {
  const defaults = { ...recordAt(file, "defaults") };
  const cleared = tools.filter((tool) => Object.hasOwn(defaults, tool));
  for (const tool of cleared) delete defaults[tool];
  putRecord(file, "defaults", defaults);
  return cleared;
}

/**
 * Calls `change` with the tool of every slot that names the route `name`: the slot is set to what
 * it returns, removed for undefined, or left alone for null. A dir rule left with no slot goes.
 * Returns the rules changed. Entries that cannot be read are left as they are.
 */
function changeReferences(
  file: RoutesFile,
  name: string,
  change: (tool: ToolName) => string | undefined | null,
): RuleRef[] {
  const changed: RuleRef[] = [];
  /** The slots changed, or null when none was. */
  const inSlots = (slots: Record<string, unknown>, dir?: string): Record<string, unknown> | null => {
    const next: Array<[string, unknown]> = [];
    let hit = false;
    for (const [tool, value] of Object.entries(slots)) {
      const to = isSlotTool(tool) && value === name ? change(tool) : null;
      if (to === null) {
        next.push([tool, value]);
        continue;
      }
      hit = true;
      changed.push(dir === undefined ? { tool: tool as ToolName } : { dir, tool: tool as ToolName });
      if (to !== undefined) next.push([tool, to]);
    }
    return hit ? Object.fromEntries(next) : null;
  };
  if (isRecord(file.dirs)) {
    let hit = false;
    const dirs: Array<[string, unknown]> = [];
    for (const [dir, slots] of Object.entries(file.dirs)) {
      const next = isRecord(slots) ? inSlots(slots, dir) : null;
      if (next === null) dirs.push([dir, slots]);
      else if (Object.keys(next).length > 0) dirs.push([dir, next]);
      hit ||= next !== null;
    }
    if (hit) putRecord(file, "dirs", Object.fromEntries(dirs));
  }
  if (isRecord(file.defaults)) {
    const next = inSlots(file.defaults);
    if (next !== null) putRecord(file, "defaults", next);
  }
  return changed;
}

/** Points every rule that names `from` at `to`. Returns the rules changed. */
export function renameReferences(file: RoutesFile, from: string, to: string): RuleRef[] {
  return changeReferences(file, from, () => to);
}

/** Clears every rule that names `name`. Returns the rules cleared. */
export function removeReferences(file: RoutesFile, name: string): RuleRef[] {
  return changeReferences(file, name, () => undefined);
}

/**
 * Clears the rules that name `name` for a tool a route of `tool` cannot fill: what a route whose
 * tool changed leaves behind. Returns the rules cleared.
 */
export function removeUnfillable(file: RoutesFile, name: string, tool: RouteTool): RuleRef[] {
  return changeReferences(file, name, (slot) => (toolsOf(tool).includes(slot) ? null : undefined));
}

/** The rules that name `name`, which removing it would clear; routes.json is not changed. */
export function rulesNaming(file: RoutesFile, name: string): RuleRef[] {
  return removeReferences(structuredClone(file), name);
}

/**
 * Rules as a sentence lists them, a directory's slots together: `the dir rule for ~/work (claude,
 * codex)`, `the claude default`, `the claude and codex defaults`. Join them with an `and`.
 */
export function rulesText(refs: readonly RuleRef[]): string[] {
  const dirs = new Map<string, ToolName[]>();
  let defaults: ToolName[] = [];
  for (const ref of refs) {
    if (ref.dir === undefined) defaults.push(ref.tool);
    else dirs.set(ref.dir, [...(dirs.get(ref.dir) ?? []), ref.tool]);
  }
  // Tools in one order, claude first, whichever order the file holds them in.
  const ordered = (tools: ToolName[]) => SLOT_TOOLS.filter((tool) => tools.includes(tool));
  defaults = ordered(defaults);
  for (const [dir, tools] of dirs) dirs.set(dir, ordered(tools));
  return [
    ...[...dirs].map(([dir, tools]) => `the dir rule for ${dir} (${tools.join(", ")})`),
    ...(defaults.length ? [`the ${defaults.join(" and ")} default${defaults.length > 1 ? "s" : ""}`] : []),
  ];
}
