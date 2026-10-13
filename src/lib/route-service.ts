import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { collectQuotas, type QuotaTarget } from "../core/quota-store.js";
import {
  applyOverrides,
  checkPattern,
  checkRoute,
  checkRouteName,
  emptyRoutesFile,
  NO_PROFILE_NAMES,
  type ProfileNames,
  profileNames,
  type Route,
  type RouteOverrides,
  type RouteSpec,
  type RoutesFile,
  type RouteTool,
  storedRoute,
  toolsOf,
  withDefaults,
} from "../core/route-config.js";
import { expandPatterns, type Member, splitToolPrefix } from "../core/route-patterns.js";
import {
  chooseRule,
  currentDir,
  type PathSystem,
  pathSystem,
  readRules,
  type SkippedRule,
} from "../core/route-rules.js";
import {
  type LoadedRoutes,
  loadRoutes,
  pickWithRecord,
  RoutesFileError,
  type RoutesPaths,
  readPicks,
  routesPaths,
} from "../core/routes-store.js";
import { type Ranking, rankRoute } from "../core/routing.js";
import type { QuotaSnapshot, Registry, ToolName } from "../types.js";
import { editInEditor } from "./editor.js";
import { foldProfileName } from "./profile-ref.js";
import type { ResolvedBy } from "./route-render.js";
import type { RoutingOptions } from "./run-args.js";
import { loadRegistry, noRegistryError } from "./service.js";

/** What routing reaches outside itself, injectable for tests. */
export type RouteDeps = {
  loadRegistry: () => Promise<Registry | null>;
  /** With `refresh`, a cached reading is fetched again, unless the tool's endpoint is cooling down. */
  collectQuotas: (targets: QuotaTarget[], options?: { refresh?: boolean }) => Promise<Record<string, QuotaSnapshot>>;
  paths: RoutesPaths;
  clock: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts (`--wait`). */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Calls `handler` on Ctrl-C until the function it returns is called (`--wait`). */
  onInterrupt: (handler: () => void) => () => void;
  /** Where a waiting command says what it waits for: stderr, so that stdout keeps only its answer. */
  progress: (text: string) => void;
  /** Opens text in the user's editor and resolves to what was saved (route edit). */
  editText: (initial: string, fileName: string) => Promise<string>;
  /** The directory a run starts in, which picks its dir rule. */
  cwd: string;
  /** The home directory, which dir rules write as `~`. */
  home: string;
};

export function defaultRouteDeps(): RouteDeps {
  return {
    loadRegistry,
    collectQuotas: (targets, options) => collectQuotas(targets, { refresh: options?.refresh }),
    paths: routesPaths(),
    clock: () => Date.now(),
    // Aborted, the timer rejects; a wait checks the signal itself, so that is not an error here.
    sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
    onInterrupt: (handler) => {
      process.on("SIGINT", handler);
      return () => {
        process.off("SIGINT", handler);
      };
    },
    progress: (text) => {
      process.stderr.write(`${text}\n`);
    },
    editText: editInEditor,
    cwd: currentDir(),
    home: homedir(),
  };
}

/** How dir rules read paths, for these deps. */
export const pathsFor = (deps: Pick<RouteDeps, "home">): PathSystem => pathSystem(deps.home);

/** Exit code 75 (EX_TEMPFAIL): no account can be used now; trying later may work. */
export class NoAccountError extends Error {
  readonly exitCode = 75;
  constructor(
    message: string,
    /** Printed to stdout instead of the message, for `--json`. */
    readonly stdout?: string,
  ) {
    super(message);
    this.name = "NoAccountError";
  }
}

export class UnknownRouteError extends Error {
  /** The routes there are. A key pasted into routes.json as a route's name is never among them. */
  readonly existing: string[];
  constructor(
    readonly routeName: string,
    existing: string[],
  ) {
    const listed = existing.filter((name) => checkRouteName(name) === null);
    super(
      `Route '${routeName}' does not exist.${listed.length ? ` Existing routes: ${listed.join(", ")}.` : ""} Create it: clausona route add ${routeName}`,
    );
    this.name = "UnknownRouteError";
    this.existing = listed;
  }
}

/** The registered profiles' names, which routes.json's checks let through (checkPattern); none before init. */
export const namesOf = (registry: Registry | null): ProfileNames => profileNames(Object.keys(registry?.profiles ?? {}));

