import { existsSync } from "node:fs";

import { carriesCredentialToken } from "./core/credential-token.js";
import { foldProfileName } from "./core/profile-name.js";
import type { QuotaTarget } from "./core/quota-store.js";
import {
  applyOverrides,
  type BrokenRoute,
  checkPattern,
  checkRoute,
  checkRouteName,
  checkRoutesFile,
  emptyRoutesFile,
  holdsKey,
  newRouteSpec,
  type ProfileNames,
  type Route,
  type RouteOverrides,
  type RouteSpec,
  type RoutesFile,
  type RouteTool,
  storedRoute,
  withDefaults,
} from "./core/route-config.js";
import {
  clearDefaultRoute,
  clearDirRoute,
  expandDir,
  type RouteRules,
  type RuleRef,
  readRules,
  removeReferences,
  renameReferences,
  routeProblem,
  rulesText,
  ruleWarnings,
  SLOT_TOOLS,
  type Slots,
  sameDir,
  setDefaultRoute,
  setDirRoute,
  storedDir,
} from "./core/route-rules.js";
import {
  brokenRoutesHint,
  type LoadedRoutes,
  loadRoutes,
  parseRoutesText,
  RoutesFileError,
  readRoutes,
  readRoutesText,
  replaceRoutesText,
  updateRoutes,
  writeRefusal,
} from "./core/routes-store.js";
import type { Ranking } from "./core/routing.js";
import { withJsonErrors } from "./extensions/cli.js";
import { ExitError } from "./extensions/exit-error.js";
import { accent, bold, dim, helpSection, helpUsage, stripAnsi, success, warnIcon } from "./lib/cli-style.js";
import { type RouteIo, terminalIo } from "./lib/route-io.js";
import {
  explainJson,
  nobodyAdvice,
  pickJson,
  type RuleRow,
  type RunHere,
  renderNoAccount,
  renderRouteDetail,
  renderRouteTable,
  renderRules,
  renderRunsHere,
  routeListJson,
  rulesJson,
  runHereJson,
  skippedText,
  takesNobody,
} from "./lib/route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  inferRouteTool,
  membersOf,
  NoAccountError,
  namesOf,
  otherToolTaking,
  pathsFor,
  quotaTargets,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  routeByRules,
  routesFor,
  UnknownRouteError,
} from "./lib/route-service.js";
import { parsePatterns, parseRouteTool, ROUTE_FIELD_OPTIONS, readOptions, toRoutingOptions } from "./lib/run-args.js";
import { noRegistryError } from "./lib/service.js";
import type { Registry, ToolName } from "./types.js";

// ─── Help ──────────────────────────────────────────────────────────
//
// Written to be read by an agent as much as by a person: a user's local Claude Code or Codex
// session will usually run `clausona route --help` before anything else, so this page alone
// has to be enough to use routes correctly.

const FIELD_HELP: [string, string][] = [
  ["--from <patterns>", "Pool members, comma-separated (default: *)"],
  ["--exclude <patterns>", "Leave these out of from and fallback"],
  ["--strategy <s>", "round-robin (default), headroom or expiring"],
  ["--max-usage <n>", "Cut members at or above n% (default: 80)"],
  ["--fallback <patterns>", "Tried in order when the pool has nobody under the cut"],
];

