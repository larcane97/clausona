import { carriesCredentialToken, looksLikeCredential } from "../core/credential-token.js";
import {
  applyOverrides,
  DEFAULT_RESERVE_USAGE,
  newRouteSpec,
  type RouteTool,
  toolsOf,
  withDefaults,
} from "../core/route-config.js";
import { readRoutes } from "../core/routes-store.js";
import { createRoute } from "../route-commands.js";
import type { Registry } from "../types.js";
import {
  CREDENTIAL_AS_NAME_ERROR,
  type ParsedProfileRef,
  parseProfileRef,
  validateProfileName,
} from "./profile-ref.js";
import { confirmNewRoute, type RouteIo, terminalIo } from "./route-create.js";
import { renderNoAccount, renderNote } from "./route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  NoAccountError,
  type ResolvedRoute,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  UnknownRouteError,
} from "./route-service.js";
import { isResumeRun, type RunArgs, readRunArgs } from "./run-args.js";
import { noRegistryError } from "./service.js";

/** A string quoted for a POSIX shell, so the command in a message can be pasted as it is. */
const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

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
    if (
      [input, ...input.split(/[\s,:]+/)].some((piece) => looksLikeCredential(piece) || carriesCredentialToken(piece))
    ) {
      throw new Error(CREDENTIAL_AS_NAME_ERROR);
    }
    // Shaped like a reference (`work`, `claude:work`, `gemini:work`): parseProfileRef's message
    // says what is wrong with it. Anything else is not a name at all.
    const colon = input.indexOf(":");
    const refShaped =
      colon === -1
        ? validateProfileName(input).ok
        : /^[A-Za-z][A-Za-z0-9-]*$/.test(input.slice(0, colon)) && validateProfileName(input.slice(colon + 1)).ok;
    if (!refShaped) {
      throw new Error(
        `'${input}' is not a profile or a tool. To pass a prompt, name the tool: clausona run claude ${shellQuote(input)}`,
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
  const { route: _name, ...overrides } = run.options;
  const proposed = applyOverrides(newRouteSpec(run.tool ?? "claude"), overrides);
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
  let resolved: ResolvedRoute | null = null;
  let unknown: UnknownRouteError | undefined;
  try {
    resolved = resolveRoute(await readRoutes(deps.paths), run);
  } catch (error) {
    if (!(error instanceof UnknownRouteError)) throw error;
    unknown = error;
  }
  // `run --route main claude:b` would otherwise launch another account with `claude:b` as its
  // prompt. Checked before anything is created, ranked or recorded; the name is not echoed.
  if (
    (resolved || unknown) &&
    !run.sawSeparator &&
    namesProfile(run.toolArgs[0], registry, resolved?.onlyTool ?? resolved?.route.tool ?? run.tool)
  ) {
    throw new Error(
      "Routing options cannot be combined with a profile. Run it by name: clausona run <profile> …, or put it after -- to pass it to the tool.",
    );
  }
  if (unknown) resolved = await offerToCreate(unknown, run, registry, io, deps);

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

  // An `all` route run without a tool word reads the arguments as either tool's: a resume that
  // either tool would see is not missed.
  const runTools = toolsOf(resolved.onlyTool ?? resolved.route.tool);
  const ranking = await rankRouteNow(resolved, deps, {
    resume: runTools.some((tool) => isResumeRun(tool, run.toolArgs)),
    record: true,
  });
  if (ranking.outcome.kind === "none") throw new NoAccountError(renderNoAccount(resolved.name, ranking, deps.clock()));
  io.say(renderNote(resolved.name, ranking));
  return launch(ranking.outcome.id, run.toolArgs);
}
