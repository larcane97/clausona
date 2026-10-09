import type { QuotaTarget } from "./core/quota-store.js";
import {
  applyOverrides,
  checkPattern,
  checkRoute,
  checkRouteName,
  emptyRoutesFile,
  holdsKey,
  newRouteSpec,
  type Route,
  type RouteOverrides,
  type RouteSpec,
  type RouteTool,
  storedRoute,
  withDefaults,
} from "./core/route-config.js";
import { expandPatterns } from "./core/route-patterns.js";
import {
  parseRoutesText,
  RoutesFileError,
  readRoutes,
  readRoutesText,
  replaceRoutesText,
  updateRoutes,
} from "./core/routes-store.js";
import type { Ranking } from "./core/routing.js";
import { accent, bold, dim, helpSection, helpUsage, stripAnsi, success } from "./lib/cli-style.js";
import { type RouteIo, terminalIo } from "./lib/route-io.js";
import {
  explainJson,
  nobodyAdvice,
  pickJson,
  renderNoAccount,
  renderRouteDetail,
  renderRoutesEmpty,
  renderRouteTable,
  takesNobody,
} from "./lib/route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  inferRouteTool,
  membersOf,
  NoAccountError,
  otherToolTaking,
  quotaTargets,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  UnknownRouteError,
} from "./lib/route-service.js";
import { parsePatterns, parseRouteTool, ROUTE_FIELD_OPTIONS, readOptions, toRoutingOptions } from "./lib/run-args.js";
import { noRegistryError } from "./lib/service.js";
import type { Registry } from "./types.js";

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
    `    ${dim("Warns about names that are not registered (removed profiles) and patterns that match nobody.")}`,
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
    `    ${dim("clausona route add solo --from work --fallback personal --strategy headroom")}`,
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
    "",
    `    ${dim("Every member with its 5H and 7D use, its usage (the higher of the two), when it was")}`,
    `    ${dim("last picked, and why it would or would not be picked now. Launches nothing and")}`,
    `    ${dim("records nothing. --resume ranks as a resumed run would (shared sessions only).")}`,
    `    ${dim("On an all route, --tool ranks only that tool's accounts, as a run naming it would.")}`,
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
      ["explain <name>", "Show the ranking without launching anything"],
      ["pick <name>", "Take a turn: print the picked profile and record it"],
    ]),
    "",
    `  ${bold("RUN ON A ROUTE")}`,
    helpUsage("clausona run --route <name> [--] [tool args...]"),
    helpUsage("clausona run claude --from 'team-*' [--] [tool args...]     # an unsaved route"),
    `    ${dim("On a route over both tools (--tool all), name the tool before its arguments:")}`,
    `    ${dim("clausona run codex --route any -- exec 'review this'")}`,
    "",
    `  ${bold("HOW A PROFILE IS PICKED")}`,
    `    ${dim("usage = the higher of the account's 5H and 7D windows")}`,
    `    ${dim("1. pool      from-members under max-usage, by strategy")}`,
    `    ${dim("2. fallback  fallback-members under max-usage, first in listed order")}`,
    `    ${dim("3. reserve   any member under 100%, lowest usage first")}`,
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
    `    ${dim("clausona run <profile> [--] ...          launch on the picked profile")}`,
    `    ${dim("add and set never ask; run asks one Y/n only for an unknown route in a terminal.")}`,
    `    ${dim("Create and change routes with add / set / remove, not by editing routes.json.")}`,
    `    ${dim("Before creating or changing a route for the user, show them its members (explain).")}`,
    "",
    `  ${bold("EXIT CODES")}`,
    `    ${dim("the tool's own   run launched the tool")}`,
    `    ${dim("1                usage error, or routes.json cannot be used")}`,
    `    ${dim("75               no account is available now: retry later, or name a profile")}`,
    "",
    `  ${dim("Run clausona route <command> --help for each command.")}`,
    `  ${dim("Docs: https://github.com/larcane97/clausona/blob/main/docs/routing.md")}`,
    "",
  ].join("\n");
}

// ─── Subcommands ───────────────────────────────────────────────────

const usage = (sub: string) => `Usage: ${stripAnsi(SUB_HELP[sub]?.[0] ?? "").trim()}`;

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

