import type { ToolName } from "../types.js";
import { carriesCredentialToken, looksLikeCredential } from "./credential-token.js";
import { splitToolPrefix } from "./route-patterns.js";

/**
 * A route: a pool of profiles and a rule for picking one of them by plan quota, stored in
 * ~/.clausona/routes.json (routes-store.ts). This module is the model and its checks only; it
 * reads and writes nothing.
 */

export type Strategy = "round-robin" | "headroom" | "expiring";

export const STRATEGIES: readonly Strategy[] = ["round-robin", "headroom", "expiring"];

export const DEFAULT_STRATEGY: Strategy = "round-robin";
export const DEFAULT_MAX_USAGE = 80;
export const DEFAULT_RESERVE_USAGE = 95;

export const ROUTES_VERSION = 1;

/** A route's tool: one of them, or `all`, whose pool spans the subscription profiles of both. */
export type RouteTool = ToolName | "all";

export const ROUTE_TOOLS: readonly RouteTool[] = ["claude", "codex", "all"];

/** The tools whose profiles a route of `tool` takes. */
export function toolsOf(tool: RouteTool): ToolName[] {
  return tool === "all" ? ["claude", "codex"] : [tool];
}

/** A route as stored. Only `tool` is required; withDefaults fills in the rest. */
export type RouteSpec = {
  tool: RouteTool;
  from?: string[];
  exclude?: string[];
  strategy?: Strategy;
  maxUsage?: number;
  reserveUsage?: number;
  fallback?: string[];
};

/** A route with every default applied: what ranking works on. */
export type Route = {
  tool: RouteTool;
  from: string[];
  exclude: string[];
  strategy: Strategy;
  maxUsage: number;
  reserveUsage: number;
  fallback: string[];
};

/** The fields a run, or `route set`, may replace for one route. */
export type RouteOverrides = Partial<Omit<RouteSpec, "tool">>;

/**
 * routes.json. Top-level keys other than `version` and `routes` - `dirs`, `defaults` and
 * `budgets`, which later versions add - are kept as they are on every write.
 */
export type RoutesFile = { version: 1; routes: Record<string, RouteSpec>; [key: string]: unknown };

export function emptyRoutesFile(): RoutesFile {
  return { version: ROUTES_VERSION, routes: {} };
}

/** What `route add` and the unknown-route prompt create: the defaults, written out. */
export function newRouteSpec(tool: RouteTool = "claude"): RouteSpec {
  return {
    tool,
    from: ["*"],
    strategy: DEFAULT_STRATEGY,
    maxUsage: DEFAULT_MAX_USAGE,
    reserveUsage: DEFAULT_RESERVE_USAGE,
  };
}

export function withDefaults(spec: RouteSpec): Route {
  const maxUsage = spec.maxUsage ?? DEFAULT_MAX_USAGE;
  return {
    tool: spec.tool,
    from: spec.from ?? ["*"],
    exclude: spec.exclude ?? [],
    strategy: spec.strategy ?? DEFAULT_STRATEGY,
    maxUsage,
    // A route that cuts above 95% has no reserve stage, rather than a reserve below its cut.
    reserveUsage: spec.reserveUsage ?? Math.max(DEFAULT_RESERVE_USAGE, maxUsage),
    fallback: spec.fallback ?? [],
  };
}

export function applyOverrides(spec: RouteSpec, overrides: RouteOverrides): RouteSpec {
  const next: RouteSpec = { ...spec };
  if (overrides.from !== undefined) next.from = overrides.from;
  if (overrides.exclude !== undefined) next.exclude = overrides.exclude;
  if (overrides.strategy !== undefined) next.strategy = overrides.strategy;
  if (overrides.maxUsage !== undefined) next.maxUsage = overrides.maxUsage;
  if (overrides.reserveUsage !== undefined) next.reserveUsage = overrides.reserveUsage;
  if (overrides.fallback !== undefined) next.fallback = overrides.fallback;
  // `--max-usage 98` on a route storing reserveUsage 95 means "cut at 98", not an error about
  // the reserve the user did not mention: the reserve goes back to its default for this cut.
  if (
    overrides.maxUsage !== undefined &&
    overrides.reserveUsage === undefined &&
    next.reserveUsage !== undefined &&
    next.reserveUsage < overrides.maxUsage
  ) {
    delete next.reserveUsage;
  }
  return next;
}

const ROUTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9._*?-]+$/;
const ROUTE_KEYS = new Set(["tool", "from", "exclude", "strategy", "maxUsage", "reserveUsage", "fallback"]);
const TOOLS: readonly string[] = ["claude", "codex"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteTool(value: unknown): value is RouteTool {
  return ROUTE_TOOLS.includes(value as RouteTool);
}

function isPercent(value: unknown, min: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= 100;
}

export function checkRouteName(name: string): string | null {
  // Checked first, so the message below never echoes something key-shaped. A vendor token
  // (`hf_…`, `ghp_…`) fits the name rule and the length ceiling, so it is looked for anywhere too.
  if (looksLikeCredential(name) || carriesCredentialToken(name)) return "That looks like an API key, not a route name.";
  if (ROUTE_NAME.test(name)) return null;
  return `Invalid route name '${name}': start with a letter or digit, and use only letters, digits, '.', '_' and '-'.`;
}

/**
 * A pattern's problem, or null. A key-shaped pattern is never quoted back. A `tool:` prefix must
 * name the route's tool; on an `all` route it may name either.
 */
export function checkPattern(pattern: unknown, tool: RouteTool): string | null {
  if (typeof pattern !== "string" || pattern.trim() === "") return "must be a non-empty string";
  // Each piece as well as the whole: `claude:<key>` does not start with 'sk-', and a shorter key
  // behind a prefix or a space stays under the length ceiling, so the checks below would store
  // it in routes.json or quote it back. And a key anywhere in it: a vendor token (`hf_…`, `AIza…`,
  // `ghp_…`) is short and does not start with 'sk-', so only carriesCredentialToken sees it.
  if (
    [pattern, ...pattern.split(/[\s,:]+/)].some((piece) => looksLikeCredential(piece) || carriesCredentialToken(piece))
  ) {
    return "looks like an API key, not a profile name or email pattern";
  }
  // Split as the matcher splits it, so a name and an email pattern read a prefix the same way.
  const { prefix, body } = splitToolPrefix(pattern);
  if (prefix !== null && !toolsOf(tool).includes(prefix as ToolName)) {
    const what = TOOLS.includes(prefix) ? `a ${prefix} profile` : `unknown tool '${prefix}'`;
    return `'${pattern}' names ${what}, but this route is for ${tool}`;
  }
  // A colon left in an email pattern would sit inside the address, which no account has.
  if (body.includes("@")) return /[\s,:]/.test(body) ? `'${pattern}' is not an email pattern` : null;
  if (!NAME_PATTERN.test(body)) {
    return `'${pattern}' is not a profile name pattern (letters, digits, '.', '_', '-', '*' and '?')`;
  }
  return null;
}

/** Every problem with one route, each prefixed with where it is (`routes.<name>.<key>`). */
export function checkRoute(name: string, raw: unknown, at = `routes.${name}`): string[] {
  const nameProblem = checkRouteName(name);
  if (nameProblem) return [nameProblem];
  if (!isRecord(raw)) return [`${at}: must be an object`];

  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (ROUTE_KEYS.has(key)) continue;
    // A vendor token (`ghp_…`, `hf_…`) is short and does not start with 'sk-': only
    // carriesCredentialToken sees it, and the key is quoted below.
    problems.push(
      looksLikeCredential(key) || carriesCredentialToken(key)
        ? `${at}: an unknown key looks like an API key`
        : `${at}: unknown key '${key}'`,
    );
  }
  const tool = raw.tool;
  if (!isRouteTool(tool)) {
    problems.push(`${at}.tool: must be "claude", "codex" or "all"`);
    return problems;
  }
  for (const key of ["from", "exclude", "fallback"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      problems.push(`${at}.${key}: must be a list of patterns`);
      continue;
    }
    value.forEach((pattern, index) => {
      const problem = checkPattern(pattern, tool);
      if (problem) problems.push(`${at}.${key}[${index}]: ${problem}`);
    });
  }
  if (Array.isArray(raw.from) && raw.from.length === 0) {
    problems.push(`${at}.from: must name at least one pattern; leave it out for every account ("*")`);
  }
  if (raw.strategy !== undefined && !STRATEGIES.includes(raw.strategy as Strategy)) {
    problems.push(`${at}.strategy: must be one of ${STRATEGIES.join(", ")}`);
  }
  // `null` is refused like any other non-number, as it is for every other key.
  const maxUsage = raw.maxUsage === undefined ? DEFAULT_MAX_USAGE : raw.maxUsage;
  if (!isPercent(maxUsage, 1)) problems.push(`${at}.maxUsage: must be a number from 1 to 100`);
  if (raw.reserveUsage !== undefined) {
    const floor = isPercent(maxUsage, 1) ? (maxUsage as number) : DEFAULT_MAX_USAGE;
    if (!isPercent(raw.reserveUsage, floor)) {
      problems.push(`${at}.reserveUsage: must be a number from maxUsage (${floor}) to 100`);
    }
  }
  return problems;
}

export type RoutesCheck = { ok: true; file: RoutesFile } | { ok: false; problems: string[]; newerVersion?: number };

export function checkRoutesFile(raw: unknown): RoutesCheck {
  if (!isRecord(raw)) return { ok: false, problems: ["must be a JSON object"] };
  if (typeof raw.version === "number" && raw.version > ROUTES_VERSION) {
    return {
      ok: false,
      newerVersion: raw.version,
      problems: [`was written by a newer clausona (version ${raw.version}); update clausona to use it`],
    };
  }
  if (raw.version !== ROUTES_VERSION) return { ok: false, problems: [`version: must be ${ROUTES_VERSION}`] };
  if (raw.routes !== undefined && !isRecord(raw.routes)) {
    return { ok: false, problems: ["routes: must be an object of named routes"] };
  }
  const routes = (raw.routes ?? {}) as Record<string, unknown>;
  const problems = Object.entries(routes).flatMap(([name, spec]) => checkRoute(name, spec));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, file: { ...raw, version: ROUTES_VERSION, routes: routes as Record<string, RouteSpec> } };
}
