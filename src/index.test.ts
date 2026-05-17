import { describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
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

describe("--period validation (F4)", () => {
  it("throws for an invalid --period value", async () => {
    await expect(runCommand("usage", ["--period=foo"])).rejects.toThrow(/invalid --period value 'foo'/i);
  });

  it("does not throw an invalid-period error for a valid period value", async () => {
    // A valid period should not produce an "invalid --period" error.
    // (It may succeed or fail for unrelated reasons on this machine.)
    for (const val of ["today", "week", "month", "all"]) {
      let caught: unknown;
      try {
        await runCommand("usage", [`--period=${val}`]);
      } catch (e) {
        caught = e;
      }
      if (caught instanceof Error) {
        expect(caught.message).not.toMatch(/invalid --period/i);
      }
    }
  });
});
