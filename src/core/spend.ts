import type { BudgetPeriod, BudgetWindow, SpendReading } from "../types.js";
import { checkBaseUrl } from "./api-url.js";
import { QuotaHttpError } from "./quota.js";
import { BUDGET_PERIODS, type Budget } from "./route-budgets.js";

/**
 * An API profile's spend, read from its provider with the profile's own key, and what it comes to
 * against a limit. Two providers report spend: OpenRouter (`GET https://openrouter.ai/api/v1/key`)
 * and a LiteLLM proxy (`GET <baseUrl>/key/info`, which answers for the key that calls it). Any
 * other base URL is asked as a LiteLLM proxy; one that answers 404, or with anything but the JSON
 * a reader expects, gives no spend reading.
 *
 * The key goes in one request header to that one URL and nowhere else: not into a child process's
 * arguments, a log, an error, the cache or any output. A redirect is refused rather than followed,
 * since it would carry the header to wherever it points.
 */

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/** Where a profile points, and how it sends its key. */
export type SpendEndpoint = { baseUrl: string; authScheme: "bearer" | "api-key" };

export type SpendProvider = "openrouter" | "litellm";

const DAY_MS = 24 * 60 * 60 * 1000;

/** OpenRouter by its host, exactly; anything else is asked as a LiteLLM proxy. */
export function spendProvider(baseUrl: string): SpendProvider {
  const checked = checkBaseUrl(baseUrl);
  return checked.ok && checked.url.hostname === "openrouter.ai" ? "openrouter" : "litellm";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Dollars as a provider reports them: a finite number, not below 0. */
function dollars(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ─── Periods ────────────────────────────────────────────────────────
//
// In UTC, as OpenRouter counts them: a day from midnight, a week from Monday, a month from the 1st.

export function periodStart(now: number, per: BudgetPeriod): string {
  const at = new Date(now);
  const [year, month, day] = [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()];
  if (per === "day") return new Date(Date.UTC(year, month, day)).toISOString();
  if (per === "week") return new Date(Date.UTC(year, month, day - ((at.getUTCDay() + 6) % 7))).toISOString();
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

/** When the period `now` is in ends, which is when a budget for it renews. */
export function periodEnd(now: number, per: BudgetPeriod): string {
  const start = Date.parse(periodStart(now, per));
  if (per === "day") return new Date(start + DAY_MS).toISOString();
  if (per === "week") return new Date(start + 7 * DAY_MS).toISOString();
  const at = new Date(start);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
}

// ─── Readers ────────────────────────────────────────────────────────

/** A LiteLLM budget_duration that is one of the periods: `1d`, `7d`, `1mo` and their like. */
const LITELLM_PERIODS: Record<string, BudgetPeriod> = {
  "1d": "day",
  "24h": "day",
  "7d": "week",
  "1w": "week",
  "30d": "month",
  "1mo": "month",
};

/**
 * `GET /key/info` of a LiteLLM proxy, called with the key itself and no `key` parameter:
 * `{ info: { spend, max_budget, budget_duration, budget_reset_at, … } }`. Without a duration the
 * spend is a running total and `max_budget` a limit that never renews; with one, LiteLLM sets the
 * spend back to 0 at `budget_reset_at`. Null when there is no spend in it. The response names the
 * key too, which is never read.
 */
export function parseLiteLlmKeyInfo(raw: unknown): SpendReading | null {
  const info = record(record(raw)?.info);
  const spend = dollars(info?.spend);
  if (!info || spend === null) return null;
  const reading: SpendReading = { totalUsd: spend };
  const max = dollars(info.max_budget);
  if (max !== null) {
    const duration = typeof info.budget_duration === "string" ? info.budget_duration.trim().toLowerCase() : "";
    const per = Object.hasOwn(LITELLM_PERIODS, duration) ? LITELLM_PERIODS[duration] : undefined;
    reading.limit = { usd: max, resetsAt: duration ? toIso(info.budget_reset_at) : null, ...(per ? { per } : {}) };
  }
  return reading;
}

const OPENROUTER_PERIODS: Array<[BudgetPeriod, string]> = [
  ["day", "usage_daily"],
  ["week", "usage_weekly"],
  ["month", "usage_monthly"],
];

const OPENROUTER_RESETS: Record<string, BudgetPeriod> = { daily: "day", weekly: "week", monthly: "month" };

/**
 * `GET https://openrouter.ai/api/v1/key`: `{ data: { usage, usage_daily, usage_weekly,
 * usage_monthly, limit, limit_remaining, limit_reset, … } }`. `usage` is every dollar the key has
 * spent; the others are this UTC day's, week's and month's. A `limit_reset` renews the limit each
 * such period. Null when there is no spend in it.
 */
export function parseOpenRouterKey(raw: unknown, now: number): SpendReading | null {
  const data = record(record(raw)?.data);
  const usage = dollars(data?.usage);
  if (!data || usage === null) return null;
  const reading: SpendReading = { totalUsd: usage };
  const periods: Partial<Record<BudgetPeriod, number>> = {};
  for (const [per, key] of OPENROUTER_PERIODS) {
    const spent = dollars(data[key]);
    if (spent !== null) periods[per] = spent;
  }
  if (Object.keys(periods).length) reading.periods = periods;
  const limit = dollars(data.limit);
  if (limit !== null) {
    const reset = typeof data.limit_reset === "string" ? data.limit_reset : "";
    const per = Object.hasOwn(OPENROUTER_RESETS, reset) ? OPENROUTER_RESETS[reset] : undefined;
    const remaining = dollars(data.limit_remaining);
    reading.limit = {
      usd: limit,
      resetsAt: per ? periodEnd(now, per) : null,
      ...(per ? { per } : {}),
      ...(remaining === null ? {} : { remainingUsd: remaining }),
    };
  }
  return reading;
}

/** The proxy's `/key/info`, under the base URL's own path; its query and fragment are dropped. */
function keyInfoUrl(url: URL): string {
  const next = new URL(url.href);
  next.pathname = `${next.pathname.replace(/\/+$/, "")}/key/info`;
  next.search = "";
  next.hash = "";
  return next.href;
}

/**
 * Reads the spend on `key` from the provider `endpoint` points at. Null when the provider gives
 * no spend reading: a 404, a body that is not JSON, or one of another shape. Any other refusal
 * throws a QuotaHttpError with its status, which the cache treats as it treats plan quota's; a
 * base URL clausona would not store is not asked at all.
 */
export async function readSpend(
  endpoint: SpendEndpoint,
  key: string,
  options: { fetch: typeof fetch; signal: AbortSignal; now: number },
): Promise<SpendReading | null> {
  const checked = checkBaseUrl(endpoint.baseUrl);
  if (!checked.ok) throw new Error("the profile's base URL cannot be used");
  const openRouter = checked.url.hostname === "openrouter.ai";
  const url = openRouter ? OPENROUTER_KEY_URL : keyInfoUrl(checked.url);
  // OpenRouter takes a Bearer key whatever the profile sends Claude Code; a proxy, the profile's own.
  const auth: Record<string, string> =
    openRouter || endpoint.authScheme === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
  const response = await options.fetch(url, {
    headers: { Accept: "application/json", ...auth },
    redirect: "error",
    signal: options.signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new QuotaHttpError(response.status, response.headers.get("retry-after"));
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return null;
  }
  return openRouter ? parseOpenRouterKey(body, options.now) : parseLiteLlmKeyInfo(body);
}

// ─── Usage ──────────────────────────────────────────────────────────

/**
 * Whether the provider set its count back to 0 since the last reading, taken at `previousAt`
 * (LiteLLM does at its budget_reset_at): the total fell, or the reset the last reading named has
 * come. The second catches a reset after which the spend has already climbed past the last
 * reading. A reset the last reading named as already past when it was taken (a proxy late with
 * its own reset) is not one, or every reading after it would be taken for another.
 */
function providerReset(reading: SpendReading, previous: SpendReading, previousAt: number | undefined, now: number) {
  if (reading.totalUsd < previous.totalUsd) return true;
  const resetsAt = previous.limit?.resetsAt ? Date.parse(previous.limit.resetsAt) : Number.NaN;
  return previousAt !== undefined && !Number.isNaN(resetsAt) && resetsAt > previousAt && resetsAt <= now;
}

/**
 * Notes, on a reading of a provider that reports only a running total, the total each period
 * starts from: the one at clausona's first reading in it (spend before that is not counted), and
 * carried over from the last reading (`previous`, taken at `previousAt`) while the period lasts.
 * When the provider has set its count back to 0 since (providerReset), what the period had spent
 * by the last reading is kept, so the spend since counts on top of it.
 */
export function withBaselines(
  reading: SpendReading,
  previous: SpendReading | undefined,
  now: number,
  previousAt?: number,
): SpendReading {
  if (reading.periods) return reading;
  const reset = previous !== undefined && providerReset(reading, previous, previousAt, now);
  const baselines: NonNullable<SpendReading["baselines"]> = {};
  for (const per of BUDGET_PERIODS) {
    const start = periodStart(now, per);
    const before = previous?.baselines?.[per];
    if (before?.start !== start) baselines[per] = { start, totalUsd: reading.totalUsd };
    else baselines[per] = reset ? { start, totalUsd: before.totalUsd - (previous?.totalUsd ?? 0) } : before;
  }
  return { ...reading, baselines };
}

/** The spend in the period `now` is in, from a reading taken in it. */
function spentIn(reading: SpendReading, per: BudgetPeriod, now: number): number {
  const reported = reading.periods?.[per];
  if (reported !== undefined) return reported;
  const baseline = reading.baselines?.[per];
  // A reading with no start for this period is the first one in it: nothing is counted yet.
  if (!baseline || baseline.start !== periodStart(now, per)) return 0;
  return Math.max(0, reading.totalUsd - baseline.totalUsd);
}

function percentOf(spent: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, (spent / limit) * 100));
}

/**
 * What a reading comes to as a `budget` window: against the clausona budget when one is set,
 * which replaces the provider key's limit, else against that limit. Undefined when there is
 * neither, which leaves the profile without a limit.
 */
export function budgetWindow(reading: SpendReading, budget: Budget | undefined, now: number): BudgetWindow | undefined {
  if (budget) {
    const spent = spentIn(reading, budget.per, now);
    return {
      usedPercent: percentOf(spent, budget.usd),
      resetsAt: periodEnd(now, budget.per),
      spentUsd: spent,
      limitUsd: budget.usd,
      source: "budget",
      per: budget.per,
    };
  }
  const { limit } = reading;
  if (!limit) return undefined;
  // OpenRouter says what is left of a limit; a LiteLLM key's spend is what counts against its own.
  const spent =
    limit.remainingUsd !== undefined
      ? Math.max(0, limit.usd - limit.remainingUsd)
      : limit.per && reading.periods?.[limit.per] !== undefined
        ? (reading.periods[limit.per] as number)
        : reading.totalUsd;
  return {
    usedPercent: percentOf(spent, limit.usd),
    resetsAt: limit.resetsAt,
    spentUsd: spent,
    limitUsd: limit.usd,
    source: "provider",
    ...(limit.per ? { per: limit.per } : {}),
  };
}
