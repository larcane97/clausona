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

export function renderLauncher({ appDir, nodeBin = "node" }: { appDir: string; nodeBin?: string }) {
  return `#!/usr/bin/env bash
set -euo pipefail

exec "${nodeBin}" "${appDir}/index.js" "$@"
`;
}

function escapeCmdValue(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}

export function renderWindowsLauncher({ appDir, nodeBin = "node" }: { appDir: string; nodeBin?: string }) {
  const entryPoint = path.win32.join(appDir, "index.js");
  return `@echo off\r\n"${escapeCmdValue(nodeBin)}" "${escapeCmdValue(entryPoint)}" %*\r\n`;
}
