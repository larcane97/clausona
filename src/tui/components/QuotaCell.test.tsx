import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { color } from "../theme.js";
import { QuotaCell, quotaColor } from "./QuotaCell.js";

/** No reset time, so the text does not depend on the clock. */
const at = (usedPercent: number) => ({ usedPercent, resetsAt: null });

const frame = (element: ReactElement) => render(element).lastFrame() ?? "";

describe("quotaColor", () => {
  it("grades a live reading: critical at 90%, warning at 75%", () => {
    expect([at(10), at(75), at(89), at(90), at(100)].map((window) => quotaColor(window, true))).toEqual([
      color.text,
      color.warning,
      color.warning,
      color.error,
      color.error,
    ]);
  });

  it("mutes a last-known reading whatever it says", () => {
    expect(quotaColor(at(95), false)).toBe(color.muted);
  });
});

describe("QuotaCell", () => {
  it("shows a dash for no window", () => {
    expect(frame(<QuotaCell live width={10} />)).toBe("—");
  });

  it("fits the reading to its width, the percentage last to go", () => {
    expect(frame(<QuotaCell window={at(42)} live width={20} />)).toMatch(/^\S+ {2}42%$/);
    expect(frame(<QuotaCell window={at(42)} live width={4} />)).toBe(" 42%");
  });

  it("never reads a route's cut under it, and rounds as the dashboard does without one", () => {
    expect(frame(<QuotaCell window={at(79.6)} live width={4} cut={80} />)).toBe(" 79%");
    expect(frame(<QuotaCell window={at(80)} live width={4} cut={80} />)).toBe(" 80%");
    expect(frame(<QuotaCell window={at(79.6)} live width={4} />)).toBe(" 80%");
  });
});
