import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { spawnCommandSync } from "./process.js";

const WINDOWS_SPAWN_TEST_TIMEOUT_MS = 60_000;

describe("spawnCommandSync", () => {
  it.runIf(process.platform === "win32")(
    "runs cmd shims and preserves arguments with shell metacharacters",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "clausona-process-"));
      const shim = path.join(root, "echo-argument.cmd");
      writeFileSync(shim, '@echo off\r\nnode -e "process.stdout.write(process.argv[1])" %*\r\n');

      try {
        const argument = "hello & echo INJECTED";
        const result = spawnCommandSync(shim, [argument], { encoding: "utf8" });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe(argument);
        expect(result.stderr).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    // Cold-starts powershell.exe, then cmd.exe, then node. That took 478ms on an idle
    // CI runner and 22s when another PowerShell test ran alongside it, so the budget has
    // to cover contention rather than the best case.
    WINDOWS_SPAWN_TEST_TIMEOUT_MS,
  );
});