const SUB_HELP: Record<string, string[]> = {
  list: [
    helpUsage("clausona route list [--json] [--no-quota]"),
    "",
    `    ${dim("Every route with its settings, how many of its accounts are free now, and the one it")}`,
    `    ${dim("would pick next (nothing is recorded). --no-quota reads no quota and shows a dash.")}`,
    `    ${dim("Warns about names that are not registered (removed profiles), patterns and excludes that")}`,
    `    ${dim("match nobody, and routes in routes.json that cannot be used.")}`,
  ],
  add: [
    helpUsage("clausona route add <name> [--tool claude|codex|all] [options]"),
    "",
    helpSection("OPTIONS", [["--tool <tool>", "claude (default), codex or all"], ...FIELD_HELP]),
    "",
    `    ${dim("Asks nothing, and shows the new route with its members. Without --tool, --from entries")}`,
    `    ${dim("that all start with codex: make a codex route; entries of both tools make an all route.")}`,
    "",
    `  ${bold("EXAMPLES")}`,
    `    ${dim("clausona route add main                                   # every claude account, round-robin")}`,
    `    ${dim("clausona route add any --tool all                         # claude and codex accounts")}`,
    `    ${dim("clausona route add work --from '*@example.com' --exclude '*-share'")}`,
    `    ${dim("clausona route add solo --from work --fallback team --strategy headroom")}`,
  ],
  set: [
    helpUsage("clausona route set <name> [options] [--add <patterns>] [--drop <patterns>] [--no-fallback]"),
    "",
    helpSection("OPTIONS", [
      // An edit: unlike a run's --exclude, which adds to the route's list for that run.
      ...FIELD_HELP.map(([flag, text]): [string, string] =>
        flag.startsWith("--exclude") ? [flag, "Replace the route's exclude list"] : [flag, text],
      ),
      ["--add <patterns>", "Add entries to from"],
      ["--drop <patterns>", "Remove entries from from (to leave one account out of *, use --exclude)"],
      ["--no-fallback", "Remove the fallback list"],
    ]),
  ],
  rename: [helpUsage("clausona route rename <old> <new>")],
  remove: [helpUsage("clausona route remove <name>")],
  edit: [
    helpUsage("clausona route edit"),
    "",
    `    ${dim("Opens routes.json in $VISUAL or $EDITOR. It is checked when you save; if it")}`,
    `    ${dim("has a problem, nothing is written and you can edit again.")}`,
  ],
  explain: [
    helpUsage("clausona route explain <name> [--tool claude|codex] [options] [--resume] [--json]"),
    helpUsage("clausona route explain --tool claude|codex|all --from <patterns> [--json]"),
    helpUsage("clausona route explain [--tool claude|codex] [--resume] [--json]"),
    "",
    `    ${dim("Every member with its 5H and 7D use, its usage (the higher of the two), when it was")}`,
    `    ${dim("last picked, and why it would or would not be picked now. Launches nothing and")}`,
    `    ${dim("records nothing. --resume ranks as a resumed run would (shared sessions only).")}`,
    `    ${dim("On an all route, --tool ranks only that tool's accounts, as a run naming it would.")}`,
    `    ${dim("With no name: what clausona run claude and clausona run codex would take in this")}`,
    `    ${dim("directory, which dir rule or default says so, and the explain of each route.")}`,
  ],
  dir: [
    helpUsage("clausona route dir <path> <route> [--tool claude|codex]"),
    helpUsage("clausona route dir <path> --clear [--tool claude|codex]"),
    helpUsage("clausona route dir"),
    "",
    `    ${dim("In <path> and below, clausona run claude (or codex) with no route takes <route>; the")}`,
    `    ${dim("deepest rule wins. A claude or codex route fills its own tool's slot, an all route both,")}`,
    `    ${dim("or the one --tool names. --clear removes the rule, or one tool's slot of it. With")}`,
    `    ${dim("nothing after it, lists every dir rule and default.")}`,
  ],
  default: [
    helpUsage("clausona route default <route> [--tool claude|codex]"),
    helpUsage("clausona route default --clear --tool claude|codex|all"),
    helpUsage("clausona route default"),
    "",
    `    ${dim("Where no dir rule holds, clausona run claude (or codex) with no route takes <route>.")}`,
    `    ${dim("Without a rule or a default, it runs the tool's active profile. With nothing after it,")}`,
    `    ${dim("lists every dir rule and default.")}`,
  ],
  pick: [
    helpUsage("clausona route pick <name> [--tool claude|codex] [options] [--resume] [--json]"),
    "",
    `    ${dim("Takes a turn: prints the picked profile id (or JSON) and records the pick, so the")}`,
    `    ${dim("next pick on a round-robin route takes the next account. Exits 75 when nobody can")}`,
    `    ${dim("be picked; with --json the JSON is still printed, with profile null.")}`,
    "",
    `  ${bold("EXAMPLE")}`,
    `    ${dim('id=$(clausona route pick main) && clausona run "$id" -- -p "run the tests"')}`,
  ],
};

export function routeHelp(sub?: string): string {
  // Own keys only: `toString` and `constructor` are on every object, and are not subcommands.
  if (sub && Object.hasOwn(SUB_HELP, sub)) {
    return ["", `  ${accent(`clausona route ${sub}`)}`, "", `  ${bold("USAGE")}`, ...SUB_HELP[sub], ""].join("\n");
  }
  return [
    "",
    `  ${accent("clausona route")} ${dim("— Pick an account by plan quota")}`,
    "",
    `  ${bold("USAGE")}`,
    helpUsage("clausona route <command> [options]"),
    "",
    helpSection("COMMANDS", [
      ["(no arguments)", "In a terminal, open the Routes screen of the dashboard"],
      ["list", "Show routes, how many accounts are free now, and who is next"],
      ["add <name>", "Create a route (every claude subscription, round-robin, skip at 80%)"],
      ["set <name>", "Change some of a route's fields"],
      ["rename <old> <new>", "Rename a route"],
      ["remove <name>", "Remove a route"],
      ["edit", "Edit routes.json in $EDITOR, checked before it is saved"],
      ["explain [name]", "Show the ranking without launching anything; no name: what a run here takes"],
      ["pick <name>", "Take a turn: print the picked profile and record it"],
      ["dir <path> <route>", "In <path> and below, run claude|codex with no route takes <route>"],
      ["default <route>", "Elsewhere, run claude|codex with no route takes <route>"],
    ]),
    "",
    `  ${bold("RUN ON A ROUTE")}`,
    helpUsage("clausona run --route <name> [--] [tool args...]"),
    helpUsage("clausona run claude --from 'team-*' [--] [tool args...]     # an unsaved route"),
    `    ${dim("On a route over both tools (--tool all), name the tool before its arguments:")}`,
    `    ${dim("clausona run codex --route any -- exec 'review this'")}`,
    "",
    `  ${bold("DIR RULES AND DEFAULTS")}`,
    helpUsage("clausona route dir ~/work work       # in ~/work and below, clausona run claude takes route work"),
    helpUsage("clausona route default main          # everywhere else, it takes route main"),
    `    ${dim("Only clausona run claude|codex with no --route or --from reads them: the deepest dir")}`,
    `    ${dim("rule for the current directory, then the default, then the tool's active profile.")}`,
    `    ${dim("A rule whose route is gone, or for the other tool, is skipped with a warning.")}`,
    "",
    `  ${bold("HOW A PROFILE IS PICKED")}`,
    `    ${dim("usage = the higher of the account's 5H and 7D windows")}`,
    `    ${dim("1. pool      from-members under max-usage, by strategy")}`,
    `    ${dim("2. fallback  fallback-members under max-usage, first in listed order")}`,
    `    ${dim("3. overflow  any member under 100%, lowest usage first")}`,
    `    ${dim("4. nobody    exit 75")}`,
    `    ${dim("round-robin: picked longest ago · headroom: lowest usage ·")}`,
    `    ${dim("expiring: weekly limit resetting within 24h first")}`,
    `    ${dim("Resumed runs (-c, --resume, codex resume) use only accounts that share sessions.")}`,
    "",
    `  ${bold("PATTERNS")} ${dim("(--from, --exclude, --fallback; comma-separated, quoted in the shell)")}`,
    `    ${dim("*               every subscription profile of the route's tool (of both, on an all route)")}`,
    `    ${dim("team-*          profile names; a tool prefix works too: claude:team-*")}`,
    `    ${dim("*@example.com   account emails: any pattern with an @")}`,
    `    ${dim("API profiles never match a pattern; routes take subscription profiles only for now.")}`,
    "",
    `  ${bold("FOR AGENTS")}`,
    `    ${dim("clausona route add <name> --tool <tool>  create a route: claude (default), codex or all")}`,
    `    ${dim("clausona route explain <name> --json     every member, its usage, and why it is or is not picked")}`,
    `    ${dim("clausona route pick <name> --json        take a turn; call it once per worker you start")}`,
    `    ${dim("clausona route explain --json            what clausona run claude|codex takes here, and why")}`,
    `    ${dim("clausona run <profile> [--] ...          launch on the picked profile")}`,
    `    ${dim("add and set never ask; run asks one Y/n only for an unknown route in a terminal.")}`,
    `    ${dim("Without a terminal, run exits 1 on an unknown route and creates nothing.")}`,
    `    ${dim("Create and change routes with add / set / remove, not by editing routes.json.")}`,
    `    ${dim("Before creating or changing a route for the user, show them its members (explain).")}`,
    "",
    `  ${bold("EXIT CODES")}`,
    `    ${dim("the tool's own   run launched the tool")}`,
    `    ${dim("1                usage error, or routes.json cannot be used")}`,
    `    ${dim("75               no account is available now: retry later, or name a profile")}`,
    `    ${dim("With --json, a failure is one object on stdout: { version, error, message }.")}`,
    "",
    `  ${dim("Run clausona route <command> --help for each command.")}`,
    `  ${dim("Docs: https://github.com/larcane97/clausona/blob/main/docs/routing.md")}`,
    "",
  ].join("\n");
}

