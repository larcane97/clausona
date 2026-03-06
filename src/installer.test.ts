import { describe, expect, it } from "vitest";

import { renderLauncher, resolveInstallDir } from "./installer.js";

describe("installer helpers", () => {
  it("prefers the directory of an existing clausona command", () => {
    expect(
      resolveInstallDir({
        existingPath: "/Users/test/.local/bin/clausona",
        homeDir: "/Users/test",
        localBinExists: true,
      }),
    ).toBe("/Users/test/.local/bin");
  });

  it("falls back to ~/.local/bin when available", () => {
    expect(
      resolveInstallDir({
        existingPath: null,
        homeDir: "/Users/test",
        localBinExists: true,
      }),
    ).toBe("/Users/test/.local/bin");
  });

  it("renders a launcher that execs node on dist/index.js", () => {
    const launcher = renderLauncher({
      appDir: "/Users/test/.local/share/clausona",
    });

    expect(launcher).toContain('"/Users/test/.local/share/clausona/index.js" "$@"');
    expect(launcher).toContain("#!/usr/bin/env bash");
    expect(launcher).toContain("exec");
  });
});
