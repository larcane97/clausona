import { applyOverrides, DEFAULT_RESERVE_USAGE, newRouteSpec, withDefaults } from "../core/route-config.js";
import { readRoutes } from "../core/routes-store.js";
import { createRoute } from "../route-commands.js";
import type { Registry } from "../types.js";
import { askTool, confirmNewRoute, type RouteIo, terminalIo } from "./route-create.js";
import { renderNoAccount, renderNote } from "./route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  NoAccountError,
  onlyTool,
  type ResolvedRoute,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  UnknownRouteError,
} from "./route-service.js";
import { isResumeRun, type RunArgs, readRunArgs } from "./run-args.js";
import { noRegistryError } from "./service.js";

/** A registered profile literally named `claude` or `codex` keeps meaning that profile. */
function isProfileName(name: string, registry: Registry): boolean {
  return Object.keys(registry.profiles).some((id) => id.slice(id.indexOf(":") + 1) === name);
}

async function offerToCreate(
  error: UnknownRouteError,
  run: RunArgs,
  registry: Registry,
  io: RouteIo,
  deps: RouteDeps,
): Promise<ResolvedRoute> {
  // Without a terminal nothing is written: a typo in a script must not create a route.
  if (!io.interactive) throw error;
  io.say(
    `Route '${error.routeName}' does not exist.${error.existing.length ? ` Existing routes: ${error.existing.join(", ")}.` : ""}`,
  );
  const tool = run.tool ?? onlyTool(registry) ?? (await askTool(io));
  if (!tool) throw new Error("Nothing was created, and nothing was run: say claude or codex.");
  const { route: _name, ...overrides } = run.options;
  const proposed = applyOverrides(newRouteSpec(tool), overrides);
  // As `route add` writes it: the reserve spelled out, even when a cut above 95% moved it.
  if (proposed.reserveUsage === undefined) {
    proposed.reserveUsage = Math.max(DEFAULT_RESERVE_USAGE, proposed.maxUsage ?? 0);
  }
  // Checked before the screen, as `route add` does: the screen quotes the patterns, and a key
  // given to --from must be refused without being shown or written to routes.json.
  checkRouteMembers(error.routeName, proposed, registry);
  const spec = await confirmNewRoute(
    error.routeName,
    proposed,
    io,
    (candidate) => rankRouteNow({ route: withDefaults(candidate) }, deps, { resume: false, record: false }),
    true,
  );
  if (!spec) throw new Error("Nothing was created, and nothing was run.");
  checkRouteMembers(error.routeName, spec, registry);
  await createRoute(error.routeName, spec, deps);
  const resolved = resolveRoute(await readRoutes(deps.paths), run);
  if (!resolved) throw error;
  return resolved;
}

/**
 * `clausona run` without a named profile. Picks through the route the arguments name (or an
 * unsaved one from --from), records the pick, says on stderr what it picked, and launches it.
 * With only a tool and no route, it runs that tool's active profile.
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
  let resolved: ResolvedRoute | null;
  try {
    resolved = resolveRoute(await readRoutes(deps.paths), run);
  } catch (error) {
    if (!(error instanceof UnknownRouteError)) throw error;
    resolved = await offerToCreate(error, run, registry, io, deps);
  }

  if (!resolved) {
    if (!run.tool) {
      throw new Error(
        "Name a route, a tool or a profile: clausona run --route <name> …, clausona run claude …, or clausona run <profile> ….",
      );
    }
    const active = registry.activeProfiles[run.tool];
    if (!active || !registry.profiles[active]) {
      throw new Error(`No active ${run.tool} profile. Run \`clausona use\`, or name one: clausona run <profile>.`);
    }
    io.say(`→ ${active} · active profile (no route)`);
    return launch(active, run.toolArgs);
  }

  const ranking = await rankRouteNow(resolved, deps, {
    resume: isResumeRun(resolved.route.tool, run.toolArgs),
    record: true,
  });
  if (ranking.outcome.kind === "none") throw new NoAccountError(renderNoAccount(resolved.name, ranking, deps.clock()));
  io.say(renderNote(resolved.name, ranking));
  return launch(ranking.outcome.id, run.toolArgs);
}
