import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { routesPaths } from "../core/routes-store.js";
import type { QuotaSnapshot, Registry } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import type { RouteIo } from "./route-io.js";
import { runRouted, runTarget } from "./route-run.js";
import { NoAccountError, type RouteDeps, UnknownRouteError } from "./route-service.js";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REGISTRY: Registry = {
  version: 2,
  primarySources: { claude: "/home/u/.claude" },
  activeProfiles: { claude: "claude:a" },
  profiles: {
    "claude:a": { tool: "claude", configDir: "/home/u/.claude", email: "a@example.com", isPrimary: true },
    "claude:b": { tool: "claude", configDir: "/home/u/.claude-b", email: "b@example.com", mergeSessions: true },
    "claude:solo": { tool: "claude", configDir: "/home/u/.claude-solo", email: "s@example.com" },
  },
};

const snap = (n: number): QuotaSnapshot => ({
  state: "ok",
  fetchedAt: NOW,
  session: { usedPercent: n, resetsAt: null },
});

function setup(
  options: {
    registry?: Registry;
    quotas?: Record<string, QuotaSnapshot>;
    routes?: object;
    answers?: Array<string | null>;
    interactive?: boolean;
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-route-run-"));
  temps.push(dir);
  const paths = routesPaths(dir);
  if (options.routes) writeFileSync(paths.routesPath, JSON.stringify(options.routes));
  const deps: RouteDeps = {
    loadRegistry: async () => options.registry ?? REGISTRY,
    collectQuotas: async () => options.quotas ?? { "claude:a": snap(30), "claude:b": snap(10), "claude:solo": snap(5) },
    paths,
    clock: () => NOW,
    editText: async () => "",
  };
  const answers = [...(options.answers ?? [])];
  const notes: string[] = [];
  const confirmed: string[] = [];
  const next = () => (answers.length ? (answers.shift() as string | null) : null);
  const io: RouteIo = {
    interactive: options.interactive ?? false,
    ask: async () => next(),
    // As terminalIo reads a Y/n: Enter, y or yes; anything else, or a closed input, is no.
    confirm: async (question) => {
      confirmed.push(stripAnsi(question));
      const answer = next();
      return answer !== null && ["", "y", "yes"].includes(answer.toLowerCase());
    },
    say: (text) => notes.push(stripAnsi(text)),
  };
  const launches: Array<[string, string[]]> = [];
  const launch = async (profile: string, toolArgs: string[]) => {
    launches.push([profile, toolArgs]);
    return 0;
  };
  return { deps, io, notes, confirmed, launches, launch, paths };
}

const MAIN = { version: 1, routes: { main: { tool: "claude", from: ["*"], strategy: "headroom" } } };

/** Both tools registered, with an `all` route over them. */
const BOTH: Registry = {
  ...REGISTRY,
  profiles: {
    ...REGISTRY.profiles,
    "codex:x": { tool: "codex", configDir: "/home/u/.codex", email: "x@example.com", isPrimary: true },
    "codex:y": { tool: "codex", configDir: "/home/u/.codex-y", email: "y@example.com" },
  },
};
const ANY = { version: 1, routes: { any: { tool: "all", strategy: "headroom" } } };
const BOTH_QUOTAS = {
  "claude:a": snap(30),
  "claude:b": snap(10),
  "claude:solo": snap(5),
  "codex:x": snap(1),
  "codex:y": snap(2),
};

describe("runTarget", () => {
  it("resolves a profile as parseProfileRef does", () => {
    expect(runTarget("solo", REGISTRY)).toEqual({ tool: "claude", name: "solo", id: "claude:solo" });
  });

  it("says a prompt is not a profile or a tool, and how to pass it", () => {
    expect(() => runTarget("fix the bug", REGISTRY)).toThrow(
      "'fix the bug' is not a profile or a tool. To pass a prompt, name the tool: clausona run claude 'fix the bug'",
    );
    expect(() => runTarget("don't stop", REGISTRY)).toThrow(/clausona run claude 'don'\\''t stop'$/);
  });

  it("keeps saying a well-formed name is not found", () => {
    expect(() => runTarget("nobody", REGISTRY)).toThrow("Profile 'nobody' not found.");
    expect(() => runTarget("claude:nobody", REGISTRY)).toThrow("Profile 'claude:nobody' not found.");
    expect(() => runTarget("gemini:x", REGISTRY)).toThrow("Unknown tool 'gemini'. Use one of: claude, codex.");
  });

  it("never quotes a key, or a sentence with a token in it", () => {
    for (const input of [
      ["sk", "ant", "y".repeat(24)].join("-"),
      `use ${["ghp", "Ab".repeat(18)].join("_")} now`,
      `run ${["sk", "ant", "y".repeat(8)].join("-")}`,
    ]) {
      const error = (() => {
        try {
          runTarget(input, REGISTRY);
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error?.message).toMatch(/^That looks like an API key, not a profile name/);
      expect(error?.message).not.toContain(input);
    }
  });
});

describe("runRouted", () => {
  it("launches the picked profile with the tool's arguments, after a note", async () => {
    const s = setup({ routes: MAIN });
    expect(await runRouted(["--route", "main", "-p", "hi"], s.launch, s.io, s.deps)).toBe(0);
    expect(s.launches).toEqual([["claude:solo", ["-p", "hi"]]]);
    expect(s.notes).toEqual(["  ▸ claude:solo  route main, most room, 5% of 5H used"]);
  });

  it("keeps a resumed run to profiles that share sessions", async () => {
    const s = setup({ routes: MAIN });
    await runRouted(["--route", "main", "--resume", "abc"], s.launch, s.io, s.deps);
    expect(s.launches).toEqual([["claude:b", ["--resume", "abc"]]]);
  });

  it("keeps the route's own excludes when a run excludes one more", async () => {
    const registry: Registry = {
      ...REGISTRY,
      profiles: {
        ...REGISTRY.profiles,
        "claude:team-share": { tool: "claude", configDir: "/home/u/.claude-team-share", email: "t@example.com" },
      },
    };
    const s = setup({
      registry,
      routes: { version: 1, routes: { main: { tool: "claude", exclude: ["*-share"], strategy: "headroom" } } },
      quotas: { "claude:a": snap(30), "claude:b": snap(10), "claude:solo": snap(5), "claude:team-share": snap(1) },
    });
    const asked: string[][] = [];
    const collect = s.deps.collectQuotas;
    s.deps.collectQuotas = async (targets) => {
      asked.push(targets.map((target) => target.id));
      return collect(targets);
    };
    await runRouted(["--route", "main", "--exclude", "solo", "-p", "hi"], s.launch, s.io, s.deps);
    expect(asked).toEqual([["claude:a", "claude:b"]]);
    expect(s.launches).toEqual([["claude:b", ["-p", "hi"]]]);
  });

  it("refuses a profile after routing options, launching and recording nothing", async () => {
    for (const args of [
      ["--route", "main", "claude:b"],
      ["--route", "main", "solo", "-p", "hi"],
      ["claude", "--from", "a,b", "solo"],
    ]) {
      const s = setup({ routes: MAIN });
      await expect(runRouted(args, s.launch, s.io, s.deps)).rejects.toThrow(
        "Routing options cannot be combined with a profile. Run it by name: clausona run <profile> …, or put it after -- to pass it to the tool.",
      );
      expect(s.launches).toEqual([]);
      expect(() => readFileSync(s.paths.picksPath)).toThrow();
    }
    // Before an unknown route is offered, so nothing is created either.
    const s = setup({ interactive: true, answers: ["y"] });
    await expect(runRouted(["--route", "work", "claude:b"], s.launch, s.io, s.deps)).rejects.toThrow(
      /^Routing options cannot be combined with a profile\./,
    );
    expect(() => readFileSync(s.paths.routesPath)).toThrow();
    expect(s.notes).toEqual([]);
  });

  it("passes a profile's name to the tool after --, and a word that names no profile as it is", async () => {
    const s = setup({ routes: MAIN });
    await runRouted(["--route", "main", "--", "claude:b"], s.launch, s.io, s.deps);
    await runRouted(["--route", "main", "hello"], s.launch, s.io, s.deps);
    expect(s.launches).toEqual([
      ["claude:solo", ["claude:b"]],
      ["claude:solo", ["hello"]],
    ]);
  });

  it("exits 75 when nobody can be picked", async () => {
    const s = setup({ routes: MAIN, quotas: { "claude:a": snap(99), "claude:b": snap(99), "claude:solo": snap(99) } });
    const error = (await runRouted(["--route", "main"], s.launch, s.io, s.deps).catch(
      (e: unknown) => e,
    )) as NoAccountError;
    expect(error).toBeInstanceOf(NoAccountError);
    expect(error.exitCode).toBe(75);
    expect(s.launches).toEqual([]);
  });

  it("refuses an unknown route without a terminal, and writes nothing", async () => {
    const s = setup();
    await expect(runRouted(["--route", "work"], s.launch, s.io, s.deps)).rejects.toBeInstanceOf(UnknownRouteError);
    expect(() => readFileSync(s.paths.routesPath)).toThrow();
  });

  it("takes a route name every object has for an unknown route, not for one in routes.json", async () => {
    const s = setup({ routes: MAIN });
    await expect(runRouted(["--route", "constructor"], s.launch, s.io, s.deps)).rejects.toBeInstanceOf(
      UnknownRouteError,
    );
    expect(s.launches).toEqual([]);
  });

  it("offers to create an unknown route in a terminal, then runs on it", async () => {
    const s = setup({ interactive: true, answers: ["y"] });
    await runRouted(["--route", "work", "-p", "hi"], s.launch, s.io, s.deps);
    expect(JSON.parse(readFileSync(s.paths.routesPath, "utf8")).routes.work).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    });
    expect(s.notes[0]).toContain("Route work does not exist yet. It would take every claude account,");
    expect(s.notes[0]).toContain("claude:solo 5%");
    expect(s.confirmed).toEqual(["  Create it and run? (Y/n) "]);
    expect(s.launches).toEqual([["claude:solo", ["-p", "hi"]]]);
  });

  it("proposes the run's options over the defaults, and asks once", async () => {
    const s = setup({ interactive: true, answers: ["", "y"] });
    await runRouted(["--route", "work", "--strategy", "headroom", "--exclude", "solo"], s.launch, s.io, s.deps);
    expect(JSON.parse(readFileSync(s.paths.routesPath, "utf8")).routes.work).toEqual({
      tool: "claude",
      from: ["*"],
      exclude: ["solo"],
      strategy: "headroom",
      maxUsage: 80,
      reserveUsage: 95,
    });
    expect(s.notes[0]).toContain("taking the one with the most room");
    expect(s.confirmed).toHaveLength(1);
    expect(s.launches).toEqual([["claude:b", []]]);
  });

  it("creates an unknown route for the tool the run names, or its --from prefixes say", async () => {
    const named = setup({ registry: BOTH, quotas: BOTH_QUOTAS, interactive: true, answers: ["y"] });
    await runRouted(["codex", "--route", "work"], named.launch, named.io, named.deps);
    expect(JSON.parse(readFileSync(named.paths.routesPath, "utf8")).routes.work.tool).toBe("codex");
    expect(named.notes[0]).toContain("It would take every codex account,");
    expect(named.launches).toEqual([["codex:x", []]]);

    const prefixed = setup({ registry: BOTH, quotas: BOTH_QUOTAS, interactive: true, answers: ["y"] });
    await runRouted(["--route", "work", "--from", "codex:*"], prefixed.launch, prefixed.io, prefixed.deps);
    expect(JSON.parse(readFileSync(prefixed.paths.routesPath, "utf8")).routes.work).toMatchObject({
      tool: "codex",
      from: ["codex:*"],
    });
  });

  it("never shows or stores a key given to --from while offering to create a route", async () => {
    // Short, and not starting with sk-: only a check for a key anywhere in it catches the second.
    for (const key of [["sk", "ant", "y".repeat(24)].join("-"), ["hf", "Ab".repeat(17)].join("_")]) {
      const s = setup({ interactive: true, answers: ["y"] });
      const error = (await runRouted(["--route", "work", "--from", key], s.launch, s.io, s.deps).catch(
        (e: unknown) => e,
      )) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(key);
      expect(s.notes.join("\n")).not.toContain(key);
      expect(() => readFileSync(s.paths.routesPath)).toThrow();
      expect(s.launches).toEqual([]);
    }
  });

  it("refuses to create a route of an API profile, as route add does", async () => {
    const registry: Registry = {
      ...REGISTRY,
      profiles: { ...REGISTRY.profiles, "claude:glm": { tool: "claude", kind: "api", configDir: "/x", email: "" } },
    };
    const s = setup({ registry, interactive: true, answers: ["y"] });
    await expect(runRouted(["--route", "work", "--from", "glm"], s.launch, s.io, s.deps)).rejects.toThrow(
      /claude:glm is an API profile/,
    );
    expect(() => readFileSync(s.paths.routesPath)).toThrow();
  });

  it("writes the reserve out when a cut above 95% moved it, as route add does", async () => {
    const s = setup({ interactive: true, answers: ["y"] });
    await runRouted(["--route", "work", "--max-usage", "98"], s.launch, s.io, s.deps);
    expect(JSON.parse(readFileSync(s.paths.routesPath, "utf8")).routes.work).toMatchObject({
      maxUsage: 98,
      reserveUsage: 98,
    });
  });

  it("creates and runs nothing when the answer is no, or the input closes", async () => {
    for (const answer of ["n", null]) {
      const s = setup({ routes: MAIN, interactive: true, answers: [answer] });
      await expect(runRouted(["--route", "work"], s.launch, s.io, s.deps)).rejects.toThrow(
        /^Nothing was created, and nothing was run\.$/,
      );
      expect(JSON.parse(readFileSync(s.paths.routesPath, "utf8")).routes).toEqual(MAIN.routes);
      expect(() => readFileSync(s.paths.picksPath)).toThrow();
      expect(s.launches).toEqual([]);
    }
    const fresh = setup({ interactive: true, answers: ["n"] });
    await expect(runRouted(["--route", "work"], fresh.launch, fresh.io, fresh.deps)).rejects.toThrow(
      "Nothing was created, and nothing was run.",
    );
    expect(() => readFileSync(fresh.paths.routesPath)).toThrow();
  });

  it("runs the active profile for a tool with no route", async () => {
    const s = setup();
    await runRouted(["claude", "-p", "hi"], s.launch, s.io, s.deps);
    expect(s.launches).toEqual([["claude:a", ["-p", "hi"]]]);
    expect(s.notes).toEqual(["  ▸ claude:a  active profile (no route)"]);
  });

  it("refuses routing options that name no route, rather than running the active profile", async () => {
    const s = setup();
    await expect(runRouted(["claude", "--exclude", "x", "-p", "hi"], s.launch, s.io, s.deps)).rejects.toThrow(
      "--exclude needs --route <name> or --from <patterns>.",
    );
    expect(s.launches).toEqual([]);
  });

  it("treats a registered profile named claude as that profile", async () => {
    const registry: Registry = {
      ...REGISTRY,
      profiles: { ...REGISTRY.profiles, "codex:claude": { tool: "codex", configDir: "/x", email: "x@example.com" } },
    };
    const s = setup({ registry });
    await runRouted(["claude", "--", "-p", "hi"], s.launch, s.io, s.deps);
    expect(s.launches).toEqual([["claude", ["-p", "hi"]]]);
  });

  it("asks for a route, a tool or a profile when given none", async () => {
    const s = setup();
    await expect(runRouted(["-p", "hi"], s.launch, s.io, s.deps)).rejects.toThrow(/^Name a route, a tool or a profile/);
  });

  describe("on an all route", () => {
    it("refuses the tool's arguments without a tool word, launching and recording nothing", async () => {
      const s = setup({ registry: BOTH, quotas: BOTH_QUOTAS, routes: ANY });
      await expect(runRouted(["--route", "any", "-p", "hi"], s.launch, s.io, s.deps)).rejects.toThrow(
        /^Route any has claude and codex accounts\. Say which tool these arguments are for: csn run claude --route any … \(or codex\)\.$/,
      );
      await expect(runRouted(["--route", "any", "--", "exec", "hi"], s.launch, s.io, s.deps)).rejects.toThrow(
        /^Route any has claude and codex accounts\./,
      );
      expect(s.launches).toEqual([]);
      expect(() => readFileSync(s.paths.picksPath)).toThrow();
    });

    it("launches whichever tool's account is picked when there are no arguments", async () => {
      const s = setup({ registry: BOTH, quotas: BOTH_QUOTAS, routes: ANY });
      await runRouted(["--route", "any"], s.launch, s.io, s.deps);
      expect(s.launches).toEqual([["codex:x", []]]);
      expect(s.notes).toEqual(["  ▸ codex:x  route any, most room, 1% of 5H used"]);
    });

    it("ranks only the named tool's members, and resumes within that tool", async () => {
      const s = setup({ registry: BOTH, quotas: BOTH_QUOTAS, routes: ANY });
      const asked: string[][] = [];
      const collect = s.deps.collectQuotas;
      s.deps.collectQuotas = async (targets) => {
        asked.push(targets.map((target) => target.id));
        return collect(targets);
      };
      await runRouted(["claude", "--route", "any", "--resume", "x"], s.launch, s.io, s.deps);
      // codex:x shares sessions and has the most room, but the run is claude's.
      expect(asked).toEqual([["claude:a", "claude:b"]]);
      expect(s.launches).toEqual([["claude:b", ["--resume", "x"]]]);
      await runRouted(["codex", "--route", "any", "resume"], s.launch, s.io, s.deps);
      expect(asked[1]).toEqual(["codex:x"]);
      expect(s.launches[1]).toEqual(["codex:x", ["resume"]]);
    });

    it("names the tool, and explains only it, when nobody of the narrowed tool is free", async () => {
      const quotas = { ...BOTH_QUOTAS, "claude:a": snap(99), "claude:b": snap(99), "claude:solo": snap(99) };
      const s = setup({ registry: BOTH, quotas, routes: ANY });
      const error = (await runRouted(["claude", "--route", "any", "-p", "hi"], s.launch, s.io, s.deps).catch(
        (e: unknown) => e,
      )) as NoAccountError;
      expect(error).toBeInstanceOf(NoAccountError);
      const text = stripAnsi(error.message);
      expect(text.split("\n")[0]).toBe("No claude account in route any is free right now.");
      expect(text).toContain("csn route explain any --tool claude");
      expect(text).not.toContain("codex:");
      expect(s.launches).toEqual([]);
    });

    it("refuses a profile of either tool after the routing options, unless a tool word narrows it", async () => {
      for (const args of [
        ["--route", "any", "claude:b"],
        ["--route", "any", "y"],
      ]) {
        const s = setup({ registry: BOTH, quotas: BOTH_QUOTAS, routes: ANY });
        await expect(runRouted(args, s.launch, s.io, s.deps)).rejects.toThrow(
          /^Routing options cannot be combined with a profile\./,
        );
        expect(s.launches).toEqual([]);
      }
      // `y` is only a codex profile, so to a claude run it is the tool's argument.
      const s = setup({ registry: BOTH, quotas: BOTH_QUOTAS, routes: ANY });
      await runRouted(["claude", "--route", "any", "y"], s.launch, s.io, s.deps);
      expect(s.launches).toEqual([["claude:solo", ["y"]]]);
    });
  });

  it("spreads concurrent runs on a round-robin route", async () => {
    const s = setup({ routes: { version: 1, routes: { rr: { tool: "claude" } } } });
    let tick = 0;
    s.deps.clock = () => NOW + tick++;
    await Promise.all([1, 2, 3].map(() => runRouted(["--route", "rr"], s.launch, s.io, s.deps)));
    expect(s.launches.map(([profile]) => profile).sort()).toEqual(["claude:a", "claude:b", "claude:solo"]);
  });
});
