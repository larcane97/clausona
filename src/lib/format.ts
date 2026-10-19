import { countIssues } from "../core/doctor.js";
import { isFresh } from "../core/quota.js";
import { symbol } from "../tui/theme.js";
import type {
  DoctorIssue,
  DoctorProfileResult,
  ProfileListItem,
  QuotaSnapshot,
  QuotaWindow,
  ToolName,
  UsageSummary,
} from "../types.js";

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
  stripAnsi,
  styledCost,
  styledCount,
  truncate,
  warnIcon,
  fail as xMark,
  yellow,
} from "./cli-style.js";
import { displayName } from "./profile-env.js";

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

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** A count in a few characters - `12.2B` - for a column with no room for every digit. */
export function formatCompactCount(value: number) {
  return value > 0 ? COMPACT.format(value) : "—";
}

/** A cost in a few characters - `$218.1K` - for a column with no room for every digit. */
export function formatCompactCurrency(value: number) {
  return value >= 1000 ? `$${COMPACT.format(value)}` : formatCurrency(value);
}

const SIGN_IN_LAPSES: Partial<Record<QuotaSnapshot["state"], string>> = {
  expired: "expired",
  // As routing says it: no credential is stored, and Claude Code leaves an empty one at sign-out.
  missing: "signed out",
};

/**
 * What a reading says in place of its numbers once the account cannot be used until it signs in
 * again. Those numbers are the last ones read before that, and drawn dimmed they read as current:
 * a codex account signed out for a month listed `100% now`.
 */
function signInLapse(quota: QuotaSnapshot | undefined): string | undefined {
  return quota && SIGN_IN_LAPSES[quota.state];
}

/** Compact one-line quota for dense rows, e.g. `5h 61% | 7d 100%`. */
export function formatQuotaInline(quota: QuotaSnapshot | undefined): string {
  if (!quota) return "";
  const lapse = signInLapse(quota);
  if (lapse) return lapse;
  const parts: string[] = [];
  if (quota.session) parts.push(`5h ${formatQuotaPercent(quota.session)}`);
  if (quota.weekly) parts.push(`7d ${formatQuotaPercent(quota.weekly)}`);
  if (parts.length === 0) return quota.state === "ok" ? "" : quota.state;
  const suffix = quota.state === "ok" ? "" : ` (${quota.state})`;
  return `${parts.join(" | ")}${suffix}`;
}

/**
 * An API profile's spend against its limit as a dense row says it, `budget 35%`, or nothing when
 * there is no reading of it. The dashboard reads only what the cache holds, so a reading older
 * than the cache keeps it fresh says how old.
 */
export function formatBudgetInline(quota: QuotaSnapshot | undefined, now: number = Date.now()): string {
  if (!quota?.budget) return "";
  const live = quota.state === "ok" && isFresh(quota, now);
  return `budget ${formatQuotaPercent(quota.budget)}${live ? "" : ` (${formatAge(quota.fetchedAt, new Date(now))})`}`;
}

/**
 * Severity of a profile's most-consumed window, for colouring a whole row at a glance. A lapsed
 * sign-in is as bad as a full window, except an API profile's: its reading is spend, and a key
 * its provider refused is `route budget`'s to say.
 */
export function quotaSeverity({
  kind,
  quota,
}: Pick<ProfileListItem, "kind" | "quota">): "healthy" | "warning" | "error" | "muted" {
  if (kind !== "api" && signInLapse(quota)) return "error";
  if (!quota || quota.state !== "ok") return "muted";
  const peak = Math.max(
    quota.session?.usedPercent ?? 0,
    quota.weekly?.usedPercent ?? 0,
    quota.budget?.usedPercent ?? 0,
  );
  if (peak >= QUOTA_CRITICAL) return "error";
  if (peak >= QUOTA_WARNING) return "warning";
  return "healthy";
}

/**
 * A profile's model as every surface shows it: the id as stored, or a dash when none is
 * pinned. `list` and the dashboard's preview both go through this, with the id worked out
 * once by `profileModel`, so they cannot disagree about a profile's model or about "none".
 */
export function formatModel(model: string | undefined): string {
  return model ?? "—";
}

/**
 * A model id cut to `width`, for every surface that has less room than the id: `list`'s
 * column and the preview's row. From the middle, with twice the room for the end as for the
 * start - the end is what tells variants apart (`-flash`, `-air`, a date) and the start names
 * the gateway, while the middle is what two ids share. Cut from the end, as a width limit
 * would, `openrouter/z-ai/glm-5.3-flash` and `…-air` read the same.
 */
