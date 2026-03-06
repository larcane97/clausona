import { describe, expect, it } from "vitest";

import { renderShellInit } from "./shell.js";

describe("renderShellInit", () => {
  it("includes the claude wrapper function and alias", () => {
    const shellInit = renderShellInit();

    expect(shellInit).toContain("claude()");
    expect(shellInit).toContain("alias csn=clausona");
    expect(shellInit).toContain("CLAUDE_CONFIG_DIR");
    expect(shellInit).toContain("_clausona_resolve_config");
    expect(shellInit).toContain("_track-usage");
  });
});
