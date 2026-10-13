import { describe, expect, it } from "vitest";

import {
  DEFAULT_WAIT_MS,
  isResumeRun,
  modelOf,
  parseModel,
  parseRouteTool,
  parseWait,
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

  // After `--` everything is the tool's, even what looks like ours.
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
    expect(() => readRunArgs(["--route="])).toThrow("--route needs a value.");
    expect(() => readRunArgs(["--route", ""])).toThrow("--route needs a value.");
    expect(() => readRunArgs(["claude", "--route", " "])).toThrow("--route needs a value.");
    expect(() => readRunArgs(["--route", "a", "--route", "b"])).toThrow("--route was given more than once.");
    expect(() => readRunArgs(["--max-usage", "0"])).toThrow("--max-usage must be a number from 1 to 100.");
    expect(() => readRunArgs(["--strategy", "secret-thing"])).toThrow(
      "--strategy must be one of round-robin, headroom, expiring.",
    );
    expect(() => readRunArgs(["--from", " , "])).toThrow("--from needs at least one pattern.");

    // A key typed into an option's slot, or after an option missing its value, is not repeated.
    const key = ["sk", "ant", "y".repeat(24)].join("-");
    // Each case is named, never shown: its arguments hold the key.
    const refusal = (name: string, args: string[]) => {
      try {
        readRunArgs(args);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error(`${name} was read, not refused`);
    };
    const cases: Array<[string, string[]]> = [
      ["the next option after one missing its value", ["--route", "--from", key]],
      ["a repeated option", ["--route", key, "--route", key]],
      ["a repeated inline option", [`--route=${key}`, `--route=${key}`]],
      ["--max-usage", ["--max-usage", key]],
      ["an inline --max-usage", [`--max-usage=${key}`]],
      ["--strategy", ["--strategy", key]],
      ["a repeated --max-usage", ["--max-usage", "70", "--max-usage", key]],
    ];
    for (const [name, args] of cases) {
      const message = refusal(name, args);
      expect(message).toMatch(/^--[a-z-]+ /);
      expect(message).not.toContain(key);
      expect(message).not.toContain("sk-");
    }
  });
});

describe("--wait", () => {
  it.each([
    ["30m", 30],
    ["2h", 120],
    ["1h30m", 90],
    ["90m", 90],
  ])("takes %s as %d minutes", (value, minutes) => {
    expect(parseWait(value)).toBe(minutes * 60_000);
  });

  it("is five hours with no cap given", () => {
    expect(parseWait(undefined)).toBe(DEFAULT_WAIT_MS);
    expect(DEFAULT_WAIT_MS).toBe(5 * 60 * 60_000);
  });

  it.each(["", "0m", "30", "30s", "1d", "2H", "1.5h", "h", "-5m", "30m2h"])("refuses %j, naming the forms", (value) => {
    expect(() => parseWait(value)).toThrow("--wait takes a duration such as 30m, 2h or 1h30m: --wait=30m.");
  });

  it("is read by a run, bare or with its cap after =, and never takes the tool's next argument", () => {
    expect(readRunArgs(["claude", "--wait", "-p", "hi"])).toEqual({
      tool: "claude",
      options: {},
      waitMs: DEFAULT_WAIT_MS,
      toolArgs: ["-p", "hi"],
      sawSeparator: false,
    });
    expect(readRunArgs(["--route", "main", "--wait=1h30m", "fix it"])).toMatchObject({
      options: { route: "main" },
      waitMs: 90 * 60_000,
      toolArgs: ["fix it"],
    });
    expect(readRunArgs(["--route", "main"]).waitMs).toBeUndefined();
    // After the tool's part has begun, --wait is the tool's.
    expect(readRunArgs(["--route", "main", "-p", "--wait"])).toMatchObject({ toolArgs: ["-p", "--wait"] });
  });

  it("refuses a cap given after a space, and --wait twice", () => {
    for (const next of ["30m", "2h", "90"]) {
      expect(() => readRunArgs(["--route", "main", "--wait", next])).toThrow(
        "Give --wait its cap after =, as in --wait=30m.",
      );
    }
    expect(() => readRunArgs(["--wait", "--route", "main", "--wait=1h"])).toThrow(
      "--wait was given more than once. Pass it at most once.",
    );
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

describe("modelOf", () => {
  it.each([
    ["claude", ["--model", "opus", "-p", "hi"], "opus"],
    ["claude", ["-p", "hi", "--model=claude-opus-4-5"], "claude-opus-4-5"],
    ["claude", ["--model", "sonnet", "--model", "opus"], "opus"],
    ["claude", ["--model", "opus[1m]"], "opus[1m]"],
    // Claude Code has no -m, and its --fallback-model is not the session's model.
    ["claude", ["-m", "opus"], undefined],
    ["claude", ["--fallback-model", "opus"], undefined],
    ["claude", ["-p", "--model opus"], undefined],
    ["claude", ["-p", "--", "--model", "opus"], undefined],
    ["claude", ["--model"], undefined],
    ["claude", ["--model", "-p", "hi"], undefined],
    ["claude", [], undefined],
    ["codex", ["-m", "gpt-5.3-codex-spark"], "gpt-5.3-codex-spark"],
    ["codex", ["--model", "gpt-5.3-codex"], "gpt-5.3-codex"],
    ["codex", ["--model=gpt-5.3-codex"], "gpt-5.3-codex"],
    ["codex", ["-m=gpt-5.3-codex"], "gpt-5.3-codex"],
    ["codex", ["-mgpt-5.3-codex-spark"], "gpt-5.3-codex-spark"],
    ["codex", ["exec", "-m", "gpt-5.3-codex-spark", "fix the tests"], "gpt-5.3-codex-spark"],
    // A config override and a config profile may name a model too; neither is read.
    ["codex", ["-c", "model=gpt-5.3-codex-spark"], undefined],
    ["codex", ["-p", "fast", "exec", "hi"], undefined],
  ] as const)("%s %j names %s", (tool, args, expected) => {
    expect(modelOf(tool, [...args])).toBe(expected);
  });

  it("does not read a value shaped like a key, and changes nothing", () => {
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    const args = ["--model", key];
    expect(modelOf("claude", args)).toBeUndefined();
    expect(args).toEqual(["--model", key]);
  });
});

describe("parseModel", () => {
  it("takes a model name, trimmed, and refuses a blank one or a key without echoing it", () => {
    expect(parseModel(" opus ")).toBe("opus");
    expect(() => parseModel(" ")).toThrow("--model needs a value.");
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    expect(() => parseModel(key)).toThrow("That looks like an API key, not a model name.");
  });
});
