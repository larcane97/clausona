import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { routesPaths } from "./core/routes-store.js";
import { stripAnsi } from "./lib/cli-style.js";
import type { RouteIo } from "./lib/route-create.js";
import { NoAccountError, type RouteDeps } from "./lib/route-service.js";
import { runRouteCommand } from "./route-commands.js";
import type { QuotaSnapshot, Registry } from "./types.js";

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
    "claude:b": { tool: "claude", configDir: "/home/u/.claude-b", email: "b@corp.example.com", mergeSessions: true },
    "claude:c": { tool: "claude", configDir: "/home/u/.claude-c", email: "c@corp.example.com" },
    "claude:glm": { tool: "claude", kind: "api", configDir: "/home/u/.claude-glm", email: "" },
  },
};

const snap = (five: number, seven: number): QuotaSnapshot => ({
  state: "ok",
  fetchedAt: NOW,
  session: { usedPercent: five, resetsAt: new Date(NOW + 3_600_000).toISOString() },
  weekly: { usedPercent: seven, resetsAt: null },
});

function setup(
  quotas: Record<string, QuotaSnapshot> = {
    "claude:a": snap(10, 10),
    "claude:b": snap(20, 20),
    "claude:c": snap(30, 30),
  },
) {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-route-cmd-"));
  temps.push(dir);
  const deps: RouteDeps = {
    loadRegistry: async () => REGISTRY,
    collectQuotas: async () => quotas,
    paths: routesPaths(dir),
    clock: () => NOW,
    editText: async () => {
      throw new Error("no editor");
    },
  };
  const io: RouteIo = { interactive: false, ask: async () => null, say: () => {} };
  const run = async (...args: string[]) => stripAnsi(await runRouteCommand(args, io, deps));
  const file = () => JSON.parse(readFileSync(deps.paths.routesPath, "utf8"));
  return { deps, io, run, file };
}

describe("route help", () => {
  it("is enough for an agent on its own", async () => {
    const { run } = setup();
    const help = await run("--help");
    for (const text of [
      "list",
      "add <name>",
      "set <name>",
      "explain <name>",
      "pick <name>",
      "FOR AGENTS",
      "EXIT CODES",
      "75",
    ]) {
      expect(help).toContain(text);
    }
  });

  it("has a page per subcommand", async () => {
    const { run } = setup();
    expect(await run("add", "--help")).toContain("clausona route add <name>");
    expect(await run("pick", "-h")).toContain("--json");
  });
});

describe("route add", () => {
  it("creates a route with the defaults written out", async () => {
    const { run, file } = setup();
    const out = await run("add", "main", "--tool", "claude");
    expect(out).toContain("Created route main");
    expect(out).toContain("clausona run --route main");
    expect(file().routes.main).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    });
  });

  it("takes the tool from the registry when only one tool has accounts", async () => {
    const { run, file } = setup();
    await run("add", "main");
    expect(file().routes.main.tool).toBe("claude");
  });

  it("stores the fields given", async () => {
    const { run, file } = setup();
    await run(
      "add",
      "work",
      "--from",
      "*@corp.example.com",
      "--exclude",
      "c",
      "--strategy",
      "headroom",
      "--max-usage",
      "70",
    );
    expect(file().routes.work).toEqual({
      tool: "claude",
      from: ["*@corp.example.com"],
      exclude: ["c"],
      strategy: "headroom",
      maxUsage: 70,
      reserveUsage: 95,
    });
  });

  it("refuses an existing name, an API profile and a bad name", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("add", "main")).rejects.toThrow(
      "Route 'main' already exists. Change it with clausona route set main …",
    );
    await expect(run("add", "api", "--from", "glm")).rejects.toThrow(/claude:glm is an API profile/);
    await expect(run("add", "a b")).rejects.toThrow(/Invalid route name/);
  });

  it("asks for --tool, and says why, when it cannot tell the tool", async () => {
    const { deps, io } = setup();
    const withRegistry = (profiles: Registry["profiles"]): RouteDeps => ({
      ...deps,
      loadRegistry: async () => ({ ...REGISTRY, profiles }),
    });
    const both = withRegistry({
      ...REGISTRY.profiles,
      "codex:x": { tool: "codex", configDir: "/home/u/.codex", email: "x@example.com" },
    });
    await expect(runRouteCommand(["add", "main"], io, both)).rejects.toThrow(
      "Pass --tool claude or --tool codex: there are accounts for both.",
    );
    const apiOnly = withRegistry({ "claude:glm": REGISTRY.profiles["claude:glm"] });
    await expect(runRouteCommand(["add", "main"], io, apiOnly)).rejects.toThrow(
      "Pass --tool claude or --tool codex: no subscription account is registered yet.",
    );
  });

  it("asks before creating in a terminal, and creates nothing on no", async () => {
    const { deps } = setup();
    const said: string[] = [];
    const io: RouteIo = { interactive: true, ask: async () => "n", say: (text) => said.push(stripAnsi(text)) };
    expect(stripAnsi(await runRouteCommand(["add", "main"], io, deps))).toBe("Nothing was created.");
    expect(said.join("\n")).toContain("Create 'main' now?");
    expect(() => readFileSync(deps.paths.routesPath)).toThrow();
  });
});

