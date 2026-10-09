import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withDefaults } from "../core/route-config.js";
import { routesPaths } from "../core/routes-store.js";
import type { QuotaSnapshot, Registry } from "../types.js";
import { editInEditor } from "./editor.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  inferRouteTool,
  membersOf,
  NoAccountError,
  quotaTargets,
  type RouteDeps,
  rankRouteNow,
  resolveRoute,
  UnknownRouteError,
} from "./route-service.js";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const profile = (tool: "claude" | "codex", name: string, extra: Record<string, unknown> = {}) => ({
  tool,
  configDir: `/home/u/.${tool}-${name}`,
  email: `${name}@example.com`,
  ...extra,
});

const REGISTRY: Registry = {
  version: 2,
  primarySources: { claude: "/home/u/.claude" },
  activeProfiles: { claude: "claude:a" },
  profiles: {
    "claude:a": profile("claude", "a", { isPrimary: true }),
    "claude:b": profile("claude", "b", { mergeSessions: true }),
    "claude:c": profile("claude", "c"),
    "claude:glm": { tool: "claude", kind: "api", configDir: "/home/u/.claude-glm", email: "" },
    "codex:x": profile("codex", "x"),
  },
};

const snap = (five: number, seven: number): QuotaSnapshot => ({
  state: "ok",
  fetchedAt: NOW,
  session: { usedPercent: five, resetsAt: null },
  weekly: { usedPercent: seven, resetsAt: null },
});

function deps(quotas: Record<string, QuotaSnapshot>): RouteDeps & { asked: string[][] } {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-route-service-"));
  temps.push(dir);
  const asked: string[][] = [];
  return {
    asked,
    loadRegistry: async () => REGISTRY,
    collectQuotas: vi.fn<RouteDeps["collectQuotas"]>(async (targets) => {
      asked.push(targets.map((target) => target.id));
      return quotas;
    }),
    paths: routesPaths(dir),
    clock: () => NOW,
    editText: async () => {
      throw new Error("no editor in tests");
    },
  };
}

describe("membersOf", () => {
  it("maps the registry's profiles of one tool", () => {
    expect(membersOf(REGISTRY, "claude").map((m) => [m.id, m.name, m.kind, m.sharesSessions])).toEqual([
      ["claude:a", "a", "subscription", true],
      ["claude:b", "b", "subscription", true],
      ["claude:c", "c", "subscription", false],
      ["claude:glm", "glm", "api", false],
    ]);
  });
});

describe("resolveRoute", () => {
  const file = {
    version: 1 as const,
    routes: { main: { tool: "claude" as const, from: ["*"], maxUsage: 80, reserveUsage: 95 } },
  };

  it("finds a stored route and applies the run's overrides", () => {
    expect(resolveRoute(file, { options: { route: "main", strategy: "headroom" } })).toEqual({
      name: "main",
      resolvedBy: "flag",
      route: withDefaults({ tool: "claude", from: ["*"], maxUsage: 80, reserveUsage: 95, strategy: "headroom" }),
    });
  });

  it("throws UnknownRouteError naming the existing routes", () => {
    const error = (() => {
      try {
        resolveRoute(file, { options: { route: "work" } });
      } catch (e) {
        return e;
      }
    })() as UnknownRouteError;
    expect(error).toBeInstanceOf(UnknownRouteError);
    expect(error.existing).toEqual(["main"]);
    expect(error.message).toBe(
      "Route 'work' does not exist. Existing routes: main. Create it: clausona route add work",
    );
  });

  it("refuses a route for the other tool", () => {
    expect(() => resolveRoute(file, { tool: "codex", options: { route: "main" } })).toThrow(
      "Route 'main' is for claude, not codex.",
    );
  });

  it("builds an unsaved route from --from", () => {
    expect(resolveRoute(file, { tool: "codex", options: { from: ["*"] } })).toMatchObject({
      resolvedBy: "inline",
      route: { tool: "codex" },
    });
    expect(resolveRoute(file, { options: { from: ["claude:a", "claude:b"] } })?.route.tool).toBe("claude");
    // Unprefixed names, no tool word: a claude route, as `route add` makes one.
    expect(resolveRoute(file, { options: { from: ["a"] } })?.route.tool).toBe("claude");
  });

  it("is null when the run names no route", () => {
    expect(resolveRoute(file, { tool: "claude", options: {} })).toBeNull();
  });

  it("refuses field options that name no route, naming the flags only", () => {
    expect(() => resolveRoute(file, { tool: "claude", options: { exclude: ["work"], maxUsage: 70 } })).toThrow(
      /^--exclude and --max-usage need --route <name> or --from <patterns>\.$/,
    );
    expect(() => resolveRoute(file, { tool: "claude", options: { strategy: "headroom" } })).toThrow(
      /^--strategy needs --route <name> or --from <patterns>\.$/,
    );
    expect(() =>
      resolveRoute(file, {
        options: { fallback: ["b"], reserveUsage: 90, maxUsage: 70, strategy: "expiring", exclude: ["work"] },
      }),
    ).toThrow(
      /^--exclude, --strategy, --max-usage, --reserve-usage and --fallback need --route <name> or --from <patterns>\.$/,
    );
  });

  it("checks the run's overrides, without quoting a key-shaped one", () => {
    const key = ["sk", "ant", "x".repeat(24)].join("-");
    const run = () => resolveRoute(file, { options: { route: "main", exclude: [key] } });
    expect(run).toThrow("routes.main.exclude[0]: looks like an API key, not a profile name or email pattern");
    expect(run).not.toThrow(key);
  });

  it("adds a run's --exclude to the route's own, folding case, rather than replacing it", () => {
    const stored = {
      version: 1 as const,
      routes: { main: { tool: "claude" as const, exclude: ["*-share", "old"] } },
    };
    expect(resolveRoute(stored, { options: { route: "main", exclude: ["x", "OLD", "x"] } })?.route.exclude).toEqual([
      "*-share",
      "old",
      "x",
    ]);
    // A route that excludes nobody takes the run's list as it is.
    expect(resolveRoute(file, { options: { route: "main", exclude: ["x"] } })?.route.exclude).toEqual(["x"]);
  });

  it("refuses an empty route name before looking it up", () => {
    expect(() => resolveRoute(file, { options: { route: "" } })).toThrow(/^Invalid route name/);
  });
});

