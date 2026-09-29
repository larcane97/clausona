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
