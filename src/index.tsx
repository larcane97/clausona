import { render } from "ink";
import { spawnSync } from "node:child_process";

import { runCommand } from "./commands.js";
import { trackUsage } from "./core/track-usage.js";
import { fail as xMark, accent } from "./lib/cli-style.js";
import { resolveProfileEnv } from "./lib/service.js";
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
      process.stdout.write('\x1bc'); // FULL reset
    }
    
    const { waitUntilExit, clear } = render(<App initialScreen="dashboard" />, renderOptions);

    await waitUntilExit();
    if (process.stdout.isTTY) {
      process.stdout.write('\x1bc'); // Full clear on exit
    }
    return;
  }

  if (parsed.kind === "exec") {
    try {
      const { env } = await resolveProfileEnv(parsed.profile);
      const result = spawnSync("claude", parsed.args, {
        stdio: "inherit",
        env,
      });
      process.exitCode = result.status ?? 1;
      await trackUsage(parsed.profile).catch(() => {});
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
          process.stdout.write('\x1bc'); // FULL reset
        }
        
        const { waitUntilExit, clear } = render(<App initialScreen={screen as "dashboard" | "use" | "doctor" | "init"} />, renderOptions);

        await waitUntilExit();
        if (process.stdout.isTTY) {
          process.stdout.write('\x1bc'); // Full clear on exit
        }
        return;
      }
      process.stderr.write(`  ${xMark} This command requires an argument.\n    Run ${accent(`clausona ${parsed.command} --help`)} for usage.\n`);
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

import { realpathSync } from "node:fs";

const entryReal = realpathSync(process.argv[1]!);
if (import.meta.url === `file://${entryReal}`) {
  void main();
}
