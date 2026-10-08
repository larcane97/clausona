import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { routesPaths } from "../core/routes-store.js";
import type { QuotaSnapshot, Registry } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import type { RouteIo } from "./route-create.js";
import { runRouted } from "./route-run.js";
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
  const io: RouteIo = {
    interactive: options.interactive ?? false,
    ask: async () => (answers.length ? (answers.shift() as string | null) : null),
    say: (text) => notes.push(stripAnsi(text)),
  };
  const launches: Array<[string, string[]]> = [];
  const launch = async (profile: string, toolArgs: string[]) => {
    launches.push([profile, toolArgs]);
    return 0;
  };
  return { deps, io, notes, launches, launch, paths };
}

const MAIN = { version: 1, routes: { main: { tool: "claude", from: ["*"], strategy: "headroom" } } };

describe("runRouted", () => {
  it("launches the picked profile with the tool's arguments, after a note", async () => {
    const s = setup({ routes: MAIN });
    expect(await runRouted(["--route", "main", "-p", "hi"], s.launch, s.io, s.deps)).toBe(0);
    expect(s.launches).toEqual([["claude:solo", ["-p", "hi"]]]);
    expect(s.notes).toEqual(["→ claude:solo · route main · usage 5% (5H) · headroom"]);
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
    expect(s.notes[0]).toBe("Route 'work' does not exist.");
    expect(s.launches).toHaveLength(1);
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

  it("names the existing routes when offering to create one", async () => {
    const s = setup({ routes: MAIN, interactive: true, answers: ["n"] });
    await expect(runRouted(["--route", "work"], s.launch, s.io, s.deps)).rejects.toThrow("Nothing was created");
    expect(s.notes[0]).toBe("Route 'work' does not exist. Existing routes: main.");
  });

  it("creates and runs nothing when the answer is no", async () => {
    const s = setup({ interactive: true, answers: ["n"] });
    await expect(runRouted(["--route", "work"], s.launch, s.io, s.deps)).rejects.toThrow(
      "Nothing was created, and nothing was run.",
    );
    expect(s.launches).toEqual([]);
  });

  it("runs the active profile for a tool with no route", async () => {
    const s = setup();
    await runRouted(["claude", "-p", "hi"], s.launch, s.io, s.deps);
    expect(s.launches).toEqual([["claude:a", ["-p", "hi"]]]);
    expect(s.notes).toEqual(["→ claude:a · active profile (no route)"]);
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

  it("spreads concurrent runs on a round-robin route", async () => {
    const s = setup({ routes: { version: 1, routes: { rr: { tool: "claude" } } } });
    let tick = 0;
    s.deps.clock = () => NOW + tick++;
    await Promise.all([1, 2, 3].map(() => runRouted(["--route", "rr"], s.launch, s.io, s.deps)));
    expect(s.launches.map(([profile]) => profile).sort()).toEqual(["claude:a", "claude:b", "claude:solo"]);
  });
});
