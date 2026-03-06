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
