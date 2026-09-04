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

/** Coarsest useful "time until reset" — one unit, for table cells. */
export function formatResetShort(resetsAt: string | null | undefined, now: Date = new Date()): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now.getTime();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";

  const minutes = Math.floor(ms / 60000);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.max(1, minutes)}m`;
}

/** A 10-cell gauge reads faster than a number when scanning several accounts. */
export function quotaBar(usedPercent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(usedPercent / 10)));
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(10 - filled)}`;
}

/**
 * Most detailed rendering of a window that fits `width`, shedding the gauge, then the
 * wording, then the reset time. The percentage is never dropped, so a value can still
 * exceed `width` when even that does not fit.
 */
export function fitQuotaValue(window: QuotaWindow, width: number, now: Date = new Date()): string {
  const percent = formatQuotaPercent(window).padStart(4);
  const long = formatResetIn(window.resetsAt, now);
  const short = formatResetShort(window.resetsAt, now);
  const gauge = quotaBar(window.usedPercent);

  const candidates = short
    ? [
        `${gauge} ${percent}  resets in ${long}`,
        `${percent}  resets in ${long}`,
        `${gauge} ${percent} ${short}`,
        `${percent} ${short}`,
        percent,
      ]
    : [`${gauge} ${percent}`, percent];

  return candidates.find((candidate) => candidate.length <= width) ?? percent;
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
type ColumnKey = "profile" | "account" | "session" | "weekly" | "cost" | "input" | "output";

const QUOTA_WIDTH_WITH_RESET = 11;
const QUOTA_WIDTH_PLAIN = 7;

type Layout = {
  keys: ColumnKey[];
  /** Whether quota cells carry their reset time. */
  reset: boolean;
  profileWidth: number;
  accountWidth: number;
};

const LABELS: Record<ColumnKey, string> = {
  profile: "PROFILE",
  account: "ACCOUNT",
  session: "5H",
  weekly: "7D",
  cost: "COST",
  input: "INPUT",
  output: "OUTPUT",
};

const FIXED_WIDTHS = { cost: 12, input: 14, output: 10 } as const;

function columnWidth(key: ColumnKey, layout: Layout): number {
  switch (key) {
    case "profile":
      return layout.profileWidth;
    case "account":
      return layout.accountWidth;
    case "session":
    case "weekly":
      return layout.reset ? QUOTA_WIDTH_WITH_RESET : QUOTA_WIDTH_PLAIN;
    default:
      return FIXED_WIDTHS[key];
  }
}

const INDENT = 4;

function layoutWidth(layout: Layout): number {
  return INDENT + layout.keys.reduce((sum, key) => sum + columnWidth(key, layout), 0);
}

/**
 * Progressively narrower fallbacks, widest first. Cost and token counts give way
 * before the quota pair does: quota is why you run the command, and the spend figures
 * are still available in full from `clausona usage`.
 */
function candidateLayouts(showQuota: boolean): Layout[] {
  const base = { profileWidth: 20, accountWidth: 32 };
  const tail: ColumnKey[][] = [["cost", "input", "output"], ["cost", "input"], ["cost"], []];

  if (!showQuota) {
    return [
      ...tail.map((extra) => ({ keys: ["profile", "account", ...extra] as ColumnKey[], reset: false, ...base })),
      { keys: ["profile", "account", "cost"], reset: false, profileWidth: 14, accountWidth: 22 },
    ];
  }

  const quota: ColumnKey[] = ["session", "weekly"];
  return [
    ...tail.map((extra) => ({
      keys: ["profile", "account", ...quota, ...extra] as ColumnKey[],
      reset: true,
      ...base,
    })),
    { keys: ["profile", "account", ...quota], reset: false, ...base },
    { keys: ["profile", "account", ...quota], reset: false, profileWidth: 14, accountWidth: 22 },
  ];
}

/** Widest layout that fits; the narrowest is used when even that overflows. */
export function pickLayout(showQuota: boolean, available: number): Layout {
  const layouts = candidateLayouts(showQuota);
  return layouts.find((layout) => layoutWidth(layout) <= available) ?? layouts[layouts.length - 1];
}

/**
 * Narrowest terminal the table is guaranteed to fit. Below this there is nothing left
 * to drop, so rows are allowed to overflow rather than losing the profile name.
 */
export const LIST_MIN_WIDTH = Math.max(
  ...[true, false].map((showQuota) => {
    const layouts = candidateLayouts(showQuota);
    return layoutWidth(layouts[layouts.length - 1]);
  }),
);

function quotaCell(
  window: QuotaWindow | undefined,
  state: QuotaSnapshot["state"] | undefined,
  withReset: boolean,
  now: Date,
): string {
  const percent = styledQuota(window, state);
  if (!withReset || !window) return percent;

  const reset = formatResetShort(window.resetsAt, now);
  return reset ? `${percent} ${dimmer(reset)}` : percent;
}

export function renderList(items: ProfileListItem[], options: { width?: number } = {}) {
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
  const available = options.width ?? process.stdout.columns ?? 120;
  const layout = pickLayout(showQuota, available);

  const widths = layout.keys.map((key) => columnWidth(key, layout));
  const headerLine = `    ${layout.keys.map((key, i) => secondary(LABELS[key].padEnd(widths[i]))).join("")}`;
  const sep = `    ${dimmer("─".repeat(widths.reduce((a, b) => a + b, 0)))}`;

  // The footnote only earns its line while a column it explains is on screen.
  const spendShown = layout.keys.some((key) => key === "cost" || key === "input" || key === "output");
  const hasCodex = sorted.some((item) => item.tool === "codex");

  const rows = sorted.map((item) => {
    const marker = item.isActive ? accent("▸") : " ";
    const isCodex = item.tool === "codex";

    const cell = (key: ColumnKey): string => {
      switch (key) {
        case "profile": {
          // Truncate before styling so the ellipsis lands inside the column.
          const name = truncate(item.name, layout.profileWidth - 1);
          return item.isActive ? accent(name) : name;
        }
        case "account": {
          const email = truncate(item.email, layout.accountWidth - 1);
          return item.isActive ? email : secondary(email);
        }
        case "session":
          return quotaCell(item.quota?.session, item.quota?.state, layout.reset, now);
        case "weekly":
          return quotaCell(item.quota?.weekly, item.quota?.state, layout.reset, now);
        case "cost":
          return isCodex ? dim("—") : styledCost(item.week.cost);
        case "input":
          return isCodex ? dim("—") : styledCount(item.week.inputTokens);
        case "output":
          return isCodex ? dim("—") : styledCount(item.week.outputTokens);
      }
    };

    const cells = layout.keys.map((key, i) => (i === layout.keys.length - 1 ? cell(key) : pad(cell(key), widths[i])));
    const suffix = isCodex && spendShown ? `  ${dim("*")}` : "";
    return `  ${marker} ${cells.join("")}${suffix}`;
  });

  const footnotes = [
    ...(hasCodex && spendShown ? ["* cost and token tracking are not available for codex"] : []),
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