describe("errors", () => {
  it("UnknownRouteError leaves out the list when there are no routes", () => {
    expect(new UnknownRouteError("work", []).message).toBe(
      "Route 'work' does not exist. Create it: clausona route add work",
    );
  });

  it("NoAccountError exits 75 and carries the --json output", () => {
    const error = new NoAccountError("no account", "{}");
    expect([error.exitCode, error.stdout, error.name]).toEqual([75, "{}", "NoAccountError"]);
  });

  // Both variables are blanked first, so a real editor in the developer's environment never opens.
  it("route edit uses the editor config --edit uses, which says what to set when there is none", async () => {
    expect(defaultRouteDeps().editText).toBe(editInEditor);
    vi.stubEnv("VISUAL", "");
    vi.stubEnv("EDITOR", "");
    try {
      await expect(defaultRouteDeps().editText("", "routes.json")).rejects.toThrow("Set $EDITOR (or $VISUAL) to edit.");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("quotaTargets", () => {
  it("asks only for listed subscription members that are not excluded", () => {
    const members = membersOf(REGISTRY, "claude");
    const route = withDefaults({ tool: "claude", from: ["*", "glm"], exclude: ["c"] });
    expect(quotaTargets(route, members, false).map((target) => target.id)).toEqual(["claude:a", "claude:b"]);
  });

  it("leaves out, on a resumed run, the members that keep their own sessions", () => {
    const members = membersOf(REGISTRY, "claude");
    const route = withDefaults({ tool: "claude" });
    expect(quotaTargets(route, members, true).map((target) => target.id)).toEqual(["claude:a", "claude:b"]);
  });
});

describe("rankRouteNow", () => {
  it("ranks without recording when asked to", async () => {
    const d = deps({ "claude:a": snap(10, 10), "claude:b": snap(20, 20), "claude:c": snap(30, 30) });
    const ranking = await rankRouteNow({ route: withDefaults({ tool: "claude" }) }, d, {
      resume: false,
      record: false,
    });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(d.asked).toEqual([["claude:a", "claude:b", "claude:c"]]);
    expect(() => readFileSync(d.paths.picksPath)).toThrow();
  });

  it("never reads the quota of a member a resumed run skips", async () => {
    const d = deps({ "claude:a": snap(10, 10), "claude:b": snap(20, 20), "claude:c": snap(1, 1) });
    const ranking = await rankRouteNow({ route: withDefaults({ tool: "claude" }) }, d, {
      resume: true,
      record: false,
    });
    expect(d.asked).toEqual([["claude:a", "claude:b"]]);
    expect(ranking.rows.find((row) => row.id === "claude:c")?.skip).toBe("keeps-own-sessions");
  });

  it("records the pick, so the next run takes the next member", async () => {
    const d = deps({ "claude:a": snap(10, 10), "claude:b": snap(20, 20), "claude:c": snap(30, 30) });
    let tick = 0;
    d.clock = () => NOW + tick++;
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { outcome } = await rankRouteNow({ route: withDefaults({ tool: "claude" }) }, d, {
        resume: false,
        record: true,
      });
      if (outcome.kind === "picked") picks.push(outcome.id);
    }
    expect(picks).toEqual(["claude:a", "claude:b", "claude:c"]);
  });
});

describe("all routes in the service", () => {
  it("lists members of both tools", () => {
    expect(membersOf(REGISTRY, "all").map((m) => m.id)).toEqual([
      "claude:a",
      "claude:b",
      "claude:c",
      "claude:glm",
      "codex:x",
    ]);
  });

  it("lets a tool word narrow a stored all route", () => {
    const file = { version: 1 as const, routes: { any: { tool: "all" as const } } };
    expect(resolveRoute(file, { tool: "codex", options: { route: "any" } })).toMatchObject({
      name: "any",
      onlyTool: "codex",
    });
    // Without one, the whole route is ranked.
    expect(resolveRoute(file, { options: { route: "any" } })).not.toHaveProperty("onlyTool");
  });

  it("takes all as --tool: an unsaved route over both, or a stored all route as it is", () => {
    const file = {
      version: 1 as const,
      routes: { any: { tool: "all" as const }, main: { tool: "claude" as const } },
    };
    expect(resolveRoute(file, { tool: "all", options: { from: ["a"] } })?.route.tool).toBe("all");
    const stored = resolveRoute(file, { tool: "all", options: { route: "any" } });
    expect(stored?.route.tool).toBe("all");
    expect(stored).not.toHaveProperty("onlyTool");
    expect(() => resolveRoute(file, { tool: "all", options: { route: "main" } })).toThrow(
      "Route 'main' is for claude, not all.",
    );
  });

  it("infers the tool of an unsaved route, defaulting to claude", () => {
    const file = { version: 1 as const, routes: {} };
    expect(resolveRoute(file, { options: { from: ["a"] } })?.route.tool).toBe("claude");
    expect(resolveRoute(file, { options: { from: ["codex:*"] } })?.route.tool).toBe("codex");
    expect(resolveRoute(file, { options: { from: ["claude:a", "codex:x"] } })?.route.tool).toBe("all");
  });

  it("narrows an unsaved all route by the tool word, and keeps a one-tool one as the word says", () => {
    const file = { version: 1 as const, routes: {} };
    expect(resolveRoute(file, { tool: "codex", options: { from: ["claude:a", "codex:x"] } })).toMatchObject({
      route: { tool: "all" },
      onlyTool: "codex",
    });
    expect(resolveRoute(file, { tool: "codex", options: { from: ["a"] } })).not.toHaveProperty("onlyTool");
    // The word and the prefixes disagree: the prefix is checked against the word's tool.
    expect(() => resolveRoute(file, { tool: "codex", options: { from: ["claude:a"] } })).toThrow(
      "--from route.from[0]: 'claude:a' names a claude profile, but this route is for codex",
    );
  });

  it("asks quota only for the narrowed tool", () => {
    const route = withDefaults({ tool: "all" });
    expect(quotaTargets(route, membersOf(REGISTRY, "all"), false, "codex").map((t) => t.id)).toEqual(["codex:x"]);
    expect(quotaTargets(route, membersOf(REGISTRY, "all"), false).map((t) => t.id)).toEqual([
      "claude:a",
      "claude:b",
      "claude:c",
      "codex:x",
    ]);
  });

  it("ranks and reads only the tool a run names", async () => {
    const d = deps({ "claude:a": snap(1, 1), "codex:x": snap(50, 50) });
    const ranking = await rankRouteNow({ route: withDefaults({ tool: "all" }), onlyTool: "codex" }, d, {
      resume: false,
      record: false,
    });
    expect(d.asked).toEqual([["codex:x"]]);
    expect(ranking.rows.map((row) => row.id)).toEqual(["codex:x"]);
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "codex:x" });
  });
});

describe("inferRouteTool", () => {
  it("is the tool every entry is prefixed with, all for both, and nothing for a bare entry", () => {
    expect(inferRouteTool(["claude:a", "claude:*@example.com"])).toBe("claude");
    expect(inferRouteTool(["codex:x"])).toBe("codex");
    expect(inferRouteTool(["claude:a", "codex:x"])).toBe("all");
    expect(inferRouteTool(["claude:a", "b"])).toBeUndefined();
    expect(inferRouteTool(["*@example.com"])).toBeUndefined();
    expect(inferRouteTool(["gpt:x"])).toBeUndefined();
  });
});

describe("checkRouteMembers", () => {
  it("refuses an API profile, naming how to run it", () => {
    expect(() => checkRouteMembers("main", { tool: "claude", from: ["*", "glm"] }, REGISTRY)).toThrow(
      "claude:glm is an API profile. Routes take subscription profiles only in this version; run it by name: clausona run claude:glm",
    );
  });

  it("throws the route's own problems", () => {
    expect(() => checkRouteMembers("main", { tool: "claude", maxUsage: 0 }, REGISTRY)).toThrow(
      "routes.main.maxUsage: must be a number from 1 to 100",
    );
  });
});
