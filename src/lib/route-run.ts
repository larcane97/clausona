import { readBudgets } from "../core/route-budgets.js";
import { holdsKey, type ProfileNames, type RouteTool, toolsOf, withDefaults } from "../core/route-config.js";
import { type LoadedRoutes, loadRoutes, RoutesFileError, refusalOf } from "../core/routes-store.js";
import { posixQuote } from "../core/shell.js";
import { createRoute, newRouteFrom } from "../route-commands.js";
import type { Registry, ToolName } from "../types.js";
import { accent, bold, dim } from "./cli-style.js";
import {
  CREDENTIAL_AS_NAME_ERROR,
  type ParsedProfileRef,
  parseProfileRef,
  validateProfileName,
} from "./profile-ref.js";
import { type RouteIo, terminalIo } from "./route-io.js";
import {
  renderNewRoutePreview,
  renderNoAccount,
  renderNote,
  renderNothingToCreate,
  renderRulesProblems,
  renderRulesUnread,
  renderSkippedRule,
  takesNobody,
} from "./route-render.js";
import {
  checkRouteMembersNow,
  defaultRouteDeps,
  inferRouteTool,
  NoAccountError,
  namesOf,
  otherToolTaking,
  pathsFor,
  type ResolvedRoute,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  routeByRules,
  routesFor,
  UnknownRouteError,
} from "./route-service.js";
import { rankWaiting } from "./route-wait.js";
import { isResumeRun, modelOf, type RunArgs, readRunArgs } from "./run-args.js";
import { noRegistryError } from "./service.js";

/**
 * The profile `clausona run <target>` names. A target that cannot be a profile name - a prompt,
 * typed where the profile goes - is told how to pass it, rather than that no such profile
 * exists; a key-shaped one, or a sentence with a token in it, is refused without being quoted.
 * Other commands keep parseProfileRef's messages.
 */
export function runTarget(input: string, registry: Registry): ParsedProfileRef {
  try {
    return parseProfileRef(input, registry);
  } catch (error) {
    if (holdsKey(input)) throw new Error(CREDENTIAL_AS_NAME_ERROR);
    // Shaped like a reference (`work`, `claude:work`, `gemini:work`): parseProfileRef's message
    // says what is wrong with it. Anything else is not a name at all.
    const colon = input.indexOf(":");
    const refShaped =
      colon === -1
        ? validateProfileName(input).ok
        : /^[A-Za-z][A-Za-z0-9-]*$/.test(input.slice(0, colon)) && validateProfileName(input.slice(colon + 1)).ok;
    if (!refShaped) {
      throw new Error(
        `'${input}' is not a profile or a tool. To pass a prompt, name the tool: clausona run claude ${posixQuote(input)}`,
      );
    }
    throw error;
  }
}

/** A registered profile literally named `claude` or `codex` keeps meaning that profile. */
function isProfileName(name: string, registry: Registry): boolean {
  return Object.keys(registry.profiles).some((id) => id.slice(id.indexOf(":") + 1) === name);
}

/**
 * Whether the tool's first argument names a registered profile: an exact id, or a bare name of
 * the tool in play (any tool's while it is not known yet, or on an `all` route).
 */
function namesProfile(arg: string | undefined, registry: Registry, tool: RouteTool | undefined): boolean {
  if (arg === undefined) return false;
  if (Object.hasOwn(registry.profiles, arg)) return true;
  if (arg.includes(":")) return false;
  return toolsOf(tool ?? "all").some((candidate) => Object.hasOwn(registry.profiles, `${candidate}:${arg}`));
}

/**
 * An `all` route ranks both tools' accounts, so arguments given without a tool word could be
 * either tool's: a claude flag handed to codex, or the other way round. Refused before anything
 * is ranked, recorded or created.
 */
function checkArgsHaveTool(name: string | undefined, tool: RouteTool, run: RunArgs): void {
  if (tool !== "all" || run.tool || run.toolArgs.length === 0) return;
  throw new Error(
    name
      ? `Route ${name} has claude and codex accounts. Say which tool these arguments are for: clausona run claude --route ${name} … (or codex).`
      : "The inline route has claude and codex accounts. Say which tool these arguments are for: clausona run claude --from … (or codex).",
  );
}