/** The registry's profiles of every tool a route of `tool` takes, as routing sees them. */
export function membersOf(registry: Registry, tool: RouteTool): Member[] {
  const tools = toolsOf(tool);
  return Object.entries(registry.profiles)
    .filter(([, profile]) => tools.includes(profile.tool))
    .map(([id, profile]) => ({
      id,
      tool: profile.tool,
      name: id.slice(profile.tool.length + 1),
      email: profile.email ?? "",
      kind: profile.kind === "api" ? "api" : "subscription",
      sharesSessions: Boolean(profile.isPrimary || profile.mergeSessions),
      configDir: profile.configDir,
    }));
}

export type ResolvedRoute = {
  name?: string;
  route: Route;
  resolvedBy: ResolvedBy;
  /** The tool a run named for an `all` route: only its members are ranked (RankInput.onlyTool). */
  onlyTool?: ToolName;
};

/** The field options a run may give, as their flags, in the order an error lists them. */
const FIELD_FLAGS: ReadonlyArray<[keyof RouteOverrides, string]> = [
  ["exclude", "--exclude"],
  ["strategy", "--strategy"],
  ["maxUsage", "--max-usage"],
  ["fallback", "--fallback"],
];

/** The pattern options a run may give, as their flags. */
const PATTERN_FLAGS: ReadonlyArray<["from" | "exclude" | "fallback", string]> = [
  ["from", "--from"],
  ["exclude", "--exclude"],
  ["fallback", "--fallback"],
];

/**
 * The problems with a run's pattern options, each named by its flag and quoting the entry as it
 * was given: not by where it would sit in routes.json, which it never reaches, and not by an
 * index into the exclude list the route's own entries are merged into.
 */
function runPatternProblems(overrides: RouteOverrides, tool: RouteTool, names: ProfileNames): string[] {
  return PATTERN_FLAGS.flatMap(([key, flag]) =>
    (overrides[key] ?? []).flatMap((pattern) => {
      const problem = checkPattern(pattern, tool, names);
      return problem ? [`${flag}: ${problem}`] : [];
    }),
  );
}

/** `--a`, `--a and --b`, `--a, --b and --c`. */
function listFlags(flags: string[]): string {
  return flags.length < 2 ? flags.join("") : `${flags.slice(0, -1).join(", ")} and ${flags[flags.length - 1]}`;
}

