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

  // `clausona run` hands the tool an env with the parent's credentials removed. Through a
  // .cmd shim, that env used to be merged back over clausona's own process.env - so a
  // variable clausona has but the given env does not reached the tool anyway.
  it.runIf(process.platform === "win32")(
    "gives a cmd shim only the env it was handed, not clausona's own",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "clausona-process-"));
      const shim = path.join(root, "print-env.cmd");
      writeFileSync(
        shim,
        '@echo off\r\nnode -e "process.stdout.write(String(process.env.CLAUSONA_TEST_PARENT_ONLY))"\r\n',
      );
      process.env.CLAUSONA_TEST_PARENT_ONLY = "sk-ant-parent-sentinel";

      try {
        const env = { ...process.env };
        delete env.CLAUSONA_TEST_PARENT_ONLY;
        const result = spawnCommandSync(shim, [], { encoding: "utf8", env });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe("undefined");
      } finally {
        delete process.env.CLAUSONA_TEST_PARENT_ONLY;
        rmSync(root, { recursive: true, force: true });
      }
    },
    WINDOWS_SPAWN_TEST_TIMEOUT_MS,
  );
});