// ─── Subcommands ───────────────────────────────────────────────────

const usage = (sub: string) => `Usage: ${stripAnsi(SUB_HELP[sub]?.[0] ?? "").trim()}`;

/** Bad usage, which `--json` calls `usage`. It exits 1, as every routing failure but 75 does. */
class RouteUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteUsageError";
  }
}

/**
 * Reads a command's arguments with `read`: whatever plain error it throws is bad usage. Only a
 * plain one: an unknown route, or a routes.json that cannot be used, keeps its own kind.
 */
function asUsage<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
      throw new RouteUsageError(error.message);
    }
    throw error;
  }
}

/** readOptions for the subcommands: an option they do not take is bad usage. */
const readArgs = (...args: Parameters<typeof readOptions>) => asUsage(() => readOptions(...args));

async function registryOrThrow(deps: RouteDeps): Promise<Registry> {
  const registry = await deps.loadRegistry();
  if (!registry) throw await noRegistryError();
  return registry;
}

function routeNameArg(name: string | undefined, sub: string): string {
  if (!name) throw new Error(`${usage(sub)}\nRun \`clausona route ${sub} --help\` for usage.`);
  const problem = checkRouteName(name);
  if (problem) throw new Error(problem);
  return name;
}

/**
 * A new route as `route add` writes it, and as `run --route <unknown>` proposes it: the defaults
 * for the tool with the options given.
 */
export function newRouteFrom(tool: RouteTool, overrides: RouteOverrides): RouteSpec {
  return applyOverrides(newRouteSpec(tool), overrides);
}

/** Refuses a name a route already has, pointing at the command that changes that route. */
function refuseTakenName(file: RoutesFile, name: string): void {
  if (Object.hasOwn(file.routes, name)) {
    throw new Error(`Route '${name}' already exists. Change it with clausona route set ${name} …`);
  }
}

/** updateRoutes, with the registered profiles' names, which routes.json's checks let through. */
async function changeRoutes(deps: RouteDeps, update: (file: RoutesFile) => RoutesFile | null): Promise<RoutesFile> {
  return updateRoutes(update, deps.paths, namesOf(await deps.loadRegistry()));
}

/** Writes a new route, refusing a name someone created meanwhile. */
export async function createRoute(name: string, spec: RouteSpec, deps: RouteDeps): Promise<void> {
  await changeRoutes(deps, (file) => {
    refuseTakenName(file, name);
    file.routes[name] = spec;
    return file;
  });
}

/**
 * The route's settings box and members, as `route explain` shows them; nothing is recorded.
 * `advise` says what to do about a route that takes nobody.
 */
async function routeDetail(name: string, spec: RouteSpec, deps: RouteDeps, advise?: () => string): Promise<string> {
  const ranking = await rankRouteNow({ route: withDefaults(spec) }, deps, { resume: false, record: false });
  const nobodyHint = advise && takesNobody(ranking) ? advise() : undefined;
  return renderRouteDetail(name, ranking, { now: deps.clock(), nobodyHint });
}

