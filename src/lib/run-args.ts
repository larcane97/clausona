import { ROUTE_TOOLS, type RouteOverrides, type RouteTool, STRATEGIES, type Strategy } from "../core/route-config.js";
import type { ToolName } from "../types.js";

/**
 * The arguments of a routed `clausona run` and of the `route` subcommands. As everywhere in
 * clausona, an option's value is never echoed in an error: a key typed into the wrong slot
 * would otherwise land in the scrollback.
 */

export type RoutingOptions = RouteOverrides & { route?: string };

export const ROUTE_FIELD_OPTIONS = ["--from", "--exclude", "--strategy", "--max-usage", "--fallback"] as const;

export const ROUTING_VALUE_OPTIONS = ["--route", ...ROUTE_FIELD_OPTIONS] as const;

type RoutingFlag = (typeof ROUTING_VALUE_OPTIONS)[number];

const isRoutingFlag = (flag: string): flag is RoutingFlag =>
  (ROUTING_VALUE_OPTIONS as readonly string[]).includes(flag);

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

/** The routing options among `values`. The rest - `--tool`, `--add` and the like - are the caller's. */
export function toRoutingOptions(values: Map<string, string>): RoutingOptions {
  const options: RoutingOptions = {};
  for (const [flag, value] of values) {
    if (!isRoutingFlag(flag)) continue;
    switch (flag) {
      case "--route":
        // `--route=` and `--route ""` give no name, as a missing value does.
        if (value.trim() === "") throw new Error(`${flag} needs a value.`);
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
      default: {
        // An option added to the lists above without a case here fails to compile, rather than
        // being read and then dropped.
        const unhandled: never = flag;
        throw new Error(`unhandled routing option: ${unhandled}`);
      }
    }
  }
  return options;
}

function splitOption(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * Stores the value of the option at `args[i]`, given after `=` or as the next argument, and
 * returns the index of the last argument it used. An option given twice and one with no value
 * after it are refused; neither message says what the value was.
 */
function readValue(values: Map<string, string>, args: string[], i: number): number {
  const [flag, inline] = splitOption(args[i]);
  if (values.has(flag)) throw new Error(`${flag} was given more than once. Pass it at most once.`);
  if (inline !== undefined) {
    values.set(flag, inline);
    return i;
  }
  const next = args[i + 1];
  if (next === undefined || next.startsWith("-")) throw new Error(`${flag} needs a value.`);
  values.set(flag, next);
  return i + 1;
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
    if (!isRoutingFlag(splitOption(arg)[0])) break;
    i = readValue(values, args, i);
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
    i = readValue(out.values, args, i);
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
