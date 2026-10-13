import type { BudgetPeriod, Profile } from "../types.js";
import { foldProfileName } from "./profile-name.js";
import { holdsKey, NO_PROFILE_NAMES, type ProfileNames, type RoutesFile } from "./route-config.js";

/**
 * Budgets: what an API profile may spend before routes stop taking it, kept in routes.json beside
 * the routes. A budget replaces the limit set on the provider key; the two are not compared.
 *
 *   "budgets": { "claude:gateway": { "usd": 20, "per": "month" } }
 *
 * Read leniently, as dir rules are: an entry that cannot be read is a problem that `route budget`
 * and `route list` show, and the others still apply. A write is refused while there is one. This
 * module reads and edits them; it writes nothing.
 */

export type { BudgetPeriod };

export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["day", "week", "month"];

export type Budget = { usd: number; per: BudgetPeriod };

/** By profile id (`claude:gateway`). */
export type Budgets = Record<string, Budget>;

export type BudgetsRead = {
  budgets: Budgets;
  /** Every entry that cannot be read, each prefixed with where it is: `budgets["claude:gw"].usd`. */
  problems: string[];
};

const BUDGET_KEYS = new Set(["usd", "per"]);
const TOOLS: readonly string[] = ["claude", "codex"];
/** A profile's name, as the profile-name rule spells it. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The command that sets one, as the messages that ask for one name it. */
export const budgetCommand = (id: string) => `clausona route budget ${id} --usd 20 --per month`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A budget's limit: dollars above 0. */
export function isBudgetUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return BUDGET_PERIODS.includes(value as BudgetPeriod);
}

/** Whether `id` is spelled as a profile id: a tool, a colon, and a name of a profile's characters. */
function isProfileId(id: string): boolean {
  const colon = id.indexOf(":");
  return TOOLS.includes(id.slice(0, colon)) && PROFILE_NAME.test(id.slice(colon + 1));
}

/**
 * `budgets` as read. `names` are the registered profiles' (checkPattern in route-config.ts): a
 * profile shaped like a key is let through when it is one of them, and is never quoted otherwise.
 */
export function readBudgets(file: RoutesFile, names: ProfileNames = NO_PROFILE_NAMES): BudgetsRead {
  if (file.budgets === undefined) return { budgets: {}, problems: [] };
  if (!isRecord(file.budgets)) {
    return {
      budgets: {},
      problems: [
        'budgets: must be an object of a budget per API profile, such as { "claude:gateway": { "usd": 20, "per": "month" } }',
      ],
    };
  }
  const budgets: Budgets = {};
  const problems: string[] = [];
  for (const [id, raw] of Object.entries(file.budgets)) {
    // A profile is quoted wherever it is shown, so one shaped like a key is never shown.
    if (!names.has(foldProfileName(id)) && holdsKey(id)) {
      problems.push("budgets: a profile looks like an API key");
      continue;
    }
    const at = `budgets[${JSON.stringify(id)}]`;
    if (!isProfileId(id)) {
      problems.push(`${at}: must be a profile id, such as claude:gateway`);
      continue;
    }
    if (!isRecord(raw)) {
      problems.push(`${at}: must be an object such as { "usd": 20, "per": "month" }`);
      continue;
    }
    const before = problems.length;
    for (const key of Object.keys(raw)) {
      if (BUDGET_KEYS.has(key)) continue;
      problems.push(holdsKey(key) ? `${at}: an unknown key looks like an API key` : `${at}: unknown key '${key}'`);
    }
    if (!isBudgetUsd(raw.usd)) problems.push(`${at}.usd: must be a number of dollars above 0`);
    if (!isBudgetPeriod(raw.per)) problems.push(`${at}.per: must be one of ${BUDGET_PERIODS.join(", ")}`);
    if (problems.length === before) budgets[id] = { usd: raw.usd as number, per: raw.per as BudgetPeriod };
  }
  return { budgets, problems };
}

/**
 * The budgets that name a profile no budget applies to, as `route budget` and `route list` warn
 * about them: one that is not registered, and one that is not an API profile.
 */
export function budgetWarnings(budgets: Budgets, profiles: Record<string, Pick<Profile, "kind">>): string[] {
  return Object.keys(budgets).flatMap((id) => {
    const profile = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
    if (!profile) return [`budgets names ${id}, which is not a registered profile.`];
    if (profile.kind !== "api")
      return [`budgets names ${id}, which is not an API profile; a budget applies only to one.`];
    return [];
  });
}

/** `$20/month`, `$12.50/day`. */
export function budgetText(budget: Budget): string {
  return `${usdText(budget.usd)}/${budget.per}`;
}

/** Dollars as a limit is said: whole ones bare (`$20`), else to the cent (`$12.50`). */
export function usdText(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

// ─── Edits ──────────────────────────────────────────────────────────
//
// Each changes the copy of routes.json that updateRoutes hands it; updateRoutes refuses to write a
// file that still has a problem.

/** `budgets` as an object to change: a new one when there is none. */
function budgetsAt(file: RoutesFile): Record<string, unknown> {
  if (file.budgets === undefined) return {};
  if (!isRecord(file.budgets)) {
    throw new Error(
      "budgets in routes.json is not an object, so it cannot be changed. Fix it with clausona route edit.",
    );
  }
  return file.budgets;
}

/** Puts `budgets` back, or leaves the key out once it is empty. */
function putBudgets(file: RoutesFile, budgets: Record<string, unknown>): void {
  if (Object.keys(budgets).length === 0) delete file.budgets;
  else file.budgets = budgets;
}

/** Sets the budget of the profile `id`, where its entry was, or last. */
export function setBudget(file: RoutesFile, id: string, budget: Budget): void {
  const entries = Object.entries(budgetsAt(file));
  const at = entries.findIndex(([stored]) => stored === id);
  const entry: [string, unknown] = [id, { usd: budget.usd, per: budget.per }];
  if (at === -1) entries.push(entry);
  else entries[at] = entry;
  // Built from entries rather than assigned: a hand edit can hold any key, `__proto__` too.
  putBudgets(file, Object.fromEntries(entries));
}

/** Clears the budget of the profile `id`; whether it had one. */
export function clearBudget(file: RoutesFile, id: string): boolean {
  const entries = Object.entries(budgetsAt(file));
  const kept = entries.filter(([stored]) => stored !== id);
  if (kept.length === entries.length) return false;
  putBudgets(file, Object.fromEntries(kept));
  return true;
}
