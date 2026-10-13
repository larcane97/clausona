import type { QuotaWindow, QuotaWindows, ScopedQuotaWindow } from "../types.js";

/** How long a cached snapshot is served without touching the network. */
export const QUOTA_FRESH_MS = 5 * 60 * 1000;

/** Fallback cooldown when a 429 arrives without a usable Retry-After. */
export const QUOTA_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/** Requests are abandoned at this point; Claude Code uses the same budget. */
export const QUOTA_TIMEOUT_MS = 5000;

/** Carries the HTTP status so the caller can tell 401 (expired) from 429 (cooldown). */
export class QuotaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(`quota endpoint returned ${status}`);
    this.name = "QuotaHttpError";
  }
}

function toPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Claude reports each window as `{ utilization, resets_at }`, where a window the
 * account does not have (e.g. seven_day_opus on a non-Opus plan) is null.
 */
function claudeWindow(value: unknown): QuotaWindow | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const usedPercent = toPercent(obj.utilization);
  if (usedPercent === null) return undefined;
  return { usedPercent, resetsAt: toIso(obj.resets_at) };
}

type ScopedWindow = ScopedQuotaWindow;

/** Every model-scoped weekly limit Claude reports: one entry per model, labelled by its name. */
function claudeScopedLimits(value: unknown): ScopedWindow[] {
  if (!Array.isArray(value)) return [];

  const limits: ScopedWindow[] = [];
  for (const entry of value) {
    const obj = record(entry);
    if (!obj || obj.kind !== "weekly_scoped") continue;

    const usedPercent = toPercent(obj.percent);
    if (usedPercent === null) continue;

    const label = record(record(obj.scope)?.model)?.display_name;
    if (typeof label !== "string" || label === "") continue;

    limits.push({ usedPercent, resetsAt: toIso(obj.resets_at), label });
  }
  return limits;
}

/** Whether `a` resets after `b`; false when either reset is unknown. */
function resetsLater(a: ScopedWindow, b: ScopedWindow): boolean {
  return a.resetsAt !== null && b.resetsAt !== null && Date.parse(a.resetsAt) > Date.parse(b.resetsAt);
}

/**
 * The binding one of several scoped windows is whichever sits highest. Two windows of one limit
 * at the same height (Codex's 5-hour and weekly, both full) give the one that resets later, which
 * holds the model longer; any other tie, the first.
 */
export function mostUsedWindow(limits: ScopedWindow[]): ScopedWindow | undefined {
  let best: ScopedWindow | undefined;
  for (const limit of limits) {
    if (
      !best ||
      limit.usedPercent > best.usedPercent ||
      (limit.usedPercent === best.usedPercent && limit.label === best.label && resetsLater(limit, best))
    ) {
      best = limit;
    }
  }
  return best;
}

/** `scoped` for the dashboard, and the whole list for routing; no list when there is none. */
function scopedWindows(limits: ScopedWindow[]): Pick<QuotaWindows, "scoped" | "scopedLimits"> {
  return limits.length ? { scoped: mostUsedWindow(limits), scopedLimits: limits } : {};
}

/** Parses `GET https://api.anthropic.com/api/oauth/usage`. */
export function parseClaudeQuota(raw: unknown): QuotaWindows | null {
  const obj = record(raw);
  if (!obj) return null;

  const windows: QuotaWindows = {
    session: claudeWindow(obj.five_hour),
    weekly: claudeWindow(obj.seven_day),
    ...scopedWindows(claudeScopedLimits(obj.limits)),
  };

  return hasAnyWindow(windows) ? windows : null;
}

/**
 * Codex reports windows positionally (`primary`/`secondary`) but the period each one
 * covers varies by plan, so they are classified by their declared width instead.
 */
function codexWindow(value: unknown): { window: QuotaWindow; seconds: number } | undefined {
  const obj = record(value);
  if (!obj) return undefined;

  const usedPercent = toPercent(obj.used_percent);
  if (usedPercent === null) return undefined;

  const seconds = typeof obj.limit_window_seconds === "number" ? obj.limit_window_seconds : 0;
  return { window: { usedPercent, resetsAt: toIsoFromEpochSeconds(obj.reset_at) }, seconds };
}

/** Windows at or below a day are the rolling session budget; anything longer is the weekly one. */
const CODEX_SESSION_MAX_SECONDS = 24 * 60 * 60;

/** Whether a Codex window `seconds` long is the session budget rather than the weekly one. */
export function isSessionLength(seconds: number): boolean {
  return seconds > 0 && seconds <= CODEX_SESSION_MAX_SECONDS;
}

/** Parses `GET https://chatgpt.com/backend-api/codex/usage`. */
export function parseCodexQuota(raw: unknown): QuotaWindows | null {
  const obj = record(raw);
  if (!obj) return null;

  const rateLimit = record(obj.rate_limit);
  const windows: QuotaWindows = {};

  for (const key of ["primary_window", "secondary_window"] as const) {
    const parsed = codexWindow(rateLimit?.[key]);
    if (!parsed) continue;
    if (isSessionLength(parsed.seconds)) {
      windows.session = parsed.window;
    } else {
      windows.weekly = parsed.window;
    }
  }

  // Each limit on one model (`GPT-5.3-Codex-Spark`), labelled by its name. It has the same two
  // slots as the account's own limit, and can fill both: a 5-hour and a weekly window, or only the
  // weekly one, as primary. Each window is kept, with its length.
  const scoped: ScopedWindow[] = [];
  if (Array.isArray(obj.additional_rate_limits)) {
    for (const entry of obj.additional_rate_limits) {
      const additional = record(entry);
      if (!additional) continue;

      const label = additional.limit_name;
      if (typeof label !== "string" || label === "") continue;

      const modelLimit = record(additional.rate_limit);
      for (const key of ["primary_window", "secondary_window"] as const) {
        const parsed = codexWindow(modelLimit?.[key]);
        if (!parsed) continue;
        scoped.push({ ...parsed.window, label, ...(parsed.seconds > 0 ? { windowSeconds: parsed.seconds } : {}) });
      }
    }
  }
  Object.assign(windows, scopedWindows(scoped));

  return hasAnyWindow(windows) ? windows : null;
}

function hasAnyWindow(windows: QuotaWindows): boolean {
  return Boolean(windows.session ?? windows.weekly ?? windows.scoped);
}

/** True while a cached snapshot may be served without re-fetching. */
export function isFresh(snapshot: { fetchedAt: number }, now: number): boolean {
  const age = now - snapshot.fetchedAt;
  return age >= 0 && age < QUOTA_FRESH_MS;
}

/**
 * Anonymous calls to the Claude usage endpoint are rejected with a flat one-hour
 * Retry-After, so a 429 is treated as a host-wide pause rather than something to retry.
 */
export function cooldownUntil(retryAfterHeader: string | null, now: number): number {
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) {
    return now + Math.min(seconds, 24 * 60 * 60) * 1000;
  }
  return now + QUOTA_DEFAULT_COOLDOWN_MS;
}