/** Asks nothing: the flags say everything, and what was created is shown. */
async function addRoute(args: string[], deps: RouteDeps): Promise<string> {
  // --yes is read and changes nothing: add asked before creating once, and scripts still pass it.
  const read = readArgs(args, { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--yes", "-y"] }, "route add");
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("add")}\nRun \`clausona route add --help\` for usage.`);
  const name = routeNameArg(nameArg, "add");
  const options = toRoutingOptions(read.values);
  const tool = parseRouteTool(read.values.get("--tool")) ?? inferRouteTool(options.from ?? []) ?? "claude";
  const registry = await registryOrThrow(deps);
  refuseTakenName(await readRoutes(deps.paths, namesOf(registry)), name);
  const spec = newRouteFrom(tool, options);
  checkRouteMembers(name, spec, registry);
  await createRoute(name, spec, deps);
  // A Codex-only user's `route add main` makes a claude route: it is said how to make it codex's.
  const advise = () => nobodyAdvice(name, otherToolTaking(spec, registry), options);
  return [
    success(`Created route ${bold(name)}`),
    await routeDetail(name, spec, deps, advise),
    dim(`    Run on it: clausona run --route ${name}`),
    "",
  ].join("\n");
}

async function setRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(
    args,
    { values: [...ROUTE_FIELD_OPTIONS, "--add", "--drop"], flags: ["--no-fallback"] },
    "route set",
  );
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("set")}\nRun \`clausona route set --help\` for usage.`);
  const name = routeNameArg(nameArg, "set");
  const options = toRoutingOptions(read.values);
  const add = read.values.has("--add") ? parsePatterns("--add", read.values.get("--add") as string) : [];
  const drop = read.values.has("--drop") ? parsePatterns("--drop", read.values.get("--drop") as string) : [];
  const noFallback = read.flags.has("--no-fallback");
  if (noFallback && options.fallback) throw new Error("--fallback and --no-fallback cannot be used together.");
  if (Object.keys(options).length === 0 && !add.length && !drop.length && !noFallback) {
    throw new Error(
      "Nothing to change. Pass at least one of --from, --add, --drop, --exclude, --strategy, --max-usage, --fallback, --no-fallback.",
    );
  }
  const registry = await registryOrThrow(deps);
  const names = namesOf(registry);
  const written = await changeRoutes(deps, (file) => {
    if (!Object.hasOwn(file.routes, name)) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    const current: unknown = file.routes[name];
    // A route routes.json holds as something other than an object has no fields to change.
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new Error(checkRoute(name, current, undefined, names).join("\n"));
    }
    const next = applyOverrides(current as RouteSpec, options);
    if (add.length || drop.length) {
      // Entries compare as profile names do: `Work` and `work` are one entry.
      const same = (a: string, b: string) => foldProfileName(a) === foldProfileName(b);
      const from = next.from ?? ["*"];
      // The message below quotes the from list and the dropped entry, so both are checked first:
      // a key given to --from or --drop is refused without being repeated.
      const problems = [
        ...checkRoute(name, next, undefined, names),
        ...drop.flatMap((entry) => {
          const problem = checkPattern(entry, next.tool, names);
          return problem ? [`--drop: ${problem}`] : [];
        }),
      ];
      if (problems.length) throw new Error(problems.join("\n"));
      for (const entry of drop) {
        if (!from.some((pattern) => same(pattern, entry))) {
          throw new Error(
            `'${entry}' is not in ${name}'s from list (${from.join(", ")}). To leave an account out of a pattern, use --exclude ${entry}.`,
          );
        }
      }
      const kept = from.filter((pattern) => !drop.some((entry) => same(entry, pattern)));
      next.from = [...kept, ...add.filter((entry) => !kept.some((pattern) => same(pattern, entry)))];
      // Said here, in the words of the options given: the file's own check would point at
      // leaving `from` out of routes.json, which `route set` cannot do.
      if (next.from.length === 0) {
        throw new Error("A route needs at least one entry in from; add one with --add, or remove the route.");
      }
    }
    if (noFallback) delete next.fallback;
    checkRouteMembers(name, next, registry);
    file.routes[name] = next;
    return file;
  });
  return [success(`Updated route ${bold(name)}`), await routeDetail(name, written.routes[name], deps)].join("\n");
}

async function renameRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: [], flags: [] }, "route rename");
  const [oldArg, newArg, ...extra] = read.positionals;
  if (!oldArg || !newArg || extra.length)
    throw new Error(`${usage("rename")}\nRun \`clausona route rename --help\` for usage.`);
  const from = routeNameArg(oldArg, "rename");
  const to = routeNameArg(newArg, "rename");
  const names = namesOf(await deps.loadRegistry());
  if (from === to) {
    // Not "already exists": the name it is taken by is its own, and there is nothing to write.
    const { file, broken } = await loadRoutes(deps.paths, names);
    if (!Object.hasOwn(file.routes, from) && !broken.some((route) => route.name === from)) {
      throw new UnknownRouteError(from, Object.keys(file.routes).sort());
    }
    return success(dim(`Route ${from} already has that name. Nothing was changed.`));
  }
  let rules: RuleRef[] = [];
  await changeRoutes(deps, (file) => {
    if (!Object.hasOwn(file.routes, from)) throw new UnknownRouteError(from, Object.keys(file.routes).sort());
    if (Object.hasOwn(file.routes, to)) throw new Error(`Route '${to}' already exists.`);
    // A route that cannot be used is no better under another name. Refused here, while it still has
    // the name its way out (route remove) needs, whatever it is stored as.
    const check = checkRoutesFile(file, names);
    if (check.ok && check.broken.some((route) => route.name === from)) {
      throw writeRefusal(deps.paths.routesPath, check.broken);
    }
    const spec = file.routes[from];
    delete file.routes[from];
    file.routes[to] = spec;
    rules = renameReferences(file, from, to);
    return file;
  });
  return [
    success(`Renamed route ${bold(from)} to ${bold(to)}`),
    ...(rules.length ? [dim(`    Also renamed in ${andList(rulesText(rules))}.`)] : []),
  ].join("\n");
}

