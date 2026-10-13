import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./commands.js";
import { RoutesFileError, routesPaths } from "./core/routes-store.js";
import { budgetWindow } from "./core/spend.js";
import { reportError } from "./index.js";
import { stripAnsi } from "./lib/cli-style.js";
import type { ExitError } from "./lib/json-errors.js";
import type { RouteIo } from "./lib/route-io.js";
import { renderRoutesEmpty } from "./lib/route-render.js";
import { NoAccountError, type RouteDeps } from "./lib/route-service.js";
import { routeDoctor, runRouteCommand } from "./route-commands.js";
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

const QUOTAS: Record<string, QuotaSnapshot> = {
  "claude:a": snap(10, 10),
  "claude:b": snap(20, 20),
  "claude:c": snap(30, 30),
  "codex:x": snap(5, 5),
};

function setup(quotas: Record<string, QuotaSnapshot> = QUOTAS) {
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
    cwd: dir,
    home: dir,
    sleep: async () => {
      throw new Error("slept without --wait");
    },
    onInterrupt: () => () => {},
    progress: () => {},
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

  it("covers --wait, --model and exit code 130 in route's, pick's and run's help", async () => {
    const { run } = setup();
    const overview = await run("--help");
    expect(overview).toContain(
      "4. nobody    with --wait, sleep until the soonest reset and start again at 1; else exit 75",
    );
    expect(overview).toMatch(/130\s+Ctrl-C while --wait waited/);
    const pick = await run("pick", "--help");
    expect(pick).toContain("[--model <name>] [--wait[=<duration>]]");
    expect(await run("explain", "--help")).toContain("--model ranks as a run of that model would");
    const runHelp = stripAnsi(await runCommand("run", ["--help"]));
    expect(runHelp).toMatch(/--wait\[=<duration>\]\s+When nobody is free, wait for a reset: up to 5h/);
    expect(runHelp).toContain("130 on Ctrl-C while --wait waits");
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

  it("says in route's and run's help what an unknown route does without a terminal", async () => {
    const { run } = setup();
    expect(await run("--help")).toContain("Without a terminal, run exits 1 on an unknown route and creates nothing.");
    expect(stripAnsi(await runCommand("run", ["--help"]))).toContain(
      "Without a terminal, an unknown --route exits 1 and creates nothing.",
    );
  });

  it("says a run's --exclude adds to the route's list, and route set's replaces it", async () => {
    const { run } = setup();
    expect(await run("set", "--help")).toMatch(/--exclude <patterns>\s+Replace the route's exclude list/);
    expect(stripAnsi(await runCommand("run", ["--help"]))).toMatch(
      /--exclude <patterns>\s+Also leave these out for this run/,
    );
  });

  it("says in run's help that a profile does not go after a tool word or routing options", async () => {
    expect(stripAnsi(await runCommand("run", ["--help"]))).toContain(
      "A profile right after claude, codex or routing options is an error; after a -- it goes to the tool.",
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

  // A Codex-only machine: `route add main` makes a claude route, which takes nobody.
  it("says how to make a route that takes nobody into one of the other tool's accounts", async () => {
    const { deps, run, file } = setup();
    const codexOnly: Registry = { ...REGISTRY, profiles: { "codex:x": REGISTRY.profiles["codex:x"] } };
    deps.loadRegistry = async () => codexOnly;
    const out = (await run("add", "main", "--max-usage", "70")).replace(/\s+/g, " ");
    expect(file().routes.main.tool).toBe("claude");
    expect(out).toContain(
      "No profile matches *. For your codex accounts, make it a codex route: clausona route remove main && clausona route add main --tool codex --max-usage 70",
    );

    // Nobody of either tool: the list of profiles, to see what there is.
    const none = (await run("add", "work", "--from", "gone")).replace(/\s+/g, " ");
    expect(none).toContain("No profile matches gone. See your profiles: clausona list");
    // A route that takes someone says neither.
    const some = await run("add", "cx", "--tool", "codex");
    expect(some).not.toContain("No profile matches");
    expect(some).not.toContain("clausona list");
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
    });
  });

  it("refuses an existing name, an API profile and a bad name", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("add", "main")).rejects.toThrow(
      "Route 'main' already exists. Change it with clausona route set main …",
    );
    // claude:glm has no spend reading in QUOTAS, and no budget: whether its key has a limit is not known.
    await expect(run("add", "api", "--from", "glm")).rejects.toThrow(/claude:glm's spend could not be read just now/);
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

  it("never quotes or stores a key given to --exclude or --fallback", async () => {
    const { run, file, deps } = setup();
    await run("add", "main");
    for (const key of [["sk", "ant", "y".repeat(24)].join("-"), ["hf", "Ab".repeat(17)].join("_")]) {
      for (const flag of ["--exclude", "--fallback"]) {
        for (const args of [
          ["add", "other", flag, key],
          ["set", "main", flag, key],
          ["explain", "main", flag, key],
          ["explain", "--tool", "claude", "--from", "*", flag, key],
        ]) {
          const error = (await run(...args).catch((e: unknown) => e)) as Error;
          expect(error).toBeInstanceOf(Error);
          expect(error.message).not.toContain(key);
        }
      }
      expect(readFileSync(deps.paths.routesPath, "utf8")).not.toContain(key);
    }
    expect(file().routes).toEqual({ main: { tool: "claude", from: ["*"], strategy: "round-robin", maxUsage: 80 } });
  });

  it("refuses --fallback with --no-fallback, and changes nothing", async () => {
    const { run, file } = setup();
    await run("add", "main", "--fallback", "c");
    await expect(run("set", "main", "--fallback", "b", "--no-fallback")).rejects.toThrow(
      /^--fallback and --no-fallback cannot be used together\.$/,
    );
    expect(file().routes.main.fallback).toEqual(["c"]);
  });

  it("refuses to change nothing, and an unknown route", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("set", "main")).rejects.toThrow(/^Nothing to change/);
    await expect(run("set", "main")).rejects.toThrow(
      "Nothing to change. Pass at least one of --from, --add, --drop, --exclude, --strategy, --max-usage, --fallback, --no-fallback.",
    );
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

  it("refuses to rename onto a name a route already has, and changes neither", async () => {
    const { run, file } = setup();
    await run("add", "main");
    await run("add", "other", "--strategy", "headroom");
    const before = file().routes;
    await expect(run("rename", "main", "other")).rejects.toThrow(/^Route 'other' already exists\.$/);
    expect(file().routes).toEqual(before);
  });

  it("says a rename to the route's own name changes nothing, and writes nothing", async () => {
    const { run, file, deps } = setup();
    await run("add", "main");
    const before = readFileSync(deps.paths.routesPath, "utf8");
    expect(await run("rename", "main", "main")).toBe("  ✔ Route main already has that name. Nothing was changed.");
    expect(readFileSync(deps.paths.routesPath, "utf8")).toBe(before);
    expect(Object.keys(file().routes)).toEqual(["main"]);
    await expect(run("rename", "gone", "gone")).rejects.toThrow(/^Route 'gone' does not exist\./);
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
    expect(out).toMatch(/^ {4}any\s+claude \+ codex\s+headroom\s+80%\s+3 of 4\s+codex:x$/m);
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80%\s+2 of 3\s+claude:a$/m);
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
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80%\s+—\s+—$/m);
    expect(reads).toBe(0);
    // --json reads quota for freeNow and next, and with --no-quota does not.
    const json = JSON.parse(await run("list", "--json", "--no-quota"));
    expect(reads).toBe(0);
    expect(json.routes[0]).toMatchObject({ members: ["claude:a", "claude:b", "claude:c"], freeNow: null, next: null });
  });

  it("lists in --json the members a run would rank, who is free now and who is next", async () => {
    const { run, deps } = setup({ ...QUOTAS, "claude:b": snap(90, 0) });
    // claude:glm is an API profile with no spend reading: a member, skipped by every run until it has one.
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude", from: ["glm", "a", "b"], fallback: ["c"] } } }),
    );
    const [entry] = JSON.parse(await run("list", "--json")).routes;
    expect(entry).toEqual({
      name: "main",
      route: {
        tool: "claude",
        from: ["glm", "a", "b"],
        exclude: [],
        strategy: "round-robin",
        maxUsage: 80,
        fallback: ["c"],
      },
      members: ["claude:glm", "claude:a", "claude:b"],
      fallbackMembers: ["claude:c"],
      excluded: [],
      unknownNames: [],
      emptyPatterns: [],
      emptyExcludes: [],
      freeNow: { free: 2, members: 4 },
      next: { kind: "picked", id: "claude:a", stage: "pool", reason: "next in turn" },
    });
    expect(await run("list")).toMatch(/^ {4}main\s+claude\s+round-robin\s+80%\s+2 of 4\s+claude:a$/m);
  });

  it("names nobody unknown before clausona init, when no profile is registered yet", async () => {
    const { run, deps } = setup();
    deps.loadRegistry = async () => null;
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude", from: ["work"] } } }),
    );
    expect(await run("list")).not.toContain("⚠");
    const [entry] = JSON.parse(await run("list", "--json")).routes;
    expect(entry).toMatchObject({ members: [], unknownNames: [], emptyPatterns: [], freeNow: null, next: null });
  });

  it("says a pattern that matches nobody once, and an exclude that matches nobody too", async () => {
    const { run, deps } = setup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: { main: { tool: "claude", from: ["*", "x-*"], fallback: ["x-*"], exclude: ["persnal", "c"] } },
      }),
    );
    const out = await run("list");
    expect(out.match(/'x-\*' matches nobody/g)).toHaveLength(1);
    expect(out).toContain("  ⚠ main: exclude 'persnal' matches nobody.");
    const [entry] = JSON.parse(await run("list", "--json")).routes;
    expect(entry).toMatchObject({ emptyPatterns: ["x-*"], emptyExcludes: ["persnal"], excluded: ["claude:c"] });
    expect(await run("explain", "main")).toMatch(/^ {4}persnal\s+excludes nobody$/m);
  });

  // A route can name a profile that has since been removed.
  it("warns about names that are not registered", async () => {
    const { run, deps } = setup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude", from: ["gone", "*"] } } }),
    );
    const out = await run("list");
    expect(out).toMatch(/^ {4}ROUTE\s+TOOL\s+STRATEGY\s+SKIP AT\s+FREE NOW\s+NEXT$/m);
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80%/m);
    expect(out).toContain("  ⚠ main names 'gone', which is not a registered profile.");
    const json = JSON.parse(await run("list", "--json"));
    expect(json.routes[0]).toMatchObject({
      name: "main",
      members: ["claude:a", "claude:b", "claude:c"],
      unknownNames: ["gone"],
    });
  });
});

