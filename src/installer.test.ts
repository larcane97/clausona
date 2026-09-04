import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