describe("route set, rename, remove", () => {
  it("changes only the fields given", async () => {
    const { run, file } = setup();
    await run("add", "main");
    await run("set", "main", "--strategy", "headroom", "--fallback", "c");
    expect(file().routes.main).toMatchObject({ strategy: "headroom", fallback: ["c"], from: ["*"] });
    await run("set", "main", "--no-fallback");
    expect(file().routes.main.fallback).toBeUndefined();
  });

  it("adds and drops members one at a time", async () => {
    const { run, file } = setup();
    await run("add", "two", "--from", "a,b");
    await run("set", "two", "--add", "c", "--drop", "a");
    expect(file().routes.two.from).toEqual(["b", "c"]);
  });

  it("points at --exclude when a dropped name is not in from", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("set", "main", "--drop", "b")).rejects.toThrow(
      "'b' is not in main's from list (*). To leave an account out of a pattern, use --exclude b.",
    );
  });

  it("never quotes a key given to --drop, --from or --add", async () => {
    const { run, file } = setup();
    await run("add", "main");
    const key = ["sk", "ant", "y".repeat(24)].join("-");
    for (const args of [
      ["--drop", key],
      ["--from", key, "--drop", "b"],
      ["--add", key],
    ]) {
      const error = (await run("set", "main", ...args).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(key);
    }
    expect(file().routes.main.from).toEqual(["*"]);
  });

  it("refuses to change nothing, and an unknown route", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("set", "main")).rejects.toThrow(/^Nothing to change/);
    await expect(run("set", "work", "--strategy", "headroom")).rejects.toThrow(/Route 'work' does not exist/);
  });

  it("renames and removes", async () => {
    const { run, file } = setup();
    await run("add", "main");
    await run("rename", "main", "all");
    expect(Object.keys(file().routes)).toEqual(["all"]);
    expect(await run("remove", "all")).toContain("Removed route all");
    expect(file().routes).toEqual({});
  });
});

describe("route list", () => {
  it("says how to start when there are no routes", async () => {
    const { run } = setup();
    expect(await run("list")).toMatch(/^No routes yet\. Create one: clausona route add <name>/);
  });

  it("takes no route name", async () => {
    const { run } = setup();
    await expect(run("list", "main")).rejects.toThrow("Usage: clausona route list [--json]");
  });

  // Review Focus 5 (list side): a removed profile named in a route is pointed out.
  it("warns about names that are not registered", async () => {
    const { run, deps } = setup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude", from: ["gone", "*"] } } }),
    );
    const out = await run("list");
    expect(out).toContain("main");
    expect(out).toContain("⚠ 'gone' is not registered");
    const json = JSON.parse(await run("list", "--json"));
    expect(json.routes[0]).toMatchObject({
      name: "main",
      members: ["claude:a", "claude:b", "claude:c"],
      unknownNames: ["gone"],
    });
  });
});

describe("route explain and pick", () => {
  it("explains without recording", async () => {
    const { run, deps } = setup();
    await run("add", "main");
    const out = await run("explain", "main");
    expect(out).toMatch(/→ claude:a/);
    expect(() => readFileSync(deps.paths.picksPath)).toThrow();
    const json = JSON.parse(await run("explain", "main", "--json"));
    expect(json).toMatchObject({ route: "main", resolvedBy: "flag", outcome: { kind: "picked", id: "claude:a" } });
  });

  it("explains an unsaved route", async () => {
    const { run } = setup();
    expect(await run("explain", "--tool", "claude", "--from", "b,c")).toContain("inline route");
  });

  it("picks in turn and records each pick", async () => {
    const { run } = setup();
    await run("add", "main");
    expect([await run("pick", "main"), await run("pick", "main"), await run("pick", "main")]).toEqual([
      "claude:a",
      "claude:b",
      "claude:c",
    ]);
    expect(JSON.parse(await run("pick", "main", "--json"))).toMatchObject({ profile: "claude:a", stage: "pool" });
  });

  it("fails with exit code 75 when nobody can be picked, as JSON when asked", async () => {
    const { run } = setup({ "claude:a": snap(99, 0), "claude:b": snap(99, 0), "claude:c": snap(99, 0) });
    await run("add", "main");
    const error = (await run("pick", "main").catch((e: unknown) => e)) as NoAccountError;
    expect(error).toBeInstanceOf(NoAccountError);
    expect(error.exitCode).toBe(75);
    expect(stripAnsi(error.message)).toContain("No account is available for route main.");
    const jsonError = (await run("pick", "main", "--json").catch((e: unknown) => e)) as NoAccountError;
    expect(JSON.parse(jsonError.stdout ?? "")).toMatchObject({ profile: null });
  });
});

describe("unknown subcommands", () => {
  it("names the help, and never echoes a key typed in its place", async () => {
    const { run } = setup();
    await expect(run("frobnicate")).rejects.toThrow(
      "Unknown route command 'frobnicate'. Run `clausona route --help` for the list.",
    );
    const key = ["sk", "ant", "y".repeat(24)].join("-");
    const error = (await run(key).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(key);
    // Short, and not starting with sk-: only a check for a key anywhere in it catches this one.
    const token = ["hf", "Ab".repeat(17)].join("_");
    const tokenError = (await run(token).catch((e: unknown) => e)) as Error;
    expect(tokenError.message).toBe("That is not a route command. Run `clausona route --help` for the list.");
  });
});
