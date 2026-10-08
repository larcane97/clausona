import { describe, expect, it } from "vitest";

import { withDefaults } from "../core/route-config.js";
import type { Member } from "../core/route-patterns.js";
import { rankRoute } from "../core/routing.js";
import type { QuotaSnapshot, ToolName } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import {
  describeSpec,
  explainJson,
  pickJson,
  renderCreateScreen,
  renderExplain,
  renderNoAccount,
  renderNote,
  renderRouteList,
  usageText,
} from "./route-render.js";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const member = (id: string): Member => {
  const [tool, name] = id.split(":") as [ToolName, string];
  return {
    id,
    tool,
    name,
    email: `${name}@example.com`,
    kind: "subscription",
    sharesSessions: true,
    configDir: `/h/${name}`,
  };
};
const snap = (five: number, seven: number, state: QuotaSnapshot["state"] = "ok"): QuotaSnapshot => ({
  state,
  fetchedAt: NOW,
  session: { usedPercent: five, resetsAt: inHours(1) },
  weekly: { usedPercent: seven, resetsAt: inHours(50) },
});
const members = ["claude:team", "claude:work", "claude:old"].map(member);
const plain = (text: string) => stripAnsi(text);

function ranking(quotas: Record<string, QuotaSnapshot>, from = ["*"], lastPicked: Record<string, string> = {}) {
  return rankRoute({
    route: withDefaults({ tool: "claude", from }),
    members,
    quotas,
    lastPicked,
    now: NOW,
    resume: false,
  });
}

describe("usageText", () => {
  it("says the percent and the window", () => {
    expect(usageText({ percent: 40, window: "5H", stale: false })).toBe("40% 5H");
    expect(usageText({ percent: 20.4, window: "7D", stale: true })).toBe("20% 7D (stale)");
    expect(usageText(undefined)).toBe("—");
  });
});

