import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runCommand } from "./commands.js";
import { spawnCommandSync } from "./core/process.js";
import { trackUsage } from "./core/track-usage.js";
import { createUpdater, type UpdateOffer } from "./core/update.js";
import { ExitError } from "./extensions/exit-error.js";
import { dropLauncherCompileCache } from "./installer.js";
import { accent, ok, fail as xMark } from "./lib/cli-style.js";
import { parseProfileRef } from "./lib/profile-ref.js";
import { loadRegistry, noRegistryError, resolveProfileEnv } from "./lib/service.js";
import type { ParsedCommand } from "./types.js";

export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { kind: "tui", command: "dashboard" };
  }

  const [command, ...args] = argv;

  if (command === "run") {
    const [profile, ...rest] = args;
    if (!profile || profile.startsWith("-")) {
      return { kind: "command", command: "run", args };
    }
    // `run <profile> -- -p "q"` separates clausona's arguments from the tool's; the `--` is
    // clausona's, and handed on it would make the tool read `-p` as its prompt. Only the
    // first goes, so `-- --` still passes one through.
    return { kind: "exec", profile, args: rest[0] === "--" ? rest.slice(1) : rest };
  }

  return { kind: "command", command, args };
}

type TuiScreen = "dashboard" | "use" | "doctor" | "init";

const TUI_SCREENS = new Set<string>(["dashboard", "use", "doctor", "init"]);

/**
 * React and Ink are the bulk of this bundle's startup cost, and nothing but the TUI needs
 * them. They stay behind a dynamic import because the shell hook calls `clausona _shell-env`
 * before every `claude` and `codex` run, and that command prints two lines and exits - it
 * should not be paying to evaluate a React renderer first.
 */
async function renderTui(screen: TuiScreen): Promise<void> {
  const [{ render }, { App }] = await Promise.all([import("ink"), import("./tui/App.js")]);

  // Clear initial state
  if (process.stdout.isTTY) {
    process.stdout.write("\x1bc"); // FULL reset
  }

  // The dashboard is the one screen that offers an update; `csn use` and the rest open on a task.
  // `handoff` is an object so the callback's write is visible below; a `let` would be narrowed to `null`.
  const handoff: { offer: UpdateOffer | null } = { offer: null };
  // Pass the real streams so ink does not throw Raw mode errors when piped.
  const { waitUntilExit } = render(
    <App
      initialScreen={screen}
      updater={screen === "dashboard" ? createUpdater() : undefined}
      onRestart={(offer) => {
        handoff.offer = offer;
      }}
    />,
    { stdout: process.stdout, stdin: process.stdin },
  );

  await waitUntilExit();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1bc"); // Full clear on exit
  }
  if (handoff.offer?.target) {
    process.exitCode = relaunch(handoff.offer.target, handoff.offer.latest);
  }
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));

  // Skip TUI completely if not in a TTY (for scripts, CI, etc)
  if (parsed.kind === "tui" && !process.stdout.isTTY) {
    process.stdout.write("Run 'clausona --help' for usage. The interactive TUI requires a terminal.\n");
    return;
  }

  if (parsed.kind === "tui") {
    await renderTui("dashboard");
    return;
  }

  if (parsed.kind === "exec") {
    try {
      process.exitCode = await runProfile(parsed.profile, parsed.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`  ${xMark} ${message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    const result = await runCommand(parsed.command, parsed.args);
    if (result.startsWith("__OPEN_TUI__:")) {
      const screen = result.replace("__OPEN_TUI__:", "");
      if (TUI_SCREENS.has(screen)) {
        if (!process.stdout.isTTY) {
          process.stdout.write("Operation successful. (Interactive TUI skipped due to non-TTY environment)\n");
          return;
        }

        await renderTui(screen as TuiScreen);
        return;
      }
      process.stderr.write(
        `  ${xMark} This command requires an argument.\n    Run ${accent(`clausona ${parsed.command} --help`)} for usage.\n`,
      );
      process.exitCode = 1;
      return;
    }
    writeCommandResult(result);
  } catch (error) {
    process.exitCode = writeCommandError(error);
  }
}

/**
 * Prints why a command failed and returns the exit code. An ExitError carries its own code, and
 * may carry an answer for stdout instead - the `--json` object for a name several items have -
 * which then goes alone, so a script reading stdout gets JSON and stderr stays empty. Any other
 * error is a message on stderr and exit code 1.
 */
export function writeCommandError(
  error: unknown,
  streams: { out: { write(chunk: string): unknown }; err: { write(chunk: string): unknown } } = {
    out: process.stdout,
    err: process.stderr,
  },
): number {
  if (error instanceof ExitError && error.stdout !== undefined) {
    writeCommandResult(error.stdout, streams.out);
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  streams.err.write(`  ${xMark} ${message}\n`);
  return error instanceof ExitError ? error.code : 1;
}

/**
 * `clausona run <profile> [args...]`: launches the profile's tool with the profile's
 * environment and returns its exit code. The platform reaches both the environment and the
 * spawn, so what the child actually receives on Windows is testable on every OS.
 */
export async function runProfile(
  profileArg: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const registry = await loadRegistry();
  if (!registry) throw await noRegistryError();
  const ref = parseProfileRef(profileArg, registry);
  const { binary, env } = await resolveProfileEnv(ref.id, platform);
  const result = spawnCommandSync(binary, args, { stdio: "inherit", env }, platform);
  if (ref.tool === "claude") {
    await trackUsage(ref.id).catch(() => {});
  }
  return result.status ?? 1;
}

/**
 * After an update, the App exits and this starts the version it installed: the same node, the
 * same arguments, and the terminal handed straight over, as `run` hands it to a tool. It returns
 * the exit code to leave with. If the new version cannot be started, the update itself still
 * stands, and this only says so.
 */
export function relaunch(
  target: string,
  latest: string,
  options: {
    argv?: string[];
    spawn?: typeof spawnCommandSync;
    out?: { write(chunk: string): unknown };
  } = {},
): number {
  const { argv = process.argv.slice(2), spawn = spawnCommandSync, out = process.stdout } = options;
  const result = spawn(process.execPath, [target, ...argv], { stdio: "inherit" });
  if (result.error) {
    out.write(`  ${ok} Updated to v${latest}. Run csn again.\n`);
    return 0;
  }
  return result.status ?? 1;
}

/**
 * Prints a command's result. An empty result prints nothing: the internal commands the
 * shell hooks call around every launch (`_sync-plugins`, `_track-usage`) return "", and
 * the hooks silence only their stderr, so a bare newline here was a blank line above and
 * below every wrapped `claude` run. `_shell-env` is unaffected either way: `$(...)` strips
 * the newline, and PowerShell reads no output and an empty line alike as falsy.
 */
export function writeCommandResult(result: string, out: { write(chunk: string): unknown } = process.stdout) {
  if (result === "") return;
  out.write(`${result}\n`);
}

export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  return Boolean(entryPath && moduleUrl === pathToFileURL(realpathSync(entryPath)).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // Before anything can start a child: the launcher's compile cache is for clausona alone.
  dropLauncherCompileCache();
  void main();
}
