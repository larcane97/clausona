import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { DoctorIssue } from "../../types.js";
import { HealthFindings } from "./HealthFindings.js";

const issues = (count: number): DoctorIssue[] =>
  Array.from({ length: count }, (_, i) => ({
    kind: "local_override",
    message: `notes-${String(i + 1).padStart(2, "0")}.json replaced an expected shared link`,
  }));

const linesAt = (columns: number, list: DoctorIssue[], rows?: number) =>
  (
    render(
      <Box width={columns} flexDirection="column">
        <HealthFindings issues={list} profile="claude:work" rows={rows} />
      </Box>,
    ).lastFrame() ?? ""
  ).split("\n");

// Health check's pane under a profile, in the lines the terminal leaves it (#180).
describe("HealthFindings", () => {
  it("lists every finding when they fit", () => {
    expect(linesAt(60, issues(5), 20)).toEqual(linesAt(60, issues(5)));
    expect(linesAt(60, issues(5)).filter((line) => line.includes("➔"))).toHaveLength(5);
  });

  it("keeps to its lines, and says how many more there are and where to see them all", () => {
    for (const columns of [30, 60]) {
      for (let rows = 1; rows <= 14; rows++) {
        const lines = linesAt(columns, issues(15), rows);
        const shown = lines.filter((line) => line.includes("➔")).length;
        const what = `${columns} columns, ${rows} lines`;

        expect(lines.length, what).toBeLessThanOrEqual(rows);
        expect(shown, what).toBeLessThan(15);
        expect(lines.at(-1), what).toContain(`… ${15 - shown} more`);
      }
    }
    expect(linesAt(60, issues(15), 6).at(-1)).toContain("… 10 more · csn doctor claude:work");
  });
});