describe("a route in routes.json that cannot be used", () => {
  const BROKEN = {
    version: 1,
    routes: { main: { tool: "claude" }, bad: { tool: "claude", strategy: "fastest" } },
  };
  const PROBLEM = "routes.bad.strategy: must be one of round-robin, headroom, expiring";

  function withBroken() {
    const s = setup();
    writeFileSync(s.deps.paths.routesPath, `${JSON.stringify(BROKEN, null, 2)}\n`);
    return s;
  }

  it("is warned about by list and explain, which go on with the others", async () => {
    const { run } = withBroken();
    const out = await run("list");
    expect(out).toMatch(/^ {4}main\s+claude\s+round-robin\s+80%\s+3 of 3\s+claude:a$/m);
    expect(out).not.toMatch(/^ {4}bad\s/m);
    expect(out).toContain(`  ⚠ ${PROBLEM}`);
    expect(out).toContain("  ⚠ Fix it with clausona route edit, or remove the route: clausona route remove bad.");
    const json = JSON.parse(await run("list", "--json"));
    expect(Object.keys(json).sort()).toEqual([
      "budgetWarnings",
      "defaults",
      "dirs",
      "problems",
      "routes",
      "ruleWarnings",
    ]);
    expect(json.routes.map((route: { name: string }) => route.name)).toEqual(["main"]);
    expect(json.problems).toEqual([PROBLEM]);
    expect(await run("explain", "main")).toContain(`  ⚠ ${PROBLEM}`);
  });

  it("stops only a command that uses it, naming that route and the way out route list gives", async () => {
    const { run, deps } = withBroken();
    expect(await run("pick", "main")).toBe("claude:a");
    for (const sub of ["pick", "explain"]) {
      const error = (await run(sub, "bad").catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(RoutesFileError);
      expect(error.message).toBe(
        [
          `Route 'bad' in ${deps.paths.routesPath} cannot be used:`,
          `    ${PROBLEM}`,
          "  Fix it with clausona route edit, or remove the route: clausona route remove bad.",
        ].join("\n"),
      );
    }
  });

  // Identity cannot follow a string or null through a rename, so the name is checked before the move.
  it("refuses to rename one stored as a string or null, naming it by its name on disk", async () => {
    for (const spec of ["claude", null]) {
      const { run, deps } = setup();
      writeFileSync(
        deps.paths.routesPath,
        JSON.stringify({ version: 1, routes: { main: { tool: "claude" }, old: spec } }),
      );
      const before = readFileSync(deps.paths.routesPath, "utf8");
      const error = (await run("rename", "old", "older").catch((e: unknown) => e)) as Error;
      expect(error.message, String(spec)).toBe(
        [
          `${deps.paths.routesPath} has a route that cannot be used, so nothing was saved:`,
          "    routes.old: must be an object",
          "  Fix it with clausona route edit, or remove the route: clausona route remove old.",
        ].join("\n"),
      );
      expect(readFileSync(deps.paths.routesPath, "utf8")).toBe(before);
    }
  });

  // Renamed, it would still be broken: the refusal names it as it is on disk, where remove finds it.
  it("refuses to rename it, naming it by its name on disk", async () => {
    const { run, deps } = withBroken();
    const before = readFileSync(deps.paths.routesPath, "utf8");
    const error = (await run("rename", "bad", "older").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      [
        `${deps.paths.routesPath} has a route that cannot be used, so nothing was saved:`,
        `    ${PROBLEM}`,
        "  Fix it with clausona route edit, or remove the route: clausona route remove bad.",
      ].join("\n"),
    );
    expect(readFileSync(deps.paths.routesPath, "utf8")).toBe(before);
  });

  it("keeps every write from saving it again, and says how to get past it", async () => {
    const { run, deps } = withBroken();
    const before = readFileSync(deps.paths.routesPath, "utf8");
    for (const args of [
      ["add", "new"],
      ["set", "main", "--strategy", "headroom"],
      ["rename", "main", "other"],
      ["remove", "main"],
    ]) {
      const error = (await run(...args).catch((e: unknown) => e)) as Error;
      expect(error.message, args.join(" ")).toBe(
        [
          `${deps.paths.routesPath} has a route that cannot be used, so nothing was saved:`,
          `    ${PROBLEM}`,
          "  Fix it with clausona route edit, or remove the route: clausona route remove bad.",
        ].join("\n"),
      );
    }
    expect(readFileSync(deps.paths.routesPath, "utf8")).toBe(before);
  });

  it("can be mended with route set, or removed", async () => {
    const mended = withBroken();
    await mended.run("set", "bad", "--strategy", "headroom");
    expect(mended.file().routes.bad).toEqual({ tool: "claude", strategy: "headroom" });
    const removed = withBroken();
    await removed.run("remove", "bad");
    expect(removed.file().routes).toEqual({ main: { tool: "claude" } });
  });

  it("never names a route whose name looks like a key, in a warning, a list of routes or a way out", async () => {
    const { run, deps } = setup();
    const key = ["sk", "ant", "y".repeat(24)].join("-");
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { main: { tool: "claude" }, [key]: { tool: "claude" } } }),
    );
    const out = await run("list");
    expect(out).toContain("  ⚠ That looks like an API key, not a route name.");
    expect(out).toContain("  ⚠ Fix it with clausona route edit.");
    const unknown = (await run("explain", "nope").catch((e: unknown) => e)) as Error;
    expect(unknown.message).toContain("Existing routes: main.");
    const refused = (await run("add", "new").catch((e: unknown) => e)) as Error;
    for (const text of [out, unknown.message, refused.message]) expect(text).not.toContain("sk-");
  });
});