/** Every pattern of the lists, in order, once: two that differ only in case are one. */
function unionPatterns(...lists: string[][]): string[] {
  const seen = new Set<string>();
  return lists.flat().filter((pattern) => {
    const folded = foldProfileName(pattern);
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}

/**
 * The tool the `tool:` prefixes of `patterns` say: the one every entry names, or `all` when they
 * name both. Undefined when any entry has no tool prefix, as checkPattern reads one.
 */
export function inferRouteTool(patterns: string[]): RouteTool | undefined {
  const tools = new Set<ToolName>();
  for (const pattern of patterns) {
    const { prefix } = splitToolPrefix(pattern);
    if (prefix !== "claude" && prefix !== "codex") return undefined;
    tools.add(prefix);
  }
  if (tools.size === 0) return undefined;
  return tools.size === 1 ? [...tools][0] : "all";
}

/**
 * The route a run names: a stored one (`--route`), or an unsaved one (`--from`), with the run's
 * field options applied over it. Each replaces its field for the run, except `--exclude`, which
 * adds to the route's own exclude list. Null when the run names neither and gives no field options.
 *
 * A tool word must be a one-tool route's own tool; on an `all` route it narrows the run to that
 * tool. An unsaved route takes the tool word, else the tool its prefixes say, else claude. `all`
 * (`route explain --tool all`) narrows nothing: it asks for an `all` route.
 */
export function resolveRoute(
  file: RoutesFile,
  run: { tool?: RouteTool; options: RoutingOptions },
  names: ProfileNames = NO_PROFILE_NAMES,
): ResolvedRoute | null {
  const { tool, options } = run;
  const { route: name, ...overrides } = options;
  let spec: RouteSpec;
  let onlyTool: ToolName | undefined;
  if (name !== undefined) {
    const nameProblem = checkRouteName(name);
    if (nameProblem) throw new Error(nameProblem);
    const stored = storedRoute(file, name);
    if (!stored) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    if (tool && stored.tool === "all") {
      if (tool !== "all") onlyTool = tool;
    } else if (tool && stored.tool !== tool) {
      throw new Error(`Route '${name}' is for ${stored.tool}, not ${tool}.`);
    }
    spec = stored;
  } else if (options.from !== undefined) {
    const inferred = inferRouteTool(options.from);
    // `run claude --from claude:a,codex:x`: a route over both, narrowed to the tool the run names.
    if (tool && tool !== "all" && inferred === "all") onlyTool = tool;
    spec = { tool: onlyTool ? "all" : (tool ?? inferred ?? "claude") };
  } else {
    // Without a route these would be dropped, and the tool run on its active profile as if they
    // were never given. Only the flags are named: an option's value is never echoed.
    const given = FIELD_FLAGS.filter(([key]) => overrides[key] !== undefined).map(([, flag]) => flag);
    if (given.length) {
      throw new Error(
        `${listFlags(given)} ${given.length === 1 ? "needs" : "need"} --route <name> or --from <patterns>.`,
      );
    }
    return null;
  }
  const runProblems = runPatternProblems(overrides, spec.tool, names);
  if (runProblems.length) throw new Error(runProblems.join("\n"));
  // Leaving one more account out for a run must not bring back the ones the route leaves out.
  // (`route set --exclude` replaces the list: that is an edit, and goes through applyOverrides.)
  const runOverrides =
    overrides.exclude !== undefined && spec.exclude?.length
      ? { ...overrides, exclude: unionPatterns(spec.exclude, overrides.exclude) }
      : overrides;
  const merged = applyOverrides(spec, runOverrides);
  const problems = checkRoute(name ?? "inline", merged, name ? `routes.${name}` : "--from route", names);
  if (problems.length) throw new Error(problems.join("\n"));
  return {
    ...(name ? { name } : {}),
    route: withDefaults(merged),
    resolvedBy: name ? "flag" : "inline",
    ...(onlyTool ? { onlyTool } : {}),
  };
}

/**
 * routes.json as a command that names the route `name` needs it. It is not read at all when no
 * route is named: an unsaved route needs nothing from it, and a run that takes its route from the
 * dir rules reads it for them itself (route-run.ts). The other routes' problems do not stop the
 * command; the named route's own do, as a RoutesFileError.
 */
export async function routesFor(
  name: string | undefined,
  paths: RoutesPaths,
  names: ProfileNames = NO_PROFILE_NAMES,
): Promise<LoadedRoutes> {
  if (name === undefined) return { filePath: paths.routesPath, file: emptyRoutesFile(), broken: [] };
  const loaded = await loadRoutes(paths, names);
  // A name that cannot be a route's is resolveRoute's to refuse, without quoting it.
  const broken = checkRouteName(name) === null ? loaded.broken.find((route) => route.name === name) : undefined;
  if (broken) throw new RoutesFileError(loaded.filePath, broken.problems, false, name);
  return loaded;
}

/**
 * What a run of `tool` that names no route takes in `cwd`: the route of the deepest dir rule that
 * holds there, else the tool's default, else none (the active profile). `skipped` are the rules
 * passed over on the way, which cannot be used; `problems` the entries of dirs and defaults that
 * cannot be read at all, which no run can take.
 */
export function routeByRules(
  loaded: LoadedRoutes,
  tool: ToolName,
  cwd: string,
  sys: PathSystem,
  names: ProfileNames = NO_PROFILE_NAMES,
): { resolved: ResolvedRoute | null; skipped: SkippedRule[]; problems: string[] } {
  const rules = readRules(loaded.file, sys.platform);
  const { problems } = rules;
  const { chosen, skipped } = chooseRule(loaded.file, loaded.broken, rules, tool, cwd, sys);
  if (!chosen) return { resolved: null, skipped, problems };
  // The rule's route is one of this tool's, or an `all` route that the tool narrows.
  const resolved = resolveRoute(loaded.file, { tool, options: { route: chosen.route } }, names);
  if (!resolved) return { resolved: null, skipped, problems };
  const resolvedBy = chosen.dir === undefined ? "default" : (`dir:${chosen.dir}` as const);
  return { resolved: { ...resolved, resolvedBy }, skipped, problems };
}

/**
 * The members whose quota a route needs: listed, not excluded, and subscription profiles; on a
 * resumed run, only those that share sessions, since ranking skips the others whatever they read;
 * on a run narrowed to one tool of an `all` route, only that tool's.
 */
export function quotaTargets(route: Route, members: Member[], resume: boolean, onlyTool?: ToolName): QuotaTarget[] {
  const excluded = new Set(expandPatterns(route.exclude, members).members.map((entry) => entry.member.id));
  const seen = new Set<string>();
  const targets: QuotaTarget[] = [];
  for (const { member } of [
    ...expandPatterns(route.from, members).members,
    ...expandPatterns(route.fallback, members).members,
  ]) {
    // An excluded or skipped account is not touched at all: no quota read, so no token renewal either.
    if (member.kind !== "subscription" || excluded.has(member.id) || seen.has(member.id)) continue;
    if (resume && !member.sharesSessions) continue;
    if (onlyTool && member.tool !== onlyTool) continue;
    seen.add(member.id);
    targets.push({ id: member.id, tool: member.tool, configDir: member.configDir });
  }
  return targets;
}

/**
 * Ranks a route on quota read now. `record` makes it a pick, under the pick-record lock; `model`
 * is the model the run names, whose own limit then counts. `refresh` reads quota again however
 * fresh the cache is. Once `signal` has aborted, the pick throws its reason and records nothing.
 */
export async function rankRouteNow(
  resolved: Pick<ResolvedRoute, "route" | "onlyTool">,
  deps: RouteDeps,
  options: { resume: boolean; record: boolean; model?: string; refresh?: boolean; signal?: AbortSignal },
): Promise<Ranking> {
  const registry = await deps.loadRegistry();
  if (!registry) throw await noRegistryError();
  const { route, onlyTool } = resolved;
  const members = membersOf(registry, route.tool);
  // Read first: it can take seconds, and the pick-record lock is held only for the pick itself.
  const quotas = await deps.collectQuotas(
    quotaTargets(route, members, options.resume, onlyTool),
    options.refresh ? { refresh: true } : undefined,
  );
  const rank = (lastPicked: Record<string, string>) =>
    rankRoute({
      route,
      members,
      quotas,
      lastPicked,
      now: deps.clock(),
      resume: options.resume,
      ...(onlyTool ? { onlyTool } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
  if (!options.record) return rank(await readPicks(deps.paths));
  return pickWithRecord(
    (lastPicked) => {
      // Ctrl-C while the quota was read: nothing is picked or recorded, and the lock is let go.
      options.signal?.throwIfAborted();
      const ranking = rank(lastPicked);
      return { result: ranking, picked: ranking.outcome.kind === "picked" ? ranking.outcome.id : undefined };
    },
    deps.clock,
    deps.paths,
    new Set(Object.keys(registry.profiles)),
  );
}

/**
 * The other tool, when a route of one tool takes none of the accounts the same patterns would
 * take of the other's: the tool a Codex-only user meant when a run or `route add` made a claude
 * route by default. Undefined for an `all` route, or when the other tool's accounts are no help.
 */
export function otherToolTaking(spec: RouteSpec, registry: Registry): ToolName | undefined {
  if (spec.tool === "all") return undefined;
  const other: ToolName = spec.tool === "claude" ? "codex" : "claude";
  const route = withDefaults({ ...spec, tool: other });
  const members = membersOf(registry, other).filter((member) => member.kind === "subscription");
  const excluded = new Set(expandPatterns(route.exclude, members).members.map((entry) => entry.member.id));
  const taken = [...expandPatterns(route.from, members).members, ...expandPatterns(route.fallback, members).members];
  return taken.some((entry) => !excluded.has(entry.member.id)) ? other : undefined;
}

/** For add and set: the route's own problems, then the API profiles this version refuses. */
export function checkRouteMembers(name: string, spec: RouteSpec, registry: Registry): void {
  const problems = checkRoute(name, spec, undefined, namesOf(registry));
  if (problems.length) throw new Error(problems.join("\n"));
  const route = withDefaults(spec);
  const members = membersOf(registry, route.tool);
  const api = [...expandPatterns(route.from, members).members, ...expandPatterns(route.fallback, members).members].find(
    (entry) => entry.member.kind === "api",
  );
  if (api) {
    throw new Error(
      `${api.member.id} is an API profile. Routes take subscription profiles only in this version; run it by name: clausona run ${api.member.id}`,
    );
  }
}