/**
 * `run --route <unknown>` in a terminal: shows the route it would create, with each account's
 * usage now, and asks one Y/n. Without a terminal nothing is written: a typo in a script must not
 * create a route.
 */
async function offerToCreate(
  error: UnknownRouteError,
  run: RunArgs,
  registry: Registry,
  io: RouteIo,
  deps: RouteDeps,
  loaded: LoadedRoutes,
): Promise<ResolvedRoute> {
  if (!io.interactive) throw error;
  // Writing it would be refused while another route, a dir rule, a default or a budget cannot be
  // used: said now, before any quota is read or a question asked that a yes could not make good.
  const names = namesOf(registry);
  const refusal = refusalOf(loaded.filePath, loaded.file, loaded.broken, names);
  if (refusal) throw refusal;
  const { route: _name, ...overrides } = run.options;
  const tool = run.tool ?? inferRouteTool(overrides.from ?? []) ?? "claude";
  checkArgsHaveTool(error.routeName, tool, run);
  const spec = newRouteFrom(tool, overrides);
  // Checked before the preview, as `route add` does: the preview quotes the patterns, and a key
  // given to --from must be refused without being shown or written to routes.json. An API profile
  // it names needs a limit.
  await checkRouteMembersNow(error.routeName, spec, registry, {
    budgets: readBudgets(loaded.file, names).budgets,
    collect: deps.collectQuotas,
  });
  const ranking = await rankRouteNow({ route: withDefaults(spec) }, deps, { resume: false, record: false });
  // A route that takes nobody could only exit 75: not proposed, so not asked about or written.
  if (takesNobody(ranking)) {
    throw new Error(
      renderNothingToCreate(error.routeName, ranking, { other: otherToolTaking(spec, registry), overrides }),
    );
  }
  io.say(renderNewRoutePreview(error.routeName, spec, ranking));
  if (!(await io.confirm(`  Create it and run? ${accent("(Y/n)")} `))) {
    throw new Error("Nothing was created, and nothing was run.");
  }
  await createRoute(error.routeName, spec, deps);
  const resolved = resolveRoute((await routesFor(error.routeName, deps.paths, names)).file, run, names);
  if (!resolved) throw error;
  return resolved;
}

/**
 * The route a run of `tool` that names none takes from routes.json's dir rules and defaults, or
 * null for the active profile. Each rule passed over is said on stderr; so is a routes.json that
 * cannot be read at all, which then stops nothing: the run goes on as if it had no rules.
 */
async function ruleRoute(
  tool: ToolName,
  io: RouteIo,
  deps: RouteDeps,
  names: ProfileNames,
): Promise<ResolvedRoute | null> {
  let loaded: LoadedRoutes;
  try {
    loaded = await loadRoutes(deps.paths, names);
  } catch (error) {
    const problem =
      error instanceof RoutesFileError
        ? error.problems.join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    io.say(renderRulesUnread(deps.paths.routesPath, problem, error instanceof RoutesFileError && error.newer));
    return null;
  }
  const { resolved, skipped, problems } = routeByRules(loaded, tool, deps.cwd, pathsFor(deps), names);
  // A rule whose directory cannot be read never comes up below, yet may have been meant for here.
  if (problems.length) io.say(renderRulesProblems(loaded.filePath, problems.length));
  for (const skip of skipped) io.say(renderSkippedRule(skip));
  return resolved;
}

/**
 * `clausona run` without a named profile. Picks through the route the arguments name (or an
 * unsaved one from --from), records the pick, says on stderr what it picked, and launches it.
 * With only a tool, the route comes from the dir rule for the current directory, else the tool's
 * default; with neither, it runs that tool's active profile.
 */
