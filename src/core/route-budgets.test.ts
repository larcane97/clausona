import { describe, expect, it } from "vitest";

import { budgetText, budgetWarnings, clearBudget, readBudgets, setBudget, usdText } from "./route-budgets.js";
import { profileNames, type RoutesFile } from "./route-config.js";

// Built from pieces so the source never holds a key-shaped string.
const keyShaped = () => ["sk", "ant", "x".repeat(24)].join("-");

const file = (budgets?: unknown): RoutesFile => ({
  version: 1,
  routes: {},
  ...(budgets === undefined ? {} : { budgets }),
});

describe("readBudgets", () => {
  it("reads each profile's budget, and none when there is no budgets key", () => {
    expect(readBudgets(file())).toEqual({ budgets: {}, problems: [] });
    expect(
      readBudgets(file({ "claude:gw": { usd: 20, per: "month" }, "claude:or": { usd: 2.5, per: "day" } })),
    ).toEqual({
      budgets: { "claude:gw": { usd: 20, per: "month" }, "claude:or": { usd: 2.5, per: "day" } },
      problems: [],
    });
  });

  it("checks every field, keeps the entries that read, and says where each problem is", () => {
    const read = readBudgets(
      file({
        "claude:gw": { usd: 20, per: "month" },
        "claude:zero": { usd: 0, per: "month" },
        "claude:text": { usd: "20", per: "year" },
        "claude:extra": { usd: 5, per: "week", limit: 9 },
        "claude:flat": 20,
        gw: { usd: 20, per: "month" },
      }),
    );
    expect(read.budgets).toEqual({ "claude:gw": { usd: 20, per: "month" } });
    expect(read.problems).toEqual([
      'budgets["claude:zero"].usd: must be a number of dollars above 0',
      'budgets["claude:text"].usd: must be a number of dollars above 0',
      'budgets["claude:text"].per: must be one of day, week, month',
      `budgets["claude:extra"]: unknown key 'limit'`,
      'budgets["claude:flat"]: must be an object such as { "usd": 20, "per": "month" }',
      'budgets["gw"]: must be a profile id, such as claude:gateway',
    ]);
  });

  it("refuses budgets that are not an object", () => {
    expect(readBudgets(file([1])).problems).toEqual([
      'budgets: must be an object of a budget per API profile, such as { "claude:gateway": { "usd": 20, "per": "month" } }',
    ]);
  });

  it("never quotes a profile shaped like a key, unless it is a registered profile", () => {
    const key = keyShaped();
    const read = readBudgets(file({ [key]: { usd: 1, per: "day" }, [`claude:${key}`]: { usd: 1, per: "day" } }));
    expect(read.problems).toEqual([
      "budgets: a profile looks like an API key",
      "budgets: a profile looks like an API key",
    ]);
    expect(read.problems.join("\n")).not.toContain("xxxx");
    // A long name with digits through it trips the key check without being a key.
    const long = ["Team", "Gateway", "2026", "Eu", "West", "Prod", "07"].join("");
    expect(readBudgets(file({ [`claude:${long}`]: { usd: 1, per: "day" } }), profileNames([`claude:${long}`]))).toEqual(
      {
        budgets: { [`claude:${long}`]: { usd: 1, per: "day" } },
        problems: [],
      },
    );
  });
});

describe("budgetWarnings", () => {
  it("names a budget for a profile that is not registered, or not an API profile", () => {
    const budgets = {
      "claude:gw": { usd: 20, per: "month" as const },
      "claude:gone": { usd: 5, per: "day" as const },
      "claude:work": { usd: 5, per: "day" as const },
    };
    expect(budgetWarnings(budgets, { "claude:gw": { kind: "api" }, "claude:work": {} })).toEqual([
      "budgets names claude:gone, which is not a registered profile.",
      "budgets names claude:work, which is not an API profile; a budget applies only to one.",
    ]);
  });
});

describe("budget edits", () => {
  it("sets a budget in place or last, and clears it, leaving the key out once empty", () => {
    const routes = file({ "claude:a": { usd: 1, per: "day" }, "claude:b": { usd: 2, per: "day" } });
    setBudget(routes, "claude:a", { usd: 9, per: "week" });
    setBudget(routes, "claude:c", { usd: 3, per: "month" });
    expect(Object.entries(routes.budgets as object)).toEqual([
      ["claude:a", { usd: 9, per: "week" }],
      ["claude:b", { usd: 2, per: "day" }],
      ["claude:c", { usd: 3, per: "month" }],
    ]);
    expect(clearBudget(routes, "claude:b")).toBe(true);
    expect(clearBudget(routes, "claude:b")).toBe(false);
    clearBudget(routes, "claude:a");
    clearBudget(routes, "claude:c");
    expect(routes).not.toHaveProperty("budgets");
  });

  it("keeps a hand-edited entry it does not touch, problems and all", () => {
    const routes = file({ "claude:bad": { usd: 0, per: "month" } });
    setBudget(routes, "claude:gw", { usd: 20, per: "month" });
    expect(routes.budgets).toEqual({ "claude:bad": { usd: 0, per: "month" }, "claude:gw": { usd: 20, per: "month" } });
  });

  it("refuses to change budgets that are not an object", () => {
    expect(() => setBudget(file("x"), "claude:gw", { usd: 1, per: "day" })).toThrow(
      "budgets in routes.json is not an object, so it cannot be changed. Fix it with clausona route edit.",
    );
  });
});

describe("budget text", () => {
  it("says whole dollars bare and others to the cent", () => {
    expect(budgetText({ usd: 20, per: "month" })).toBe("$20/month");
    expect(budgetText({ usd: 12.5, per: "day" })).toBe("$12.50/day");
    expect(usdText(0.004)).toBe("$0.00");
  });
});
