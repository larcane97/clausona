import { describe, expect, it } from "vitest";

import {
  isResumeRun,
  parseRouteTool,
  ROUTE_FIELD_OPTIONS,
  readOptions,
  readRunArgs,
  toRoutingOptions,
} from "./run-args.js";

describe("readRunArgs", () => {
  it("reads routing options, then hands the rest to the tool", () => {
    expect(readRunArgs(["--route", "main", "-p", "summarize"])).toEqual({
      options: { route: "main" },
      toolArgs: ["-p", "summarize"],
      sawSeparator: false,
    });
  });

  it("reads the tool, before or after the options, once", () => {
    expect(readRunArgs(["claude", "--from", "team-*,work", "--strategy=headroom", "fix it"])).toEqual({
      tool: "claude",
      options: { from: ["team-*", "work"], strategy: "headroom" },
      toolArgs: ["fix it"],
      sawSeparator: false,
    });
    expect(readRunArgs(["--route", "cx", "codex", "exec", "codex"])).toEqual({
      tool: "codex",
      options: { route: "cx" },
      toolArgs: ["exec", "codex"],
      sawSeparator: false,
    });
  });

  it("reads every field option", () => {
    const run = readRunArgs([
      "--route=main",
      "--exclude",
      "*-share",
      "--max-usage",
      "70",
      "--strategy",
      "expiring",
      "--fallback",
      "dalsoo",
    ]);
    expect(run.options).toEqual({
      route: "main",
      exclude: ["*-share"],
      maxUsage: 70,
      strategy: "expiring",
      fallback: ["dalsoo"],
    });
  });

  // Routes have no reserve limit: the option an earlier build took is the tool's, like any other.
  it("does not read --reserve-usage", () => {
    expect(readRunArgs(["--route", "main", "--reserve-usage", "90"])).toEqual({
      options: { route: "main" },
      toolArgs: ["--reserve-usage", "90"],
      sawSeparator: false,
    });
  });

  // Review Focus 3: after `--` everything is the tool's, even what looks like ours.
  it("drops one -- and passes everything after it through", () => {
    expect(readRunArgs(["--route", "main", "--", "--route", "x"])).toEqual({
      options: { route: "main" },
      toolArgs: ["--route", "x"],
      sawSeparator: true,
    });
  });

  it("stops at the first argument that is not its own", () => {
    expect(readRunArgs(["--route", "main", "-p", "--from", "x"]).toolArgs).toEqual(["-p", "--from", "x"]);
  });

  it("refuses a missing value, a repeat and a bad value without echoing it", () => {
    expect(() => readRunArgs(["--route"])).toThrow("--route needs a value.");
    expect(() => readRunArgs(["--route", "-p"])).toThrow("--route needs a value.");
    expect(() => readRunArgs(["--route", "a", "--route", "b"])).toThrow("--route was given more than once.");
    expect(() => readRunArgs(["--max-usage", "0"])).toThrow("--max-usage must be a number from 1 to 100.");
    expect(() => readRunArgs(["--strategy", "secret-thing"])).toThrow(
      "--strategy must be one of round-robin, headroom, expiring.",
    );
    expect(() => readRunArgs(["--from", " , "])).toThrow("--from needs at least one pattern.");
  });
});

describe("readOptions", () => {
  it("reads values, flags and positionals anywhere", () => {
    const read = readOptions(
      ["main", "--json", "--from", "*"],
      { values: ["--from"], flags: ["--json"] },
      "route explain",
    );
    expect(read.positionals).toEqual(["main"]);
    expect([...read.flags]).toEqual(["--json"]);
    expect(read.values.get("--from")).toBe("*");
  });

  it("refuses an unknown option, naming the command's help", () => {
    expect(() => readOptions(["--nope=1"], { values: [], flags: [] }, "route list")).toThrow(
      "Unknown option: --nope\nRun `clausona route list --help` for usage.",
    );
    expect(() =>
      readOptions(["--reserve-usage", "90"], { values: ROUTE_FIELD_OPTIONS, flags: [] }, "route set"),
    ).toThrow("Unknown option: --reserve-usage\nRun `clausona route set --help` for usage.");
  });

  it("converts the routing fields", () => {
    const read = readOptions(
      ["--max-usage", "85", "--from", "a, b"],
      { values: ["--max-usage", "--from"], flags: [] },
      "route set",
    );
    expect(toRoutingOptions(read.values)).toEqual({ maxUsage: 85, from: ["a", "b"] });
  });
});

describe("parseRouteTool", () => {
  it("parses --tool including all", () => {
    expect(parseRouteTool("all")).toBe("all");
    expect(parseRouteTool("codex")).toBe("codex");
    expect(parseRouteTool(undefined)).toBeUndefined();
    expect(() => parseRouteTool("gpt")).toThrow("--tool must be claude, codex or all.");
  });
});

describe("isResumeRun", () => {
  it.each([
    ["-c"],
    ["--continue"],
    ["-r", "abc"],
    ["--resume=abc"],
    ["--from-pr", "12"],
  ])("claude %j resumes", (...args) => {
    expect(isResumeRun("claude", args)).toBe(true);
  });

  it("claude without those flags does not", () => {
    expect(isResumeRun("claude", ["-p", "resume the work"])).toBe(false);
  });

  it.each([
    ["resume", "--last"],
    ["fork", "abc"],
    ["exec", "resume", "--last"],
    ["-m", "gpt-5.5", "resume"],
  ])("codex %j resumes", (...args) => {
    expect(isResumeRun("codex", args)).toBe(true);
  });

  it("codex exec with a prompt does not", () => {
    expect(isResumeRun("codex", ["exec", "fix the tests"])).toBe(false);
  });
});
