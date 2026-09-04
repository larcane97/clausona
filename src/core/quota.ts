import type { QuotaWindow, QuotaWindows } from "../types.js";

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

/**
 * Picks the most-consumed scoped limit (Claude reports one entry per model, so the
 * binding one is whichever sits highest).
 */
function claudeScoped(value: unknown): (QuotaWindow & { label: string }) | undefined {
  if (!Array.isArray(value)) return undefined;

  let best: (QuotaWindow & { label: string }) | undefined;
  for (const entry of value) {
    const obj = record(entry);
    if (!obj || obj.kind !== "weekly_scoped") continue;

    const usedPercent = toPercent(obj.percent);
    if (usedPercent === null) continue;

    const label = record(record(obj.scope)?.model)?.display_name;
    if (typeof label !== "string" || label === "") continue;

    if (!best || usedPercent > best.usedPercent) {
      best = { usedPercent, resetsAt: toIso(obj.resets_at), label };
    }
  }
  return best;
}

/** Parses `GET https://api.anthropic.com/api/oauth/usage`. */
export function parseClaudeQuota(raw: unknown): QuotaWindows | null {
  const obj = record(raw);
  if (!obj) return null;

  const windows: QuotaWindows = {
    session: claudeWindow(obj.five_hour),
    weekly: claudeWindow(obj.seven_day),
    scoped: claudeScoped(obj.limits),
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

/** Parses `GET https://chatgpt.com/backend-api/codex/usage`. */
export function parseCodexQuota(raw: unknown): QuotaWindows | null {
  const obj = record(raw);
  if (!obj) return null;

  const rateLimit = record(obj.rate_limit);
  const windows: QuotaWindows = {};

  for (const key of ["primary_window", "secondary_window"] as const) {
    const parsed = codexWindow(rateLimit?.[key]);
    if (!parsed) continue;
    if (parsed.seconds > 0 && parsed.seconds <= CODEX_SESSION_MAX_SECONDS) {
      windows.session = parsed.window;
    } else {
      windows.weekly = parsed.window;
    }
  }

  if (Array.isArray(obj.additional_rate_limits)) {
    for (const entry of obj.additional_rate_limits) {
      const additional = record(entry);
      if (!additional) continue;

      const label = additional.limit_name;
      if (typeof label !== "string" || label === "") continue;

      const parsed = codexWindow(record(additional.rate_limit)?.primary_window);
      if (!parsed) continue;

      if (!windows.scoped || parsed.window.usedPercent > windows.scoped.usedPercent) {
        windows.scoped = { ...parsed.window, label };
      }
    }
  }

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
