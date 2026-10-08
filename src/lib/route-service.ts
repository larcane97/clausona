import { collectQuotas, type QuotaTarget } from "../core/quota-store.js";
import {
  applyOverrides,
  checkRoute,
  checkRouteName,
  type Route,
  type RouteSpec,
  type RoutesFile,
  withDefaults,
} from "../core/route-config.js";
import { expandPatterns, type Member } from "../core/route-patterns.js";
import { pickWithRecord, type RoutesPaths, readPicks, routesPaths } from "../core/routes-store.js";
import { type Ranking, rankRoute } from "../core/routing.js";
import type { QuotaSnapshot, Registry, ToolName } from "../types.js";
import type { ResolvedBy } from "./route-render.js";
import type { RoutingOptions } from "./run-args.js";
import { loadRegistry, noRegistryError } from "./service.js";

/** What routing reaches outside itself, injectable for tests. */
export type RouteDeps = {
  loadRegistry: () => Promise<Registry | null>;
  collectQuotas: (targets: QuotaTarget[]) => Promise<Record<string, QuotaSnapshot>>;
  paths: RoutesPaths;
  clock: () => number;
  /** Opens text in the user's editor and resolves to what was saved (route edit). */
  editText: (initial: string, fileName: string) => Promise<string>;
};

export function defaultRouteDeps(): RouteDeps {
  return {
    loadRegistry,
    collectQuotas: (targets) => collectQuotas(targets),
    paths: routesPaths(),
    clock: () => Date.now(),
    editText: async () => {
      throw new Error("route edit is not available yet.");
    },
  };
}

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
  constructor(
    readonly routeName: string,
    readonly existing: string[],
  ) {
    super(
      `Route '${routeName}' does not exist.${existing.length ? ` Existing routes: ${existing.join(", ")}.` : ""} Create it: clausona route add ${routeName}`,
    );
    this.name = "UnknownRouteError";
  }
}

export function membersOf(registry: Registry, tool: ToolName): Member[] {
  return Object.entries(registry.profiles)
    .filter(([, profile]) => profile.tool === tool)
    .map(([id, profile]) => ({
      id,
      tool,
      name: id.slice(tool.length + 1),
      email: profile.email ?? "",
      kind: profile.kind === "api" ? "api" : "subscription",
      sharesSessions: Boolean(profile.isPrimary || profile.mergeSessions),
      configDir: profile.configDir,
    }));
}

export function onlyTool(registry: Registry): ToolName | undefined {
  const tools = new Set(
    Object.values(registry.profiles)
      .filter((profile) => profile.kind !== "api")
      .map((profile) => profile.tool),
  );
  return tools.size === 1 ? [...tools][0] : undefined;
}

export type ResolvedRoute = { name?: string; route: Route; resolvedBy: ResolvedBy };

function inferTool(patterns: string[]): ToolName | undefined {
  const tools = new Set(patterns.map((pattern) => /^(claude|codex):/.exec(pattern)?.[1] as ToolName | undefined));
  if (tools.size !== 1) return undefined;
  return [...tools][0];
}

/**
 * The route a run names: a stored one (`--route`), or an unsaved one (`--from`), with the run's
 * field options applied over it. Null when the run names neither.
 */
export function resolveRoute(
  file: RoutesFile,
  run: { tool?: ToolName; options: RoutingOptions },
): ResolvedRoute | null {
  const { tool, options } = run;
  const { route: name, ...overrides } = options;
  let spec: RouteSpec;
  if (name !== undefined) {
    const nameProblem = checkRouteName(name);
    if (nameProblem) throw new Error(nameProblem);
    const stored = file.routes[name];
    if (!stored) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    if (tool && stored.tool !== tool) throw new Error(`Route '${name}' is for ${stored.tool}, not ${tool}.`);
    spec = stored;
  } else if (options.from !== undefined) {
    const inferred = tool ?? inferTool(options.from);
    if (!inferred) {
      throw new Error(
        "Say which tool --from is for: clausona run claude --from … or clausona run codex --from …, or prefix the names (claude:work).",
      );
    }
    spec = { tool: inferred };
  } else {
    return null;
  }
  const merged = applyOverrides(spec, overrides);
  const problems = checkRoute(name ?? "inline", merged, name ? `routes.${name}` : "--from route");
  if (problems.length) throw new Error(problems.join("\n"));
  return { ...(name ? { name } : {}), route: withDefaults(merged), resolvedBy: name ? "flag" : "inline" };
}

/** The members whose quota a route needs: listed, not excluded, and subscription profiles. */
export function quotaTargets(route: Route, members: Member[]): QuotaTarget[] {
  const excluded = new Set(expandPatterns(route.exclude, members).members.map((entry) => entry.member.id));
  const seen = new Set<string>();
  const targets: QuotaTarget[] = [];
  for (const { member } of [
    ...expandPatterns(route.from, members).members,
    ...expandPatterns(route.fallback, members).members,
  ]) {
    // An excluded account is not touched at all: no quota read, so no token renewal either.
    if (member.kind !== "subscription" || excluded.has(member.id) || seen.has(member.id)) continue;
    seen.add(member.id);
    targets.push({ id: member.id, tool: member.tool, configDir: member.configDir });
  }
  return targets;
}

export async function rankRouteNow(
  resolved: Pick<ResolvedRoute, "route">,
  deps: RouteDeps,
  options: { resume: boolean; record: boolean },
): Promise<Ranking> {
  const registry = await deps.loadRegistry();
  if (!registry) throw await noRegistryError();
  const members = membersOf(registry, resolved.route.tool);
  // Read first: it can take seconds, and the pick-record lock is held only for the pick itself.
  const quotas = await deps.collectQuotas(quotaTargets(resolved.route, members));
  const rank = (lastPicked: Record<string, string>) =>
    rankRoute({ route: resolved.route, members, quotas, lastPicked, now: deps.clock(), resume: options.resume });
  if (!options.record) return rank(await readPicks(deps.paths));
  return pickWithRecord(
    (lastPicked) => {
      const ranking = rank(lastPicked);
      return { result: ranking, picked: ranking.outcome.kind === "picked" ? ranking.outcome.id : undefined };
    },
    deps.clock,
    deps.paths,
  );
}

/** For add and set: the route's own problems, then the API profiles this version refuses. */
export function checkRouteMembers(name: string, spec: RouteSpec, registry: Registry): void {
  const problems = checkRoute(name, spec);
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
