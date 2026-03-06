import type { UsagePeriod, UsageRecord, UsageSummary } from "../types.js";

// All cutoff calculations use local time — "today" means the user's local calendar day.
function cutoffForPeriod(now: Date, period: UsagePeriod): Date | null {
  if (period === "all") {
    return null;
  }

  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);

  if (period === "today") {
    return cutoff;
  }

  if (period === "week") {
    const weekday = cutoff.getDay();
    const delta = weekday === 0 ? 6 : weekday - 1;
    cutoff.setDate(cutoff.getDate() - delta);
    return cutoff;
  }

  cutoff.setDate(1);
  return cutoff;
}

export function summarizeUsage({
  now,
  period,
  records,
}: {
  now: string;
  period: UsagePeriod;
  records: UsageRecord[];
}): UsageSummary {
  const nowDate = new Date(now);
  const cutoff = cutoffForPeriod(nowDate, period);

  return records.reduce<UsageSummary>(
    (summary, record) => {
      const ts = new Date(record.ts);
      if (cutoff && ts < cutoff) {
        return summary;
      }

      return {
        cost: summary.cost + record.cost,
        inputTokens: summary.inputTokens + record.inputTokens,
        outputTokens: summary.outputTokens + record.outputTokens,
      };
    },
    { cost: 0, inputTokens: 0, outputTokens: 0 },
  );
}
