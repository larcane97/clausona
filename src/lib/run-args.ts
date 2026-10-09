import { ROUTE_TOOLS, type RouteOverrides, type RouteTool, STRATEGIES, type Strategy } from "../core/route-config.js";
import type { ToolName } from "../types.js";

/**
 * The arguments of a routed `clausona run` and of the `route` subcommands. As everywhere in
 * clausona, an option's value is never echoed in an error: a key typed into the wrong slot
 * would otherwise land in the scrollback.
 */

export type RoutingOptions = RouteOverrides & { route?: string };

export const ROUTE_FIELD_OPTIONS: readonly string[] = [
  "--from",
  "--exclude",
  "--strategy",
  "--max-usage",
  "--reserve-usage",
  "--fallback",
];

export const ROUTING_VALUE_OPTIONS: readonly string[] = ["--route", ...ROUTE_FIELD_OPTIONS];

export type RunArgs = {
  tool?: ToolName;
  options: RoutingOptions;
  toolArgs: string[];
  /** Whether a `--` ended clausona's part, so that what follows is the tool's whatever it looks like. */
  sawSeparator: boolean;
};

export function parsePatterns(flag: string, value: string): string[] {
  const patterns = value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) throw new Error(`${flag} needs at least one pattern.`);
  return patterns;
}

function parsePercent(flag: string, value: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < 1 || number > 100) {
    throw new Error(`${flag} must be a number from 1 to 100.`);
  }
  return number;
}

function parseStrategy(value: string): Strategy {
  if (!STRATEGIES.includes(value as Strategy)) throw new Error(`--strategy must be one of ${STRATEGIES.join(", ")}.`);
  return value as Strategy;
}

/** `--tool` of the `route` subcommands: claude, codex, or all for a route over both. */
export function parseRouteTool(value: string | undefined): RouteTool | undefined {
  if (value === undefined) return undefined;
  if (!ROUTE_TOOLS.includes(value as RouteTool)) throw new Error("--tool must be claude, codex or all.");
  return value as RouteTool;
}

export function toRoutingOptions(values: Map<string, string>): RoutingOptions {
  const options: RoutingOptions = {};
  for (const [flag, value] of values) {
    switch (flag) {
      case "--route":
        options.route = value;
        break;
      case "--from":
        options.from = parsePatterns(flag, value);
        break;
      case "--exclude":
        options.exclude = parsePatterns(flag, value);
        break;
      case "--fallback":
        options.fallback = parsePatterns(flag, value);
        break;
      case "--strategy":
        options.strategy = parseStrategy(value);
        break;
      case "--max-usage":
        options.maxUsage = parsePercent(flag, value);
        break;
      case "--reserve-usage":
        options.reserveUsage = parsePercent(flag, value);
        break;
    }
  }
  return options;
}

function splitOption(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * Reads clausona's part of `clausona run` without a named profile: routing options and, once, a
 * tool (`claude` or `codex`), until the first other argument or a `--` (dropped). Everything
 * from there on is the tool's, untouched.
 */
export function readRunArgs(args: string[]): RunArgs {
  const values = new Map<string, string>();
  let tool: ToolName | undefined;
  let sawSeparator = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      sawSeparator = true;
      i++;
      break;
    }
    if (!tool && (arg === "claude" || arg === "codex")) {
      tool = arg;
      continue;
    }
    const [flag, inline] = splitOption(arg);
    if (!ROUTING_VALUE_OPTIONS.includes(flag)) break;
    if (values.has(flag)) throw new Error(`${flag} was given more than once. Pass it at most once.`);
    let value = inline;
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
      i++;
    }
    values.set(flag, value);
  }
  return { ...(tool ? { tool } : {}), options: toRoutingOptions(values), toolArgs: args.slice(i), sawSeparator };
}

export type OptionSpec = { values: readonly string[]; flags: readonly string[] };

export type ReadOptions = { values: Map<string, string>; flags: Set<string>; positionals: string[] };

/** Options anywhere among the arguments, for the `route` subcommands. */
export function readOptions(args: string[], spec: OptionSpec, command: string): ReadOptions {
  const out: ReadOptions = { values: new Map(), flags: new Set(), positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-") {
      out.positionals.push(arg);
      continue;
    }
    const [flag, inline] = splitOption(arg);
    if (inline === undefined && spec.flags.includes(flag)) {
      out.flags.add(flag);
      continue;
    }
    if (!spec.values.includes(flag)) {
      throw new Error(`Unknown option: ${flag}\nRun \`clausona ${command} --help\` for usage.`);
    }
    if (out.values.has(flag)) throw new Error(`${flag} was given more than once. Pass it at most once.`);
    let value = inline;
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
      i++;
    }
    out.values.set(flag, value);
  }
  return out;
}

const CLAUDE_RESUME_FLAGS = new Set(["-c", "--continue", "-r", "--resume", "--from-pr"]);

/**
 * Whether the tool's arguments continue an earlier session, which only a profile that shares
 * session history can find. Codex's `resume` and `fork` are subcommands, also under `exec`;
 * a bare argument equal to either counts, which a prompt of exactly that word would trip.
 */
export function isResumeRun(tool: ToolName, toolArgs: string[]): boolean {
  if (tool === "claude") return toolArgs.some((arg) => CLAUDE_RESUME_FLAGS.has(splitOption(arg)[0]));
  return toolArgs.some((arg) => arg === "resume" || arg === "fork");
}
