import { symbol } from "../tui/theme.js";
import type { DoctorProfileResult, ProfileListItem, QuotaSnapshot, QuotaWindow, UsageSummary } from "../types.js";

import {
  accent,
  bold,
  dim,
  dimmer,
  green,
  heading,
  ok,
  padEnd as pad,
  red,
  secondary,
  styledCost,
  styledCount,
  truncate,
  fail as xMark,
  yellow,
} from "./cli-style.js";

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

/** Compact one-line quota for dense rows, e.g. `5h 61% | 7d 100%`. */
export function formatQuotaInline(quota: QuotaSnapshot | undefined): string {
  if (!quota) return "";
  const parts: string[] = [];
  if (quota.session) parts.push(`5h ${formatQuotaPercent(quota.session)}`);
  if (quota.weekly) parts.push(`7d ${formatQuotaPercent(quota.weekly)}`);
  if (parts.length === 0) return quota.state === "ok" ? "" : quota.state;
  const suffix = quota.state === "ok" ? "" : ` (${quota.state})`;
  return `${parts.join(" | ")}${suffix}`;
}

/** Severity of the most-consumed window, for colouring a whole row at a glance. */
export function quotaSeverity(quota: QuotaSnapshot | undefined): "healthy" | "warning" | "error" | "muted" {
  if (!quota || quota.state !== "ok") return "muted";
  const peak = Math.max(quota.session?.usedPercent ?? 0, quota.weekly?.usedPercent ?? 0);
  if (peak >= QUOTA_CRITICAL) return "error";
  if (peak >= QUOTA_WARNING) return "warning";
  return "healthy";
}

export function formatUsage(summary: UsageSummary) {
  return `${formatCurrency(summary.cost)} | in ${formatCount(summary.inputTokens)} | out ${formatCount(summary.outputTokens)}`;
}

// ─── Quota ──────────────────────────────────────────────────────────
/** Matches the severity bands the API itself reports (normal / warning / critical). */
const QUOTA_CRITICAL = 90;
const QUOTA_WARNING = 75;

/** True when the reading is current rather than a last-known value. */
function isLiveQuota(state: QuotaSnapshot["state"]): boolean {
  return state === "ok";
}

export function formatQuotaPercent(window: QuotaWindow | undefined): string {
  return window ? `${Math.round(window.usedPercent)}%` : "—";
}

/** Colours a percentage by severity; anything not freshly fetched is dimmed instead. */
export function styledQuota(window: QuotaWindow | undefined, state: QuotaSnapshot["state"] | undefined): string {
  if (!window || !state) return dim("—");
  const text = formatQuotaPercent(window);
  if (!isLiveQuota(state)) return dimmer(text);
  if (window.usedPercent >= QUOTA_CRITICAL) return red(text);
  if (window.usedPercent >= QUOTA_WARNING) return yellow(text);
  return text;
}

