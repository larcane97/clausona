import { describe, expect, it } from "vitest";

import { listWindow } from "./fit.js";

/** The lines a window takes: its items, and a line for each side that leaves items out. */
const linesOf = (view: ReturnType<typeof listWindow>, size: number) =>
  (view.end - view.start) * size + (view.above > 0 ? 1 : 0) + (view.below > 0 ? 1 : 0);

describe("listWindow", () => {
  it("shows every item when they fit, with no line above or below", () => {
    expect(listWindow(5, 10, 4, 0, 2)).toEqual({ start: 0, end: 5, above: 0, below: 0 });
  });

  it("keeps to its room, the lines that say how many more included, wherever the cursor is", () => {
    for (const size of [1, 2]) {
      for (let room = size + 2; room <= 12; room++) {
        let start = 0;
        for (let cursor = 0; cursor < 14; cursor++) {
          const view = listWindow(14, room, cursor, start, size);
          expect(linesOf(view, size), `size ${size}, room ${room}, cursor ${cursor}`).toBeLessThanOrEqual(room);
          expect(cursor).toBeGreaterThanOrEqual(view.start);
          expect(cursor).toBeLessThan(view.end);
          expect(view.above).toBe(view.start);
          expect(view.below).toBe(14 - view.end);
          start = view.start;
        }
      }
    }
  });

  it("moves only as far as the cursor takes it", () => {
    const down = listWindow(20, 6, 9, 0);
    // From the top to row 9 in five lines: one says how many are above, one how many below.
    expect(down).toEqual({ start: 6, end: 10, above: 6, below: 10 });
    // Back up one row: still in view, so nothing moves.
    expect(listWindow(20, 6, 8, down.start)).toEqual(down);
  });

  it("ends at the last item rather than leave room empty below it", () => {
    expect(listWindow(10, 5, null, 9)).toEqual({ start: 6, end: 10, above: 6, below: 0 });
  });

  it("shows the cursor's item even in less room than it takes", () => {
    const view = listWindow(10, 1, 5, 0, 2);
    expect(view.start).toBeLessThanOrEqual(5);
    expect(view.end).toBeGreaterThan(5);
  });
});
