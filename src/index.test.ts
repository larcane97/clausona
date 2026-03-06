import { describe, expect, it } from "vitest";

import { parseCommand } from "./index.js";

describe("parseCommand", () => {
  it("defaults to interactive mode with no args", () => {
    expect(parseCommand([])).toEqual({ kind: "tui", command: "dashboard" });
  });

  it("parses a named subcommand", () => {
    expect(parseCommand(["use", "work"])).toEqual({
      kind: "command",
      command: "use",
      args: ["work"],
    });
  });

  it("parses run as exec with profile and claude args", () => {
    expect(parseCommand(["run", "work", "-p", "/project"])).toEqual({
      kind: "exec",
      profile: "work",
      args: ["-p", "/project"],
    });
  });

  it("parses run without profile as a regular command", () => {
    expect(parseCommand(["run", "--help"])).toEqual({
      kind: "command",
      command: "run",
      args: ["--help"],
    });
  });
});