async function removeRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: [], flags: [] }, "route remove");
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("remove")}\nRun \`clausona route remove --help\` for usage.`);
  const name = routeNameArg(nameArg, "remove");
  let rules: RuleRef[] = [];
  await changeRoutes(deps, (file) => {
    if (!Object.hasOwn(file.routes, name)) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    delete file.routes[name];
    // A rule that names it would only be skipped from now on.
    rules = removeReferences(file, name);
    return file;
  });
  return [
    success(`Removed route ${bold(name)}`),
    ...(rules.length ? [dim(`    Also removed ${andList(rulesText(rules))}.`)] : []),
  ].join("\n");
}

/** `a`, `a and b`, `a, b and c`. */
function andList(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ─── Dir rules and defaults ────────────────────────────────────────

/** The rules as the tables show them: each slot's route, and whether it can be used there. */
function ruleRows({ file, broken }: LoadedRoutes, rules: RouteRules): RuleRow[] {
  const slots = (read: Slots): RuleRow["slots"] =>
    Object.fromEntries(
      SLOT_TOOLS.flatMap((tool) => {
        const slot = read[tool];
        if (!slot) return [];
        if ("problem" in slot) return [[tool, { route: "?", usable: false }]];
        return [[tool, { route: slot.route, usable: routeProblem(file, broken, tool, slot.route) === null }]];
      }),
    );
  const rows: RuleRow[] = rules.dirs.map((rule) => ({ label: rule.dir, slots: slots(rule.slots) }));
  if (Object.keys(rules.defaults).length)
    rows.push({ label: "default", isDefault: true, slots: slots(rules.defaults) });
  return rows;
}

/** What is wrong with the rules: entries that cannot be read, then slots whose route cannot be used. */
const ruleNotes = ({ file, broken }: LoadedRoutes, rules: RouteRules) => [
  ...rules.problems,
  ...ruleWarnings(file, broken, rules),
];

/** `route dir` and `route default` with nothing after them: every rule. */
async function listRules(deps: RouteDeps): Promise<string> {
  const loaded = await loadRoutes(deps.paths, namesOf(await deps.loadRegistry()));
  const rules = readRules(loaded.file);
  return renderRules(ruleRows(loaded, rules), ruleNotes(loaded, rules));
}

/**
 * The tools a rule for the route `name` fills: a one-tool route's own, or on an `all` route the one
 * `--tool` names, both without it.
 */
function slotTools(name: string, routeTool: RouteTool, tool: RouteTool | undefined): ToolName[] {
  if (routeTool === "all") return tool === undefined || tool === "all" ? [...SLOT_TOOLS] : [tool];
  if (tool === "all") throw new Error(`Route '${name}' is for ${routeTool} only, so it cannot fill both tools.`);
  if (tool !== undefined && tool !== routeTool) throw new Error(`Route '${name}' is for ${routeTool}, not ${tool}.`);
  return [routeTool];
}

/** The route a rule is about to name: there, and usable. */
async function routeForRule(name: string, deps: RouteDeps, names: ProfileNames): Promise<RouteSpec> {
  const { file } = await routesFor(name, deps.paths, names);
  const spec = storedRoute(file, name);
  if (!spec) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
  return spec;
}

/** `clausona run claude uses`, or both runs for an `all` route that fills both slots. */
const runsUse = (tools: readonly ToolName[]) =>
  tools.length === 1
    ? `clausona run ${tools[0]} uses`
    : `${tools.map((tool) => `clausona run ${tool}`).join(" and ")} use`;

async function dirRule(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: ["--tool"], flags: ["--clear"] }, "route dir");
  const tool = asUsage(() => parseRouteTool(read.values.get("--tool")));
  const clear = read.flags.has("--clear");
  const [dirArg, routeArg, ...extra] = read.positionals;
  if (dirArg === undefined && !clear && tool === undefined) return listRules(deps);
  if (dirArg === undefined || extra.length || (clear ? routeArg !== undefined : routeArg === undefined)) {
    throw new RouteUsageError(`${usage("dir")}\nRun \`clausona route dir --help\` for usage.`);
  }
  // A key typed where the directory goes is neither written to routes.json nor said back.
  if (carriesCredentialToken(dirArg)) throw new RouteUsageError("That looks like an API key, not a directory.");
  const sys = pathsFor(deps);
  const dir = storedDir(dirArg, deps.cwd, sys);
  // However routes.json spells the directory: `~/work`, the same path in full, or through a link.
  const isDir = (stored: string) => sameDir(stored, dir, deps.cwd, sys);
  if (clear) {
    const tools = tool === undefined || tool === "all" ? undefined : [tool];
    const what = tools ? `${tools[0]} rule` : "dir rule";
    let cleared: string[] = [];
    await changeRoutes(deps, (file) => {
      cleared = clearDirRoute(file, tools, isDir);
      return cleared.length ? file : null;
    });
    if (cleared.length === 0) return success(dim(`No ${what} for ${dir}. Nothing was changed.`));
    return success(`Cleared the ${what} for ${bold(dir)}`);
  }
  const name = routeNameArg(routeArg, "dir");
  const spec = await routeForRule(name, deps, namesOf(await deps.loadRegistry()));
  const tools = asUsage(() => slotTools(name, spec.tool, tool));
  await changeRoutes(deps, (file) => {
    if (!Object.hasOwn(file.routes, name)) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    setDirRoute(file, dir, tools, name, isDir);
    return file;
  });
  const lines = [success(`In ${bold(dir)} and below, ${runsUse(tools)} route ${bold(name)}`)];
  // Kept all the same: the directory may be made later, or be a mount that is not there now.
  if (!existsSync(expandDir(dir, deps.cwd, sys))) {
    lines.push(`  ${warnIcon} ${dir} does not exist yet. The rule holds once it does.`);
  }
  return lines.join("\n");
}

