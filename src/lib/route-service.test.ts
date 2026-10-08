import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withDefaults } from "../core/route-config.js";
import { routesPaths } from "../core/routes-store.js";
import type { QuotaSnapshot, Registry } from "../types.js";
import {
  checkRouteMembers,
  defaultRouteDeps,
  membersOf,
  NoAccountError,
  onlyTool,
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

describe("onlyTool", () => {
  it("is undefined when both tools have subscription profiles", () => {
    expect(onlyTool(REGISTRY)).toBeUndefined();
  });

  it("is the tool when only one has any", () => {
    const { "codex:x": _, ...claudeOnly } = REGISTRY.profiles;
    expect(onlyTool({ ...REGISTRY, profiles: claudeOnly })).toBe("claude");
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
    expect(() => resolveRoute(file, { options: { from: ["a"] } })).toThrow(/Say which tool --from is for/);
  });

  it("is null when the run names no route", () => {
    expect(resolveRoute(file, { tool: "claude", options: {} })).toBeNull();
  });

  it("checks the run's overrides, without quoting a key-shaped one", () => {
    const key = ["sk", "ant", "x".repeat(24)].join("-");
    const run = () => resolveRoute(file, { options: { route: "main", exclude: [key] } });
    expect(run).toThrow("routes.main.exclude[0]: looks like an API key, not a profile name or email pattern");
    expect(run).not.toThrow(key);
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

  it("route edit rejects until the editor is wired", async () => {
    await expect(defaultRouteDeps().editText("", "routes.json")).rejects.toThrow("route edit is not available yet");
  });
});

describe("quotaTargets", () => {
  it("asks only for listed subscription members that are not excluded", () => {
    const members = membersOf(REGISTRY, "claude");
    const route = withDefaults({ tool: "claude", from: ["*", "glm"], exclude: ["c"] });
    expect(quotaTargets(route, members).map((target) => target.id)).toEqual(["claude:a", "claude:b"]);
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
