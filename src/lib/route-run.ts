import { carriesCredentialToken, looksLikeCredential } from "../core/credential-token.js";
import { type RouteTool, toolsOf, withDefaults } from "../core/route-config.js";
import { readRoutes } from "../core/routes-store.js";
import { createRoute, newRouteFrom } from "../route-commands.js";
import type { Registry } from "../types.js";
import { accent, bold, dim } from "./cli-style.js";
import {
  CREDENTIAL_AS_NAME_ERROR,
  type ParsedProfileRef,
  parseProfileRef,
  validateProfileName,
} from "./profile-ref.js";
import { type RouteIo, terminalIo } from "./route-io.js";
import { renderNewRoutePreview, renderNoAccount, renderNote } from "./route-render.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  inferRouteTool,
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

/**
 * An `all` route ranks both tools' accounts, so arguments given without a tool word could be
 * either tool's: a claude flag handed to codex, or the other way round. Refused before anything
 * is ranked, recorded or created.
 */
function checkArgsHaveTool(name: string | undefined, tool: RouteTool, run: RunArgs): void {
  if (tool !== "all" || run.tool || run.toolArgs.length === 0) return;
  throw new Error(
    name
      ? `Route ${name} has claude and codex accounts. Say which tool these arguments are for: csn run claude --route ${name} … (or codex).`
      : "The inline route has claude and codex accounts. Say which tool these arguments are for: csn run claude --from … (or codex).",
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
): Promise<ResolvedRoute> {
  if (!io.interactive) throw error;
  const { route: _name, ...overrides } = run.options;
  const tool = run.tool ?? inferRouteTool(overrides.from ?? []) ?? "claude";
  checkArgsHaveTool(error.routeName, tool, run);
  const spec = newRouteFrom(tool, overrides);
  // Checked before the preview, as `route add` does: the preview quotes the patterns, and a key
  // given to --from must be refused without being shown or written to routes.json.
  checkRouteMembers(error.routeName, spec, registry);
  const ranking = await rankRouteNow({ route: withDefaults(spec) }, deps, { resume: false, record: false });
  io.say(renderNewRoutePreview(error.routeName, spec, ranking));
  if (!(await io.confirm(`  Create it and run? ${accent("(Y/n)")} `))) {
    throw new Error("Nothing was created, and nothing was run.");
  }
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
    io.say(`  ${accent("▸")} ${bold(active)}  ${dim("active profile (no route)")}`);
    return launch(active, run.toolArgs);
  }

  checkArgsHaveTool(resolved.name, resolved.onlyTool ?? resolved.route.tool, run);
  // The tool whose flags say whether this is a resume. On an `all` route without a tool word
  // there are no arguments (checked above), so there is nothing to resume.
  const runTool = resolved.onlyTool ?? (resolved.route.tool === "all" ? undefined : resolved.route.tool);
  const ranking = await rankRouteNow(resolved, deps, {
    resume: runTool ? isResumeRun(runTool, run.toolArgs) : false,
    record: true,
  });
  if (ranking.outcome.kind === "none") {
    throw new NoAccountError(renderNoAccount(resolved.name, ranking, { now: deps.clock() }));
  }
  io.say(renderNote(resolved.name, ranking));
  return launch(ranking.outcome.id, run.toolArgs);
}
