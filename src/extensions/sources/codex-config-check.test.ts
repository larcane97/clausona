import { describe, expect, it } from "vitest";

import { mergeCodexConfig } from "./codex-config-check.js";

describe("mergeCodexConfig", () => {
  it("merges a project's server over the user's as Codex does: tables key by key, lists and values whole", () => {
    // Codex 0.159.3's config/read in a trusted project with these two servers.
    const user = { command: "npx", args: ["-y", "exa"], env: { A: "1", B: "1" }, enabled_tools: ["search"] };
    const project = { command: "proj", args: ["--p"], env: { B: "2" } };
    expect(mergeCodexConfig(user, project)).toEqual({
      command: "proj",
      args: ["--p"],
      env: { A: "1", B: "2" },
      enabled_tools: ["search"],
    });
    // A table over a value, and a value over a table, is the project's.
    expect(mergeCodexConfig({ env: "x" }, { env: { A: "1" } })).toEqual({ env: { A: "1" } });
    expect(mergeCodexConfig({ env: { A: "1" } }, { env: 5 })).toEqual({ env: 5 });
  });
});
