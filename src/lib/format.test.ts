import { describe, expect, it } from "vitest";

import type { ProfileListItem, QuotaSnapshot } from "../types.js";
import {
  formatAge,
  formatQuotaInline,
  formatQuotaPercent,
  formatResetIn,
  quotaNotes,
  quotaSeverity,
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
