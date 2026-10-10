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
  fallback?: string[];
};

/** A route with every default applied: what ranking works on. */
export type Route = {
  tool: RouteTool;
  from: string[];
  exclude: string[];
  strategy: Strategy;
  maxUsage: number;
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

/**
 * The route stored under `name`, or undefined. Own keys only: `toString` and `constructor` are on
 * every object, and are route names like any other.
 */
export function storedRoute(file: RoutesFile, name: string): RouteSpec | undefined {
  return Object.hasOwn(file.routes, name) ? file.routes[name] : undefined;
}

/** What `route add` and the unknown-route prompt create: the defaults, written out. */
export function newRouteSpec(tool: RouteTool = "claude"): RouteSpec {
  return {
    tool,
    from: ["*"],
    strategy: DEFAULT_STRATEGY,
    maxUsage: DEFAULT_MAX_USAGE,
  };
}

export function withDefaults(spec: RouteSpec): Route {
  return {
    tool: spec.tool,
    from: spec.from ?? ["*"],
    exclude: spec.exclude ?? [],
    strategy: spec.strategy ?? DEFAULT_STRATEGY,
    maxUsage: spec.maxUsage ?? DEFAULT_MAX_USAGE,
    fallback: spec.fallback ?? [],
  };
}

export function applyOverrides(spec: RouteSpec, overrides: RouteOverrides): RouteSpec {
  const next: RouteSpec = { ...spec };
  if (overrides.from !== undefined) next.from = overrides.from;
  if (overrides.exclude !== undefined) next.exclude = overrides.exclude;
  if (overrides.strategy !== undefined) next.strategy = overrides.strategy;
  if (overrides.maxUsage !== undefined) next.maxUsage = overrides.maxUsage;
  if (overrides.fallback !== undefined) next.fallback = overrides.fallback;
  return next;
}

const ROUTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9._*?-]+$/;
const ROUTE_KEYS = new Set(["tool", "from", "exclude", "strategy", "maxUsage", "fallback"]);
/**
 * Keys an earlier build of this version wrote and routes no longer have: `reserveUsage`, the limit
 * past the cut that a route once had. Accepted whatever they hold, and left out of the file as it
 * is read, so the next write drops them.
 */
const RETIRED_KEYS = new Set(["reserveUsage"]);
const TOOLS: readonly string[] = ["claude", "codex"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteTool(value: unknown): value is RouteTool {
  return ROUTE_TOOLS.includes(value as RouteTool);
}

/** A route's limit: a number from 1 to 100. */
function isLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100;
}

/**
 * Whether text holds something shaped like a key, so that it is neither stored nor quoted back:
 * the whole of it, or a piece of it between spaces, commas and colons, starts like one or carries
 * one anywhere. Pieces as well as the whole: `claude:<key>` does not start with 'sk-', and a
 * shorter key behind a prefix or a space stays under the length ceiling. A key anywhere: a vendor
 * token (`hf_…`, `AIza…`, `ghp_…`) is short and does not start with 'sk-', so only
 * carriesCredentialToken sees it. Route names, patterns and the TUI's route form all ask this.
 */
export function holdsKey(text: string): boolean {
  return [text, ...text.split(/[\s,:]+/)].some((piece) => looksLikeCredential(piece) || carriesCredentialToken(piece));
}

export function checkRouteName(name: string): string | null {
  // Checked first, so the message below never echoes something key-shaped.
  if (holdsKey(name)) return "That looks like an API key, not a route name.";
  if (ROUTE_NAME.test(name)) return null;
  return `Invalid route name '${name}': start with a letter or digit, and use only letters, digits, '.', '_' and '-'.`;
}

/**
 * A pattern's problem, or null. A key-shaped pattern is never quoted back. A `tool:` prefix must
 * name the route's tool; on an `all` route it may name either.
 */
export function checkPattern(pattern: unknown, tool: RouteTool): string | null {
  if (typeof pattern !== "string" || pattern.trim() === "") return "must be a non-empty string";
  // Before anything below would store it in routes.json or quote it back.
  if (holdsKey(pattern)) return "looks like an API key, not a profile name or email pattern";
  // Split as the matcher splits it, so a name and an email pattern read a prefix the same way.
  const { prefix, body } = splitToolPrefix(pattern);
  if (prefix !== null && !toolsOf(tool).includes(prefix as ToolName)) {
    const what = TOOLS.includes(prefix) ? `a ${prefix} profile` : `unknown tool '${prefix}'`;
    return `'${pattern}' names ${what}, but this route is for ${tool === "all" ? "claude + codex" : tool}`;
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
    if (ROUTE_KEYS.has(key) || RETIRED_KEYS.has(key)) continue;
    // The key is quoted below, so a key-shaped one is not.
    problems.push(holdsKey(key) ? `${at}: an unknown key looks like an API key` : `${at}: unknown key '${key}'`);
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
  if (!isLimit(maxUsage)) problems.push(`${at}.maxUsage: must be a number from 1 to 100`);
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
  const kept = Object.fromEntries(
    Object.entries(routes as Record<string, Record<string, unknown>>).map(([name, spec]) => [
      name,
      Object.fromEntries(Object.entries(spec).filter(([key]) => !RETIRED_KEYS.has(key))) as RouteSpec,
    ]),
  );
  return { ok: true, file: { ...raw, version: ROUTES_VERSION, routes: kept } };
}
