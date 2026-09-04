import { describe, expect, it } from "vitest";

import type { ProfileListItem, QuotaSnapshot } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import {
  fitQuotaValue,
  formatAge,
  formatQuotaInline,
  formatQuotaPercent,
  formatResetIn,
  formatResetShort,
  LIST_MIN_WIDTH,
  pickLayout,
  quotaBar,
  quotaNotes,
  quotaSeverity,
  renderList,
} from "./format.js";

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return { state: "ok", fetchedAt: 0, ...overrides };
}

describe("formatQuotaPercent", () => {
  it("rounds to a whole percent", () => {
    expect(formatQuotaPercent({ usedPercent: 44.6, resetsAt: null })).toBe("45%");
  });

  it("renders an em dash when the window is absent", () => {
    expect(formatQuotaPercent(undefined)).toBe("—");
  });
});

describe("formatResetIn", () => {
  const now = new Date("2026-09-04T00:00:00Z");

  it("formats sub-hour, hour, and multi-day gaps", () => {
    expect(formatResetIn("2026-09-04T00:42:00Z", now)).toBe("42m");
    expect(formatResetIn("2026-09-04T02:10:00Z", now)).toBe("2h 10m");
    expect(formatResetIn("2026-09-04T05:00:00Z", now)).toBe("5h");
    expect(formatResetIn("2026-09-07T04:00:00Z", now)).toBe("3d 4h");
    expect(formatResetIn("2026-09-07T00:00:00Z", now)).toBe("3d");
  });

  it("collapses an elapsed window to `now`", () => {
    expect(formatResetIn("2026-09-03T23:00:00Z", now)).toBe("now");
  });

  it("handles a missing or unparseable timestamp", () => {
    expect(formatResetIn(null, now)).toBe("—");
    expect(formatResetIn("not a date", now)).toBe("—");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const at = (iso: string) => formatAge(Date.parse(iso), now);

  it("describes how long ago a reading was taken", () => {
    expect(at("2026-09-04T11:58:00Z")).toBe("2m ago");
    expect(at("2026-09-04T09:00:00Z")).toBe("3h ago");
    expect(at("2026-09-01T09:00:00Z")).toBe("3d ago");
  });

  it("collapses anything under a minute", () => {
    expect(at("2026-09-04T11:59:30Z")).toBe("just now");
  });
});

describe("formatQuotaInline", () => {
  it("joins the windows it has", () => {
    const quota = snapshot({
      session: { usedPercent: 61, resetsAt: null },
      weekly: { usedPercent: 100, resetsAt: null },
    });

    expect(formatQuotaInline(quota)).toBe("5h 61% | 7d 100%");
  });

  it("omits a window the plan does not report", () => {
    expect(formatQuotaInline(snapshot({ weekly: { usedPercent: 4, resetsAt: null } }))).toBe("7d 4%");
  });

  it("flags a reading that is not current", () => {
    const quota = snapshot({ state: "cooldown", weekly: { usedPercent: 4, resetsAt: null } });

    expect(formatQuotaInline(quota)).toBe("7d 4% (cooldown)");
  });

  it("falls back to the bare state when there are no numbers", () => {
    expect(formatQuotaInline(snapshot({ state: "expired" }))).toBe("expired");
    expect(formatQuotaInline(undefined)).toBe("");
  });
});

describe("quotaSeverity", () => {
  it("grades on the most-consumed window", () => {
    const peak = (session: number, weekly: number) =>
      quotaSeverity(
        snapshot({
          session: { usedPercent: session, resetsAt: null },
          weekly: { usedPercent: weekly, resetsAt: null },
        }),
      );

    expect(peak(5, 46)).toBe("healthy");
    expect(peak(5, 77)).toBe("warning");
    expect(peak(100, 46)).toBe("error");
  });

  it("stays neutral when the reading is not live", () => {
    expect(quotaSeverity(snapshot({ state: "cooldown", weekly: { usedPercent: 100, resetsAt: null } }))).toBe("muted");
    expect(quotaSeverity(undefined)).toBe("muted");
  });
});

describe("quotaNotes", () => {
  const item = (quota?: QuotaSnapshot) => ({ quota }) as ProfileListItem;

  it("emits one note per distinct problem", () => {
    const notes = quotaNotes([
      item(snapshot()),
      item(snapshot({ state: "expired" })),
      item(snapshot({ state: "expired" })),
      item(snapshot({ state: "missing" })),
    ]);

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^expired: /);
    expect(notes[1]).toMatch(/^missing: /);
  });

  it("is silent when everything is current", () => {
    expect(quotaNotes([item(snapshot()), item(undefined)])).toEqual([]);
  });
});

describe("formatResetShort", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const at = (iso: string) => formatResetShort(iso, now);

  it("collapses to a single unit for table cells", () => {
    expect(at("2026-09-04T00:42:00Z")).toBe("42m");
    expect(at("2026-09-04T02:10:00Z")).toBe("2h");
    expect(at("2026-09-07T04:00:00Z")).toBe("3d");
  });

  it("never rounds a live window down to zero", () => {
    expect(at("2026-09-04T00:00:30Z")).toBe("1m");
    expect(at("2026-09-03T23:00:00Z")).toBe("now");
  });

  it("is empty when there is nothing to report", () => {
    expect(formatResetShort(null, now)).toBe("");
    expect(formatResetShort("nope", now)).toBe("");
  });
});

