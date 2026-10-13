import { Box } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { FallbackEntries, fallbackLines, Radio, radioLines } from "./RouteFormRows.js";

/** The lines `row` takes drawn `width` columns wide. */
function linesAt(row: ReactElement, width: number): number {
  const instance = render(<Box width={width}>{row}</Box>);
  const count = (instance.lastFrame() ?? "").split("\n").length;
  instance.unmount();
  return count;
}

// The route form works out how tall these rows are before ink draws them, to keep its frame
// shorter than the terminal: the count has to be the lines ink draws, at every width.
describe("the route form's rows that wrap", () => {
  it("take the lines radioLines and fallbackLines say they take, at every width", () => {
    const options: Array<[string, string]> = [
      ["claude", "claude"],
      ["codex", "codex"],
      ["all", "claude + codex"],
    ];
    const entries = ["claude:acct-01", "claude:work", "claude:ops-share"];
    const pool = new Set(["claude:work"]);
    for (let width = 8; width <= 80; width++) {
      expect(linesAt(<Radio options={options} selected="codex" focused />, width), `radio, ${width}`).toBe(
        radioLines(options, width),
      );
      expect(linesAt(<FallbackEntries entries={entries} cursor={1} pool={pool} />, width), `fallback, ${width}`).toBe(
        fallbackLines(entries, pool, width),
      );
    }
  });
});