/** Writes a new route, refusing a name someone created meanwhile. */
export async function createRoute(name: string, spec: RouteSpec, deps: RouteDeps): Promise<void> {
  await updateRoutes((file) => {
    if (storedRoute(file, name))
      throw new Error(`Route '${name}' already exists. Change it with clausona route set ${name} …`);
    file.routes[name] = spec;
    return file;
  }, deps.paths);
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
  const read = readOptions(args, { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--yes", "-y"] }, "route add");
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("add")}\nRun \`clausona route add --help\` for usage.`);
  const name = routeNameArg(nameArg, "add");
  const options = toRoutingOptions(read.values);
  const tool = parseRouteTool(read.values.get("--tool")) ?? inferRouteTool(options.from ?? []) ?? "claude";
  const registry = await registryOrThrow(deps);
  if (storedRoute(await readRoutes(deps.paths), name)) {
    throw new Error(`Route '${name}' already exists. Change it with clausona route set ${name} …`);
  }
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
  const read = readOptions(
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
  const written = await updateRoutes((file) => {
    const current = storedRoute(file, name);
    if (!current) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    const next = applyOverrides(current, options);
    if (add.length || drop.length) {
      const fold = (value: string) => value.normalize("NFKC").toLowerCase();
      const from = next.from ?? ["*"];
      // The message below quotes the from list and the dropped entry, so both are checked first:
      // a key given to --from or --drop is refused without being repeated.
      const problems = [
        ...checkRoute(name, next),
        ...drop.flatMap((entry) => {
          const problem = checkPattern(entry, next.tool);
          return problem ? [`--drop: ${problem}`] : [];
        }),
      ];
      if (problems.length) throw new Error(problems.join("\n"));
      for (const entry of drop) {
        if (!from.some((pattern) => fold(pattern) === fold(entry))) {
          throw new Error(
            `'${entry}' is not in ${name}'s from list (${from.join(", ")}). To leave an account out of a pattern, use --exclude ${entry}.`,
          );
        }
      }
      const kept = from.filter((pattern) => !drop.some((entry) => fold(entry) === fold(pattern)));
      next.from = [...kept, ...add.filter((entry) => !kept.some((pattern) => fold(pattern) === fold(entry)))];
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
  }, deps.paths);
  return [success(`Updated route ${bold(name)}`), await routeDetail(name, written.routes[name], deps)].join("\n");
}

async function renameRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: [] }, "route rename");
  const [oldArg, newArg, ...extra] = read.positionals;
  if (!oldArg || !newArg || extra.length)
    throw new Error(`${usage("rename")}\nRun \`clausona route rename --help\` for usage.`);
  const from = routeNameArg(oldArg, "rename");
  const to = routeNameArg(newArg, "rename");
  await updateRoutes((file) => {
    const spec = storedRoute(file, from);
    if (!spec) throw new UnknownRouteError(from, Object.keys(file.routes).sort());
    if (storedRoute(file, to)) throw new Error(`Route '${to}' already exists.`);
    delete file.routes[from];
    file.routes[to] = spec;
    return file;
  }, deps.paths);
  return success(`Renamed route ${bold(from)} to ${bold(to)}`);
}

async function removeRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: [] }, "route remove");
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("remove")}\nRun \`clausona route remove --help\` for usage.`);
  const name = routeNameArg(nameArg, "remove");
  await updateRoutes((file) => {
    if (!storedRoute(file, name)) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
    delete file.routes[name];
    return file;
  }, deps.paths);
  return success(`Removed route ${bold(name)}`);
}

/**
 * `route edit`: routes.json as it is on disk (an invalid one too, so it can be fixed), or an
 * empty file when there is none. Saved only once it checks out, and only if routes.json is still
 * what the edit started from.
 */