/** Compact "time until reset", e.g. `2h 10m` or `3d 4h`. */
export function formatResetIn(resetsAt: string | null | undefined, now: Date = new Date()): string {
  if (!resetsAt) return "—";
  const ms = Date.parse(resetsAt) - now.getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "now";

  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** How long ago a reading was taken, e.g. `3h ago`. */
export function formatAge(fetchedAt: number, now: Date = new Date()): string {
  const ms = now.getTime() - fetchedAt;
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";

  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${minutes}m ago`;
}

const QUOTA_NOTES: Record<Exclude<QuotaSnapshot["state"], "ok">, string> = {
  expired: "sign-in has lapsed — run `clausona login <profile>`",
  missing: "no stored credential for this profile",
  cooldown: "quota endpoint is rate limited; retrying later",
  error: "quota lookup failed",
};

/** One footnote per distinct problem, so a wide table does not need a status column. */
export function quotaNotes(items: ProfileListItem[]): string[] {
  const states = new Set<Exclude<QuotaSnapshot["state"], "ok">>();
  for (const item of items) {
    const state = item.quota?.state;
    if (state && state !== "ok") states.add(state);
  }
  return [...states].map((state) => `${state}: ${QUOTA_NOTES[state]}`);
}

// ─── List ───────────────────────────────────────────────────────────
export function renderList(items: ProfileListItem[]) {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const range = `${fmt(weekAgo)} – ${fmt(now)}`;

  // Sort: claude before codex, primary first within tool, then name ascending
  const sorted = [...items].sort((a, b) => {
    if (a.tool !== b.tool) return a.tool === "claude" ? -1 : 1;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Quota columns are only worth their width once something has been fetched.
  const showQuota = sorted.some((item) => item.quota);

  const cols = [
    { label: "PROFILE", w: 20 },
    { label: "ACCOUNT", w: 32 },
    ...(showQuota
      ? [
          { label: "5H", w: 7 },
          { label: "7D", w: 7 },
        ]
      : []),
    { label: "COST", w: 12 },
    { label: "INPUT", w: 14 },
    { label: "OUTPUT", w: 10 },
  ];
  const headerLine = `    ${cols.map((c) => secondary(c.label.padEnd(c.w))).join("")}`;
  const sep = `    ${dimmer("─".repeat(cols.reduce((s, c) => s + c.w, 0)))}`;

  const hasCodex = sorted.some((item) => item.tool === "codex");

  const rows = sorted.map((item) => {
    const marker = item.isActive ? accent("▸") : " ";
    // Truncate before styling so the ellipsis lands inside the column, not after it.
    const rawName = truncate(item.name, 19);
    const rawEmail = truncate(item.email, 31);
    const name = pad(item.isActive ? accent(rawName) : rawName, 20);
    const email = pad(item.isActive ? rawEmail : secondary(rawEmail), 32);
    const quota = showQuota
      ? pad(styledQuota(item.quota?.session, item.quota?.state), 7) +
        pad(styledQuota(item.quota?.weekly, item.quota?.state), 7)
      : "";
    let cost: string;
    let input: string;
    let output: string;
    if (item.tool === "codex") {
      cost = pad(dim("—"), 12);
      input = pad(dim("—"), 14);
      output = `${dim("—")}  *`;
    } else {
      cost = pad(styledCost(item.week.cost), 12);
      input = pad(styledCount(item.week.inputTokens), 14);
      output = styledCount(item.week.outputTokens);
    }
    return `  ${marker} ${name}${email}${quota}${cost}${input}${output}`;
  });

  const footnotes = [
    ...(hasCodex ? ["* cost and token tracking are not available for codex"] : []),
    ...quotaNotes(sorted),
  ].map((note) => `  ${dim(note)}`);

  return ["", `  ${dim(range)}  ${dim(localTimezoneLabel())}`, "", headerLine, sep, ...rows, ...footnotes, ""].join(
    "\n",
  );
}

// ─── Usage Summary ──────────────────────────────────────────────────
export function renderUsageSummary(
  data: Record<string, UsageSummary> | UsageSummary,
  profileName?: string,
  period?: string,
) {
  const periodLabel =
    period === "today" ? "Today" : period === "week" ? "This week" : period === "month" ? "This month" : "All time";
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
  const headerLine = `    ${cols.map((c) => secondary(c.label.padEnd(c.w))).join("")}`;
  const sep = `    ${dimmer("─".repeat(cols.reduce((s, c) => s + c.w, 0)))}`;

  const rows = Object.entries(entries).map(([name, s]) => {
    return `    ${name.padEnd(cols[0].w)}${pad(styledCost(s.cost), cols[1].w)}${pad(styledCount(s.inputTokens), cols[2].w)}${styledCount(s.outputTokens)}`;
  });

  const totalCost = Object.values(entries).reduce((sum, s) => sum + s.cost, 0);
  const totalIn = Object.values(entries).reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOut = Object.values(entries).reduce((sum, s) => sum + s.outputTokens, 0);

  const totalRow = `    ${pad(bold("Total"), cols[0].w)}${pad(bold(styledCost(totalCost)), cols[1].w)}${pad(styledCount(totalIn), cols[2].w)}${styledCount(totalOut)}`;

  return [
    "",
    heading(`${periodLabel}${period !== "all" ? ` ${dim(`(${tzLabel})`)}` : ""}`),
    "",
    headerLine,
    sep,
    ...rows,
    sep,
    totalRow,
    "",
  ].join("\n");
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
    const suggestion = `       ${dim(`Run ${accent(`clausona repair ${result.name}`)} to fix`)}`;

    return [title, statusLine, ...issueLines, suggestion].join("\n");
  });

  return ["", ...sections, ""].join("\n\n");
}