// The profile rule takes this name, and the key check, which is wider, would not.
describe("a profile whose name the key check would take for a key", () => {
  const longName = ["Team", "Build", "2026", "Runner", "Alpha", "7Beta", "9Zed"].join("");
  const withLong = () => {
    const s = setup({ ...QUOTAS, [`claude:${longName}`]: snap(5, 5) });
    s.deps.loadRegistry = async () => ({
      ...REGISTRY,
      profiles: {
        ...REGISTRY.profiles,
        [`claude:${longName}`]: { tool: "claude", configDir: "/home/u/.claude-l", email: "l@example.com" },
      },
    });
    return s;
  };

  it("can be named in a route, by route add and by hand", async () => {
    const { run, file, deps } = withLong();
    await run("add", "solo", "--from", longName);
    expect(file().routes.solo.from).toEqual([longName]);
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: { hand: { tool: "claude", from: [`claude:${longName}`, "a"] } } }),
    );
    expect(await run("pick", "hand")).toBe(`claude:${longName}`);
    // And by a run's own options, unsaved.
    expect(await run("explain", "--tool", "claude", "--from", longName)).toContain(`▸ claude:${longName}`);
    expect(JSON.parse(await run("list", "--json")).problems).toEqual([]);
  });

  // The name passed only because a profile had it; once that profile is gone, it is checked again.
  it("makes a route that names it unusable once the profile is removed, and says why", async () => {
    const { run, deps } = withLong();
    await run("add", "solo", "--from", longName);
    deps.loadRegistry = async () => REGISTRY;
    const out = await run("list", "--no-quota");
    expect(out).toContain(
      "  ⚠ routes.solo.from[0]: looks like an API key, or names a profile that is no longer registered",
    );
    expect(out).not.toContain(longName);
  });

  it("is a key to every route command while no profile has that name", async () => {
    const { run } = setup();
    const error = (await run("add", "solo", "--from", longName).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(
      "routes.solo.from[0]: looks like an API key, or names a profile that is no longer registered",
    );
  });
});

