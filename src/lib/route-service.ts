import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { collectQuotas, type QuotaTarget } from "../core/quota-store.js";
import { type Budget, type Budgets, budgetCommand, readBudgets } from "../core/route-budgets.js";
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
import { resolveSecret } from "./secrets.js";
import { loadRegistry, noRegistryError } from "./service.js";

/** What routing reaches outside itself, injectable for tests. */
export type RouteDeps = {
  loadRegistry: () => Promise<Registry | null>;
  /**
   * With `refreshBefore`, a cached reading fetched before then is fetched again, unless the tool's
   * endpoint is cooling down. An API profile's target reads its spend.
   */
  collectQuotas: CollectQuotas;
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

export type CollectQuotas = (
  targets: QuotaTarget[],
  options?: { refreshBefore?: number },
) => Promise<Record<string, QuotaSnapshot>>;

export function defaultRouteDeps(): RouteDeps {
  return {
    loadRegistry,
    collectQuotas: (targets, options) => collectQuotas(targets, { refreshBefore: options?.refreshBefore }),
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
      ...(profile.kind === "api" && profile.api ? { api: profile.api } : {}),
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
 * An API profile's quota target: its spend, read with its key, which is resolved only when the
 * cache cannot answer, and within the reading's time. None for a hand-edited profile with no endpoint, whose spend cannot be read.
 */
export function spendTarget(member: Member, budget?: Budget): QuotaTarget | undefined {
  const { api } = member;
  if (!api || typeof api.baseUrl !== "string") return undefined;
  return {
    id: member.id,
    tool: member.tool,
    configDir: member.configDir,
    api: {
      baseUrl: api.baseUrl,
      authScheme: api.authScheme === "api-key" ? "api-key" : "bearer",
      readKey: (signal) => resolveSecret(member.id, api.secret, undefined, { signal }),
      ...(budget ? { budget } : {}),
    },
  };
}

/** The members a route takes: listed in from or fallback, and not excluded; each once. */
function takenBy(route: Route, members: Member[]): Member[] {
  const excluded = new Set(expandPatterns(route.exclude, members).members.map((entry) => entry.member.id));
  const seen = new Set<string>();
  return [...expandPatterns(route.from, members).members, ...expandPatterns(route.fallback, members).members]
    .map((entry) => entry.member)
    .filter((member) => {
      if (excluded.has(member.id) || seen.has(member.id)) return false;
      seen.add(member.id);
      return true;
    });
}

/**
 * The members whose quota a route needs: listed and not excluded, an API profile's being its
 * spend against its budget (`budgets`) or its key's limit; on a resumed run, only those that share
 * sessions, since ranking skips the others whatever they read; on a run narrowed to one tool of an
 * `all` route, only that tool's.
 */
export function quotaTargets(
  route: Route,
  members: Member[],
  resume: boolean,
  onlyTool?: ToolName,
  budgets: Budgets = {},
): QuotaTarget[] {
  const targets: QuotaTarget[] = [];
  // An excluded or skipped account is not touched at all: no quota read, so no token renewal either.
  for (const member of takenBy(route, members)) {
    if (resume && !member.sharesSessions) continue;
    if (onlyTool && member.tool !== onlyTool) continue;
    if (member.kind === "api") {
      const target = spendTarget(member, Object.hasOwn(budgets, member.id) ? budgets[member.id] : undefined);
      if (target) targets.push(target);
      continue;
    }
    targets.push({ id: member.id, tool: member.tool, configDir: member.configDir });
  }
  return targets;
}

/**
 * The budgets routes.json holds. None when it cannot be read: that stops no run, which then counts
 * each API profile against its key's own limit.
 */
async function budgetsNow(paths: RoutesPaths, names: ProfileNames): Promise<Budgets> {
  try {
    return readBudgets((await loadRoutes(paths, names)).file, names).budgets;
  } catch {
    return {};
  }
}

/**
 * Ranks a route on quota read now. `record` makes it a pick, under the pick-record lock; `model`
 * is the model the run names, whose own limit then counts. `refreshBefore` reads again quota
 * fetched before then, however fresh the cache is. Once `signal` has aborted, the pick throws
 * its reason and records nothing.
 */
export async function rankRouteNow(
  resolved: Pick<ResolvedRoute, "route" | "onlyTool">,
  deps: RouteDeps,
  options: { resume: boolean; record: boolean; model?: string; refreshBefore?: number; signal?: AbortSignal },
): Promise<Ranking> {
  const registry = await deps.loadRegistry();
  if (!registry) throw await noRegistryError();
  const { route, onlyTool } = resolved;
  const members = membersOf(registry, route.tool);
  // Whether an API profile can be picked is checked on every run, against the budgets as they are.
  const budgets = takenBy(route, members).some((member) => member.kind === "api")
    ? await budgetsNow(deps.paths, namesOf(registry))
    : {};
  // Read first: it can take seconds, and the pick-record lock is held only for the pick itself.
  const quotas = await deps.collectQuotas(
    quotaTargets(route, members, options.resume, onlyTool, budgets),
    options.refreshBefore === undefined ? undefined : { refreshBefore: options.refreshBefore },
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

/** The API profiles a route takes, which need a limit to join it. */
export function apiMembers(spec: RouteSpec, registry: Registry): Member[] {
  const route = withDefaults(spec);
  return takenBy(route, membersOf(registry, route.tool)).filter((member) => member.kind === "api");
}

/**
 * Why an API profile cannot join a route, or null when it can. It needs a limit clausona can read
 * - a budget, or one set on the provider key - from a provider that reports spend. A reading that
 * failed lets in one with a budget, whose runs skip it until a reading works, and not one without,
 * since whether its key has a limit is not known.
 */
export function limitProblem(
  id: string,
  snapshot: QuotaSnapshot | undefined,
  budget: Budget | undefined,
): string | null {
  if (snapshot?.noSpendReading) {
    return `${id} cannot join a route: its provider does not report spend, so its usage cannot be read. Run it by name: clausona run ${id}`;
  }
  if (budget) return null;
  if (!snapshot || snapshot.state !== "ok") {
    return `${id}'s spend could not be read just now, so whether its key has a limit is not known. Try again, or set a budget: ${budgetCommand(id)}`;
  }
  if (!snapshot.budget) {
    return `${id} has no spend limit, so it cannot join a route.\n  Set a limit on the provider key, or: ${budgetCommand(id)}`;
  }
  return null;
}

/** By profile id: why each API profile a route takes cannot join it, or null. */
export type LimitProblems = ReadonlyMap<string, string | null>;

/**
 * Reads the spend of each API profile the route takes, through the quota cache, and says which
 * cannot join it. What add, set, the unknown-route prompt and the form check, and so every run.
 */
export async function readLimitProblems(
  spec: RouteSpec,
  registry: Registry,
  budgets: Budgets,
  collect: CollectQuotas,
): Promise<LimitProblems> {
  const api = apiMembers(spec, registry);
  if (api.length === 0) return new Map();
  const budgetOf = (id: string) => (Object.hasOwn(budgets, id) ? budgets[id] : undefined);
  const targets = api.flatMap((member) => spendTarget(member, budgetOf(member.id)) ?? []);
  const quotas = await collect(targets);
  return new Map(api.map((member) => [member.id, limitProblem(member.id, quotas[member.id], budgetOf(member.id))]));
}

/**
 * For add and set: the route's own problems, then the first API profile it takes that cannot join
 * it, by `limits` (readLimitProblems' answer). One the answer does not cover came into the route
 * after it was read: routes.json changed meanwhile.
 */
export function checkRouteMembers(name: string, spec: RouteSpec, registry: Registry, limits: LimitProblems): void {
  const problems = checkRoute(name, spec, undefined, namesOf(registry));
  if (problems.length) throw new Error(problems.join("\n"));
  for (const member of apiMembers(spec, registry)) {
    const problem = limits.get(member.id);
    if (problem === undefined) {
      throw new Error(`routes.json changed while ${member.id}'s spend was read. Run the command again.`);
    }
    if (problem) throw new Error(problem);
  }
}

/** checkRouteMembers, the route's own problems first and then each API profile's spend, read now. */
export async function checkRouteMembersNow(
  name: string,
  spec: RouteSpec,
  registry: Registry,
  read: { budgets: Budgets; collect: CollectQuotas },
): Promise<void> {
  const problems = checkRoute(name, spec, undefined, namesOf(registry));
  if (problems.length) throw new Error(problems.join("\n"));
  checkRouteMembers(name, spec, registry, await readLimitProblems(spec, registry, read.budgets, read.collect));
}
