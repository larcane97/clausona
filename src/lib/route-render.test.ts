import { afterEach, describe, expect, it } from "vitest";

import { type RouteSpec, withDefaults } from "../core/route-config.js";
import type { Member } from "../core/route-patterns.js";
import { type Row, rankRoute, type SkipReason } from "../core/routing.js";
import type { QuotaSnapshot, ToolName } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import {
  explainJson,
  pickJson,
  type RouteListRow,
  renderNewRoutePreview,
  renderNoAccount,
  renderNote,
  renderRouteDetail,
  renderRoutesEmpty,
  renderRouteTable,
  skipText,
  toolLabel,
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

/** A reading whose windows reset in the given hours; null is a reset the API did not give. */
const quota = (five: number, seven: number, fiveIn: number | null = 1, sevenIn: number | null = 50): QuotaSnapshot => ({
  state: "ok",
  fetchedAt: NOW,
  session: { usedPercent: five, resetsAt: fiveIn === null ? null : inHours(fiveIn) },
  weekly: { usedPercent: seven, resetsAt: sevenIn === null ? null : inHours(sevenIn) },
});
const signedOut: QuotaSnapshot = { state: "missing", fetchedAt: NOW };

const EVERYONE = ["claude:team", "claude:work", "claude:side", "claude:personal", "claude:old", "claude:ops-share"].map(
  member,
);

function rank(
  spec: RouteSpec,
  quotas: Record<string, QuotaSnapshot>,
  options: { members?: Member[]; lastPicked?: Record<string, string>; resume?: boolean } = {},
) {
  return rankRoute({
    route: withDefaults(spec),
    members: options.members ?? EVERYONE,
    quotas,
    lastPicked: options.lastPicked ?? {},
    now: NOW,
    resume: options.resume ?? false,
  });
}

const widest = (text: string) =>
  Math.max(
    ...plain(text)
      .split("\n")
      .map((line) => line.length),
  );
const at = (width: number) => ({ width, now: NOW });

describe("usageText", () => {
  it("says the percent and the window", () => {
    expect(usageText({ percent: 40, window: "5H", stale: false })).toBe("40% 5H");
    expect(usageText({ percent: 20.4, window: "7D", stale: true })).toBe("20% 7D (stale)");
    expect(usageText(undefined)).toBe("—");
  });
});

describe("skipText", () => {
  it("says why a member is skipped, and the command that fixes it", () => {
    const row = (skip: SkipReason): Row => ({ id: "claude:old", role: "pool", pattern: "*", skip, status: "skipped" });
    expect(skipText(row("signed-out"))).toBe("signed out (csn login claude:old)");
    expect(skipText(row("expired"))).toBe("sign-in expired (csn login claude:old)");
    expect(skipText(row("no-reading"))).toBe("no quota reading (csn list --refresh)");
    expect(skipText(row("not-registered"))).toBe("not registered");
    expect(skipText(row("keeps-own-sessions"))).toBe("keeps its own sessions, so it cannot resume a shared one");
    expect(skipText(row("api-not-supported"))).toBe("API profile: routes take subscription profiles only for now");
  });
});

describe("toolLabel", () => {
  it("names one tool, or both", () => {
    expect(toolLabel("claude")).toBe("claude");
    expect(toolLabel("codex")).toBe("codex");
    expect(toolLabel("all")).toBe("claude + codex");
  });
});

describe("renderRoutesEmpty", () => {
  it("says what a route is and how to make one", () => {
    expect(plain(renderRoutesEmpty())).toBe(
      [
        "",
        "  No routes yet.",
        "",
        "  A route picks the account for you: the next one in turn that is",
        "  under 80% of its 5-hour and weekly limits.",
        "",
        "    csn route add main               every Claude account, taking turns",
        "    csn run --route main             run on the account it picks",
        "    csn route                        create and edit routes in the dashboard",
        "",
      ].join("\n"),
    );
  });
});

describe("renderRouteTable", () => {
  const main = rank(
    { tool: "claude", exclude: ["*-share"] },
    {
      "claude:team": quota(5, 22),
      "claude:work": quota(12, 34),
      "claude:side": quota(88, 40),
      "claude:personal": quota(30, 40),
    },
  );
  const busyQuotas = {
    "claude:team": quota(99, 10, 2),
    "claude:work": quota(99, 10, 3),
    "claude:side": quota(99, 10, 4),
    "claude:personal": quota(99, 10, 5),
  };
  const busy = rank({ tool: "all", exclude: ["*-share"] }, busyQuotas);
  const rows: RouteListRow[] = [
    { name: "main", route: main.route, ranking: main },
    { name: "solo", route: withDefaults({ tool: "claude", from: ["work"], strategy: "headroom" }) },
    { name: "everything", route: busy.route, ranking: busy },
  ];
  const warnings = ["solo names 'gone', which is not a registered profile."];

  it("shows each route's settings, who is free now and who is next", () => {
    const text = plain(renderRouteTable(rows, warnings, at(120)));
    const lines = text.split("\n");
    expect(lines[0]).toBe("");
    expect(lines.at(-1)).toBe("");
    expect(lines[1]).toMatch(/^ {4}ROUTE\s+TOOL\s+STRATEGY\s+LIMITS\s+FREE NOW\s+NEXT$/);
    expect(lines[2]).toMatch(/^ {4}─+$/);
    // Free: team, work and personal; side is over the cut, old has no reading, ops-share is excluded.
    expect(text).toMatch(/^ {4}main\s+claude\s+round-robin\s+80% \/ 95%\s+3 of 5\s+claude:team$/m);
    expect(text).toMatch(
      /^ {4}everything\s+claude \+ codex\s+round-robin\s+80% \/ 95%\s+0 of 5\s+none, soonest in 2h$/m,
    );
  });

  it("shows dashes for a route that was not ranked (--no-quota)", () => {
    expect(plain(renderRouteTable(rows, [], at(120)))).toMatch(/^ {4}solo\s+claude\s+headroom\s+80% \/ 95%\s+—\s+—$/m);
  });

  // Review Focus 2: offline, nothing was read, so nobody is free or next: dashes, as with --no-quota.
  it("shows dashes when no member's quota could be read", () => {
    const offline = rank({ tool: "claude", from: ["*", "gone"] }, {});
    expect(plain(renderRouteTable([{ name: "offline", route: offline.route, ranking: offline }], [], at(120)))).toMatch(
      /^ {4}offline\s+claude\s+round-robin\s+80% \/ 95%\s+—\s+—$/m,
    );
  });

  it("says now for a reset that has already passed", () => {
    const late = rank({ tool: "claude", from: ["team"] }, { "claude:team": quota(99, 10, -1) });
    expect(plain(renderRouteTable([{ name: "late", route: late.route, ranking: late }], [], at(120)))).toMatch(
      /^ {4}late\s+claude\s+round-robin\s+80% \/ 95%\s+0 of 1\s+none, soonest now$/m,
    );
  });

  it("says none when nobody is free and no reset is known", () => {
    const stuck = rank({ tool: "claude", from: ["team"] }, { "claude:team": quota(99, 99, null, null) });
    expect(plain(renderRouteTable([{ name: "stuck", route: stuck.route, ranking: stuck }], [], at(120)))).toMatch(
      /^ {4}stuck\s+claude\s+round-robin\s+80% \/ 95%\s+0 of 1\s+none$/m,
    );
  });

  it("prints the warnings below the table", () => {
    const lines = plain(renderRouteTable(rows, warnings, at(120))).split("\n");
    const index = lines.indexOf("  ⚠ solo names 'gone', which is not a registered profile.");
    expect(index).toBeGreaterThan(0);
    expect(lines[index - 1]).toBe("");
  });

  // Review Focus 1: an 80-column terminal never wraps a row; TOOL goes first, then LIMITS.
  it("drops TOOL, then LIMITS, rather than wrap a row", () => {
    const wide = plain(renderRouteTable(rows, warnings, at(120)));
    expect(wide.split("\n")[1]).toContain("TOOL");

    const at80 = renderRouteTable(rows, warnings, at(80));
    expect(widest(at80)).toBeLessThanOrEqual(80);
    const header80 = plain(at80).split("\n")[1];
    expect(header80).not.toContain("TOOL");
    expect(header80).toMatch(/ROUTE\s+STRATEGY\s+LIMITS\s+FREE NOW\s+NEXT/);
    expect(plain(at80)).toMatch(/everything\s+round-robin\s+80% \/ 95%\s+0 of 5\s+none, soonest in 2h/);

    const at60 = renderRouteTable(rows, warnings, at(60));
    expect(widest(at60)).toBeLessThanOrEqual(60);
    expect(plain(at60).split("\n")[1]).toMatch(/ROUTE\s+STRATEGY\s+FREE NOW\s+NEXT$/);
  });
});

describe("renderRouteDetail", () => {
  const quotas = {
    "claude:team": quota(5, 22),
    "claude:work": quota(12, 34),
    "claude:side": quota(88, 40),
    "claude:personal": quota(96, 81),
    "claude:old": signedOut,
  };
  const main = rank({ tool: "claude", exclude: ["*-share"] }, quotas, {
    lastPicked: { "claude:work": new Date(NOW - 3 * 60_000).toISOString() },
  });

  it("shows the settings in a box, then every member", () => {
    const text = plain(renderRouteDetail("main", main, at(120)));
    expect(text.startsWith("\n  ╭─ main ─")).toBe(true);
    for (const line of [
      "  │  Tool       claude",
      "  │  Strategy   round-robin (next in turn)",
      "  │  Limits     skip at 80%, reserve up to 95%",
      "  │  Accounts   * except *-share",
      "  │  Fallback   none",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/^ {4}ACCOUNT\s+5H\s+7D\s+LAST PICKED$/m);
    expect(text).toMatch(/^ {2}▸ claude:team\s+5% 1h\s+22% 2d\s+never\s+picked next$/m);
    expect(text).toMatch(/^ {4}claude:work\s+12% 1h\s+34% 2d\s+3m ago$/m);
    expect(text).toMatch(/^ {4}claude:side\s+88% 1h\s+40% 2d\s+over 80%$/m);
    expect(text).toMatch(/^ {4}claude:personal\s+96% 1h\s+81% 2d\s+over 80%$/m);
    expect(text).toMatch(/^ {4}claude:old\s+—\s+—\s+signed out \(csn login claude:old\)$/m);
    expect(text).toContain("\n    claude:ops-share  excluded by *-share\n");
    expect(text).not.toContain("Nobody can be picked");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("puts the pick first, then the others by usage, then the skipped and the excluded", () => {
    const text = plain(renderRouteDetail("main", main, at(120)));
    const order = ["▸ claude:team", "claude:work", "claude:side", "claude:personal", "claude:old", "claude:ops-share"];
    const positions = order.map((id) => text.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("shows LAST PICKED only for round-robin, and marks fallback members", () => {
    const r = rank(
      { tool: "claude", from: ["team", "work"], strategy: "headroom", fallback: ["side"] },
      { "claude:team": quota(85, 10), "claude:work": quota(90, 10), "claude:side": quota(10, 10) },
    );
    const text = plain(renderRouteDetail("solo", r, at(120)));
    expect(text).toContain("  │  Strategy   headroom (most room first)");
    expect(text).toContain("  │  Accounts   team, work");
    expect(text).toContain("  │  Fallback   side");
    expect(text).toMatch(/^ {4}ACCOUNT\s+5H\s+7D$/m);
    expect(text).not.toContain("LAST PICKED");
    expect(text).toMatch(/^ {2}▸ claude:side \(fallback\)\s+10% 1h\s+10% 2d\s+picked: fallback$/m);
    expect(text).toMatch(/^ {4}claude:team\s+85% 1h\s+10% 2d\s+over 80%$/m);
  });

  it("says when the pick comes from the reserve", () => {
    const r = rank(
      { tool: "claude", from: ["team", "work"], strategy: "expiring" },
      { "claude:team": quota(85, 10), "claude:work": quota(90, 10) },
    );
    const text = plain(renderRouteDetail("main", r, at(120)));
    expect(text).toContain("  │  Strategy   expiring (weekly limit resetting within 24h first)");
    expect(text).toMatch(/▸ claude:team\s+85% 1h\s+10% 2d\s+picked: reserve, most room up to 95%$/m);
  });

  it("says when nobody can be picked, and that a run would exit 75", () => {
    const r = rank(
      { tool: "claude", from: ["team", "work"] },
      { "claude:team": quota(99, 1), "claude:work": quota(1, 99) },
    );
    const text = plain(renderRouteDetail("main", r, at(120)));
    expect(text.endsWith("\n\n  Nobody can be picked now; csn run --route main would exit 75.\n")).toBe(true);
  });

  it("names the tool of a narrowed all route in the run that would exit 75", () => {
    const r = rankRoute({
      route: withDefaults({ tool: "all" }),
      members: [member("claude:team"), member("codex:x")],
      quotas: { "claude:team": quota(99, 10), "codex:x": quota(5, 5) },
      lastPicked: {},
      now: NOW,
      resume: false,
      onlyTool: "claude",
    });
    const text = plain(renderRouteDetail("any", r, { ...at(120), onlyTool: "claude" }));
    expect(text.endsWith("\n\n  Nobody can be picked now; csn run claude --route any would exit 75.\n")).toBe(true);
  });

  it("names both tools for an all route, and titles an unsaved one", () => {
    const text = plain(renderRouteDetail(undefined, rank({ tool: "all" }, quotas), at(120)));
    expect(text.startsWith("\n  ╭─ inline route ─")).toBe(true);
    expect(text).toContain("  │  Tool       claude + codex");
  });

  it("lists names that are not registered and patterns that match nobody", () => {
    const text = plain(
      renderRouteDetail("main", rank({ tool: "claude", from: ["*", "gone", "x-*"] }, quotas), at(120)),
    );
    expect(text).toMatch(/^ {4}claude:gone\s+not registered$/m);
    expect(text).toMatch(/^ {4}x-\*\s+matches nobody$/m);
  });

  it("says the exclude took everyone, rather than that nothing matched", () => {
    const text = plain(renderRouteDetail("main", rank({ tool: "claude", exclude: ["*"] }, quotas), at(120)));
    expect(text).toContain("No profile matches * after excluding *.");
    expect(text).not.toContain("No profile matches *.");
    expect(text).not.toContain("ACCOUNT");
  });

  // Review Focus 1.
  it("never wraps a row at 80 columns", () => {
    const text = renderRouteDetail("main", main, at(80));
    expect(widest(text)).toBeLessThanOrEqual(80);
    // The signed-out row gives up its dashes before the table gives up a column.
    expect(plain(text)).toMatch(/^ {4}ACCOUNT\s+5H\s+7D\s+LAST PICKED$/m);
    expect(plain(text)).toMatch(/^ {4}claude:old\s+signed out \(csn login claude:old\)$/m);

    // The longest words a row can carry: a resumed run's skip, and a reserve pick.
    const loners = ["claude:team", "claude:work", "claude:personal"].map((id) => ({
      ...member(id),
      sharesSessions: id === "claude:team",
    }));
    const resumedQuotas = {
      "claude:team": quota(85, 10),
      "claude:work": quota(10, 10),
      "claude:personal": quota(10, 10),
    };
    const resumed = rank({ tool: "claude" }, resumedQuotas, { members: loners, resume: true });
    const long = renderRouteDetail("main", resumed, at(80));
    expect(plain(long)).toContain("keeps its own sessions, so it cannot resume a shared one");
    expect(plain(long)).toContain("picked: reserve, most room up to 95%");
    expect(widest(long)).toBeLessThanOrEqual(80);

    // Wider still with a fallback mark: the words are cut, the row still does not wrap.
    const marked = rank({ tool: "claude", from: ["team", "work"], fallback: ["personal"] }, resumedQuotas, {
      members: loners,
      resume: true,
    });
    expect(widest(renderRouteDetail("main", marked, at(80)))).toBeLessThanOrEqual(80);
  });

  it("keeps a long pattern list inside the box at 80 columns", () => {
    const from = ["team", "work", "side", "personal", "old", "*@work.example.com", "*@home.example.com"];
    const text = renderRouteDetail("main", rank({ tool: "claude", from }, quotas), at(80));
    expect(widest(text)).toBeLessThanOrEqual(80);
    expect(plain(text)).toContain("│  Accounts   team, work, side, personal, old, *@work.example.com,");
  });
});

describe("renderNote", () => {
  it("names the profile, the route, why, and the usage", () => {
    const r = ranking({ "claude:team": snap(5, 22), "claude:work": snap(12, 34), "claude:old": snap(0, 99) });
    expect(plain(renderNote("main", r))).toBe("  ▸ claude:team  route main, next in turn, 22% of 7D used");
  });

  it("says the stage when the pool had nobody, and an unsaved route", () => {
    const r = ranking({ "claude:team": snap(85, 0), "claude:work": snap(90, 0), "claude:old": snap(0, 99) });
    expect(plain(renderNote(undefined, r))).toBe("  ▸ claude:team  inline route, reserve, 85% of 5H used");
    const fallback = rank(
      { tool: "claude", from: ["team"], fallback: ["work"] },
      { "claude:team": quota(90, 0), "claude:work": quota(10, 20) },
    );
    expect(plain(renderNote("main", fallback))).toBe("  ▸ claude:work  route main, fallback, 20% of 7D used");
  });

  it("says why for each strategy", () => {
    const quotas = { "claude:team": quota(10, 30, 1, 20), "claude:work": quota(5, 5) };
    const headroom = rank({ tool: "claude", from: ["team", "work"], strategy: "headroom" }, quotas);
    expect(plain(renderNote("main", headroom))).toBe("  ▸ claude:work  route main, most room, 5% of 5H used");
    const expiring = rank({ tool: "claude", from: ["team", "work"], strategy: "expiring" }, quotas);
    expect(plain(renderNote("main", expiring))).toBe(
      "  ▸ claude:team  route main, weekly limit resets within 24h, 30% of 7D used",
    );
    const later = rank({ tool: "claude", from: ["work"], strategy: "expiring" }, quotas);
    expect(plain(renderNote("main", later))).toBe("  ▸ claude:work  route main, most room, 5% of 5H used");
  });

  it("says when the usage is the last reading", () => {
    const stale: QuotaSnapshot = { ...quota(40, 10), state: "error", fetchedAt: NOW - 10 * 60_000 };
    const r = rank({ tool: "claude", from: ["team"] }, { "claude:team": stale });
    expect(plain(renderNote("main", r))).toBe(
      "  ▸ claude:team  route main, next in turn, 40% of 5H used, last reading",
    );
  });

  it("is empty when nobody was picked", () => {
    expect(renderNote("main", ranking({}))).toBe("");
  });
});

describe("renderNoAccount", () => {
  const quotas = {
    "claude:side": quota(96, 40, 1, 72),
    // With the reserve at 95, only the weekly window holds this one back.
    "claude:personal": quota(88, 97, 2, 48),
    "claude:old": signedOut,
  };
  const busy = rank({ tool: "claude", from: ["personal", "side", "old"] }, quotas);

  it("says nobody is free, when each will be, and what to do", () => {
    const text = plain(renderNoAccount("main", busy, at(120)));
    const lines = text.split("\n");
    expect(lines[0]).toBe("No account in route main is free right now.");
    expect(lines[1]).toBe("");
    expect(text).toMatch(/^ {4}ACCOUNT\s+5H\s+7D\s+FREE AGAIN$/m);
    expect(text).toContain("in 1h (5H resets)   soonest");
    expect(text).toMatch(/^ {4}claude:side\s+96% 1h\s+40% 3d\s+in 1h \(5H resets\) {3}soonest$/m);
    expect(text).toMatch(/^ {4}claude:personal\s+88% 2h\s+97% 2d\s+in 2d \(7D resets\)$/m);
    expect(text).toMatch(/^ {4}claude:old\s+signed out \(csn login claude:old\)$/m);
    expect(text).toContain("\n\n    Run again after 1h, or see everything with: csn route explain main\n");
    // Soonest first; the skipped last.
    expect(text.indexOf("claude:side")).toBeLessThan(text.indexOf("claude:personal"));
    expect(text.indexOf("claude:personal")).toBeLessThan(text.indexOf("claude:old"));
  });

  // Review Focus 2: offline, nothing was read, so nobody is "over" anything.
  it("says no quota could be read when none was, even with an unregistered name", () => {
    const offline = rank({ tool: "claude", from: ["*", "gone"] }, {});
    const text = plain(renderNoAccount("main", offline, at(120)));
    expect(text).toContain(
      "\n    No quota could be read for any member: check the network, or run csn list --refresh.\n",
    );
    expect(text).toMatch(/^ {4}claude:gone\s+not registered$/m);
    expect(text).not.toMatch(/over|at or above|Run again/);

    const narrow = renderNoAccount("main", offline, at(80));
    expect(widest(narrow)).toBeLessThanOrEqual(80);
    expect(plain(narrow)).toContain(
      "    No quota could be read for any member: check the network, or run\n    csn list --refresh.",
    );
  });

  it("says now for a reset that has already passed", () => {
    const r = rank(
      { tool: "claude", from: ["team", "work"] },
      { "claude:team": quota(99, 10, -1), "claude:work": quota(99, 10, 2) },
    );
    const text = plain(renderNoAccount("main", r, at(120)));
    expect(text).toMatch(/^ {4}claude:team\s.*\s{2}now \(5H resets\)\s+soonest$/m);
    expect(text).toMatch(/^ {4}claude:work\s.*\s{2}in 2h \(5H resets\)$/m);
    expect(text).toContain("\n    Run again now, or see everything with: csn route explain main\n");
    expect(text).not.toMatch(/\bin now\b|after now/);
  });

  it("names the tool a run narrowed an all route to, and explains that tool only", () => {
    const both = [...["claude:team", "claude:work"].map(member), member("codex:x")];
    const quotas = { "claude:team": quota(99, 10), "claude:work": quota(99, 10, 2), "codex:x": quota(5, 5) };
    const narrowed = (from: string[]) =>
      rankRoute({
        route: withDefaults({ tool: "all", from }),
        members: both,
        quotas,
        lastPicked: {},
        now: NOW,
        resume: false,
        onlyTool: "claude",
      });
    const text = plain(renderNoAccount("any", narrowed(["*"]), { ...at(120), onlyTool: "claude" }));
    expect(text.split("\n")[0]).toBe("No claude account in route any is free right now.");
    expect(text).toContain("or see everything with: csn route explain any --tool claude\n");
    expect(text).not.toContain("codex:x");

    const inline = plain(
      renderNoAccount(undefined, narrowed(["claude:*", "codex:*"]), { ...at(120), onlyTool: "claude" }),
    );
    expect(inline.split("\n")[0]).toBe("No claude account in the inline route is free right now.");
    expect(inline).toContain("csn route explain --tool claude --from 'claude:*,codex:*'");

    // Without narrowing, the headline and the hint stay as they are.
    const whole = plain(renderNoAccount("main", narrowed(["*"]), at(120)));
    expect(whole.split("\n")[0]).toBe("No account in route main is free right now.");
    expect(whole).toContain("csn route explain main\n");
  });

  it("says later when no reset is known", () => {
    const r = rank({ tool: "claude", from: ["team"] }, { "claude:team": quota(99, 99, null, null) });
    const text = plain(renderNoAccount("main", r, at(120)));
    expect(text).toMatch(/^ {4}claude:team\s+99%\s+99%\s+—$/m);
    expect(text).toContain("    Run again later, or see everything with: csn route explain main\n");
  });

  it("gives an unsaved route's explain command", () => {
    const r = rank(
      { tool: "claude", from: ["team", "work"] },
      { "claude:team": quota(99, 1), "claude:work": quota(99, 1) },
    );
    const text = plain(renderNoAccount(undefined, r, at(120)));
    expect(text.split("\n")[0]).toBe("No account in the inline route is free right now.");
    expect(text).toContain("csn route explain --tool claude --from 'team,work'");
  });

  it("says when the patterns match nobody, or the exclude took everyone", () => {
    expect(plain(renderNoAccount("main", rank({ tool: "claude", from: ["team-x-*"] }, {}), at(120)))).toContain(
      "No profile matches team-x-*.",
    );
    const text = plain(renderNoAccount("main", rank({ tool: "claude", exclude: ["*"] }, {}), at(120)));
    expect(text).toContain("No profile matches * after excluding *.");
    expect(text).not.toContain("No profile matches *.");
  });

  // Review Focus 1.
  it("never wraps a row at 80 columns", () => {
    expect(widest(renderNoAccount("main", busy, at(80)))).toBeLessThanOrEqual(80);
  });
});

describe("renderNewRoutePreview", () => {
  const four = ["claude:team", "claude:work", "claude:side", "claude:personal", "claude:old"].map(member);
  const quotas = {
    "claude:team": quota(5, 1),
    "claude:work": quota(12, 1),
    "claude:side": quota(88, 1),
    "claude:personal": quota(96, 1),
  };

  it("says what the new route would take, and who is in it now", () => {
    const spec: RouteSpec = { tool: "claude", from: ["*"] };
    const r = rank(spec, quotas, { members: four.slice(0, 4) });
    expect(plain(renderNewRoutePreview("work", spec, r, { width: 120 }))).toBe(
      [
        "",
        "  Route work does not exist yet. It would take every claude account,",
        "  taking turns and skipping any at 80% or more:",
        "",
        "    claude:team 5%   claude:work 12%   claude:side 88% (over)   claude:personal 96% (over)",
        "",
      ].join("\n"),
    );
  });

  it("names the accounts when the route names them, and says why one is skipped", () => {
    const spec: RouteSpec = { tool: "claude", from: ["team", "work"] };
    const text = plain(renderNewRoutePreview("work", spec, rank(spec, quotas, { members: four }), { width: 120 }));
    expect(text).toContain("  Route work does not exist yet. It would take claude:team, claude:work,\n  taking turns");
    const withOld = { ...quotas, "claude:old": signedOut };
    const all = plain(
      renderNewRoutePreview("work", { tool: "claude" }, rank({ tool: "claude" }, withOld, { members: four }), {
        width: 120,
      }),
    );
    expect(all).toContain("claude:old (signed out)");
  });

  it("wraps the accounts at the width, never inside one", () => {
    const spec: RouteSpec = { tool: "claude", from: ["*"] };
    const text = plain(
      renderNewRoutePreview("work", spec, rank(spec, quotas, { members: four.slice(0, 4) }), { width: 60 }),
    );
    expect(widest(text)).toBeLessThanOrEqual(60);
    expect(text).toContain(
      "\n    claude:team 5%   claude:work 12%\n    claude:side 88% (over)   claude:personal 96% (over)\n",
    );
  });
});

describe("terminal width", () => {
  const saved = {
    stdout: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
    stderr: Object.getOwnPropertyDescriptor(process.stderr, "columns"),
  };
  afterEach(() => {
    for (const name of ["stdout", "stderr"] as const) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(process[name], "columns", descriptor);
      else delete (process[name] as { columns?: number }).columns;
    }
  });
  const columns = (stdout: number | undefined, stderr: number | undefined) => {
    Object.defineProperty(process.stdout, "columns", { value: stdout, configurable: true, writable: true });
    Object.defineProperty(process.stderr, "columns", { value: stderr, configurable: true, writable: true });
  };

  const team = [member("claude:team"), member("claude:work")];
  const quotas = { "claude:team": quota(99, 10), "claude:work": quota(99, 10, 2) };
  const busy = rank({ tool: "claude" }, quotas, { members: team });
  const spec: RouteSpec = { tool: "claude" };
  const open = rank(spec, { "claude:team": quota(5, 1), "claude:work": quota(12, 1) }, { members: team });
  const rows: RouteListRow[] = [{ name: "everything-claude", route: busy.route, ranking: busy }];

  // The exit-75 message and the new-route preview are written to stderr; tables are written to stdout.
  it("sizes what goes to stderr by stderr, and the rest by stdout", () => {
    columns(200, 50);
    expect(widest(renderNoAccount("main", busy, { now: NOW }))).toBeLessThanOrEqual(50);
    expect(widest(renderNewRoutePreview("work", spec, open))).toBeLessThanOrEqual(50);
    expect(plain(renderRouteTable(rows, [], { now: NOW })).split("\n")[1]).toContain("TOOL");

    columns(50, 200);
    expect(plain(renderNoAccount("main", busy, { now: NOW }))).toContain(
      "    Run again after 1h, or see everything with: csn route explain main\n",
    );
    expect(plain(renderRouteTable(rows, [], { now: NOW })).split("\n")[1]).not.toContain("TOOL");
  });

  it("falls back to stdout's width when stderr has none, then to 120", () => {
    columns(50, undefined);
    expect(widest(renderNoAccount("main", busy, { now: NOW }))).toBeLessThanOrEqual(50);
    columns(undefined, undefined);
    expect(plain(renderNoAccount("main", busy, { now: NOW }))).toContain(
      "    Run again after 1h, or see everything with: csn route explain main\n",
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
