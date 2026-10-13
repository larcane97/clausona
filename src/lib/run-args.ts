import {
  holdsKey,
  ROUTE_TOOLS,
  type RouteOverrides,
  type RouteTool,
  STRATEGIES,
  type Strategy,
} from "../core/route-config.js";
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
  /** `--wait`'s cap in ms, when the run waits for an account to come free. */
  waitMs?: number;
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

/** How long `--wait` waits for a reset when no cap is given. */
export const DEFAULT_WAIT_MS = 5 * 60 * 60 * 1000;

/**
 * `--wait`'s cap: `30m`, `2h` or `1h30m`, or the default when none is given. Anything else is
 * refused with the forms it takes, the value not echoed.
 */
export function parseWait(value: string | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_MS;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(value);
  const ms = match ? (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000 : 0;
  if (ms <= 0) throw new Error("--wait takes a duration such as 30m, 2h or 1h30m: --wait=30m.");
  return ms;
}

/**
 * `--wait`'s cap is given after `=`: `--wait 30m` would hand 30m to the tool as its prompt, or to
 * `route pick` as the route's name. Refused when the next argument looks like a duration.
 */
export function refuseSpacedWait(next: string | undefined): void {
  if (next !== undefined && /^\d[\da-z]*$/i.test(next)) {
    throw new Error("Give --wait its cap after =, as in --wait=30m.");
  }
}

/** `--tool` of the `route` subcommands: claude, codex, or all for a route over both. */
export function parseRouteTool(value: string | undefined): RouteTool | undefined {
  if (value === undefined) return undefined;
  if (!ROUTE_TOOLS.includes(value as RouteTool)) throw new Error("--tool must be claude, codex or all.");
  return value as RouteTool;
}

/**
 * `--model` of `route explain` and `route pick`: the model a run would name, whose own limit then
 * counts. A blank one is refused, as is one shaped like a key, which explain would print.
 */
export function parseModel(value: string): string {
  const model = value.trim();
  if (model === "") throw new Error("--model needs a value.");
  if (holdsKey(model)) throw new Error("That looks like an API key, not a model name.");
  return model;
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
  let waitMs: number | undefined;
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
    // `--wait` takes its cap after `=` only, so a bare one never takes the tool's first argument.
    if (flag === "--wait") {
      if (waitMs !== undefined) throw new Error("--wait was given more than once. Pass it at most once.");
      if (inline === undefined) refuseSpacedWait(args[i + 1]);
      waitMs = parseWait(inline);
      continue;
    }
    if (!isRoutingFlag(flag)) break;
    i = readValue(values, args, i);
  }
  return {
    ...(tool ? { tool } : {}),
    options: toRoutingOptions(values),
    ...(waitMs === undefined ? {} : { waitMs }),
    toolArgs: args.slice(i),
    sawSeparator,
  };
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

/**
 * The model the tool's arguments name, read without changing them: Claude Code's `--model`, and
 * Codex's `-m` or `--model`, at the top level or after a subcommand such as `exec`. The last one
 * given counts, as it does for the tool. Nothing after a `--` is read: that is the prompt. Codex's
 * `-c model=…`, a Codex config profile and a profile's pinned model are not read, so such a run
 * counts no model's limit; nor is a value shaped like a key, which would be echoed.
 */
export function modelOf(tool: ToolName, toolArgs: string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < toolArgs.length; i++) {
    const arg = toolArgs[i];
    if (arg === "--") break;
    const [flag, inline] = splitOption(arg);
    let value: string | undefined;
    if (flag === "--model" || (tool === "codex" && flag === "-m")) {
      value = inline ?? toolArgs[++i];
    } else if (tool === "codex" && /^-m[^=]/.test(arg)) {
      // Codex reads `-mgpt-5.3-codex` as `-m gpt-5.3-codex`.
      value = arg.slice(2);
    } else {
      continue;
    }
    if (value !== undefined && value.trim() !== "" && !value.startsWith("-") && !holdsKey(value)) model = value.trim();
  }
  return model;
}
