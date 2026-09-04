import {
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type PreparedCommand = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

// `exit $LASTEXITCODE` alone exits 0 when the variable is unset — which is the case
// when the command never launched — reporting a failure as success. Written the long
// way because PowerShell 5.1, the documented floor, has no null-coalescing operator.
const POWERSHELL_INVOKE =
  "$commandPath = $env:CLAUSONA_COMMAND_PATH; " +
  "$commandArgs = @((ConvertFrom-Json -InputObject $env:CLAUSONA_COMMAND_ARGS)); " +
  "& $commandPath @commandArgs; " +
  "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; " +
  "if ($?) { exit 0 } else { exit 1 }";

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    return path.resolve(command);
  }

  const pathEntries = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const configuredExtensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const extensions = path.extname(command) ? [""] : [...configuredExtensions, ".PS1"];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"(.*)"$/, "$1"), `${command}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
      const uppercaseCandidate = path.join(directory.replace(/^"(.*)"$/, "$1"), `${command}${extension.toUpperCase()}`);
      if (existsSync(uppercaseCandidate)) return uppercaseCandidate;
    }
  }

  return command;
}

function prepareCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): PreparedCommand {
  if (platform !== "win32") return { command, args };

  const resolvedCommand = resolveWindowsCommand(command, env);
  const extension = path.extname(resolvedCommand).toLowerCase();
  if (extension === ".exe" || extension === ".com" || !extension) {
    return { command: resolvedCommand, args };
  }

  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_INVOKE],
    env: {
      CLAUSONA_COMMAND_PATH: resolvedCommand,
      CLAUSONA_COMMAND_ARGS: JSON.stringify(args),
    },
  };
}

/**
 * Only the PowerShell shim needs an env of our making — it reads the command and its
 * arguments out of two variables. Every other call keeps the caller's `env` exactly as
 * given, so a caller that deliberately restricts the child's environment still does.
 */
function spawnOptions<T extends SpawnOptions | SpawnSyncOptions>(
  options: T,
  resolvedEnv: NodeJS.ProcessEnv,
  preparedEnv: NodeJS.ProcessEnv | undefined,
): T {
  if (!preparedEnv) return options;
  return { ...options, env: { ...resolvedEnv, ...preparedEnv } };
}

export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const env = { ...process.env, ...options.env };
  const prepared = prepareCommand(command, args, env);
  return spawn(prepared.command, prepared.args, spawnOptions(options, env, prepared.env));
}

export function spawnCommandSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const env = { ...process.env, ...options.env };
  const prepared = prepareCommand(command, args, env);
  return spawnSync(prepared.command, prepared.args, spawnOptions(options, env, prepared.env)) as SpawnSyncReturns<
    Buffer | string
  >;
}
