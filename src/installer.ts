import { homedir } from "node:os";
import path from "node:path";

export function resolveInstallDir({
  existingPath,
  homeDir,
  localBinExists,
}: {
  existingPath: string | null;
  homeDir: string;
  localBinExists: boolean;
}) {
  if (existingPath) {
    return path.dirname(existingPath);
  }

  if (localBinExists) {
    return path.join(homeDir, ".local", "bin");
  }

  return "/usr/local/bin";
}

/**
 * The launchers point Node's compile cache at `~/.clausona/cache/node`, unless the caller
 * already chose a directory. Node 22.1+ then keeps the bundle's compiled code there, so each
 * start after the first skips most of the parse; older Node ignores the variable. The shell
 * hook starts clausona around every `claude` and `codex` run, which is why that start matters.
 */
export function renderLauncher({ appDir, nodeBin = "node" }: { appDir: string; nodeBin?: string }) {
  // Under `set -u` a bare `$HOME` would stop the launcher when HOME is unset, and clausona
  // itself starts without it; with no HOME there is just no cache.
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -n "\${HOME:-}" ]]; then
  export NODE_COMPILE_CACHE="\${NODE_COMPILE_CACHE:-$HOME/.clausona/cache/node}"
fi
exec "${nodeBin}" "${appDir}/index.js" "$@"
`;
}

/**
 * Takes the launcher's NODE_COMPILE_CACHE back out of this process's environment, so the tools
 * clausona starts - claude and codex, their logins, and what they start in turn, MCP servers
 * among them - do not write their own compiled code into clausona's cache. Node reads the
 * variable once, at startup, so this process keeps using the cache. Any other directory is the
 * caller's choice and stays: the launchers set theirs only when the variable is unset.
 */
export function dropLauncherCompileCache(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): void {
  const value = env.NODE_COMPILE_CACHE;
  if (!value) return;
  const paths = platform === "win32" ? path.win32 : path.posix;
  // `%USERPROFILE%` and `$HOME` are what homedir() reads, but separators, a trailing slash
  // and, on Windows, letter case can still differ.
  const normal = (dir: string) => {
    const resolved = paths.resolve(dir);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (normal(value) === normal(paths.join(homeDir, ".clausona", "cache", "node"))) {
    delete env.NODE_COMPILE_CACHE;
  }
}

function escapeCmdValue(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}

export function renderWindowsLauncher({ appDir, nodeBin = "node" }: { appDir: string; nodeBin?: string }) {
  const entryPoint = path.win32.join(appDir, "index.js");
  // Run from cmd.exe, a batch file's `set` stays in the caller's session after it ends, and
  // would send every other Node program started there to clausona's cache; `setlocal` keeps
  // it to this run.
  return [
    "@echo off",
    "setlocal",
    String.raw`if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%USERPROFILE%\.clausona\cache\node"`,
    `"${escapeCmdValue(nodeBin)}" "${escapeCmdValue(entryPoint)}" %*`,
    "",
  ].join("\r\n");
}
