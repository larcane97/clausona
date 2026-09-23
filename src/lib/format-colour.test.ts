import { expect, it } from "vitest";

import type { ProfileListItem } from "../types.js";

/**
 * The one thing src/lib/format.test.ts cannot see: how a cell is painted. chalk is level 0
 * under a plain `vitest run`; with FORCE_COLOR set before the modules load it is level 3 and
 * the codes are in the output, so this file sets it and imports everything dynamically -
 * static imports are hoisted above the assignment. The same arrangement as
 * src/tui/doctor-colour.test.tsx.
 */
process.env.FORCE_COLOR = "3";

const usage = { cost: 1, inputTokens: 10, outputTokens: 5 };
const row = (name: string, model?: string): ProfileListItem => ({
  name,
  tool: "claude",
  email: `${name}@example.com`,
  configDir: `/h/.claude-${name}`,
  isPrimary: false,
  isActive: false,
  model,
  // Both windows, so no quota cell is a dash: the model cell is the only one in the row.
  quota: {
    state: "ok",
    fetchedAt: 0,
    session: { usedPercent: 6, resetsAt: null },
    weekly: { usedPercent: 7, resetsAt: null },
  },
  today: usage,
  week: usage,
  month: usage,
  total: usage,
});

// The dash says "none pinned", like every other empty cell in the table, which are dim.
it("dims the model cell of a profile that pins none, and only that one", async () => {
  const { renderList } = await import("./format.js");
  const { dim, secondary } = await import("./cli-style.js");

  const lines = renderList([row("gw", "z-ai/glm-5.3"), row("work")], { width: 200 }).split("\n");
  const work = lines.find((line) => line.includes("work@example.com")) ?? "";
  const gw = lines.find((line) => line.includes("gw@example.com")) ?? "";

  expect(dim("—")).not.toBe("—");
  expect(work.split("—")).toHaveLength(2);
  expect(work).toContain(dim("—"));
  expect(gw).toContain(secondary("z-ai/glm-5.3"));
});