describe("renderNote", () => {
  it("names the profile, the route, the usage and the strategy", () => {
    const r = ranking({ "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) });
    expect(plain(renderNote("main", r))).toBe("→ claude:team · route main · usage 40% (5H) · round-robin");
  });

  it("says which stage it came from", () => {
    const r = ranking({ "claude:team": snap(85, 0), "claude:work": snap(90, 0), "claude:old": snap(0, 99) });
    expect(plain(renderNote(undefined, r))).toBe(
      "→ claude:team · inline route (reserve) · usage 85% (5H) · every member at or above 80%",
    );
  });
});

describe("renderExplain", () => {
  it("shows every member, the pick and why the others were not", () => {
    const r = ranking(
      { "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) },
      ["*", "gone"],
      { "claude:work": new Date(NOW - 3 * 60_000).toISOString() },
    );
    const text = plain(renderExplain("main", r, NOW));
    expect(text).toContain("route main (claude · round-robin · max 80% · reserve 95%)");
    expect(text).toMatch(/→ claude:team\s+40%\s+30%\s+40% 5H\s+never\s+picked: next in turn/);
    expect(text).toMatch(/ {2}claude:work\s+20%\s+70%\s+70% 7D\s+3m ago/);
    expect(text).toMatch(/claude:old\s+0%\s+99%\s+99% 7D\s+never\s+at or above 80%/);
    expect(text).toMatch(/claude:gone\s+—\s+—\s+—\s+—\s+skipped: not registered/);
  });

  it("keeps the columns aligned for the widest usage, 100% and stale", () => {
    const stale: QuotaSnapshot = { ...snap(100, 0, "error"), fetchedAt: NOW - 10 * 60_000 };
    const r = ranking({ "claude:team": stale, "claude:work": snap(20, 70), "claude:old": snap(0, 99) });
    const lines = plain(renderExplain("main", r, NOW)).split("\n");
    const header = lines[1];
    const row = lines.find((line) => line.includes("claude:team")) ?? "";
    expect(row).toContain("100% 5H (stale)");
    expect(row.indexOf("never")).toBe(header.indexOf("LAST PICKED"));
  });

  it("says never for a pick time it cannot read, as ranking treats it", () => {
    const r = ranking({ "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) }, ["*"], {
      "claude:work": "not-a-date",
    });
    expect(plain(renderExplain("main", r, NOW))).toMatch(/claude:work\s+20%\s+70%\s+70% 7D\s+never/);
  });
});

describe("renderNoAccount", () => {
  it("lists every member with its reset, marks the soonest and names a way out", () => {
    const r = ranking({ "claude:team": snap(99, 0), "claude:work": snap(97, 98), "claude:old": snap(0, 96) });
    const text = plain(renderNoAccount("main", r, NOW));
    expect(text.split("\n")[0]).toBe("No account is available for route main.");
    expect(text).toMatch(/claude:team\s+99% 5H, resets in 1h\s+← soonest/);
    expect(text).toContain("Retry later, or name a profile: clausona run claude:team");
  });

  // Offline, nothing was read; "at or above" would be wrong.
  it("says no quota could be read when none was", () => {
    const r = ranking({});
    const text = plain(renderNoAccount("main", r, NOW));
    expect(text).toContain("No quota could be read for any member");
    expect(text).not.toMatch(/at or above/);
  });

  it("still says no quota could be read when the route also names someone unregistered", () => {
    const r = ranking({}, ["*", "gone"]);
    const text = plain(renderNoAccount("main", r, NOW));
    expect(text).toMatch(/claude:gone\s+not registered/);
    expect(text).toContain("No quota could be read for any member");
  });

  it("says when the patterns match nobody", () => {
    const r = ranking({}, ["team-x-*"]);
    expect(plain(renderNoAccount("main", r, NOW))).toContain("No profile matches team-x-*.");
  });

  it("says the exclude took everyone, rather than that nothing matched", () => {
    const r = rankRoute({
      route: withDefaults({ tool: "claude", exclude: ["*"] }),
      members,
      quotas: {},
      lastPicked: {},
      now: NOW,
      resume: false,
    });
    const text = plain(renderNoAccount("main", r, NOW));
    expect(text).toContain("No profile matches * after excluding *.");
    expect(text).not.toContain("No profile matches *.");
    expect(plain(renderExplain("main", r, NOW))).toContain("No profile matches * after excluding *.");
  });
});

describe("renderCreateScreen", () => {
  it("shows the pool before anything is written", () => {
    const r = ranking({ "claude:team": snap(1, 1), "claude:work": snap(90, 1), "claude:old": snap(1, 1, "missing") });
    const { body, question } = renderCreateScreen("work", { tool: "claude", from: ["*"] }, r, true);
    const text = plain(body);
    expect(text).toContain("Create 'work' now?");
    // Only claude:team is under the cut: claude:work is over it, and claude:old is signed out.
    expect(text).toContain("pool      * · 1 of 3 account(s) under 80% now");
    expect(text).toContain("claude:team, claude:work");
    expect(text).toContain("claude:old (signed out (clausona login claude:old))");
    expect(text).toContain("strategy  round-robin · max 80% · reserve 95%");
    expect(plain(question)).toBe("[Y]es and run · [e]dit · [n]o ");
  });
});

describe("renderRouteList", () => {
  it("shows each route's settings, member count and warnings", () => {
    const text = renderRouteList([
      {
        name: "main",
        route: withDefaults({ tool: "claude", exclude: ["*-share"], fallback: ["personal"] }),
        members: ["claude:team", "claude:work"],
        fallbackMembers: ["claude:personal"],
        excluded: ["claude:share"],
        unknownNames: ["gone"],
        emptyPatterns: ["team-x-*"],
      },
      {
        name: "cx",
        route: withDefaults({ tool: "codex" }),
        members: ["codex:main"],
        fallbackMembers: [],
        excluded: [],
        unknownNames: [],
        emptyPatterns: [],
      },
    ]);
    expect(plain(text)).toBe(
      [
        "  main  claude · round-robin · max 80% · reserve 95%",
        "        from * · exclude *-share · fallback personal · 2 member(s)",
        "        ⚠ 'gone' is not registered",
        "        ⚠ 'team-x-*' matches nobody",
        "  cx    codex · round-robin · max 80% · reserve 95%",
        "        from * · 1 member(s)",
      ].join("\n"),
    );
  });
});

describe("JSON", () => {
  it("pick names the profile, the stage and the usage", () => {
    const r = ranking({ "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) });
    expect(pickJson("main", r)).toEqual({
      profile: "claude:team",
      route: "main",
      stage: "pool",
      usage: { percent: 40, window: "5H", stale: false },
      reason: "next in turn",
    });
  });

  it("pick says when there is nobody", () => {
    const r = ranking({});
    expect(pickJson("main", r)).toEqual({
      profile: null,
      route: "main",
      stage: null,
      usage: null,
      reason: "no account is available",
      soonest: null,
    });
  });

  // The documented contract (docs/routing.md). Internal fields added to a ranking never leak into it.
  const withInternals = (r: ReturnType<typeof ranking>): ReturnType<typeof ranking> =>
    ({
      ...r,
      route: { ...r.route, internal: 1 },
      outcome: {
        ...r.outcome,
        internal: 1,
        ...(r.outcome.kind === "none" && r.outcome.soonest ? { soonest: { ...r.outcome.soonest, internal: 1 } } : {}),
      },
      rows: r.rows.map((row) => ({
        ...row,
        internal: 1,
        ...(row.usage ? { usage: { ...row.usage, internal: 1 } } : {}),
        ...(row.fiveHour ? { fiveHour: { ...row.fiveHour, label: "x" } } : {}),
        ...(row.sevenDay ? { sevenDay: { ...row.sevenDay, label: "x" } } : {}),
      })),
      excluded: r.excluded.map((entry) => ({ ...entry, internal: 1 })),
    }) as unknown as ReturnType<typeof ranking>;
  const keys = (value: unknown) => Object.keys(value as object).sort();

  it("explain has exactly the documented fields", () => {
    const r = rankRoute({
      route: withDefaults({ tool: "claude", from: ["*"], exclude: ["old"] }),
      members,
      quotas: { "claude:team": snap(40, 30), "claude:work": snap(20, 70) },
      lastPicked: {},
      now: NOW,
      resume: false,
    });
    const json = explainJson("main", "flag", withInternals(r)) as Record<string, unknown> & {
      members: Array<Record<string, unknown>>;
      excluded: object[];
    };
    expect(keys(json)).toEqual(["emptyPatterns", "excluded", "members", "outcome", "resolvedBy", "route", "settings"]);
    expect(keys(json.settings)).toEqual([
      "exclude",
      "fallback",
      "from",
      "maxUsage",
      "reserveUsage",
      "strategy",
      "tool",
    ]);
    expect(keys(json.outcome)).toEqual(["id", "kind", "reason", "stage"]);
    for (const entry of json.members) {
      expect(keys(entry)).toEqual([
        "fiveHour",
        "lastPickedAt",
        "matchedBy",
        "profile",
        "role",
        "sevenDay",
        "skipReason",
        "status",
        "usage",
      ]);
      expect(keys(entry.usage)).toEqual(["percent", "stale", "window"]);
      expect(keys(entry.fiveHour)).toEqual(["resetsAt", "usedPercent"]);
      expect(keys(entry.sevenDay)).toEqual(["resetsAt", "usedPercent"]);
    }
    expect(json.excluded.map(keys)).toEqual([["matchedBy", "profile"]]);

    const none = explainJson("main", "flag", withInternals(ranking({}))) as { outcome: object };
    expect(keys(none.outcome)).toEqual(["kind"]);
    const busy = ranking({ "claude:team": snap(99, 1), "claude:work": snap(99, 1), "claude:old": snap(99, 1) });
    const soon = explainJson("main", "flag", withInternals(busy)) as { outcome: { soonest: object } };
    expect(keys(soon.outcome)).toEqual(["kind", "soonest"]);
    expect(keys(soon.outcome.soonest)).toEqual(["at", "id"]);
  });

  it("pick has exactly the documented fields", () => {
    const r = ranking({ "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) });
    const picked = pickJson("main", withInternals(r)) as { usage: object };
    expect(keys(picked)).toEqual(["profile", "reason", "route", "stage", "usage"]);
    expect(keys(picked.usage)).toEqual(["percent", "stale", "window"]);
    const busy = ranking({ "claude:team": snap(99, 1), "claude:work": snap(99, 1), "claude:old": snap(99, 1) });
    const none = pickJson("main", withInternals(busy)) as { soonest: object };
    expect(keys(none)).toEqual(["profile", "reason", "route", "soonest", "stage", "usage"]);
    expect(keys(none.soonest)).toEqual(["at", "id"]);
  });

  it("explain lists every member with its status", () => {
    const r = ranking({ "claude:team": snap(40, 30), "claude:work": snap(20, 70), "claude:old": snap(0, 99) });
    const json = explainJson("main", "flag", r) as {
      resolvedBy: string;
      members: Array<{ profile: string; status: string }>;
    };
    expect(json.resolvedBy).toBe("flag");
    expect(json.members.map((m) => [m.profile, m.status])).toEqual([
      ["claude:old", "over-limit"],
      ["claude:team", "picked"],
      ["claude:work", "eligible"],
    ]);
  });
});

describe("describeSpec", () => {
  it("is one line", () => {
    expect(describeSpec({ tool: "claude", exclude: ["*-share"] })).toBe(
      "claude · round-robin · max 80% · reserve 95% · from * · exclude *-share",
    );
  });
});