async function defaultRule(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: ["--tool"], flags: ["--clear"] }, "route default");
  const tool = asUsage(() => parseRouteTool(read.values.get("--tool")));
  const clear = read.flags.has("--clear");
  const [routeArg, ...extra] = read.positionals;
  if (routeArg === undefined && !clear && tool === undefined) return listRules(deps);
  if (extra.length || (clear ? routeArg !== undefined : routeArg === undefined)) {
    throw new RouteUsageError(`${usage("default")}\nRun \`clausona route default --help\` for usage.`);
  }
  if (clear) {
    if (tool === undefined) {
      throw new RouteUsageError(
        "Name the tool whose default to clear: clausona route default --clear --tool claude (or codex, or all).",
      );
    }
    const tools = tool === "all" ? [...SLOT_TOOLS] : [tool];
    let cleared: ToolName[] = [];
    await changeRoutes(deps, (file) => {
      cleared = clearDefaultRoute(file, tools);
      return cleared.length ? file : null;
    });
    if (cleared.length === 0) return success(dim(`No ${tools.join(" or ")} default. Nothing was changed.`));
    return success(`Cleared the ${cleared.join(" and ")} default`);
  }
  const name = routeNameArg(routeArg, "default");
  const spec = await routeForRule(name, deps, namesOf(await deps.loadRegistry()));
  const tools = asUsage(() => slotTools(name, spec.tool, tool));
  await changeRoutes(deps, (file) => {
    if (!Object.hasOwn(file.routes, name)) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    setDefaultRoute(file, tools, name);
    return file;
  });
  return success(`Outside every dir rule, ${runsUse(tools)} route ${bold(name)}`);
}

/**
 * `route edit`: routes.json as it is on disk (an invalid one too, so it can be fixed), or an
 * empty file when there is none. Saved only once it checks out, and only if routes.json is still
 * what the edit started from.
 */
async function editRoutes(args: string[], io: RouteIo, deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: [], flags: [] }, "route edit");
  if (read.positionals.length) throw new Error(`${usage("edit")}\nRun \`clausona route edit --help\` for usage.`);
  const original = await readRoutesText(deps.paths);
  const names = namesOf(await deps.loadRegistry());
  const opened = original ?? `${JSON.stringify(emptyRoutesFile(), null, 2)}\n`;
  let text = opened;
  for (;;) {
    text = await deps.editText(text, "routes.json");
    try {
      parseRoutesText(text, deps.paths.routesPath, names);
      break;
    } catch (error) {
      if (!(error instanceof RoutesFileError) || !io.interactive) throw error;
      io.say(error.message);
      const again = await io.ask("Edit again? (Y/n) ");
      if (again === null || !["", "y", "yes"].includes(again.toLowerCase())) return "Nothing was changed.";
    }
  }
  // Saving the empty file unchanged, with no routes.json yet, creates nothing.
  if (text === opened) return "Nothing was changed.";
  await replaceRoutesText(original, text, deps.paths);
  return success(`Saved ${deps.paths.routesPath}`);
}

/** The routes routes.json holds that cannot be used, as warnings: each problem, then the way out. */
function brokenWarnings(broken: BrokenRoute[]): string[] {
  return broken.length ? [...broken.flatMap((route) => route.problems), brokenRoutesHint(broken)] : [];
}

/**
 * Every route ranked as `route explain` ranks it, recording nothing, from one quota read for the
 * members of all of them: a route that shares accounts with another does not read them twice.
 * Without `readQuota` nothing is read, and the rankings say only who the members are.
 */
async function rankEvery(routes: Route[], registry: Registry, deps: RouteDeps, readQuota: boolean): Promise<Ranking[]> {
  const targets = new Map<string, QuotaTarget>();
  for (const route of routes) {
    for (const target of quotaTargets(route, membersOf(registry, route.tool), false)) targets.set(target.id, target);
  }
  const quotas = readQuota ? await deps.collectQuotas([...targets.values()]) : {};
  const read: RouteDeps = { ...deps, loadRegistry: async () => registry, collectQuotas: async () => quotas };
  return Promise.all(routes.map((route) => rankRouteNow({ route }, read, { resume: false, record: false })));
}

/** What `route list` warns about one route, from its ranking: names and patterns that take nobody. */
function routeWarnings(name: string, ranking: Ranking): string[] {
  return [
    ...ranking.rows
      .filter((row) => row.skip === "not-registered")
      .map((row) => `${name} names '${row.pattern}', which is not a registered profile.`),
    ...ranking.emptyPatterns.map((pattern) => `${name}: '${pattern}' matches nobody.`),
    ...ranking.emptyExcludes.map((pattern) => `${name}: exclude '${pattern}' matches nobody.`),
  ];
}

/**
 * What `clausona doctor` says about routes.json: what `route list` warns about, with no quota
 * read. A routes.json that cannot be read at all is one warning; none at all is nothing.
 */
