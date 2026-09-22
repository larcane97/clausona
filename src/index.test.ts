import { describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
import { isMainModule, parseCommand, writeCommandResult } from "./index.js";

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

/**
 * The shell hooks run `clausona _sync-plugins` and `clausona _track-usage` with only stderr
 * silenced, around every wrapped launch. Both return "", which used to print as a bare
 * newline - a blank line above and below every `claude` run.
 */
describe("writeCommandResult", () => {
  function sink() {
    const chunks: string[] = [];
    return { chunks, out: { write: (chunk: string) => chunks.push(chunk) > 0 } };
  }

  it("writes nothing at all for an empty result", () => {
    const { chunks, out } = sink();
    writeCommandResult("", out);
    expect(chunks).toEqual([]);
  });

  it("writes any other result followed by exactly one newline", () => {
    for (const result of ["export A='1'", "{}", " ", "\n", "line one\nline two"]) {
      const { chunks, out } = sink();
      writeCommandResult(result, out);
      expect(chunks, JSON.stringify(result)).toEqual([`${result}\n`]);
    }
  });
});

describe("isMainModule", () => {
  it("recognizes a canonical file URL for the current platform", async () => {
    const { realpathSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const entryPath = process.argv[1];

    expect(entryPath).toBeTruthy();
    expect(isMainModule(pathToFileURL(realpathSync(entryPath)).href, entryPath)).toBe(true);
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
