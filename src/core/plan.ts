/**
 * A subscription's plan as `list`, `current` and the dashboard name it: Ultra, Max, Pro, Plus and
 * so on. Both tools keep it on disk with the sign-in, so it is read without a request.
 */

/** Claude's organization types, for an account whose profile has no plan name of its own. */
const CLAUDE_TYPES: Record<string, string> = {
  claude_free: "Free",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

/** Codex's plan types (ChatGPT's), by the names ChatGPT sells them under. */
const CODEX_PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  edu: "Edu",
  education: "Edu",
};

/** `edu_plus` as `Edu Plus`: a plan type neither table knows, in words. */
function words(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The plan of a Claude account, from the `oauthAccount` Claude Code keeps in the profile's
 * `.claude.json`: the name Anthropic gives it (`planDisplayName`) when Claude Code has stored
 * one, and otherwise its organization type. `claude_max` is two plans told apart by their rate
 * limit tier, as Claude Code itself does: 20x is Ultra, the plan Max 20x became on 2026-10-30, and
 * 5x is Max. Undefined for an account that records neither, such as one Claude Code has not
 * fetched a profile for since it began storing them.
 */
export function claudePlanName(account: unknown): string | undefined {
  if (typeof account !== "object" || account === null) return undefined;
  const fields = account as Record<string, unknown>;
  const named = text(fields.planDisplayName);
  if (named) return named;
  const type = text(fields.organizationType);
  if (!type) return undefined;
  if (type === "claude_max") return fields.organizationRateLimitTier === "default_claude_max_20x" ? "Ultra" : "Max";
  return CLAUDE_TYPES[type] ?? words(type.replace(/^claude_/, ""));
}

/**
 * The plan of a Codex sign-in, from the `chatgpt_plan_type` its id_token carries. The business
 * and enterprise variants (`self_serve_business_usage_based`, `enterprise_cbp_automation`) go by
 * the plan they are a kind of.
 */
export function codexPlanName(planType: unknown): string | undefined {
  const type = text(planType)?.toLowerCase();
  if (!type) return undefined;
  if (CODEX_PLANS[type]) return CODEX_PLANS[type];
  if (type.startsWith("self_serve_business")) return "Business";
  if (type.startsWith("enterprise")) return "Enterprise";
  return words(type);
}
