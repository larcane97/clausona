import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderLauncher, renderWindowsLauncher, resolveInstallDir } from "./installer.js";

describe("installer helpers", () => {
  const homeDir = path.join(path.parse(process.cwd()).root, "Users", "test");

  it("prefers the directory of an existing clausona command", () => {
    const existingPath = path.join(homeDir, ".local", "bin", "clausona");
    expect(
      resolveInstallDir({
        existingPath,
        homeDir,
        localBinExists: true,
      }),
    ).toBe(path.dirname(existingPath));
  });

  it("falls back to ~/.local/bin when available", () => {
    expect(
      resolveInstallDir({
        existingPath: null,
        homeDir,
        localBinExists: true,
      }),
    ).toBe(path.join(homeDir, ".local", "bin"));
  });

  it("renders a launcher that execs node on dist/index.js", () => {
    const launcher = renderLauncher({
      appDir: "/Users/test/.local/share/clausona",
    });

    expect(launcher).toContain('"/Users/test/.local/share/clausona/index.js" "$@"');
    expect(launcher).toContain("#!/usr/bin/env bash");
    expect(launcher).toContain("exec");
  });

  it("renders a Windows cmd launcher with forwarded arguments", () => {
    const launcher = renderWindowsLauncher({
      appDir: String.raw`C:\Users\test\AppData\Local\clausona`,
      nodeBin: String.raw`C:\Program Files\nodejs\node.exe`,
    });

    expect(launcher).toContain(String.raw`"C:\Program Files\nodejs\node.exe"`);
    expect(launcher).toContain(String.raw`"C:\Users\test\AppData\Local\clausona\index.js" %*`);
    expect(launcher).toMatch(/^@echo off\r\n/);
  });

  it("points the Windows launcher's Node compile cache under ~/.clausona unless one is set", () => {
    const lines = renderWindowsLauncher({ appDir: String.raw`C:\Users\test\AppData\Local\clausona` }).split("\r\n");
    const cacheLine = lines.indexOf(
      String.raw`if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%USERPROFILE%\.clausona\cache\node"`,
    );
    const nodeLine = lines.findIndex((line) => line.endsWith(" %*"));

    expect(cacheLine).toBeGreaterThan(0);
    expect(cacheLine).toBeLessThan(nodeLine);
    // Run from cmd.exe, a batch file's `set` outlives it in the caller's session, where it
    // would send every other Node program there to clausona's cache.
    expect(lines.indexOf("setlocal")).toBeGreaterThan(0);
    expect(lines.indexOf("setlocal")).toBeLessThan(cacheLine);
  });

  it("exports the Node compile cache before exec in the POSIX launcher", () => {
    const launcher = renderLauncher({ appDir: "/Users/test/.local/share/clausona" });
    const exportAt = launcher.indexOf(`export NODE_COMPILE_CACHE="\${NODE_COMPILE_CACHE:-$HOME/.clausona/cache/node}"`);

    expect(exportAt).toBeGreaterThan(0);
    expect(exportAt).toBeLessThan(launcher.indexOf("exec "));
  });

  // A stand-in takes Node's place, so no run here writes a compile cache anywhere.
  describe.skipIf(process.platform === "win32")("the POSIX launcher, run", () => {
    let dir: string;
    let appDir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "clausona-launcher-"));
      appDir = path.join(dir, "app");
      const node = path.join(dir, "node");
      writeFileSync(node, `#!/bin/sh\nprintf '%s\\0' "\${NODE_COMPILE_CACHE-<unset>}" "$@"\n`, { mode: 0o755 });
      writeFileSync(path.join(dir, "clausona"), renderLauncher({ appDir, nodeBin: node }), { mode: 0o755 });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** Runs the launcher with PATH plus `env` only, so HOME is there only when given. */
    function run(env: NodeJS.ProcessEnv, args: string[] = []) {
      const result = spawnSync("bash", [path.join(dir, "clausona"), ...args], {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const [cache, entry, ...argv] = result.stdout.split("\0").slice(0, -1);
      return { cache, entry, argv };
    }

    it("defaults the cache to ~/.clausona/cache/node and passes arguments through unchanged", () => {
      const args = ["use", "a b", "", "$HOME", "*", "--flag=it's"];
      expect(run({ HOME: dir }, args)).toEqual({
        cache: `${dir}/.clausona/cache/node`,
        entry: `${appDir}/index.js`,
        argv: args,
      });
    });

    it("keeps a cache directory the caller already chose", () => {
      const chosen = path.join(dir, "elsewhere");
      expect(run({ HOME: dir, NODE_COMPILE_CACHE: chosen }).cache).toBe(chosen);
    });

    // Under `set -u` a bare `$HOME` is fatal when HOME is unset, and clausona never needed
    // HOME to start. Some bash builds fill HOME in from the password database; either way
    // the cache must not land at `/.clausona`.
    it("still starts without HOME", () => {
      const { cache, argv } = run({}, ["--version"]);
      expect(argv).toEqual(["--version"]);
      expect(cache === "<unset>" || /^\/.+\/\.clausona\/cache\/node$/.test(cache ?? "")).toBe(true);
    });
  });
});