export async function routeDoctor(
  deps: RouteDeps = defaultRouteDeps(),
): Promise<{ shown: string; warnings: string[] }> {
  const shown = deps.paths.routesPath.replace(deps.home, "~");
  const registry = await deps.loadRegistry();
  let loaded: LoadedRoutes;
  try {
    loaded = await loadRoutes(deps.paths, namesOf(registry));
  } catch (error) {
    if (!(error instanceof RoutesFileError)) {
      return { shown, warnings: [`It cannot be read: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const fix = error.newer ? "" : " Fix it with clausona route edit.";
    return { shown, warnings: [`It cannot be used: ${error.problems.join("; ")}.${fix}`] };
  }
  const names = Object.keys(loaded.file.routes).sort();
  const routes = names.map((name) => withDefaults(loaded.file.routes[name]));
  const rankings = registry ? await rankEvery(routes, registry, deps, false) : undefined;
  return { shown, warnings: listWarnings(loaded, names, rankings, readRules(loaded.file)) };
}

/**
 * What `route list` warns about under its tables: routes that cannot be used, names and patterns
 * of the others that take nobody (`rankings`, theirs in `names` order; none before init), then
 * the rules.
 */
function listWarnings(
  loaded: LoadedRoutes,
  names: string[],
  rankings: Ranking[] | undefined,
  rules: RouteRules,
): string[] {
  return [
    ...brokenWarnings(loaded.broken),
    ...(rankings ? names.flatMap((name, i) => routeWarnings(name, rankings[i])) : []),
    ...ruleNotes(loaded, rules),
  ];
}

async function listRoutes(args: string[], deps: RouteDeps): Promise<string> {
  const read = readArgs(args, { values: [], flags: ["--json", "--no-quota"] }, "route list");
  if (read.positionals.length) {
    throw new RouteUsageError(`${usage("list")}\nRun \`clausona route list --help\` for usage.`);
  }
  const registry = await deps.loadRegistry();
  const loaded = await loadRoutes(deps.paths, namesOf(registry));
  const { file, broken } = loaded;
  const rules = readRules(file);
  const names = Object.keys(file.routes).sort();
  const routes = names.map((name) => withDefaults(file.routes[name]));
  const readQuota = !read.flags.has("--no-quota");
  // Ranked as a run ranks, so a route's members are the accounts a run would consider. Without a
  // registry nobody is registered yet, so nothing is ranked and no name is called unknown.
  const rankings = registry ? await rankEvery(routes, registry, deps, readQuota) : undefined;
  // Each problem as it is worded, for the routes left out: their names can be anything.
  const problems = broken.flatMap((route) => route.problems);
  if (read.flags.has("--json")) {
    const entries = names.map((name, i) => routeListJson(name, routes[i], rankings?.[i], readQuota));
    return JSON.stringify(
      {
        routes: entries,
        problems: [...problems, ...rules.problems],
        ...rulesJson(rules),
        ruleWarnings: ruleWarnings(file, broken, rules),
      },
      null,
      2,
    );
  }
  // With --no-quota nothing was read, and the table says so with a dash.
  return renderRouteTable(
    names.map((name, i) => ({ name, route: routes[i], ...(rankings && readQuota ? { ranking: rankings[i] } : {}) })),
    listWarnings(loaded, names, rankings, rules),
    { now: deps.clock(), rules: ruleRows(loaded, rules) },
  );
}

type RankingArgs = {
  name?: string;
  overrides: RouteOverrides;
  tool?: RouteTool;
  json: boolean;
  resume: boolean;
};

function readRankingArgs(sub: "explain" | "pick", args: string[]): RankingArgs {
  return asUsage(() => {
    const read = readOptions(
      args,
      { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--json", "--resume"] },
      `route ${sub}`,
    );
    const [name, ...extra] = read.positionals;
    if (extra.length) throw new Error(`${usage(sub)}\nRun \`clausona route ${sub} --help\` for usage.`);
    return {
      name,
      overrides: toRoutingOptions(read.values),
      tool: parseRouteTool(read.values.get("--tool")),
      json: read.flags.has("--json"),
      resume: read.flags.has("--resume"),
    };
  });
}

async function resolveForRanking(sub: "explain" | "pick", ranking: RankingArgs, deps: RouteDeps) {
  const { name, overrides, tool } = ranking;
  const names = namesOf(await deps.loadRegistry());
  const loaded = await routesFor(name, deps.paths, names);
  // A bad name or option value is bad usage; a route that does not exist is not.
  const resolved = asUsage(() =>
    resolveRoute(loaded.file, { tool, options: { ...overrides, ...(name ? { route: name } : {}) } }, names),
  );
  if (!resolved) {
    throw new RouteUsageError(
      `Name a route: clausona route ${sub} <name>, or an unsaved one: clausona route ${sub} --tool claude --from '<patterns>'.`,
    );
  }
  return { resolved, loaded };
}

async function explainRoute(args: string[], deps: RouteDeps): Promise<string> {
  const parsed = readRankingArgs("explain", args);
  // Neither a route nor an unsaved one: what a run would take here, by the dir rules and defaults.
  if (parsed.name === undefined && Object.keys(parsed.overrides).length === 0) return explainHere(parsed, deps);
  const { overrides, json, resume } = parsed;
  const { resolved, loaded } = await resolveForRanking("explain", parsed, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: false });
  if (json) return JSON.stringify(explainJson(resolved.name, resolved.resolvedBy, ranking), null, 2);
  const rules = readRules(loaded.file);
  return renderRouteDetail(resolved.name, ranking, {
    now: deps.clock(),
    onlyTool: resolved.onlyTool,
    overrides,
    warnings: [...brokenWarnings(loaded.broken), ...ruleNotes(loaded, rules)],
  });
}

/**
 * `route explain` with no name: what `clausona run claude` and `clausona run codex` would each do
 * in the current directory (one of them with --tool), which rule says so, and the explain of each
 * route a run would take. Nothing is recorded.
 */
async function explainHere({ tool, json, resume }: RankingArgs, deps: RouteDeps): Promise<string> {
  const registry = await registryOrThrow(deps);
  const names = namesOf(registry);
  const loaded = await loadRoutes(deps.paths, names);
  const sys = pathsFor(deps);
  const tools: ToolName[] = tool === undefined || tool === "all" ? [...SLOT_TOOLS] : [tool];
  const found = [];
  for (const each of tools) {
    const { resolved, skipped } = routeByRules(loaded, each, deps.cwd, sys, names);
    const ranking = resolved ? await rankRouteNow(resolved, deps, { resume, record: false }) : undefined;
    found.push({ tool: each, resolved, ranking, skipped });
  }
  const active = (each: ToolName) => {
    const id = registry.activeProfiles[each];
    return id && registry.profiles[id] ? id : null;
  };
  if (json) {
    const runs = found.map(({ tool: each, resolved, ranking, skipped }) =>
      runHereJson(
        each,
        resolved && ranking
          ? { name: resolved.name, resolvedBy: resolved.resolvedBy, ranking }
          : { active: active(each) },
        skipped,
      ),
    );
    return JSON.stringify({ directory: deps.cwd, runs }, null, 2);
  }
  const runs = found.map(({ tool: each, resolved }): RunHere => {
    if (!resolved) {
      const id = active(each);
      return id
        ? { tool: each, uses: id, because: "active profile (no route)", routed: false }
        : { tool: each, uses: "nothing", because: "no active profile (clausona use)", routed: false };
    }
    const because = resolved.resolvedBy.startsWith("dir:")
      ? `dir rule ${resolved.resolvedBy.slice("dir:".length)}`
      : `the ${each} default`;
    return { tool: each, uses: `route ${resolved.name}`, because, routed: true };
  });
  const details = found.flatMap(({ resolved, ranking }) =>
    resolved && ranking
      ? [renderRouteDetail(resolved.name, ranking, { now: deps.clock(), onlyTool: resolved.onlyTool })]
      : [],
  );
  return renderRunsHere(storedDir(deps.cwd, deps.cwd, sys), runs, details, {
    warnings: [
      ...found.flatMap(({ skipped }) => skipped.map(skippedText)),
      ...brokenWarnings(loaded.broken),
      // Not in `skipped`: a rule whose directory cannot be read never matches, here or anywhere.
      ...readRules(loaded.file, sys.platform).problems,
    ],
  });
}

async function pickRoute(args: string[], deps: RouteDeps): Promise<string> {
  const parsed = readRankingArgs("pick", args);
  const { overrides, json, resume } = parsed;
  const { resolved } = await resolveForRanking("pick", parsed, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: true });
  if (ranking.outcome.kind === "none") {
    throw new NoAccountError(
      renderNoAccount(resolved.name, ranking, { now: deps.clock(), onlyTool: resolved.onlyTool, overrides, resume }),
      json ? JSON.stringify(pickJson(resolved.name, ranking), null, 2) : undefined,
    );
  }
  return json ? JSON.stringify(pickJson(resolved.name, ranking), null, 2) : ranking.outcome.id;
}

/**
 * What `--json` calls a failure (withJsonErrors, which the Extensions commands use): bad usage
 * `usage`, an unknown route `not-found`, and a routes.json or route that cannot be used `failed`,
 * with the file and its problems. Exit 75 keeps the JSON `pick` prints; each keeps its exit code.
 * Anything else is `failed`.
 */
function asJsonError(error: unknown): unknown {
  if (error instanceof NoAccountError) return new ExitError(error.message, error.exitCode, error.stdout, "failed");
  if (error instanceof RouteUsageError) return new ExitError(error.message, 1, undefined, "usage");
  if (error instanceof UnknownRouteError) return new ExitError(error.message, 1, undefined, "not-found");
  if (error instanceof RoutesFileError) {
    return new ExitError(error.message, 1, undefined, "failed", { file: error.filePath, problems: error.problems });
  }
  return error;
}

/**
 * `clausona route …`. Reads its own subcommand, options and --help. With --json, whatever way it
 * fails is one JSON object on stdout, as the Extensions commands' failures are.
 */
export async function runRouteCommand(
  args: string[],
  io: RouteIo = terminalIo(process.stdout),
  deps: RouteDeps = defaultRouteDeps(),
): Promise<string> {
  if (!args.includes("--json")) return routeCommand(args, io, deps);
  return withJsonErrors(args, () =>
    routeCommand(args, io, deps).catch((error: unknown) => {
      throw asJsonError(error);
    }),
  );
}

async function routeCommand(args: string[], io: RouteIo, deps: RouteDeps): Promise<string> {
  const [sub, ...rest] = args;
  // In a terminal, bare `route` opens the dashboard's Routes screen (index.tsx renders it).
  if (!sub) return io.interactive ? "__OPEN_TUI__:routes" : routeHelp();
  if (sub === "--help" || sub === "-h" || sub === "help") return routeHelp();
  if (rest.includes("--help") || rest.includes("-h")) return routeHelp(sub);
  switch (sub) {
    case "list":
      return listRoutes(rest, deps);
    case "add":
      return addRoute(rest, deps);
    case "set":
      return setRoute(rest, deps);
    case "rename":
      return renameRoute(rest, deps);
    case "remove":
      return removeRoute(rest, deps);
    case "edit":
      return editRoutes(rest, io, deps);
    case "explain":
      return explainRoute(rest, deps);
    case "pick":
      return pickRoute(rest, deps);
    case "dir":
      return dirRule(rest, deps);
    case "default":
      return defaultRule(rest, deps);
    default:
      // Not quoted back when it holds something key-shaped, as a route name or a pattern is not.
      if (holdsKey(sub)) throw new RouteUsageError("Unknown route command. Run `clausona route --help` for the list.");
      throw new RouteUsageError(`Unknown route command '${sub}'. Run \`clausona route --help\` for the list.`);
  }
}
