import { describe, expect, it } from "vitest";

import { summarizeUsage } from "./usage.js";

describe("usage", () => {
  it("aggregates records for the requested period using local time", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);

    const todayRecord = new Date();
    todayRecord.setHours(8, 0, 0, 0);

    const yesterdayRecord = new Date();
    yesterdayRecord.setDate(yesterdayRecord.getDate() - 1);
    yesterdayRecord.setHours(8, 0, 0, 0);

    const summary = summarizeUsage({
      now: now.toISOString(),
      period: "today",
      records: [
        { ts: todayRecord.toISOString(), tz: "+09:00", cost: 1.5, inputTokens: 100, outputTokens: 50 },
        { ts: yesterdayRecord.toISOString(), tz: "+09:00", cost: 2, inputTokens: 200, outputTokens: 75 },
      ],
    });

    expect(summary).toEqual({ cost: 1.5, inputTokens: 100, outputTokens: 50 });
  });

  it("week period starts on Monday (Sunday edge case)", () => {
    // Find the next Sunday from today
    const sunday = new Date();
    sunday.setHours(12, 0, 0, 0);
    while (sunday.getDay() !== 0) {
      sunday.setDate(sunday.getDate() + 1);
    }

    // Monday of that week = 6 days before Sunday
    const monday = new Date(sunday);
    monday.setDate(monday.getDate() - 6);
    monday.setHours(10, 0, 0, 0);

    // Saturday before that Monday (should be excluded)
    const prevSaturday = new Date(monday);
    prevSaturday.setDate(prevSaturday.getDate() - 1);
    prevSaturday.setHours(10, 0, 0, 0);

    const summary = summarizeUsage({
      now: sunday.toISOString(),
      period: "week",
      records: [
        { ts: monday.toISOString(), tz: "+09:00", cost: 1, inputTokens: 10, outputTokens: 5 },
        { ts: sunday.toISOString(), tz: "+09:00", cost: 3, inputTokens: 30, outputTokens: 15 },
        { ts: prevSaturday.toISOString(), tz: "+09:00", cost: 9, inputTokens: 90, outputTokens: 45 },
      ],
    });

    expect(summary).toEqual({ cost: 4, inputTokens: 40, outputTokens: 20 });
  });

  it("month period starts on the 1st", () => {
    // 15th of current month at noon
    const now = new Date();
    now.setDate(15);
    now.setHours(12, 0, 0, 0);

    // 1st of this month
    const firstDay = new Date(now);
    firstDay.setDate(1);
    firstDay.setHours(8, 0, 0, 0);

    // Last day of previous month (should be excluded)
    const prevMonth = new Date(firstDay);
    prevMonth.setDate(prevMonth.getDate() - 1);
    prevMonth.setHours(23, 0, 0, 0);

    const summary = summarizeUsage({
      now: now.toISOString(),
      period: "month",
      records: [
        { ts: firstDay.toISOString(), tz: "+09:00", cost: 1, inputTokens: 10, outputTokens: 5 },
        { ts: now.toISOString(), tz: "+09:00", cost: 2, inputTokens: 20, outputTokens: 10 },
        { ts: prevMonth.toISOString(), tz: "+09:00", cost: 5, inputTokens: 50, outputTokens: 25 },
      ],
    });

    expect(summary).toEqual({ cost: 3, inputTokens: 30, outputTokens: 15 });
  });

  it("returns all records for 'all' period", () => {
    const summary = summarizeUsage({
      now: new Date().toISOString(),
      period: "all",
      records: [
        { ts: "2026-01-01T08:00:00Z", tz: "+09:00", cost: 1, inputTokens: 10, outputTokens: 5 },
        { ts: "2026-02-01T08:00:00Z", tz: "+09:00", cost: 2, inputTokens: 20, outputTokens: 10 },
      ],
    });

    expect(summary).toEqual({ cost: 3, inputTokens: 30, outputTokens: 15 });
  });

  it("handles records without tz field (backward compat)", () => {
    const now = new Date();
    now.setHours(12, 0, 0, 0);

    const summary = summarizeUsage({
      now: now.toISOString(),
      period: "all",
      records: [
        { ts: "2026-01-01T08:00:00Z", cost: 1, inputTokens: 10, outputTokens: 5 } as any,
        { ts: "2026-02-01T08:00:00Z", tz: "+09:00", cost: 2, inputTokens: 20, outputTokens: 10 },
      ],
    });

    expect(summary).toEqual({ cost: 3, inputTokens: 30, outputTokens: 15 });
  });
});