async function editRoutes(args: string[], io: RouteIo, deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: [] }, "route edit");
  if (read.positionals.length) throw new Error(`${usage("edit")}\nRun \`clausona route edit --help\` for usage.`);
  const original = await readRoutesText(deps.paths);
  const opened = original ?? `${JSON.stringify(emptyRoutesFile(), null, 2)}\n`;
  let text = opened;
  for (;;) {
    text = await deps.editText(text, "routes.json");
    try {
      parseRoutesText(text, deps.paths.routesPath);
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

/**
 * Every route ranked as `route explain` ranks it, recording nothing, from one quota read for the
 * members of all of them: a route that shares accounts with another does not read them twice.
 */
async function rankEvery(routes: Route[], registry: Registry, deps: RouteDeps): Promise<Ranking[]> {
  const targets = new Map<string, QuotaTarget>();
  for (const route of routes) {
    for (const target of quotaTargets(route, membersOf(registry, route.tool), false)) targets.set(target.id, target);
  }
  const quotas = await deps.collectQuotas([...targets.values()]);
  const read: RouteDeps = { ...deps, loadRegistry: async () => registry, collectQuotas: async () => quotas };
  return Promise.all(routes.map((route) => rankRouteNow({ route }, read, { resume: false, record: false })));
}

async function listRoutes(args: string[], deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: ["--json", "--no-quota"] }, "route list");
  if (read.positionals.length) throw new Error(`${usage("list")}\nRun \`clausona route list --help\` for usage.`);
  const file = await readRoutes(deps.paths);
  const registry = await deps.loadRegistry();
  const entries = Object.keys(file.routes)
    .sort()
    .map((name) => {
      const route = withDefaults(file.routes[name]);
      const members = registry ? membersOf(registry, route.tool) : [];
      const excluded = new Set(expandPatterns(route.exclude, members).members.map((entry) => entry.member.id));
      const pool = expandPatterns(route.from, members);
      const fallback = expandPatterns(route.fallback, members);
      const ids = (list: typeof pool.members) => list.map((entry) => entry.member.id).filter((id) => !excluded.has(id));
      return {
        name,
        route,
        members: ids(pool.members),
        fallbackMembers: ids(fallback.members),
        excluded: [...excluded],
        unknownNames: [...pool.unknownNames, ...fallback.unknownNames],
        emptyPatterns: [...pool.emptyPatterns, ...fallback.emptyPatterns],
      };
    });
  if (read.flags.has("--json")) return JSON.stringify({ routes: entries }, null, 2);
  if (entries.length === 0) return renderRoutesEmpty();
  const warnings = entries.flatMap((entry) => [
    ...entry.unknownNames.map((name) => `${entry.name} names '${name}', which is not a registered profile.`),
    ...entry.emptyPatterns.map((pattern) => `${entry.name}: '${pattern}' matches nobody.`),
  ]);
  // Without a registry there is nobody to rank; with --no-quota nothing is read, and the table says so.
  const routes = entries.map((entry) => entry.route);
  const rankings = registry && !read.flags.has("--no-quota") ? await rankEvery(routes, registry, deps) : undefined;
  return renderRouteTable(
    entries.map(({ name, route }, i) => ({ name, route, ...(rankings ? { ranking: rankings[i] } : {}) })),
    warnings,
    { now: deps.clock() },
  );
}

async function resolveForRanking(sub: "explain" | "pick", args: string[], deps: RouteDeps) {
  const read = readOptions(
    args,
    { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--json", "--resume"] },
    `route ${sub}`,
  );
  const [name, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage(sub)}\nRun \`clausona route ${sub} --help\` for usage.`);
  const overrides = toRoutingOptions(read.values);
  const resolved = resolveRoute(await readRoutes(deps.paths), {
    tool: parseRouteTool(read.values.get("--tool")),
    options: { ...overrides, ...(name ? { route: name } : {}) },
  });
  if (!resolved) {
    throw new Error(
      `Name a route: clausona route ${sub} <name>, or an unsaved one: clausona route ${sub} --tool claude --from '<patterns>'.`,
    );
  }
  return { resolved, overrides, json: read.flags.has("--json"), resume: read.flags.has("--resume") };
}

async function explainRoute(args: string[], deps: RouteDeps): Promise<string> {
  const { resolved, overrides, json, resume } = await resolveForRanking("explain", args, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: false });
  return json
    ? JSON.stringify(explainJson(resolved.name, resolved.resolvedBy, ranking), null, 2)
    : renderRouteDetail(resolved.name, ranking, { now: deps.clock(), onlyTool: resolved.onlyTool, overrides });
}

async function pickRoute(args: string[], deps: RouteDeps): Promise<string> {
  const { resolved, overrides, json, resume } = await resolveForRanking("pick", args, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: true });
  if (ranking.outcome.kind === "none") {
    throw new NoAccountError(
      renderNoAccount(resolved.name, ranking, { now: deps.clock(), onlyTool: resolved.onlyTool, overrides, resume }),
      json ? JSON.stringify(pickJson(resolved.name, ranking), null, 2) : undefined,
    );
  }
  return json ? JSON.stringify(pickJson(resolved.name, ranking), null, 2) : ranking.outcome.id;
}

/** `clausona route …`. Reads its own subcommand, options and --help. */
export async function runRouteCommand(
  args: string[],
  io: RouteIo = terminalIo(process.stdout),
  deps: RouteDeps = defaultRouteDeps(),
): Promise<string> {
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
    default:
      // Not quoted back when it holds something key-shaped, as a route name or a pattern is not.
      if (holdsKey(sub)) throw new Error("Unknown route command. Run `clausona route --help` for the list.");
      throw new Error(`Unknown route command '${sub}'. Run \`clausona route --help\` for the list.`);
  }
}