describe("pickLayout", () => {
  it("keeps every column when the terminal is wide", () => {
    expect(pickLayout(true, 200).keys).toEqual(["profile", "account", "session", "weekly", "cost", "input", "output"]);
  });

  it("drops token counts before cost, and cost before quota", () => {
    expect(pickLayout(true, 104).keys).not.toContain("output");
    expect(pickLayout(true, 104).keys).toContain("cost");

    const narrow = pickLayout(true, 80).keys;
    expect(narrow).not.toContain("cost");
    expect(narrow).toEqual(["profile", "account", "session", "weekly"]);
  });

  it("gives up reset times before it gives up the quota columns", () => {
    expect(pickLayout(true, 78).reset).toBe(true);
    expect(pickLayout(true, 70).reset).toBe(false);
    expect(pickLayout(true, 70).keys).toContain("session");
  });

  it("shrinks the name and account columns as a last resort", () => {
    const tiny = pickLayout(true, 40);
    expect(tiny.profileWidth).toBeLessThan(20);
    expect(tiny.accountWidth).toBeLessThan(32);
    expect(tiny.keys).toContain("weekly");
  });

  it("keeps the pre-quota layout when quota is not shown", () => {
    expect(pickLayout(false, 200).keys).toEqual(["profile", "account", "cost", "input", "output"]);
  });
});

describe("renderList width", () => {
  const item = (name: string, quota?: QuotaSnapshot): ProfileListItem => ({
    name,
    tool: "claude",
    email: `${name}@example.com`,
    configDir: `/home/u/.claude-${name}`,
    isPrimary: false,
    isActive: false,
    quota,
    today: { cost: 0, inputTokens: 0, outputTokens: 0 },
    week: { cost: 1, inputTokens: 10, outputTokens: 5 },
    month: { cost: 1, inputTokens: 10, outputTokens: 5 },
    total: { cost: 1, inputTokens: 10, outputTokens: 5 },
  });

  const visibleWidth = (line: string) => stripAnsi(line).length;

  it("never emits a line wider than the terminal", () => {
    const items = [
      item("a-very-long-profile-name-indeed", snapshot({ session: { usedPercent: 5, resetsAt: null } })),
      item("short", snapshot({ weekly: { usedPercent: 100, resetsAt: "2030-01-01T00:00:00Z" } })),
    ];

    for (const width of [LIST_MIN_WIDTH, 60, 70, 78, 80, 90, 100, 104, 120, 200]) {
      const lines = renderList(items, { width }).split("\n");
      const over = lines.filter((line) => visibleWidth(line) > width);
      expect(over, `width ${width} overflowed: ${JSON.stringify(over)}`).toEqual([]);
    }
  });

  it("falls back to the narrowest layout below the guaranteed width", () => {
    // Nothing left to drop: keeping the profile name readable beats fitting.
    expect(LIST_MIN_WIDTH).toBeLessThanOrEqual(60);
    expect(pickLayout(true, 20)).toEqual(pickLayout(true, LIST_MIN_WIDTH - 1));
  });

  it("shows the reset time alongside the percentage when there is room", () => {
    // Half past, so the single-unit flooring cannot land on the neighbouring hour
    // while the test runs.
    const resetsAt = new Date(Date.now() + 3.5 * 3600_000).toISOString();
    const out = stripAnsi(
      renderList([item("work", snapshot({ session: { usedPercent: 42, resetsAt } }))], { width: 200 }),
    );

    expect(out).toContain("42% 3h");
  });

  it("drops the codex footnote once no spend column is left to explain", () => {
    const codex = {
      ...item("cdx"),
      tool: "codex" as const,
      quota: snapshot({ weekly: { usedPercent: 3, resetsAt: null } }),
    };

    expect(stripAnsi(renderList([codex], { width: 200 }))).toContain("not available for codex");
    expect(stripAnsi(renderList([codex], { width: 80 }))).not.toContain("not available for codex");
  });
});

describe("quotaBar", () => {
  it("fills proportionally and always spans ten cells", () => {
    expect(quotaBar(0)).toBe("░░░░░░░░░░");
    expect(quotaBar(50)).toBe("█████░░░░░");
    expect(quotaBar(100)).toBe("██████████");
  });

  it("clamps nonsense input", () => {
    expect(quotaBar(-20)).toHaveLength(10);
    expect(quotaBar(420)).toBe("██████████");
  });
});

describe("fitQuotaValue", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const window = { usedPercent: 26, resetsAt: "2026-09-04T12:59:00Z" };

  it("sheds the gauge, then the wording, then the reset time as space runs out", () => {
    expect(fitQuotaValue(window, 40, now)).toBe("███░░░░░░░  26%  resets in 12h 59m");
    expect(fitQuotaValue(window, 30, now)).toBe(" 26%  resets in 12h 59m");
    expect(fitQuotaValue(window, 20, now)).toBe("███░░░░░░░  26% 12h");
    expect(fitQuotaValue(window, 10, now)).toBe(" 26% 12h");
    expect(fitQuotaValue(window, 5, now)).toBe(" 26%");
  });

  it("never exceeds the budget once the percentage alone fits", () => {
    for (let width = 4; width <= 60; width += 1) {
      expect(fitQuotaValue(window, width, now).length).toBeLessThanOrEqual(Math.max(width, 4));
    }
  });

  it("omits reset wording entirely when the window reports no reset", () => {
    const noReset = { usedPercent: 0, resetsAt: null };

    expect(fitQuotaValue(noReset, 40, now)).toBe("░░░░░░░░░░   0%");
    expect(fitQuotaValue(noReset, 5, now)).toBe("  0%");
  });
});
