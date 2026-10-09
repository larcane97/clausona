import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
import { routesPaths } from "./core/routes-store.js";
import { stripAnsi } from "./lib/cli-style.js";
import type { RouteIo } from "./lib/route-io.js";
import { renderRoutesEmpty } from "./lib/route-render.js";
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
    "codex:x": { tool: "codex", configDir: "/home/u/.codex", email: "x@example.com" },
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
    "codex:x": snap(5, 5),
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
  const io: RouteIo = { interactive: false, ask: async () => null, say: () => {}, confirm: async () => false };
  const run = async (...args: string[]) => stripAnsi(await runRouteCommand(args, io, deps));
  const file = () => JSON.parse(readFileSync(deps.paths.routesPath, "utf8"));
  return { deps, io, run, file };
}

/** A terminal that fails the test if anything asks it a question. */
const NEVER_ASKS: RouteIo = {
  interactive: true,
  ask: async () => {
    throw new Error("asked a question");
  },
  confirm: async () => {
    throw new Error("asked to confirm");
  },
  say: () => {},
};

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
    // The docs as an installed clausona can reach them: there is no docs/ folder on that machine.
    expect(help).toContain("Docs: https://github.com/larcane97/clausona/blob/main/docs/routing.md");
  });

  it("shows the overview for a word that is not a subcommand, even one every object has", async () => {
    const { run } = setup();
    for (const sub of ["toString", "constructor", "hasOwnProperty"]) {
      expect(await run(sub, "--help")).toContain("COMMANDS");
    }
  });

  it("has a page per subcommand", async () => {
    const { run } = setup();
    expect(await run("add", "--help")).toContain("clausona route add <name>");
    expect(await run("pick", "-h")).toContain("--json");
  });

  it("is what route prints with no arguments outside a terminal", async () => {
    const { run } = setup();
    expect(await run()).toBe(await run("--help"));
  });

  it("gives way to the Routes screen with no arguments in a terminal, and still prints on --help", async () => {
    const { deps } = setup();
    expect(await runRouteCommand([], NEVER_ASKS, deps)).toBe("__OPEN_TUI__:routes");
    expect(stripAnsi(await runRouteCommand(["--help"], NEVER_ASKS, deps))).toContain("COMMANDS");
  });

  it("says add takes --tool, defaults to claude, and asks nothing", async () => {
    const { run } = setup();
    const add = await run("add", "--help");
    expect(add).toMatch(/--tool <tool>\s+claude \(default\), codex or all/);
    expect(add).not.toContain("--yes");
    const overview = await run("--help");
    expect(overview).toContain("add and set never ask; run asks one Y/n only for an unknown route in a terminal");
    expect(overview).toMatch(/\(no arguments\)\s+In a terminal, open the Routes screen of the dashboard/);
  });

  it("says a run's --exclude adds to the route's list, and route set's replaces it", async () => {
    const { run } = setup();
    expect(await run("set", "--help")).toMatch(/--exclude <patterns>\s+Replace the route's exclude list/);
    expect(stripAnsi(await runCommand("run", ["--help"]))).toMatch(
      /--exclude <patterns>\s+Also leave these out for this run/,
    );
  });

  it("says in run's help that a profile does not go with routing options", async () => {
    expect(stripAnsi(await runCommand("run", ["--help"]))).toContain(
      "A profile after routing options is an error; after a -- it goes to the tool.",
    );
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

  it("makes a claude route when both tools have accounts, and asks nothing even in a terminal", async () => {
    const { deps, file } = setup();
    const out = stripAnsi(await runRouteCommand(["add", "main"], NEVER_ASKS, deps));
    expect(file().routes.main.tool).toBe("claude");
    const lines = out.split("\n");
    expect(lines[0]).toBe("  ✔ Created route main");
    expect(out).toContain("╭─ main ─");
    expect(out).toMatch(/^ {2}▸ claude:a\s.*picked next$/m);
    expect(out).not.toContain("codex:x");
    expect(lines.slice(-2)).toEqual(["    Run on it: clausona run --route main", ""]);
    expect(out).not.toContain("See the ranking");
  });

  it("takes --tool all, and the tool the --from prefixes say", async () => {
    const { run, file } = setup();
    await run("add", "any", "--tool", "all");
    await run("add", "cx", "--from", "codex:*");
    await run("add", "both", "--from", "claude:a,codex:x");
    expect(file().routes.any.tool).toBe("all");
    expect(file().routes.cx.tool).toBe("codex");
    expect(file().routes.both.tool).toBe("all");
    await expect(run("add", "bad", "--tool", "gpt")).rejects.toThrow(/^--tool must be claude, codex or all\.$/);
  });

  it("still accepts --yes and -y, which scripts pass, and asks nothing either way", async () => {
    const { deps, file } = setup();
    await runRouteCommand(["add", "main", "--yes"], NEVER_ASKS, deps);
    await runRouteCommand(["add", "other", "-y"], NEVER_ASKS, deps);
    expect(Object.keys(file().routes).sort()).toEqual(["main", "other"]);
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

  it("stores and prints nothing of a vendor token given as a route name", async () => {
    const { run, file } = setup();
    await run("add", "main");
    // Short, and not starting with sk-: only a check for a key anywhere in it catches it.
    const token = ["hf", "Ab".repeat(17)].join("_");
    for (const args of [
      ["add", token],
      ["set", token, "--strategy", "headroom"],
      ["rename", "main", token],
      ["rename", token, "other"],
      ["remove", token],
      ["explain", token],
      ["pick", token],
    ]) {
      const error = (await run(...args).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("That looks like an API key, not a route name.");
    }
    expect(Object.keys(file().routes)).toEqual(["main"]);
  });

  it("makes a claude route when neither --tool nor the --from prefixes say otherwise", async () => {
    const { deps, io, file } = setup();
    const both: RouteDeps = {
      ...deps,
      loadRegistry: async () => ({
        ...REGISTRY,
        profiles: {
          ...REGISTRY.profiles,
          "codex:x": { tool: "codex", configDir: "/home/u/.codex", email: "x@example.com" },
        },
      }),
    };
    await runRouteCommand(["add", "main"], io, both);
    await runRouteCommand(["add", "cx", "--from", "codex:*"], io, both);
    expect(file().routes.main.tool).toBe("claude");
    expect(file().routes.cx.tool).toBe("codex");
  });
});

describe("route set, rename, remove", () => {
  it("shows the route as it is after the change", async () => {
    const { deps, file } = setup();
    await runRouteCommand(["add", "main"], NEVER_ASKS, deps);
    const out = stripAnsi(await runRouteCommand(["set", "main", "--strategy", "headroom"], NEVER_ASKS, deps));
    expect(out.split("\n")[0]).toBe("  ✔ Updated route main");
    expect(out).toContain("╭─ main ─");
    expect(out).toMatch(/Strategy {3}headroom \(most room first\)/);
    expect(file().routes.main.strategy).toBe("headroom");
  });

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

  it("says how to go on when --drop would leave from empty, and changes nothing", async () => {
    const { run, file } = setup();
    await run("add", "main");
    await expect(run("set", "main", "--drop", "*")).rejects.toThrow(
      /^A route needs at least one entry in from; add one with --add, or remove the route\.$/,
    );
    expect(file().routes.main.from).toEqual(["*"]);
    await run("set", "main", "--drop", "*", "--add", "a");
    expect(file().routes.main.from).toEqual(["a"]);
  });

  it("points at --exclude when a dropped name is not in from", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("set", "main", "--drop", "b")).rejects.toThrow(
      "'b' is not in main's from list (*). To leave an account out of a pattern, use --exclude b.",
    );
  });

  it("never quotes or stores a key given to --drop, --from or --add", async () => {
    const { run, file, deps } = setup();
    await run("add", "main");
    // The second is short and does not start with sk-: only a check for a key anywhere in it catches it.
    for (const key of [["sk", "ant", "y".repeat(24)].join("-"), ["hf", "Ab".repeat(17)].join("_")]) {
      for (const args of [
        ["set", "main", "--drop", key],
        ["set", "main", "--from", key, "--drop", "b"],
        ["set", "main", "--add", key],
        ["add", "other", "--from", key],
        ["explain", "--tool", "claude", "--from", key],
      ]) {
        const error = (await run(...args).catch((e: unknown) => e)) as Error;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(key);
      }
      expect(readFileSync(deps.paths.routesPath, "utf8")).not.toContain(key);
    }
    expect(Object.keys(file().routes)).toEqual(["main"]);
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

  // Every object has these, so a lookup that is not of own keys finds one in every routes.json.
  it("takes names every object has as route names like any other", async () => {
    const { run, file } = setup();
    await run("add", "main");
    await expect(run("remove", "toString")).rejects.toThrow(/^Route 'toString' does not exist\./);
    await expect(run("set", "constructor", "--strategy", "headroom")).rejects.toThrow(
      /^Route 'constructor' does not exist\./,
    );
    await expect(run("rename", "valueOf", "other")).rejects.toThrow(/^Route 'valueOf' does not exist\./);
    await expect(run("explain", "hasOwnProperty")).rejects.toThrow(/^Route 'hasOwnProperty' does not exist\./);
    expect(Object.keys(file().routes)).toEqual(["main"]);

    expect(await run("add", "toString")).toContain("Created route toString");
    expect(file().routes.toString).toMatchObject({ tool: "claude", from: ["*"] });
    await run("rename", "main", "constructor");
    expect(Object.keys(file().routes).sort()).toEqual(["constructor", "toString"]);
    expect(await run("remove", "toString")).toContain("Removed route toString");
    expect(Object.keys(file().routes)).toEqual(["constructor"]);
  });
});

describe("route list", () => {
  it("says how to start when there are no routes", async () => {
    const { run } = setup();
    expect(await run("list")).toBe(stripAnsi(renderRoutesEmpty()));
  });

  it("takes no route name", async () => {
    const { run } = setup();
    await expect(run("list", "main")).rejects.toThrow("Usage: clausona route list [--json] [--no-quota]");
  });

  it("ranks every route, so who is free now and who is next show", async () => {
    const { run, deps } = setup({
      "claude:a": snap(10, 10),
      "claude:b": snap(85, 20),
      "claude:c": snap(30, 30),
      "codex:x": snap(5, 5),
    });
    await run("add", "main");
    await run("add", "any", "--tool", "all", "--strategy", "headroom");
    const out = await run("list");
    expect(out).toMatch(/^ {4}any\s+claude \+ codex\s+headroom\s+80% \/ 95%\s+3 of 4\s+codex:x$/m);
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80% \/ 95%\s+2 of 3\s+claude:a$/m);
    // Ranked as explain ranks, so nothing is recorded.
    expect(() => readFileSync(deps.paths.picksPath)).toThrow();
  });

  it("reads no quota with --no-quota, and says so with a dash", async () => {
    const { run, deps } = setup();
    await run("add", "main");
    let reads = 0;
    deps.collectQuotas = async () => {
      reads++;
      return {};
    };
    const out = await run("list", "--no-quota");
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80% \/ 95%\s+—\s+—$/m);
    expect(reads).toBe(0);
    await run("list", "--json");
    expect(reads).toBe(0);
  });

  // Review Focus 5 (list side): a removed profile named in a route is pointed out.
  it("warns about names that are not registered", async () => {
    const { run, deps } = setup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude", from: ["gone", "*"] } } }),
    );
    const out = await run("list");
    expect(out).toMatch(/^ {4}ROUTE\s+TOOL\s+STRATEGY\s+LIMITS\s+FREE NOW\s+NEXT$/m);
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80% \/ 95%/m);
    expect(out).toContain("  ⚠ main names 'gone', which is not a registered profile.");
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
    expect(out).toContain("╭─ main ─");
    expect(out).toMatch(/^ {2}▸ claude:a\s.*picked next$/m);
    expect(() => readFileSync(deps.paths.picksPath)).toThrow();
    const json = JSON.parse(await run("explain", "main", "--json"));
    expect(json).toMatchObject({ route: "main", resolvedBy: "flag", outcome: { kind: "picked", id: "claude:a" } });
  });

  it("adds a run-time --exclude to the route's own, while route set --exclude replaces it", async () => {
    const { run, file } = setup();
    await run("add", "main", "--exclude", "c");
    const json = JSON.parse(await run("explain", "main", "--exclude", "a", "--json"));
    expect(json.settings.exclude).toEqual(["c", "a"]);
    expect(json.members.map((member: { profile: string }) => member.profile)).toEqual(["claude:b"]);
    expect(await run("pick", "main", "--exclude", "b")).toBe("claude:a");
    await run("set", "main", "--exclude", "b");
    expect(file().routes.main.exclude).toEqual(["b"]);
  });

  it("explains an unsaved route", async () => {
    const { run } = setup();
    expect(await run("explain", "--tool", "claude", "--from", "b,c")).toContain("inline route");
    const none = await run(
      "explain",
      "--tool",
      "claude",
      "--from",
      "b,c",
      "--exclude",
      "c",
      "--max-usage",
      "1",
      "--reserve-usage",
      "1",
    );
    expect(none.replace(/\s+/g, " ")).toContain(
      "Nobody can be picked now; clausona run claude --from 'b,c' --exclude 'c' --max-usage 1 --reserve-usage 1 would exit 75.",
    );
    const both = await run("explain", "--tool", "all", "--from", "a,x");
    expect(both).toMatch(/^ {4}claude:a\s/m);
    expect(both).toMatch(/^ {2}▸ codex:x\s/m);
  });

  it("narrows an all route to the tool --tool names", async () => {
    const { run } = setup();
    await run("add", "any", "--tool", "all");
    const codex = await run("explain", "any", "--tool", "codex");
    expect(codex).toMatch(/^ {2}▸ codex:x\s/m);
    expect(codex).not.toMatch(/claude:/);
    expect(await run("explain", "any")).toMatch(/^ {4}claude:a\s/m);
    expect(await run("pick", "any", "--tool", "claude")).toBe("claude:a");
    // Nobody of the narrowed tool is free: the 75 message names the tool and explains it alone.
    const none = (await run("pick", "any", "--tool", "claude", "--max-usage", "1", "--reserve-usage", "1").catch(
      (e: unknown) => e,
    )) as NoAccountError;
    expect(none).toBeInstanceOf(NoAccountError);
    expect(stripAnsi(none.message).split("\n")[0]).toBe("No claude account in route any is free right now.");
    expect(stripAnsi(none.message)).toContain("clausona route explain any --tool claude");
    const narrowed = await run("explain", "any", "--tool", "claude", "--max-usage", "1", "--reserve-usage", "1");
    // With the options the explain was given: without them the run would rank another route.
    expect(narrowed).toContain(
      "Nobody can be picked now; clausona run claude --route any --max-usage 1 --reserve-usage 1 would exit 75.",
    );
    await run("add", "main");
    await expect(run("explain", "main", "--tool", "codex")).rejects.toThrow("Route 'main' is for claude, not codex.");
    await expect(run("explain", "main", "--tool", "all")).rejects.toThrow("Route 'main' is for claude, not all.");
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
    expect(stripAnsi(error.message).split("\n")[0]).toBe("No account in route main is free right now.");
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
    expect(tokenError.message).toBe("Unknown route command. Run `clausona route --help` for the list.");
    // A key behind a prefix: neither the whole nor the start of it looks like one, only a piece.
    const prefixed = `x:${["sk", "ant", "y".repeat(5)].join("-")}`;
    const prefixedError = (await run(prefixed).catch((e: unknown) => e)) as Error;
    expect(prefixedError.message).toBe("Unknown route command. Run `clausona route --help` for the list.");
  });
});