export async function runRouted(
  args: string[],
  launch: (profile: string, toolArgs: string[]) => Promise<number>,
  io: RouteIo = terminalIo(process.stderr),
  deps: RouteDeps = defaultRouteDeps(),
): Promise<number> {
  const registry = await deps.loadRegistry();
  if (!registry) throw await noRegistryError();

  const [first, ...rest] = args;
  if ((first === "claude" || first === "codex") && isProfileName(first, registry)) {
    return launch(first, rest[0] === "--" ? rest.slice(1) : rest);
  }

  const run = readRunArgs(args);
  let resolved: ResolvedRoute | null = null;
  let unknown: UnknownRouteError | undefined;
  // Read here only for a named route, and refused only for that route's problems: an unsaved
  // route goes ahead whatever routes.json holds, and a run on dir rules reads it below.
  const names = namesOf(registry);
  const loaded = await routesFor(run.options.route, deps.paths, names);
  try {
    resolved = resolveRoute(loaded.file, run, names);
  } catch (error) {
    if (!(error instanceof UnknownRouteError)) throw error;
    unknown = error;
  }
  // `run --route main claude:b` would otherwise launch another account with `claude:b` as its
  // prompt. Checked before anything is created, ranked or recorded; the name is not echoed.
  // `--wait` is a routing option too, though it names no route.
  if (
    (resolved || unknown || run.waitMs !== undefined) &&
    !run.sawSeparator &&
    namesProfile(run.toolArgs[0], registry, resolved?.onlyTool ?? resolved?.route.tool ?? run.tool)
  ) {
    throw new Error(
      "Routing options cannot be combined with a profile. Run it by name: clausona run <profile> …, or put it after -- to pass it to the tool.",
    );
  }
  if (unknown) resolved = await offerToCreate(unknown, run, registry, io, deps, loaded);

  if (!resolved) {
    if (!run.tool) {
      throw new Error(
        "Name a route, a tool or a profile: clausona run --route <name> …, clausona run claude …, or clausona run <profile> ….",
      );
    }
    // `run claude claude:b` would launch another account with `claude:b` as its prompt. Only a
    // word that names a registered profile exactly; any other word is the tool's.
    const [word] = run.toolArgs;
    if (word !== undefined && !run.sawSeparator && namesProfile(word, registry, run.tool)) {
      const id = Object.hasOwn(registry.profiles, word) ? word : `${run.tool}:${word}`;
      throw new Error(
        `${id} is a profile. Run it by name: clausona run ${id} …, or put it after -- to pass it to ${run.tool}: clausona run ${run.tool} -- ${word}`,
      );
    }
    resolved = await ruleRoute(run.tool, io, deps, names);
    if (!resolved) {
      const active = registry.activeProfiles[run.tool];
      if (!active || !registry.profiles[active]) {
        throw new Error(`No active ${run.tool} profile. Run \`clausona use\`, or name one: clausona run <profile>.`);
      }
      io.say(`  ${accent("▸")} ${bold(active)}  ${dim("active profile (no route)")}`);
      return launch(active, run.toolArgs);
    }
  }

  checkArgsHaveTool(resolved.name, resolved.onlyTool ?? resolved.route.tool, run);
  // The tool whose flags say whether this is a resume. On an `all` route without a tool word
  // there are no arguments (checked above), so there is nothing to resume.
  const runTool = resolved.onlyTool ?? (resolved.route.tool === "all" ? undefined : resolved.route.tool);
  const resume = runTool ? isResumeRun(runTool, run.toolArgs) : false;
  // The model the tool is told to use; without one, no model's own limit counts.
  const model = runTool ? modelOf(runTool, run.toolArgs) : undefined;
  const { waitMs } = run;
  const { ranking, gaveUp } =
    waitMs === undefined
      ? { ranking: await rankRouteNow(resolved, deps, { resume, record: true, model }), gaveUp: undefined }
      : await rankWaiting(resolved, deps, { resume, model, capMs: waitMs });
  if (ranking.outcome.kind === "none") {
    // The explain it points to ranks with the run's own options, as the run did.
    const { route: _name, ...overrides } = run.options;
    throw new NoAccountError(
      renderNoAccount(resolved.name, ranking, {
        now: deps.clock(),
        onlyTool: resolved.onlyTool,
        overrides,
        resume,
        ...(waitMs === undefined ? {} : { wait: { capMs: waitMs, gaveUp } }),
      }),
    );
  }
  io.say(renderNote(resolved.name, ranking, resolved.resolvedBy));
  return launch(ranking.outcome.id, run.toolArgs);
}
