import { symbol } from "../tui/theme.js";
import type { DoctorProfileResult, ProfileListItem, UsageSummary } from "../types.js";

import { accent, bold, dim, dimmer, green, heading, ok, padEnd as pad, red, secondary, styledCost, styledCount, fail as xMark } from "./cli-style.js";

// ─── Timezone ────────────────────────────────────────────────────────
export function localTimezoneLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${tz} (UTC${sign}${h}:${m})`;
}

// ─── Plain-text primitives (used by TUI components) ─────────────────
export function formatCurrency(value: number) {
  return value > 0 ? `$${value.toFixed(2)}` : "—";
}

export function formatCount(value: number) {
  return value > 0 ? value.toLocaleString("en-US") : "—";
}

export function formatUsage(summary: UsageSummary) {
  return `${formatCurrency(summary.cost)} | in ${formatCount(summary.inputTokens)} | out ${formatCount(summary.outputTokens)}`;
}

// ─── List ───────────────────────────────────────────────────────────
export function renderList(items: ProfileListItem[]) {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const range = `${fmt(weekAgo)} – ${fmt(now)}`;

  const cols = [
    { label: "PROFILE", w: 14 },
    { label: "ACCOUNT", w: 32 },
    { label: "COST", w: 12 },
    { label: "INPUT", w: 14 },
    { label: "OUTPUT", w: 10 },
  ];
  const headerLine = "    " + cols.map((c) => secondary(c.label.padEnd(c.w))).join("");
  const sep = "    " + dimmer("─".repeat(cols.reduce((s, c) => s + c.w, 0)));

  const rows = items.map((item) => {
    const marker = item.isActive ? accent("▸") : " ";
    const name = item.isActive ? pad(accent(item.name), cols[0].w) : item.name.padEnd(cols[0].w);
    const email = pad(item.isActive ? item.email : secondary(item.email), cols[1].w);
    const cost = pad(styledCost(item.week.cost), cols[2].w);
    const input = pad(styledCount(item.week.inputTokens), cols[3].w);
    const output = styledCount(item.week.outputTokens);
    return `  ${marker} ${name}${email}${cost}${input}${output}`;
  });

  return ["", `  ${dim(range)}  ${dim(localTimezoneLabel())}`, "", headerLine, sep, ...rows, ""].join("\n");
}

// ─── Usage Summary ──────────────────────────────────────────────────
export function renderUsageSummary(data: Record<string, UsageSummary> | UsageSummary, profileName?: string, period?: string) {
  const periodLabel = period === "today" ? "Today" : period === "week" ? "This week" : period === "month" ? "This month" : "All time";
  const tzLabel = localTimezoneLabel();

  // Single profile
  if (profileName && "cost" in data) {
    const s = data as UsageSummary;
    return [
      "",
      heading(`${profileName} ${dim("·")} ${periodLabel}${period !== "all" ? ` ${dim(`(${tzLabel})`)}` : ""}`),
      "",
      `    ${secondary("Cost".padEnd(16))}${styledCost(s.cost)}`,
      `    ${secondary("Input tokens".padEnd(16))}${styledCount(s.inputTokens)}`,
      `    ${secondary("Output tokens".padEnd(16))}${styledCount(s.outputTokens)}`,
      "",
    ].join("\n");
  }

  // All profiles
  const entries = data as Record<string, UsageSummary>;
  const cols = [
    { label: "PROFILE", w: 16 },
    { label: "COST", w: 14 },
    { label: "INPUT", w: 14 },
    { label: "OUTPUT", w: 14 },
  ];
  const headerLine = "    " + cols.map((c) => secondary(c.label.padEnd(c.w))).join("");
  const sep = "    " + dimmer("─".repeat(cols.reduce((s, c) => s + c.w, 0)));

  const rows = Object.entries(entries).map(([name, s]) => {
    return `    ${name.padEnd(cols[0].w)}${pad(styledCost(s.cost), cols[1].w)}${pad(styledCount(s.inputTokens), cols[2].w)}${styledCount(s.outputTokens)}`;
  });

  const totalCost = Object.values(entries).reduce((sum, s) => sum + s.cost, 0);
  const totalIn = Object.values(entries).reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOut = Object.values(entries).reduce((sum, s) => sum + s.outputTokens, 0);

  const totalRow = `    ${pad(bold("Total"), cols[0].w)}${pad(bold(styledCost(totalCost)), cols[1].w)}${pad(styledCount(totalIn), cols[2].w)}${styledCount(totalOut)}`;

  return ["", heading(`${periodLabel}${period !== "all" ? ` ${dim(`(${tzLabel})`)}` : ""}`), "", headerLine, sep, ...rows, sep, totalRow, ""].join("\n");
}

// ─── Doctor ─────────────────────────────────────────────────────────
export function renderDoctor(results: DoctorProfileResult[]) {
  const sections = results.map((result) => {
    const title = `  ${bold(result.name)} ${dim(`(${result.email})`)}`;
    if (result.healthy) {
      return [title, `    ${ok} ${green("healthy")}`].join("\n");
    }

    const count = result.issues.length;
    const statusLine = `    ${xMark} ${red(`${count} issue${count === 1 ? "" : "s"}`)}`;
    const issueLines = result.issues.map((issue, i) => {
      const connector = i === count - 1 ? symbol.cornerBL : symbol.teeR;
      return `    ${dim(connector + symbol.lineH)} ${issue.message}`;
    });

    // Add repair suggestion for the last issue
    const suggestion = `       ${dim(`Run ${accent("clausona repair " + result.name)} to fix`)}`;

    return [title, statusLine, ...issueLines, suggestion].join("\n");
  });

  return ["", ...sections, ""].join("\n\n");
}
