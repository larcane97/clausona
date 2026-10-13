import { describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
import { ExitError } from "./extensions/exit-error.js";
import { isMainModule, parseCommand, reportError, TUI_SCREENS, writeCommandResult } from "./index.js";
import { stripAnsi } from "./lib/cli-style.js";

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

  it("drops the one leading -- that separates the tool's arguments from clausona's", () => {
    expect(parseCommand(["run", "claude:x", "--", "-p", "q"])).toEqual({
      kind: "exec",
      profile: "claude:x",
      args: ["-p", "q"],
    });
    expect(parseCommand(["run", "claude:x", "--", "--", "q"])).toEqual({
      kind: "exec",
      profile: "claude:x",
      args: ["--", "q"],
    });
  });

  it("parses run without profile as a regular command", () => {
    expect(parseCommand(["run", "--help"])).toEqual({
      kind: "command",
      command: "run",
      args: ["--help"],
    });
  });

  it("sends run forms without a named profile to routing, untouched", () => {
    expect(parseCommand(["run", "--route", "main", "--", "-p", "q"])).toEqual({
      kind: "route",
      args: ["--route", "main", "--", "-p", "q"],
    });
    expect(parseCommand(["run", "claude", "-p", "q"])).toEqual({ kind: "route", args: ["claude", "-p", "q"] });
    expect(parseCommand(["run", "codex"])).toEqual({ kind: "route", args: ["codex"] });
  });

  it("still runs a named profile as before", () => {
    expect(parseCommand(["run", "claude:work", "--route", "x"])).toEqual({
      kind: "exec",
      profile: "claude:work",
      args: ["--route", "x"],
    });
  });
});

describe("TUI_SCREENS", () => {
  it("lists every screen a command may open, the Routes screen of `csn route` among them", () => {
    expect([...TUI_SCREENS].sort()).toEqual(["dashboard", "doctor", "init", "routes", "use"]);
  });
});

describe("reportError", () => {
  const sink = () => {
    const chunks: string[] = [];
    return { chunks, stream: { write: (chunk: string) => chunks.push(chunk) > 0 } };
  };

  it("prints the message and returns 1", () => {
    const err = sink();
    const out = sink();
    expect(reportError(new Error("boom"), err.stream, out.stream)).toBe(1);
    expect(err.chunks.join("")).toContain("boom");
  });

  it("returns an error's own exit code, and prints its stdout instead when it has one", () => {
    const err = sink();
    const out = sink();
    const error = Object.assign(new Error("nobody"), { exitCode: 75, stdout: '{"profile":null}' });
    expect(reportError(error, err.stream, out.stream)).toBe(75);
    expect(out.chunks.join("")).toBe('{"profile":null}\n');
    expect(err.chunks).toEqual([]);
  });

  it("takes an exitCode only when it is a whole number from 1 to 255, else exits 1", () => {
    const code = (exitCode: unknown) => reportError(Object.assign(new Error("x"), { exitCode }), sink().stream);
    expect(code(1)).toBe(1);
    expect(code(255)).toBe(255);
    for (const bad of [0, -1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "75"]) expect(code(bad)).toBe(1);
  });

  it("exits with an ExitError's code, its message on stderr", () => {
    const err = sink();
    const out = sink();
    expect(reportError(new ExitError("--scope parents does not apply to skills.", 2), err.stream, out.stream)).toBe(2);
    expect(out.chunks).toEqual([]);
    expect(err.chunks.join("")).toContain("--scope parents does not apply to skills.");
  });

  it("writes an ExitError's stdout alone, so stdout is the JSON and stderr stays empty", () => {
    const err = sink();
    const out = sink();
    const json = JSON.stringify({ version: 1, error: "ambiguous", candidates: [] });
    expect(reportError(new ExitError("2 skills are named 'eli5':", 2, json), err.stream, out.stream)).toBe(2);
    expect(out.chunks).toEqual([`${json}\n`]);
    expect(err.chunks).toEqual([]);
  });

  it("says an unknown command in one line, with exit code 2 (#104)", () => {
    const err = sink();
    const out = sink();
    expect(
      reportError(new ExitError("Unknown command 'plugins'. Run clausona --help.", 2), err.stream, out.stream),
    ).toBe(2);
    expect(out.chunks).toEqual([]);
    expect(err.chunks.map(stripAnsi)).toEqual(["  ✘ Unknown command 'plugins'. Run clausona --help.\n"]);
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
  it("throws for an invalid --period value, naming the valid ones rather than the input", async () => {
    // The value is not echoed: it is an option value like any other, and the CLI does not
    // repeat those back. The message says what would have worked instead.
    await expect(runCommand("usage", ["--period=foo"])).rejects.toThrow(/invalid --period: use today, week/i);
    await expect(runCommand("usage", ["--period=foo"])).rejects.not.toThrow(/foo/);
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