describe("dir rules and defaults", () => {
  /** As routes.json stores it on every platform. */
  const WORK = "~/work";

  /** Routes for each kind of slot, and ~/work/app under the scratch home. */
  async function withRoutes() {
    const s = setup();
    await s.run("add", "main");
    await s.run("add", "cx", "--tool", "codex");
    await s.run("add", "any", "--tool", "all");
    mkdirSync(path.join(s.deps.home, "work", "app"), { recursive: true });
    return s;
  }

  it("sets a dir rule however the directory is typed, lists it, and clears it a slot at a time", async () => {
    const { run, file, deps } = await withRoutes();
    deps.cwd = path.join(deps.home, "work");
    expect(await run("dir", ".", "main")).toBe(`  ✔ In ${WORK} and below, clausona run claude uses route main`);
    deps.cwd = deps.home;
    await run("dir", "~/work", "cx");
    expect(file().dirs).toEqual({ [WORK]: { claude: "main", codex: "cx" } });
    expect(await run("dir")).toMatch(/^ {4}~\/work\s+main\s+cx$/m);
    expect(await run("dir", "work", "--clear", "--tool", "codex")).toBe(`  ✔ Cleared the codex rule for ${WORK}`);
    expect(file().dirs).toEqual({ [WORK]: { claude: "main" } });
    expect(await run("dir", path.join(deps.home, "work"), "--clear")).toBe(`  ✔ Cleared the dir rule for ${WORK}`);
    expect(file()).not.toHaveProperty("dirs");
    expect(await run("dir", "~/work", "--clear")).toBe(`  ✔ No dir rule for ${WORK}. Nothing was changed.`);
  });

  it("fills both slots with an all route unless --tool names one, and refuses a route that cannot fill it", async () => {
    const { run, file } = await withRoutes();
    expect(await run("dir", "~/work", "any")).toBe(
      `  ✔ In ${WORK} and below, clausona run claude and clausona run codex use route any`,
    );
    const other = "~/other";
    expect(await run("dir", "~/other", "any", "--tool", "codex")).toBe(
      [
        `  ✔ In ${other} and below, clausona run codex uses route any`,
        `  ⚠ ${other} does not exist yet. The rule holds once it does.`,
      ].join("\n"),
    );
    expect(file().dirs).toEqual({ [WORK]: { claude: "any", codex: "any" }, [other]: { codex: "any" } });
    await expect(run("dir", "~/work", "main", "--tool", "codex")).rejects.toThrow(
      "Route 'main' is for claude, not codex.",
    );
    await expect(run("dir", "~/work", "main", "--tool", "all")).rejects.toThrow(
      "Route 'main' is for claude only, so it cannot fill both tools.",
    );
    await expect(run("dir", "~/work", "gone")).rejects.toThrow(/^Route 'gone' does not exist\./);
    await expect(run("dir", "~/work")).rejects.toThrow(/^Usage: clausona route dir/);
  });

  it("sets each tool's default, lists it, and clears it only for a tool named", async () => {
    const { run, file } = await withRoutes();
    expect(await run("default", "main")).toBe("  ✔ Outside every dir rule, clausona run claude uses route main");
    await run("default", "any", "--tool", "codex");
    expect(file().defaults).toEqual({ claude: "main", codex: "any" });
    expect(await run("default")).toMatch(/^ {4}default\s+main\s+any$/m);
    await expect(run("default", "--clear")).rejects.toThrow(
      "Name the tool whose default to clear: clausona route default --clear --tool claude (or codex, or all).",
    );
    expect(await run("default", "--clear", "--tool", "all")).toBe("  ✔ Cleared the claude and codex default");
    expect(file()).not.toHaveProperty("defaults");
    expect(await run("default")).toContain("No dir rules or defaults yet.");
  });

  it("rewrites the rules that name a renamed route, and removes those that name a removed one", async () => {
    const { run, file } = await withRoutes();
    await run("dir", "~/work", "main");
    await run("dir", "~/work", "cx");
    await run("default", "main");
    expect(await run("rename", "main", "office")).toBe(
      [
        "  ✔ Renamed route main to office",
        `    Also renamed in the dir rule for ${WORK} (claude) and the claude default.`,
      ].join("\n"),
    );
    expect(file()).toMatchObject({
      dirs: { [WORK]: { claude: "office", codex: "cx" } },
      defaults: { claude: "office" },
    });
    expect(await run("remove", "office")).toBe(
      ["  ✔ Removed route office", `    Also removed the dir rule for ${WORK} (claude) and the claude default.`].join(
        "\n",
      ),
    );
    expect(file().dirs).toEqual({ [WORK]: { codex: "cx" } });
    expect(file()).not.toHaveProperty("defaults");
  });

  it("names a directory once for the slots of both tools when it renames or removes an all route", async () => {
    const { run } = await withRoutes();
    await run("dir", "~/work/app", "any");
    await run("default", "any", "--tool", "codex");
    expect(await run("rename", "any", "both")).toBe(
      [
        "  ✔ Renamed route any to both",
        "    Also renamed in the dir rule for ~/work/app (claude, codex) and the codex default.",
      ].join("\n"),
    );
    await run("default", "both");
    expect(await run("remove", "both")).toBe(
      [
        "  ✔ Removed route both",
        "    Also removed the dir rule for ~/work/app (claude, codex) and the claude and codex defaults.",
      ].join("\n"),
    );
  });

  it("lists the rules under the routes, and warns about one that names a route it cannot use", async () => {
    const { run, deps } = await withRoutes();
    const raw = JSON.parse(readFileSync(deps.paths.routesPath, "utf8"));
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ ...raw, dirs: { "~/work": { claude: "gone", codex: "cx" } }, defaults: { claude: "cx" } }),
    );
    const out = await run("list", "--no-quota");
    expect(out).toMatch(/^ {4}DIRECTORY\s+CLAUDE\s+CODEX$/m);
    expect(out).toMatch(/^ {4}~\/work\s+gone\s+cx$/m);
    expect(out).toMatch(/^ {4}default\s+cx\s+—$/m);
    expect(out).toContain("  ⚠ ~/work names route 'gone' for claude, which does not exist.");
    expect(out).toContain("  ⚠ The claude default names route 'cx', which is for codex.");
    const json = JSON.parse(await run("list", "--json", "--no-quota"));
    expect(json).toMatchObject({
      dirs: { "~/work": { claude: "gone", codex: "cx" } },
      defaults: { claude: "cx" },
      ruleWarnings: [
        "~/work names route 'gone' for claude, which does not exist.",
        "The claude default names route 'cx', which is for codex.",
      ],
      problems: [],
    });
  });

  it("are warned about by doctor, with what route list warns about the routes, and no quota read", async () => {
    const { deps } = setup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: {
          solo: { tool: "claude", from: ["gone", "x-*"] },
          bad: { tool: "claude", strategy: "fastest" },
          cx: { tool: "codex" },
        },
        dirs: { "~/work": { claude: "missing" } },
        defaults: { claude: "cx", codex: 5 },
      }),
    );
    let read = false;
    const report = await routeDoctor({
      ...deps,
      collectQuotas: async () => {
        read = true;
        return {};
      },
    });
    expect(report).toEqual({
      shown: path.join("~", "routes.json"),
      warnings: [
        "routes.bad.strategy: must be one of round-robin, headroom, expiring",
        "Fix it with clausona route edit, or remove the route: clausona route remove bad.",
        "solo names 'gone', which is not a registered profile.",
        "solo: 'x-*' matches nobody.",
        "defaults.codex: must be a route's name",
        "~/work names route 'missing' for claude, which does not exist.",
        "The claude default names route 'cx', which is for codex.",
      ],
    });
    expect(read).toBe(false);
    writeFileSync(deps.paths.routesPath, "{ not json");
    expect((await routeDoctor(deps)).warnings).toEqual([
      "It cannot be used: not valid JSON (line 1, column 3). Fix it with clausona route edit.",
    ]);
  });

  describe("explain with no name", () => {
    async function inApp() {
      const s = await withRoutes();
      await s.run("dir", "~/work", "main");
      const raw = JSON.parse(readFileSync(s.deps.paths.routesPath, "utf8"));
      writeFileSync(s.deps.paths.routesPath, JSON.stringify({ ...raw, defaults: { codex: "gone" } }));
      s.deps.cwd = path.join(s.deps.home, "work", "app");
      return s;
    }

    it("says what each tool's run would take here and why, then explains each route", async () => {
      const { run } = await inApp();
      const out = await run("explain");
      expect(out).toContain("  In ~/work/app\n");
      expect(out).toMatch(/^ {4}clausona run claude\s+route main\s+dir rule ~\/work$/m);
      expect(out).toMatch(/^ {4}clausona run codex\s+nothing\s+no active profile \(clausona use\)$/m);
      expect(out).toContain("  ⚠ Skipped the codex default: route 'gone' does not exist.");
      expect(out).toContain("╭─ main ─");
      expect(await run("explain", "--tool", "codex")).not.toContain("clausona run claude");
    });

    it("warns about a dir rule it cannot read, which no run here could take", async () => {
      const { run, deps } = await inApp();
      const raw = JSON.parse(readFileSync(deps.paths.routesPath, "utf8"));
      writeFileSync(deps.paths.routesPath, JSON.stringify({ ...raw, dirs: { ...raw.dirs, work: { codex: "cx" } } }));
      expect(await run("explain")).toContain('  ⚠ dirs["work"]: must be an absolute path, or start with ~');
    });

    it("gives each run's resolvedBy and the rules it skipped in --json", async () => {
      const { run, deps } = await inApp();
      const json = JSON.parse(await run("explain", "--json"));
      expect(json.directory).toBe(deps.cwd);
      expect(json.runs).toHaveLength(2);
      expect(json.runs[0]).toMatchObject({
        tool: "claude",
        route: "main",
        resolvedBy: `dir:${WORK}`,
        outcome: { kind: "picked", id: "claude:a" },
        skipped: [],
      });
      expect(json.runs[1]).toEqual({
        tool: "codex",
        route: null,
        resolvedBy: "active",
        profile: null,
        skipped: [{ rule: "default", reason: "route 'gone' does not exist" }],
      });
      const one = JSON.parse(await run("explain", "--tool", "claude", "--json"));
      expect(one.runs.map((entry: { tool: string }) => entry.tool)).toEqual(["claude"]);
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
    const { run: runFull } = setup({ ...QUOTAS, "claude:b": snap(100, 20) });
    const none = await runFull("explain", "--tool", "claude", "--from", "b,c", "--exclude", "c", "--max-usage", "1");
    expect(none.replace(/\s+/g, " ")).toContain(
      "Nobody can be picked now; clausona run claude --from 'b,c' --exclude 'c' --max-usage 1 would exit 75.",
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
    const full = setup({ ...QUOTAS, "claude:a": snap(100, 0), "claude:b": snap(100, 0), "claude:c": snap(0, 100) });
    await full.run("add", "any", "--tool", "all");
    const none = (await full
      .run("pick", "any", "--tool", "claude", "--max-usage", "1")
      .catch((e: unknown) => e)) as NoAccountError;
    expect(none).toBeInstanceOf(NoAccountError);
    expect(stripAnsi(none.message).split("\n")[0]).toBe("No claude account in route any is free right now.");
    expect(stripAnsi(none.message).replace(/\s+/g, " ")).toContain(
      "clausona route explain any --tool claude --max-usage 1",
    );
    const narrowed = await full.run("explain", "any", "--tool", "claude", "--max-usage", "1");
    // With the options the explain was given: without them the run would rank another route.
    expect(narrowed).toContain(
      "Nobody can be picked now; clausona run claude --route any --max-usage 1 would exit 75.",
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

  it("drops a removed profile's pick time when it records the next pick", async () => {
    const { run, deps } = setup();
    await run("add", "main");
    const gone = { "claude:gone": "2026-10-01T00:00:00.000Z", "claude:c": "2026-10-02T00:00:00.000Z" };
    writeFileSync(deps.paths.picksPath, JSON.stringify({ version: 1, lastPicked: gone }));
    expect(await run("pick", "main")).toBe("claude:a");
    expect(JSON.parse(readFileSync(deps.paths.picksPath, "utf8")).lastPicked).toEqual({
      "claude:a": new Date(NOW).toISOString(),
      "claude:c": "2026-10-02T00:00:00.000Z",
    });
  });

  it("ranks with the limit on the model --model names, and says which window that is", async () => {
    const opus = (percent: number) => ({ label: "Opus", usedPercent: percent, resetsAt: null });
    const { run } = setup({
      ...QUOTAS,
      "claude:a": { ...snap(10, 10), scoped: opus(95), scopedLimits: [opus(95)] },
    });
    await run("add", "main", "--strategy", "headroom");
    const text = await run("explain", "main", "--model", "opus");
    expect(text).toContain("Model      opus: the Opus limit counts too");
    expect(text).toMatch(/^ {4}ACCOUNT\s+5H\s+7D\s+OPUS$/m);
    expect(text).toMatch(/^ {4}claude:a\s+10% 1h\s+10%\s+95%\s+over 80%$/m);
    const json = JSON.parse(await run("explain", "main", "--model", "opus", "--json"));
    expect(json.model).toBe("opus");
    expect(json.members[0]).toMatchObject({ profile: "claude:a", usage: { percent: 95, window: "Opus" } });
    expect(await run("pick", "main", "--model", "opus")).toBe("claude:b");
    expect(await run("pick", "main")).toBe("claude:a");
    await expect(run("pick", "main", "--model=")).rejects.toThrow("--model needs a value.");
  });

  it("with --wait, says what it waits for on stderr and prints only the pick on stdout", async () => {
    let now = NOW;
    const full = { usedPercent: 100, resetsAt: new Date(NOW + 10 * 60_000).toISOString() };
    const said: string[] = [];
    const { deps, io } = setup();
    Object.assign(deps, {
      collectQuotas: async () =>
        now < NOW + 10 * 60_000
          ? {
              "claude:a": { ...snap(100, 0), session: full },
              "claude:b": { ...snap(100, 0), session: full },
              "claude:c": { ...snap(100, 0), session: full },
            }
          : QUOTAS,
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      progress: (text: string) => said.push(stripAnsi(text)),
    });
    const run = async (...args: string[]) => stripAnsi(await runRouteCommand(args, io, deps));
    await run("add", "main");
    expect(JSON.parse(await run("pick", "main", "--wait", "--json"))).toMatchObject({ profile: "claude:a" });
    expect(said).toEqual([expect.stringMatching(/^ {2}waiting until \d\d:\d\d for claude:a \(5H resets\) …$/)]);

    // Past the cap, exit 75 at once, with the JSON pick prints for nobody.
    now = NOW - 60 * 60_000;
    const error = (await run("pick", "main", "--wait=30m", "--json").catch((e: unknown) => e)) as ExitError;
    expect(error.code).toBe(75);
    expect(JSON.parse(error.stdout ?? "")).toMatchObject({ profile: null, soonest: { id: "claude:a" } });
    expect(said).toHaveLength(1);
  });

  it("refuses --wait on explain, a cap after a space, and a cap it cannot read", async () => {
    const { run } = setup();
    await run("add", "main");
    await expect(run("explain", "main", "--wait")).rejects.toThrow("Unknown option: --wait");
    await expect(run("pick", "--wait", "30m")).rejects.toThrow("Give --wait its cap after =, as in --wait=30m.");
    await expect(run("pick", "main", "--wait=2d")).rejects.toThrow("--wait takes a duration such as 30m, 2h or 1h30m");
    for (const twice of [
      ["--wait", "--wait"],
      ["--wait", "--wait=1h"],
    ]) {
      await expect(run("pick", "main", ...twice)).rejects.toThrow(
        "--wait was given more than once. Pass it at most once.",
      );
    }
  });

  it("stops a wait on Ctrl-C with exit code 130, as JSON when asked", async () => {
    const full = { usedPercent: 100, resetsAt: new Date(NOW + 10 * 60_000).toISOString() };
    const { deps, io } = setup({ "claude:a": { ...snap(100, 0), session: full } });
    let interrupt = () => {};
    Object.assign(deps, {
      onInterrupt: (handler: () => void) => {
        interrupt = handler;
        return () => {};
      },
      sleep: async () => interrupt(),
    });
    await runRouteCommand(["add", "main", "--from", "a"], io, deps);
    const error = (await runRouteCommand(["pick", "main", "--wait", "--json"], io, deps).catch(
      (e: unknown) => e,
    )) as ExitError;
    expect(error.code).toBe(130);
    expect(JSON.parse(error.stdout ?? "")).toEqual({
      version: 1,
      error: "failed",
      message: "Stopped waiting. No account was picked.",
    });
    const plain = await runRouteCommand(["pick", "main", "--wait"], io, deps).catch((e: unknown) => e);
    const err: string[] = [];
    expect(reportError(plain, { write: (chunk: string) => err.push(chunk) })).toBe(130);
    expect(stripAnsi(err.join(""))).toBe("  ✘ Stopped waiting. No account was picked.\n");
  });

  it("fails with exit code 75 when nobody can be picked, as JSON when asked", async () => {
    const { run } = setup({ "claude:a": snap(100, 0), "claude:b": snap(100, 0), "claude:c": snap(0, 100) });
    await run("add", "main");
    const error = (await run("pick", "main").catch((e: unknown) => e)) as NoAccountError;
    expect(error).toBeInstanceOf(NoAccountError);
    expect(error.exitCode).toBe(75);
    expect(stripAnsi(error.message).split("\n")[0]).toBe("No account in route main is free right now.");
    const jsonError = (await run("pick", "main", "--json").catch((e: unknown) => e)) as NoAccountError;
    expect(JSON.parse(jsonError.stdout ?? "")).toMatchObject({ profile: null });
  });
});

describe("the reserve limit, which routes no longer have", () => {
  it("is an unknown option to every route command, and no help offers it", async () => {
    const { run } = setup();
    await run("add", "main");
    for (const args of [
      ["add", "work", "--reserve-usage", "90"],
      ["set", "main", "--reserve-usage", "90"],
      ["explain", "main", "--reserve-usage", "90"],
      ["pick", "main", "--reserve-usage", "90"],
    ]) {
      await expect(run(...args), args[0]).rejects.toThrow(
        `Unknown option: --reserve-usage\nRun \`clausona route ${args[0]} --help\` for usage.`,
      );
    }
    for (const page of [await run("--help"), await run("add", "--help"), await run("set", "--help")]) {
      expect(page).not.toMatch(/reserve-usage|95%/);
    }
    expect(stripAnsi(await runCommand("run", ["--help"]))).not.toContain("--reserve-usage");
    expect(await run("--help")).toContain("3. overflow  any member under 100%, lowest usage first");
  });
});

describe("failures with --json", () => {
  /** What the command leaves with: its exit code, and what it prints on stdout and stderr. */
  async function fails(run: Promise<string>) {
    const error = await run.then(
      () => {
        throw new Error("did not fail");
      },
      (e: unknown) => e,
    );
    const out: string[] = [];
    const err: string[] = [];
    const sink = (chunks: string[]) => ({ write: (chunk: string) => chunks.push(chunk) > 0 });
    const code = reportError(error, sink(err), sink(out));
    return { code, json: JSON.parse(out.join("")), stderr: err.join("") };
  }

  it("is one JSON object on stdout, as the Extensions commands print it, with the exit code kept", async () => {
    const { run } = setup();
    await run("add", "main");
    for (const args of [
      ["list", "main", "--json"],
      // With no name, explain says what a run here would take; field options need a route.
      ["explain", "--exclude", "x", "--json"],
      ["pick", "--json"],
      ["pick", "main", "--bogus", "--json"],
      ["explain", "main", "--max-usage", "0", "--json"],
      ["add", "work", "--json"],
      ["frobnicate", "--json"],
    ]) {
      const failure = await fails(run(...args));
      expect(failure, args.join(" ")).toMatchObject({ code: 1, json: { version: 1, error: "usage" }, stderr: "" });
      expect(Object.keys(failure.json).sort()).toEqual(["error", "message", "version"]);
    }
    const missing = await fails(run("explain", "nope", "--json"));
    expect(missing).toMatchObject({ code: 1, stderr: "" });
    expect(missing.json).toEqual({
      version: 1,
      error: "not-found",
      message: "Route 'nope' does not exist. Existing routes: main. Create it: clausona route add nope",
    });
  });

  it("names the file and its problems when routes.json, or the route named, cannot be used", async () => {
    const { run, deps } = setup();
    writeFileSync(deps.paths.routesPath, "{ not json");
    const unusable = await fails(run("list", "--json"));
    expect(unusable).toMatchObject({ code: 1, stderr: "" });
    expect(unusable.json).toMatchObject({
      version: 1,
      error: "failed",
      file: deps.paths.routesPath,
      problems: [expect.stringMatching(/^not valid JSON/)],
    });
    expect(Object.keys(unusable.json).sort()).toEqual(["error", "file", "message", "problems", "version"]);
    writeFileSync(deps.paths.routesPath, JSON.stringify({ version: 1, routes: { bad: { tool: "x" } } }));
    const broken = await fails(run("pick", "bad", "--json"));
    expect(Object.keys(broken.json).sort()).toEqual(["error", "file", "message", "problems", "version"]);
    expect(broken.json).toMatchObject({
      error: "failed",
      problems: ['routes.bad.tool: must be "claude", "codex" or "all"'],
    });
  });

  it("leaves exit 75 and the JSON pick prints for it as they are", async () => {
    const { run } = setup({ "claude:a": snap(100, 0), "claude:b": snap(100, 0), "claude:c": snap(0, 100) });
    await run("add", "main");
    const none = await fails(run("pick", "main", "--json"));
    expect(none).toMatchObject({ code: 75, json: { profile: null, route: "main" }, stderr: "" });
  });
});

describe("route budget", () => {
  const api = (name: string, baseUrl: string) => ({
    tool: "claude" as const,
    kind: "api" as const,
    configDir: `/home/u/.claude-${name}`,
    email: "",
    api: { baseUrl, authScheme: "bearer" as const, secret: { source: "env" as const, name: "GW_KEY" } },
  });
  const BUDGETED: Registry = {
    ...REGISTRY,
    profiles: {
      ...REGISTRY.profiles,
      "claude:gw": api("gw", "https://gw.example.com"),
      "claude:or": api("or", "https://openrouter.ai/api"),
      "claude:proxy": api("proxy", "https://proxy.example.com"),
      "claude:bare": api("bare", "https://bare.example.com"),
    },
  };
  // The spend each provider reports, as the quota cache keeps it. NOW is Friday 2026-10-09 in UTC.
  const SPEND: Record<string, QuotaSnapshot> = {
    "claude:gw": {
      state: "ok",
      fetchedAt: NOW,
      spend: {
        totalUsd: 107,
        baselines: {
          day: { start: "2026-10-09T00:00:00.000Z", totalUsd: 107 },
          week: { start: "2026-10-05T00:00:00.000Z", totalUsd: 103 },
          month: { start: "2026-10-01T00:00:00.000Z", totalUsd: 100 },
        },
      },
    },
    "claude:or": {
      state: "ok",
      fetchedAt: NOW,
      spend: {
        totalUsd: 40,
        periods: { day: 1, week: 6, month: 12.5 },
        limit: { usd: 50, resetsAt: "2026-11-01T00:00:00.000Z", per: "month", remainingUsd: 37.5 },
      },
    },
    "claude:proxy": { state: "error", fetchedAt: NOW, noSpendReading: true },
    "claude:bare": { state: "ok", fetchedAt: NOW, spend: { totalUsd: 3 } },
  };

  /**
   * The CLI over BUDGETED, its spend read as collectQuotas reads it from the cache: the window for
   * the budget each target carries, else the key's own limit. Nothing reaches a network.
   */
  function budgetSetup(spend: Record<string, QuotaSnapshot> = SPEND) {
    const s = setup();
    const asked: string[][] = [];
    s.deps.loadRegistry = async () => BUDGETED;
    s.deps.collectQuotas = async (targets) => {
      asked.push(targets.map((target) => target.id));
      return Object.fromEntries(
        targets.flatMap((target) => {
          const snapshot = spend[target.id] ?? QUOTAS[target.id];
          if (!snapshot) return [];
          if (!snapshot.spend || !target.api) return [[target.id, snapshot]];
          const window = budgetWindow(snapshot.spend, target.api.budget, NOW);
          return [[target.id, window ? { ...snapshot, budget: window } : snapshot]];
        }),
      );
    };
    return { ...s, asked };
  }

  it("lists every API profile with its limit, where the limit comes from, the spend and the usage", async () => {
    const { run, deps, asked } = budgetSetup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: { main: { tool: "claude", from: ["a", "gw"] } },
        budgets: { "claude:gw": { usd: 20, per: "month" } },
      }),
    );
    const out = await run("budget");
    expect(out).toMatch(/^ {4}PROFILE\s+LIMIT\s+SOURCE\s+SPENT\s+USAGE\s+RENEWS$/m);
    expect(out).toMatch(/^ {4}claude:bare {3}no spend limit: clausona route budget claude:bare --usd 20 --per month$/m);
    expect(out).toMatch(/^ {4}claude:gw {5}\$20\/month\s+clausona budget\s+\$7\.00\s+35%\s+23d$/m);
    expect(out).toMatch(/^ {4}claude:or {5}\$50\/month\s+provider limit\s+\$12\.50\s+25%\s+23d$/m);
    expect(out).toMatch(/^ {4}claude:proxy {2}the provider does not report spend$/m);
    // Only API profiles' spend is read.
    expect(asked).toEqual([["claude:bare", "claude:gw", "claude:or", "claude:proxy"]]);
    const json = JSON.parse(await run("budget", "--json"));
    expect(json.problems).toEqual([]);
    expect(json.warnings).toEqual([]);
    expect(json.profiles.find((row: { profile: string }) => row.profile === "claude:gw")).toEqual({
      profile: "claude:gw",
      budget: { usd: 20, per: "month" },
      limit: { source: "budget", usd: 20, per: "month", resetsAt: "2026-11-01T00:00:00.000Z" },
      spentUsd: 7,
      usage: 35,
      spend: "ok",
      reason: null,
      routes: ["main"],
    });
    expect(json.profiles.find((row: { profile: string }) => row.profile === "claude:proxy")).toMatchObject({
      budget: null,
      limit: null,
      spend: "not-reported",
      reason: "the provider does not report spend",
    });
  });

  it("says why spend could not be read", async () => {
    const { run, deps } = budgetSetup({ ...SPEND, "claude:gw": { state: "expired", fetchedAt: NOW } });
    expect(await run("budget", "gw")).toMatch(
      /^ {4}claude:gw {2}spend could not be read: the provider refused the spend request \(401\/403\)$/m,
    );
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({ version: 1, routes: {}, budgets: { "claude:gw": { usd: 20, per: "month" } } }),
    );
    expect(await run("budget", "gw")).toMatch(
      /^ {4}claude:gw {2}\$20\/month \(clausona budget\); spend could not be read: the provider refused the spend request \(401\/403\)$/m,
    );
  });

  it("sets a budget, which replaces the key's limit and lets the profile join a route", async () => {
    const { run, file } = budgetSetup();
    await expect(run("add", "paid", "--from", "bare")).rejects.toThrow(/claude:bare has no spend limit/);
    const out = await run("budget", "bare", "--usd", "12.5", "--per", "week");
    expect(out.split("\n")[0]).toBe("  ✔ Budget for claude:bare: $12.50/week");
    expect(out).toMatch(/^ {4}claude:bare\s+\$12\.50\/week\s+clausona budget\s+\$0\.00\s+0%\s+3d$/m);
    expect(out).toContain(
      "Spend counts from clausona's first reading this week; what was spent before it is not counted.",
    );
    expect(file().budgets).toEqual({ "claude:bare": { usd: 12.5, per: "week" } });
    await run("add", "paid", "--from", "bare");
    expect(file().routes.paid.from).toEqual(["bare"]);
    // Set again, it is changed in place.
    await run("budget", "claude:bare", "--usd", "30", "--per", "month");
    expect(file().budgets).toEqual({ "claude:bare": { usd: 30, per: "month" } });
    expect(JSON.parse(await run("budget", "bare", "--usd", "30", "--per", "month", "--json"))).toMatchObject({
      profile: "claude:bare",
      changed: true,
      limit: { source: "budget", usd: 30 },
    });
  });

  it("says a budget on a provider that reports no spend cannot be checked", async () => {
    const { run } = budgetSetup();
    expect(await run("budget", "proxy", "--usd", "20", "--per", "month")).toContain(
      "claude:proxy's provider does not report spend, so the budget cannot be checked and claude:proxy cannot join a route.",
    );
  });

  it("clears a budget, saying which limit counts now, or that routes skip the profile", async () => {
    const { run, file, deps } = budgetSetup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: { main: { tool: "claude", from: ["a", "bare"] } },
        budgets: { "claude:bare": { usd: 5, per: "day" }, "claude:or": { usd: 5, per: "day" } },
      }),
    );
    const bare = await run("budget", "bare", "--clear");
    expect(bare.split("\n")[0]).toBe("  ✔ Cleared the budget for claude:bare");
    expect(bare.replace(/\s+/g, " ")).toContain(
      "claude:bare has no spend limit now, so route main skips it. Set a limit on the provider key, or a budget again: clausona route budget claude:bare --usd 20 --per month",
    );
    expect(await run("budget", "or", "--clear")).toContain(
      "Routes now count it against its key's own limit, $50/month.",
    );
    expect(file()).not.toHaveProperty("budgets");
    expect(await run("budget", "or", "--clear")).toBe("  ✔ No budget for claude:or. Nothing was changed.");
  });

  it("refuses what is not a budget, or not an API profile, and never quotes a key", async () => {
    const { run, file } = budgetSetup();
    await run("add", "main");
    for (const [args, message] of [
      [["bare", "--usd", "0", "--per", "month"], "--usd must be a number of dollars above 0, such as 20 or 12.50."],
      [["bare", "--usd", "20", "--per", "year"], "--per must be one of day, week, month."],
      [["bare", "--usd", "20"], "Give both --usd and --per: clausona route budget <profile> --usd 20 --per month."],
      [["bare", "--clear", "--per", "day"], "--clear cannot be used with --usd or --per."],
      [["--clear"], "Usage: clausona route budget [<profile>] [--json]"],
      [["a", "--usd", "20", "--per", "day"], "claude:a is not an API profile."],
      [["gone", "--usd", "20", "--per", "day"], "Profile 'gone' not found."],
    ] as const) {
      await expect(run("budget", ...args), args.join(" ")).rejects.toThrow(message);
    }
    const key = ["sk", "ant", "api03", ["Qm7", "Zt4"].join("").repeat(5)].join("-");
    const error = await run("budget", key, "--usd", "20", "--per", "day").catch((e: unknown) => e);
    expect(String(error)).not.toContain(key.slice(-10));
    expect(file()).not.toHaveProperty("budgets");
  });

  it("warns about budgets that cannot be read, or that name no API profile, and refuses to write past them", async () => {
    const { run, deps } = budgetSetup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: { main: { tool: "claude" } },
        budgets: { "claude:gw": { usd: "20", per: "month" }, "claude:a": { usd: 5, per: "day" } },
      }),
    );
    const list = await run("list");
    expect(list).toContain('⚠ budgets["claude:gw"].usd: must be a number of dollars above 0');
    expect(list).toContain("⚠ budgets names claude:a, which is not an API profile; a budget applies only to one.");
    const json = JSON.parse(await run("list", "--json"));
    expect(json.problems).toEqual(['budgets["claude:gw"].usd: must be a number of dollars above 0']);
    expect(json.budgetWarnings).toEqual([
      "budgets names claude:a, which is not an API profile; a budget applies only to one.",
    ]);
    await expect(run("set", "main", "--strategy", "headroom")).rejects.toThrow(
      "has a budget that cannot be used, so nothing was saved",
    );
    // Setting the broken one mends it.
    await run("budget", "gw", "--usd", "20", "--per", "month");
    await run("set", "main", "--strategy", "headroom");
  });

  it("explains an API member: its budget column, its spend and whose limit counts it", async () => {
    const { run, deps } = budgetSetup();
    writeFileSync(
      deps.paths.routesPath,
      JSON.stringify({
        version: 1,
        routes: { main: { tool: "claude", from: ["a", "gw", "or"], strategy: "headroom" } },
        budgets: { "claude:gw": { usd: 20, per: "month" } },
      }),
    );
    const out = await run("explain", "main");
    expect(out).toMatch(/^ {4}ACCOUNT\s+5H\s+7D\s+BUDGET$/m);
    expect(out).toMatch(/^ {2}▸ claude:a\s+10%.*picked next$/m);
    expect(out).toMatch(/^ {4}claude:or\s+—\s+—\s+25% 23d\s+\$12\.50 of \$50\/month \(provider limit\)$/m);
    expect(out).toMatch(/^ {4}claude:gw\s+—\s+—\s+35% 23d\s+\$7\.00 of \$20\/month \(clausona budget\)$/m);
    const json = JSON.parse(await run("explain", "main", "--json"));
    expect(json.members.find((member: { profile: string }) => member.profile === "claude:gw")).toMatchObject({
      usage: { percent: 35, window: "budget", stale: false },
      budget: { usedPercent: 35, spentUsd: 7, limitUsd: 20, source: "budget", per: "month" },
    });
  });

  it("is not-found with --json for a profile that is not there", async () => {
    const { run } = budgetSetup();
    const error = (await run("budget", "gone", "--json").catch((e: unknown) => e)) as ExitError;
    expect(error).toMatchObject({ code: 1, kind: "not-found" });
    const out: string[] = [];
    reportError(error, { write: () => true }, { write: (chunk: string) => out.push(chunk) > 0 });
    expect(JSON.parse(out.join(""))).toEqual({ version: 1, error: "not-found", message: "Profile 'gone' not found." });
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

  it("saves nothing and opens no editor again when the answer to Edit again? is no", async () => {
    for (const answer of ["n", null]) {
      const { deps } = setup();
      writeFileSync(deps.paths.routesPath, '{ "version": 1, "routes": {} }\n');
      let opened = 0;
      deps.editText = async () => {
        // A second open fails at once. An edit loop that ignored the answer would otherwise spin
        // on promises that are already resolved, and the test's timeout would never fire.
        if (++opened > 1) throw new Error("opened the editor again");
        return JSON.stringify({ version: 1, routes: { main: { tool: "x" } } });
      };
      const asked: string[] = [];
      const io: RouteIo = {
        interactive: true,
        ask: async (question) => {
          asked.push(question);
          return answer;
        },
        say: () => {},
        confirm: async () => true,
      };
      expect(stripAnsi(await runRouteCommand(["edit"], io, deps))).toBe("Nothing was changed.");
      expect(asked).toEqual(["Edit again? (Y/n) "]);
      expect(opened).toBe(1);
      expect(readFileSync(deps.paths.routesPath, "utf8")).toBe('{ "version": 1, "routes": {} }\n');
    }
  });

  it("saves nothing and offers no second edit when the editor fails", async () => {
    const { deps } = setup();
    writeFileSync(deps.paths.routesPath, '{ "version": 1, "routes": {} }\n');
    // What editInEditor throws for an editor that exits non-zero.
    deps.editText = async () => {
      throw new Error("vi exited with 1, so nothing was changed.");
    };
    await expect(runRouteCommand(["edit"], NEVER_ASKS, deps)).rejects.toThrow(
      "vi exited with 1, so nothing was changed.",
    );
    expect(readFileSync(deps.paths.routesPath, "utf8")).toBe('{ "version": 1, "routes": {} }\n');
  });

  it("keeps another terminal's change to routes.json made while the editor was open, and the edit beside it", async () => {
    const { deps, io, file } = setup();
    writeFileSync(deps.paths.routesPath, '{ "version": 1, "routes": {} }\n');
    const mine = JSON.stringify({ version: 1, routes: { mine: { tool: "claude" } } });
    deps.editText = async () => {
      await runRouteCommand(["add", "theirs"], io, { ...deps, editText: async () => "" });
      return mine;
    };
    await expect(runRouteCommand(["edit"], io, deps)).rejects.toThrow(
      `${deps.paths.routesPath} changed while you were editing, so your edit was not saved. It is kept in ${deps.paths.editPath}: run \`clausona route edit\` and paste it in.`,
    );
    expect(Object.keys(file().routes)).toEqual(["theirs"]);
    expect(readFileSync(deps.paths.editPath, "utf8")).toBe(`${mine}\n`);
    // Only its owner can read it, as the editor's scratch file: it holds whatever was typed.
    if (process.platform !== "win32") expect(statSync(deps.paths.editPath).mode & 0o777).toBe(0o600);
  });

  it("deletes the kept edit once an edit saves it, and leaves it through any other save", async () => {
    const { deps, io } = setup();
    const kept = JSON.stringify({ version: 1, routes: { mine: { tool: "claude" } } }, null, 2);
    writeFileSync(deps.paths.editPath, `${kept}\n`);
    deps.editText = async () => JSON.stringify({ version: 1, routes: { other: { tool: "claude" } } });
    await runRouteCommand(["edit"], io, deps);
    expect(existsSync(deps.paths.editPath)).toBe(true);
    // Pasted in and saved, spaced as the editor left it.
    deps.editText = async () => JSON.stringify({ version: 1, routes: { mine: { tool: "claude" } } });
    await runRouteCommand(["edit"], io, deps);
    expect(existsSync(deps.paths.editPath)).toBe(false);
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
