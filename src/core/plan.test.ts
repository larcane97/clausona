import { describe, expect, it } from "vitest";

import { claudePlanName, codexPlanName } from "./plan.js";

describe("claudePlanName", () => {
  it("is the name Claude Code stored with the account", () => {
    expect(claudePlanName({ planDisplayName: "Ultra", organizationType: "claude_max" })).toBe("Ultra");
    expect(claudePlanName({ planDisplayName: " Team Premium ", organizationType: "claude_team" })).toBe("Team Premium");
  });

  it("tells Max from Ultra by the rate limit tier when no name is stored", () => {
    // As Claude Code's own profile does for an account fetched before it stored plan names.
    const max = { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x" };
    const ultra = { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" };

    expect(claudePlanName(max)).toBe("Max");
    expect(claudePlanName(ultra)).toBe("Ultra");
    expect(claudePlanName({ organizationType: "claude_max" })).toBe("Max");
    expect(claudePlanName({ planDisplayName: null, ...ultra })).toBe("Ultra");
  });

  it("names the other organization types", () => {
    expect(claudePlanName({ organizationType: "claude_pro" })).toBe("Pro");
    expect(claudePlanName({ organizationType: "claude_team" })).toBe("Team");
    expect(claudePlanName({ organizationType: "claude_enterprise" })).toBe("Enterprise");
    expect(claudePlanName({ organizationType: "claude_free" })).toBe("Free");
    expect(claudePlanName({ organizationType: "claude_new_tier" })).toBe("New Tier");
  });

  it("is undefined for an account that records no plan", () => {
    expect(claudePlanName({ emailAddress: "a@example.com", billingType: "none" })).toBeUndefined();
    expect(claudePlanName({ planDisplayName: "", organizationType: "" })).toBeUndefined();
    expect(claudePlanName(undefined)).toBeUndefined();
    expect(claudePlanName("max")).toBeUndefined();
  });
});

describe("codexPlanName", () => {
  it("names ChatGPT's plans", () => {
    expect(codexPlanName("free")).toBe("Free");
    expect(codexPlanName("plus")).toBe("Plus");
    expect(codexPlanName("pro")).toBe("Pro");
    expect(codexPlanName("prolite")).toBe("Pro Lite");
    expect(codexPlanName("team")).toBe("Team");
    expect(codexPlanName("PLUS")).toBe("Plus");
  });

  it("names a business or enterprise variant by the plan it is a kind of", () => {
    expect(codexPlanName("self_serve_business_usage_based")).toBe("Business");
    expect(codexPlanName("enterprise_cbp_automation")).toBe("Enterprise");
    expect(codexPlanName("ent26")).toBe("Enterprise");
  });

  it("puts a plan type it does not know in words", () => {
    expect(codexPlanName("edu_plus")).toBe("Edu Plus");
  });

  it("is undefined without a plan type", () => {
    expect(codexPlanName(undefined)).toBeUndefined();
    expect(codexPlanName("")).toBeUndefined();
    expect(codexPlanName(7)).toBeUndefined();
  });
});