describe("route edit", () => {
  it("saves what the editor saved, once it checks out", async () => {
    const { deps, io, file } = setup();
    deps.editText = async () => JSON.stringify({ version: 1, routes: { main: { tool: "claude" } } });
    expect(stripAnsi(await runRouteCommand(["edit"], io, deps))).toContain("Saved");
    expect(file().routes.main).toEqual({ tool: "claude" });
  });

  it("writes nothing when the edit has a problem, and says where", async () => {
    const { deps, io } = setup();
    writeFileSync(deps.paths.routesPath, '{ "version": 1, "routes": {} }\n');
    deps.editText = async () => JSON.stringify({ version: 1, routes: { main: { tool: "claude", maxUsage: 0 } } });
    await expect(runRouteCommand(["edit"], io, deps)).rejects.toThrow(
      "routes.main.maxUsage: must be a number from 1 to 100",
    );
    expect(readFileSync(deps.paths.routesPath, "utf8")).toBe('{ "version": 1, "routes": {} }\n');
  });

  it("offers to edit again in a terminal", async () => {
    const { deps } = setup();
    const edits = [
      JSON.stringify({ version: 1, routes: { main: { tool: "x" } } }),
      JSON.stringify({ version: 1, routes: { main: { tool: "claude" } } }),
    ];
    deps.editText = async () => edits.shift() as string;
    const said: string[] = [];
    const io: RouteIo = {
      interactive: true,
      ask: async () => "",
      say: (text) => said.push(stripAnsi(text)),
      confirm: async () => true,
    };
    await runRouteCommand(["edit"], io, deps);
    expect(said.join("\n")).toContain('routes.main.tool: must be "claude", "codex" or "all"');
    expect(JSON.parse(readFileSync(deps.paths.routesPath, "utf8")).routes.main).toEqual({ tool: "claude" });
  });

  it("opens an invalid file as it is, so it can be fixed", async () => {
    const { deps, io } = setup();
    writeFileSync(deps.paths.routesPath, "{ broken");
    let opened = "";
    deps.editText = async (initial) => {
      opened = initial;
      return '{ "version": 1, "routes": {} }';
    };
    await runRouteCommand(["edit"], io, deps);
    expect(opened).toBe("{ broken");
  });

  it("changes nothing when the editor saves what it opened", async () => {
    const { deps, io } = setup();
    deps.editText = async (initial) => initial;
    expect(stripAnsi(await runRouteCommand(["edit"], io, deps))).toBe("Nothing was changed.");
    expect(existsSync(deps.paths.routesPath)).toBe(false);
    writeFileSync(deps.paths.routesPath, '{ "version": 1, "routes": {} }\n');
    expect(stripAnsi(await runRouteCommand(["edit"], io, deps))).toBe("Nothing was changed.");
  });

  it("takes no route name, and opens nothing when given one", async () => {
    const { deps, io } = setup();
    let opened = false;
    deps.editText = async (initial) => {
      opened = true;
      return initial;
    };
    await expect(runRouteCommand(["edit", "main"], io, deps)).rejects.toThrow("Usage: clausona route edit");
    expect(opened).toBe(false);
  });
});
