import { carriesCredentialToken, looksLikeCredential } from "./core/credential-token.js";
import {
  applyOverrides,
  checkPattern,
  checkRoute,
  checkRouteName,
  DEFAULT_RESERVE_USAGE,
  emptyRoutesFile,
  newRouteSpec,
  type RouteSpec,
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
import { accent, bold, dim, helpSection, helpUsage, stripAnsi, success } from "./lib/cli-style.js";
import { askTool, confirmNewRoute, type RouteIo, terminalIo } from "./lib/route-create.js";
import {
  describeSpec,
  explainJson,
  pickJson,
  type RouteListEntry,
  renderExplain,
  renderNoAccount,
  renderRouteList,
} from "./lib/route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  membersOf,
  NoAccountError,
  onlyTool,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  UnknownRouteError,
} from "./lib/route-service.js";
import { parsePatterns, parseTool, ROUTE_FIELD_OPTIONS, readOptions, toRoutingOptions } from "./lib/run-args.js";
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
  ["--reserve-usage <n>", "Reserve stage up to n% (default: 95)"],
  ["--fallback <patterns>", "Tried in order when the pool has nobody under the cut"],
];

const SUB_HELP: Record<string, string[]> = {
  list: [
    helpUsage("clausona route list [--json]"),
    "",
    `    ${dim("Every route with its settings and members. Warns about names that are not")}`,
    `    ${dim("registered (removed profiles) and patterns that match nobody.")}`,
  ],
  add: [
    helpUsage("clausona route add <name> [--tool claude|codex] [options] [--yes]"),
    "",
    helpSection("OPTIONS", [
      ["--tool <tool>", "claude or codex; needed only when both have accounts"],
      ...FIELD_HELP,
      ["--yes, -y", "Do not ask in a terminal (never asks without one)"],
    ]),
    "",
    `  ${bold("EXAMPLES")}`,
    `    ${dim("clausona route add main                                   # every account, round-robin")}`,
    `    ${dim("clausona route add work --from '*@example.com' --exclude '*-share'")}`,
    `    ${dim("clausona route add solo --from work --fallback personal --strategy headroom")}`,
  ],
  set: [
    helpUsage("clausona route set <name> [options] [--add <patterns>] [--drop <patterns>] [--no-fallback]"),
    "",
    helpSection("OPTIONS", [
      ...FIELD_HELP,
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
    helpUsage("clausona route explain <name> [options] [--resume] [--json]"),
    helpUsage("clausona route explain --tool claude --from <patterns> [--json]"),
    "",
    `    ${dim("Every member with its 5H and 7D use, its usage (the higher of the two), when it was")}`,
    `    ${dim("last picked, and why it would or would not be picked now. Launches nothing and")}`,
    `    ${dim("records nothing. --resume ranks as a resumed run would (shared sessions only).")}`,
  ],
  pick: [
    helpUsage("clausona route pick <name> [options] [--resume] [--json]"),
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
  if (sub && SUB_HELP[sub]) {
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
      ["list", "Show routes, their members, and names that match nobody"],
      ["add <name>", "Create a route (every subscription, round-robin, max 80%, reserve 95%)"],
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
    "",
    `  ${bold("HOW A PROFILE IS PICKED")}`,
    `    ${dim("usage = the higher of the account's 5H and 7D windows")}`,
    `    ${dim("1. pool      from-members under max-usage, by strategy")}`,
    `    ${dim("2. fallback  fallback-members under max-usage, first in listed order")}`,
    `    ${dim("3. reserve   any member under reserve-usage, lowest usage first")}`,
    `    ${dim("4. nobody    exit 75")}`,
    `    ${dim("round-robin: picked longest ago · headroom: lowest usage ·")}`,
    `    ${dim("expiring: weekly limit resetting within 24h first")}`,
    `    ${dim("Resumed runs (-c, --resume, codex resume) use only accounts that share sessions.")}`,
    "",
    `  ${bold("PATTERNS")} ${dim("(--from, --exclude, --fallback; comma-separated, quoted in the shell)")}`,
    `    ${dim("*               every subscription profile of the route's tool")}`,
    `    ${dim("team-*          profile names; a tool prefix works too: claude:team-*")}`,
    `    ${dim("*@example.com   account emails: any pattern with an @")}`,
    `    ${dim("API profiles never match a pattern; routes take subscription profiles only for now.")}`,
    "",
    `  ${bold("FOR AGENTS")}`,
    `    ${dim("clausona route explain <name> --json   every member, its usage, and why it is or is not picked")}`,
    `    ${dim("clausona route pick <name> --json      take a turn; call it once per worker you start")}`,
    `    ${dim("clausona run <profile> [--] ...        launch on the picked profile")}`,
    `    ${dim("Create and change routes with add / set / remove, not by editing routes.json.")}`,
    `    ${dim("Before creating or changing a route for the user, show them its members (explain).")}`,
    "",
    `  ${bold("EXIT CODES")}`,
    `    ${dim("the tool's own   run launched the tool")}`,
    `    ${dim("1                usage error, or routes.json cannot be used")}`,
    `    ${dim("75               no account is available now: retry later, or name a profile")}`,
    "",
    `  ${dim("Run clausona route <command> --help for each command. Docs: docs/routing.md")}`,
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

/** Writes a new route, refusing a name someone created meanwhile. */
export async function createRoute(name: string, spec: RouteSpec, deps: RouteDeps): Promise<void> {
  await updateRoutes((file) => {
    if (file.routes[name])
      throw new Error(`Route '${name}' already exists. Change it with clausona route set ${name} …`);
    file.routes[name] = spec;
    return file;
  }, deps.paths);
}

async function addRoute(args: string[], io: RouteIo, deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--yes", "-y"] }, "route add");
  const [nameArg, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage("add")}\nRun \`clausona route add --help\` for usage.`);
  const name = routeNameArg(nameArg, "add");
  const options = toRoutingOptions(read.values);
  const registry = await registryOrThrow(deps);
  if ((await readRoutes(deps.paths)).routes[name]) {
    throw new Error(`Route '${name}' already exists. Change it with clausona route set ${name} …`);
  }
  const prefixed = (options.from ?? []).map((pattern) => /^(claude|codex):/.exec(pattern)?.[1]);
  const fromPrefix =
    prefixed.length > 0 && prefixed.every((tool) => tool && tool === prefixed[0]) ? prefixed[0] : undefined;
  const tool =
    parseTool(read.values.get("--tool")) ??
    (fromPrefix as "claude" | "codex" | undefined) ??
    onlyTool(registry) ??
    (io.interactive ? await askTool(io) : undefined);
  if (!tool) {
    const why = Object.values(registry.profiles).some((profile) => profile.kind !== "api")
      ? "there are accounts for both"
      : "no subscription account is registered yet";
    throw new Error(`Pass --tool claude or --tool codex: ${why}.`);
  }

  let spec = applyOverrides(newRouteSpec(tool), options);
  if (spec.reserveUsage === undefined) spec.reserveUsage = Math.max(DEFAULT_RESERVE_USAGE, spec.maxUsage ?? 0);
  checkRouteMembers(name, spec, registry);

  if (io.interactive && !read.flags.has("--yes") && !read.flags.has("-y")) {
    const confirmed = await confirmNewRoute(
      name,
      spec,
      io,
      (candidate) => rankRouteNow({ route: withDefaults(candidate) }, deps, { resume: false, record: false }),
      false,
    );
    if (!confirmed) return "Nothing was created.";
    checkRouteMembers(name, confirmed, registry);
    spec = confirmed;
  }
  await createRoute(name, spec, deps);
  return [
    success(`Created route ${bold(name)} ${dim(`(${describeSpec(spec)})`)}`),
    dim(`    Run on it: clausona run --route ${name}    See the ranking: clausona route explain ${name}`),
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
      "Nothing to change. Pass at least one of --from, --add, --drop, --exclude, --strategy, --max-usage, --reserve-usage, --fallback, --no-fallback.",
    );
  }
  const registry = await registryOrThrow(deps);
  let changed: RouteSpec | undefined;
  await updateRoutes((file) => {
    const current = file.routes[name];
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
    }
    if (noFallback) delete next.fallback;
    checkRouteMembers(name, next, registry);
    file.routes[name] = next;
    changed = next;
    return file;
  }, deps.paths);
  return success(`Updated route ${bold(name)} ${dim(`(${describeSpec(changed as RouteSpec)})`)}`);
}

async function renameRoute(args: string[], deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: [] }, "route rename");
  const [oldArg, newArg, ...extra] = read.positionals;
  if (!oldArg || !newArg || extra.length)
    throw new Error(`${usage("rename")}\nRun \`clausona route rename --help\` for usage.`);
  const from = routeNameArg(oldArg, "rename");
  const to = routeNameArg(newArg, "rename");
  await updateRoutes((file) => {
    const spec = file.routes[from];
    if (!spec) throw new UnknownRouteError(from, Object.keys(file.routes).sort());
    if (file.routes[to]) throw new Error(`Route '${to}' already exists.`);
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
    if (!file.routes[name]) throw new UnknownRouteError(name, Object.keys(file.routes).sort());
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

async function listRoutes(args: string[], deps: RouteDeps): Promise<string> {
  const read = readOptions(args, { values: [], flags: ["--json"] }, "route list");
  if (read.positionals.length) throw new Error(`${usage("list")}\nRun \`clausona route list --help\` for usage.`);
  const file = await readRoutes(deps.paths);
  const registry = await deps.loadRegistry();
  const entries: RouteListEntry[] = Object.keys(file.routes)
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
  if (entries.length === 0) {
    return "No routes yet. Create one: clausona route add <name>   (every subscription account, round-robin, max 80%, reserve 95%)";
  }
  return renderRouteList(entries);
}

async function resolveForRanking(sub: "explain" | "pick", args: string[], deps: RouteDeps) {
  const read = readOptions(
    args,
    { values: ["--tool", ...ROUTE_FIELD_OPTIONS], flags: ["--json", "--resume"] },
    `route ${sub}`,
  );
  const [name, ...extra] = read.positionals;
  if (extra.length) throw new Error(`${usage(sub)}\nRun \`clausona route ${sub} --help\` for usage.`);
  const options = { ...toRoutingOptions(read.values), ...(name ? { route: name } : {}) };
  const resolved = resolveRoute(await readRoutes(deps.paths), { tool: parseTool(read.values.get("--tool")), options });
  if (!resolved) {
    throw new Error(
      `Name a route: clausona route ${sub} <name>, or an unsaved one: clausona route ${sub} --tool claude --from '<patterns>'.`,
    );
  }
  return { resolved, json: read.flags.has("--json"), resume: read.flags.has("--resume") };
}

async function explainRoute(args: string[], deps: RouteDeps): Promise<string> {
  const { resolved, json, resume } = await resolveForRanking("explain", args, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: false });
  return json
    ? JSON.stringify(explainJson(resolved.name, resolved.resolvedBy, ranking), null, 2)
    : renderExplain(resolved.name, ranking, deps.clock());
}

async function pickRoute(args: string[], deps: RouteDeps): Promise<string> {
  const { resolved, json, resume } = await resolveForRanking("pick", args, deps);
  const ranking = await rankRouteNow(resolved, deps, { resume, record: true });
  if (ranking.outcome.kind === "none") {
    throw new NoAccountError(
      renderNoAccount(resolved.name, ranking, deps.clock()),
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
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return routeHelp();
  if (rest.includes("--help") || rest.includes("-h")) return routeHelp(sub);
  switch (sub) {
    case "list":
      return listRoutes(rest, deps);
    case "add":
      return addRoute(rest, io, deps);
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
      if (looksLikeCredential(sub) || carriesCredentialToken(sub))
        throw new Error("That is not a route command. Run `clausona route --help` for the list.");
      throw new Error(`Unknown route command '${sub}'. Run \`clausona route --help\` for the list.`);
  }
}
