import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { render } from "ink";

import { runCommand } from "./commands.js";
import { spawnCommandSync } from "./core/process.js";
import { trackUsage } from "./core/track-usage.js";
import { accent, fail as xMark } from "./lib/cli-style.js";
import { parseProfileRef } from "./lib/profile-ref.js";
import { loadRegistry, resolveProfileEnv } from "./lib/service.js";
import { App } from "./tui/App.js";
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
    return { kind: "exec", profile, args: rest };
  }

  return { kind: "command", command, args };
}

const TUI_SCREENS = new Set(["dashboard", "use", "doctor", "init"]);

async function main() {
  const parsed = parseCommand(process.argv.slice(2));

  // Create a proper input stream that won't throw Raw mode errors when piped
  const renderOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
  };

  // Skip TUI completely if not in a TTY (for scripts, CI, etc)
  if (parsed.kind === "tui" && !process.stdout.isTTY) {
    process.stdout.write("Run 'clausona --help' for usage. The interactive TUI requires a terminal.\n");
    return;
  }

  if (parsed.kind === "tui") {
    // Clear initial state
    if (process.stdout.isTTY) {
      process.stdout.write("\x1bc"); // FULL reset
    }

    const { waitUntilExit } = render(<App initialScreen="dashboard" />, renderOptions);

    await waitUntilExit();
    if (process.stdout.isTTY) {
      process.stdout.write("\x1bc"); // Full clear on exit
    }
    return;
  }

  if (parsed.kind === "exec") {
    try {
      const registry = await loadRegistry();
      if (!registry) throw new Error("clausona is not initialized.");
      const ref = parseProfileRef(parsed.profile, registry);
      const { binary, env } = await resolveProfileEnv(ref.id);
      const result = spawnCommandSync(binary, parsed.args, { stdio: "inherit", env });
      process.exitCode = result.status ?? 1;
      if (ref.tool === "claude") {
        await trackUsage(ref.id).catch(() => {});
      }
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

        if (process.stdout.isTTY) {
          process.stdout.write("\x1bc"); // FULL reset
        }

        const { waitUntilExit } = render(
          <App initialScreen={screen as "dashboard" | "use" | "doctor" | "init"} />,
          renderOptions,
        );

        await waitUntilExit();
        if (process.stdout.isTTY) {
          process.stdout.write("\x1bc"); // Full clear on exit
        }
        return;
      }
      process.stderr.write(
        `  ${xMark} This command requires an argument.\n    Run ${accent(`clausona ${parsed.command} --help`)} for usage.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${result}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  ${xMark} ${message}\n`);
    process.exitCode = 1;
  }
}

export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  return Boolean(entryPath && moduleUrl === pathToFileURL(realpathSync(entryPath)).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void main();
}