export function fitModel(model: string | undefined, width: number): string {
  const text = formatModel(model);
  if (text.length <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  const keep = width - 1;
  const tail = Math.ceil((keep * 2) / 3);
  return `${text.slice(0, keep - tail)}…${text.slice(text.length - tail)}`;
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

/**
 * A usage percentage as a whole number: rounded, except that a reading under a limit never reads
 * as the limit, rounded down instead. An account at 100% cannot run, and one at 99.6 (Codex
 * reports fractions) can, and is picked. `cut` is a route's: one at 79.6 is under a cut of 80 and
 * can be picked before anyone over it, so it reads 79%, not the 80% an account over it reads.
 */
export function wholeQuotaPercent(percent: number, cut?: number): number {
  const whole = Math.round(percent);
  const reaches = (limit: number | undefined) => limit !== undefined && percent < limit && whole >= limit;
  return reaches(100) || reaches(cut) ? Math.floor(percent) : whole;
}

export function formatQuotaPercent(window: QuotaWindow | undefined, cut?: number): string {
  return window ? `${wholeQuotaPercent(window.usedPercent, cut)}%` : "—";
}

/** Colours a percentage by severity; anything not freshly fetched is dimmed instead. */
export function styledQuota(
  window: QuotaWindow | undefined,
  state: QuotaSnapshot["state"] | undefined,
  cut?: number,
): string {
  if (!window || !state) return dim("—");
  const text = formatQuotaPercent(window, cut);
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
 * exceed `width` when even that does not fit. `cut` is a route's, as wholeQuotaPercent takes it.
 */
export function fitQuotaValue(window: QuotaWindow, width: number, now: Date = new Date(), cut?: number): string {
  const percent = formatQuotaPercent(window, cut).padStart(4);
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
  missing: "no stored credential — run `clausona login <profile>`",
  cooldown: "quota endpoint is rate limited; retrying later",
  error: "quota lookup failed",
};

/**
 * One footnote per distinct problem, so a wide table does not need a status column. An API
 * profile's reading is the last one `route budget` or a routed run took, so its failures are
 * theirs to say. A lapsed sign-in's is headed by the word its row says.
 */
export function quotaNotes(items: ProfileListItem[]): string[] {
  const states = new Set<Exclude<QuotaSnapshot["state"], "ok">>();
  for (const item of items) {
    const state = item.quota?.state;
    if (state && state !== "ok" && item.kind !== "api") states.add(state);
  }
  return [...states].map((state) => `${SIGN_IN_LAPSES[state] ?? state}: ${QUOTA_NOTES[state]}`);
}

/** A lapsed sign-in across the 5H and 7D columns, as an API profile's budget runs across them. */
function lapseSpan(quota: QuotaSnapshot | undefined): string | undefined {
  const lapse = signInLapse(quota);
  return lapse && red(lapse);
}

/** An API profile's spend against its limit, across the 5H and 7D columns: `budget 35% 18d`. */
function budgetSpan(quota: QuotaSnapshot, withReset: boolean, now: Date): string | undefined {
  const window = quota.budget;
  if (!window) return undefined;
  // Only the cache is read for it: a reading older than the cache keeps one fresh is dimmed.
  const live = quota.state === "ok" && isFresh(quota, now.getTime());
  const reset = withReset ? formatResetShort(window.resetsAt, now) : "";
  return `${secondary("budget")} ${styledQuota(window, live ? "ok" : "error")}${reset ? ` ${dimmer(reset)}` : ""}`;
}

// ─── List ───────────────────────────────────────────────────────────
type ColumnKey = "profile" | "account" | "model" | "session" | "weekly" | "cost" | "input" | "output";

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
  model: "MODEL",
  session: "5H",
  weekly: "7D",
  cost: "COST",
  input: "INPUT",
  output: "OUTPUT",
};

/** The model column holds a gateway id such as `openrouter/z-ai/glm-5.3`; longer ones are cut. */
const FIXED_WIDTHS = { model: 24, cost: 12, input: 14, output: 10 } as const;

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
 *
 * The model column, shown once some profile pins a model, sits in front of all of that.
 * Every layout carrying it is tried first - dropping token counts, then cost, to keep it -
 * and each one has what the table would otherwise have at its best: the quota pair with
 * reset times, and full-width names. Once none of them fits, the list is exactly the one
 * without a model. So the model never costs the quota columns, their reset times or the
 * name a single character; it goes first, and below its narrowest layout the table is the
 * one it always was. It does outrank spend, which `clausona usage` has in full, while
 * nothing else lists every profile's model.
 */
function candidateLayouts(showQuota: boolean, showModel = false): Layout[] {
  const base = { profileWidth: 20, accountWidth: 32 };
  const tail: ColumnKey[][] = [["cost", "input", "output"], ["cost", "input"], ["cost"], []];
  const quota: ColumnKey[] = showQuota ? ["session", "weekly"] : [];

  const withModel: Layout[] = showModel
    ? tail.map((extra) => ({ keys: ["profile", "account", "model", ...quota, ...extra], reset: showQuota, ...base }))
    : [];

  if (!showQuota) {
    return [
      ...withModel,
      ...tail.map((extra) => ({ keys: ["profile", "account", ...extra] as ColumnKey[], reset: false, ...base })),
      { keys: ["profile", "account", "cost"], reset: false, profileWidth: 14, accountWidth: 22 },
    ];
  }

  return [
    ...withModel,
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
export function pickLayout(showQuota: boolean, available: number, showModel = false): Layout {
  const layouts = candidateLayouts(showQuota, showModel);
  return layouts.find((layout) => layoutWidth(layout) <= available) ?? layouts[layouts.length - 1];
}

/**
 * Narrowest terminal the table is guaranteed to fit. Below this there is nothing left
 * to drop, so rows are allowed to overflow rather than losing the profile name.
 */
export const LIST_MIN_WIDTH = Math.max(
  ...[true, false].flatMap((showQuota) =>
    [true, false].map((showModel) => {
      const layouts = candidateLayouts(showQuota, showModel);
      return layoutWidth(layouts[layouts.length - 1]);
    }),
  ),
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

  // Quota columns are only worth their width once something has been fetched, and the model
  // column once something pins a model - so a table with neither is the one it always was.
  const showQuota = sorted.some((item) => item.quota);
  const showModel = sorted.some((item) => item.model !== undefined);
  const available = options.width ?? process.stdout.columns ?? 120;
  const layout = pickLayout(showQuota, available, showModel);

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
          // An API profile has no account email; its label stands in, exactly as it does
          // in `config --show`. The dash is for a hand-edited profiles.json that carries
          // neither — a blank cell there reads as a bug rather than as "nothing to show".
          const account = truncate(displayName(item).trim() || "—", layout.accountWidth - 1);
          return item.isActive ? account : secondary(account);
        }
        case "model": {
          const model = fitModel(item.model, FIXED_WIDTHS.model - 1);
          if (item.model === undefined) return dim(model);
          return item.isActive ? model : secondary(model);
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

    const last = layout.keys.length - 1;
    // An API profile has no plan windows; its budget, when it has a reading, runs across both. So
    // does a lapsed sign-in, in place of the windows it last read.
    const span = item.kind === "api" ? item.quota && budgetSpan(item.quota, layout.reset, now) : lapseSpan(item.quota);
    const cells = layout.keys.flatMap((key, i) => {
      if (span !== undefined && key === "weekly" && layout.keys[i - 1] === "session") return [];
      if (span !== undefined && key === "session" && layout.keys[i + 1] === "weekly") {
        return [i + 1 === last ? span : pad(span, widths[i] + widths[i + 1])];
      }
      return [i === last ? cell(key) : pad(cell(key), widths[i])];
    });
    const suffix = isCodex && spendShown ? `  ${dim("*")}` : "";
    return `  ${marker} ${cells.join("")}${suffix}`;
  });

  const budgetShown = sorted.some((item) => item.kind === "api" && item.quota?.budget);
  const footnotes = [
    ...(hasCodex && spendShown ? ["* cost and token tracking are not available for codex"] : []),
    ...quotaNotes(sorted),
    ...(budgetShown && showQuota
      ? ["budget: an API profile's spend against its limit, as last read (clausona route budget)"]
      : []),
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
  const totalCost = Object.values(entries).reduce((sum, s) => sum + s.cost, 0);
  const totalIn = Object.values(entries).reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOut = Object.values(entries).reduce((sum, s) => sum + s.outputTokens, 0);

  const rowCells = [
    ...Object.entries(entries).map(([name, s]) => [
      name,
      styledCost(s.cost),
      styledCount(s.inputTokens),
      styledCount(s.outputTokens),
    ]),
    [bold("Total"), bold(styledCost(totalCost)), styledCount(totalIn), styledCount(totalOut)],
  ];
  // Each column as wide as its widest cell and two more, never narrower than it always was.
  // At a fixed width, a name or a count as long as its column ran straight into the next one.
  const cols = [
    { label: "PROFILE", w: 16 },
    { label: "COST", w: 14 },
    { label: "INPUT", w: 14 },
    { label: "OUTPUT", w: 14 },
  ].map((col, i) => ({ ...col, w: Math.max(col.w, ...rowCells.map((cells) => stripAnsi(cells[i] ?? "").length + 2)) }));
  const headerLine = `    ${cols.map((c) => secondary(c.label.padEnd(c.w))).join("")}`;
  const sep = `    ${dimmer("─".repeat(cols.reduce((s, c) => s + c.w, 0)))}`;

  const line = (cells: string[]) =>
    `    ${cells.map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, cols[i].w))).join("")}`;
  const rows = rowCells.slice(0, -1).map(line);
  const totalRow = line(rowCells.at(-1) ?? []);

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

// ─── Login ──────────────────────────────────────────────────────────
/** Kept short enough to fit the TUI's one-line status after the header. */
export function describeOtherAccount(id: string, signedInAs: string, registered: string): string {
  return `${id} is signed in as ${signedInAs}, not ${registered}`;
}

export function describeUnverifiedLogin(id: string): string {
  return `Signed in, but could not read back which account ${id} now uses`;
}

/** The product name a tool's messages use. */
export function toolProduct(tool: ToolName): string {
  return tool === "claude" ? "Claude Code" : "Codex";
}

/**
 * A sign-in whose stored credential the tool could not confirm, without saying there is none
 * (#24). `detail` says why.
 */
export function describeUnconfirmedCredential(tool: ToolName, id: string, detail: string): string {
  return `Signed in, but could not confirm that ${toolProduct(tool)} stored a credential for ${id} (${detail})`;
}

/** What to do about it. `command` is `clausona login <id>`, styled for where it is shown. */
export function unconfirmedCredentialHint(tool: ToolName, command: string): string {
  return `If ${tool} asks you to sign in, run ${command}`;
}

// ─── Doctor ─────────────────────────────────────────────────────────
/** Issues that describe a missing credential, which only signing in can resolve. */
const CREDENTIAL_ISSUE_KINDS = new Set<DoctorIssue["kind"]>(["missing_json", "missing_keychain", "missing_oauth"]);

/**
 * Issues whose message already names what to do. All but one belong to an API profile,
 * which has neither a login to renew nor shared links that could be at fault; the one,
 * `primary_broken_link`, is a break in the primary, which repair never changes. Offering
 * `repair` or `login` for any of them would point at a command that reports success and
 * changes nothing.
 */
const SELF_DIRECTED_ISSUE_KINDS = new Set<DoctorIssue["kind"]>([
  "primary_broken_link",
  "missing_config_dir",
  "missing_api_secret",
  "invalid_api_config",
  "shared_api_key_helper",
  "unreadable_settings",
  "plaintext_env_secret",
  "shared_key_source",
  "settings_env_override",
  "env_overrides_endpoint",
  "invalid_env_map",
  "invalid_profile_kind",
  // Not API profiles', but no more repair's to fix: a directory's length, and a setting or a
  // variable outside what clausona manages.
  "socket_path_too_long",
  "shared_sqlite_home",
  // The primary's own backups, which repair never touches; the message says how to delete them.
  "foreign_account_backup",
  // A plugin list or record the sync cannot read: repair would run into it again.
  "plugin_sync_blocked",
]);

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Which of the three states a doctor result is in, for anything that colours by it - the
 * same shape as `quotaSeverity`, and the same reason: two surfaces writing this rule out by
 * hand disagreed about a profile that had only warnings, one painting it green and the other
 * amber. The guarantee is that there is one rule rather than that each surface was reviewed;
 * a colour is only visible to a test with FORCE_COLOR set, which no ordinary render
 * assertion in this repo has.
 */
export function doctorSeverity(issues: DoctorIssue[]): "healthy" | "warning" | "error" {
  const { errors, warnings } = countIssues(issues);
  if (errors > 0) return "error";
  return warnings > 0 ? "warning" : "healthy";
}

/**
 * What a doctor result amounts to, in one unstyled phrase: `healthy`, `2 warnings`,
 * `1 issue`, or `1 issue, 2 warnings`. Shared with the TUI, which has one column for it
 * and would otherwise label a profile carrying only warnings "healthy" and show nothing.
 */
export function doctorSummary(issues: DoctorIssue[]): string {
  const { errors, warnings } = countIssues(issues);
  if (errors > 0) {
    return warnings === 0 ? plural(errors, "issue") : `${plural(errors, "issue")}, ${plural(warnings, "warning")}`;
  }
  return warnings > 0 ? plural(warnings, "warning") : "healthy";
}

export function renderDoctor(results: DoctorProfileResult[]) {
  const sections = results.map((result) => {
    const title = `  ${bold(result.name)} ${dim(`(${displayName(result)})`)}`;
    const { errors, warnings } = countIssues(result.issues);
    if (errors === 0 && warnings === 0) {
      return [title, `    ${ok} ${green("healthy")}`].join("\n");
    }

    const count = result.issues.length;
    // Warnings do not make a profile broken, so they never turn the line red or add to the
    // issue count. A profile that has only them says so in its own words; one that has both
    // leads with what is actually wrong.
    const statusLine =
      errors === 0
        ? `    ${warnIcon} ${yellow(plural(warnings, "warning"))}`
        : `    ${xMark} ${red(plural(errors, "issue"))}${warnings === 0 ? "" : dim(`, ${plural(warnings, "warning")}`)}`;
    const issueLines = result.issues.map((issue, i) => {
      const connector = i === count - 1 ? symbol.cornerBL : symbol.teeR;
      // Marked per line too: in a mixed list, which of these stops the profile working is
      // the first thing a reader needs.
      const marker = issue.severity === "warning" ? `${warnIcon} ` : "";
      return `    ${dim(connector + symbol.lineH)} ${marker}${issue.message}`;
    });

    // repair cannot produce a credential, so a profile that only needs one has to be
    // pointed at login instead of at a command that would report success and change
    // nothing. A profile carrying both classes of issue needs both steps. Not a kind
    // clausona does not know: that is why it reads as a subscription missing its login,
    // and signing one in would put a subscription where an API profile was meant to be.
    const needsLogin =
      !result.issues.some((issue) => issue.kind === "invalid_profile_kind") &&
      result.issues.some((issue) => CREDENTIAL_ISSUE_KINDS.has(issue.kind));
    const needsRepair = offersRepair(result.issues);
    const suggestions: string[] = [];
    if (needsRepair) suggestions.push(`       ${dim(`Run ${accent(`clausona repair ${result.name}`)} to fix`)}`);
    if (needsLogin) suggestions.push(`       ${dim(`Run ${accent(`clausona login ${result.name}`)} to sign in`)}`);

    return [title, statusLine, ...issueLines, ...suggestions].join("\n");
  });

  return ["", ...sections, ""].join("\n\n");
}

/**
 * doctor's section for routes.json (`shown`, the path as it is shown): what `route list` warns
 * about, as a profile's warnings are listed. Nothing when there is nothing to say.
 */
export function renderDoctorRoutes(shown: string, warnings: string[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((warning, i) => {
    const connector = i === warnings.length - 1 ? symbol.cornerBL : symbol.teeR;
    return `    ${dim(connector + symbol.lineH)} ${warnIcon} ${warning}`;
  });
  return [
    `  ${bold("routes")} ${dim(`(${shown})`)}`,
    `    ${warnIcon} ${yellow(plural(warnings.length, "warning"))}`,
    ...lines,
  ].join("\n");
}

/**
 * Whether `clausona repair` can fix something in a doctor result: the CLI's "Run clausona
 * repair" line and the TUI doctor screen's `r` both ask this, so neither offers it where the
 * other would not. repair rebuilds shared links, folds in session state and re-runs the
 * plugins setup; a missing credential and a finding whose message names its own fix are not
 * its to fix.
 */
export function offersRepair(issues: DoctorIssue[]): boolean {
  // repair symlinks into the config directory; it cannot create one. With the directory
  // gone, every shared-link finding is a consequence of that, and repair fails with
  // ENOENT instead of fixing anything - so the profile is left with the one instruction
  // that works, which its own message carries.
  if (issues.some((issue) => issue.kind === "missing_config_dir")) return false;
  // A profile on its tool's primary directory is never linked, so there is nothing for repair
  // to rebuild - it refuses one. The message names the registry change that settles it.
  if (issues.some((issue) => issue.kind === "primary_config_dir")) return false;
  return issues.some((issue) => !CREDENTIAL_ISSUE_KINDS.has(issue.kind) && !SELF_DIRECTED_ISSUE_KINDS.has(issue.kind));
}
