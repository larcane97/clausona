import { describe, expect, it } from "vitest";

import { flatten, WINDOW, windowsOnScreen } from "./test-frames.js";

/** The helper every TUI leak assertion goes through, checked against the shapes it exists for. */
describe("windowsOnScreen", () => {
  const KEY = "sk-ant-api03-fAkE7wvKpLmN8rTyUbHc5dFgA2sE9oIuWqXv3Bn6Mk1Lp8Rt";

  it("finds a key wrapped over two lines of a panel, which a whole-string search misses", () => {
    const frame = [
      "╭────────────────────────────────╮",
      `│  Model  ${KEY.slice(0, 24)} │`,
      `│         ${KEY.slice(24)} │`,
      "╰────────────────────────────────╯",
    ].join("\n");

    expect(frame).not.toContain(KEY);
    expect(windowsOnScreen([frame], KEY)).toHaveLength(KEY.length - WINDOW + 1);
  });

  it("finds part of a key cut off at a panel's edge", () => {
    expect(windowsOnScreen([`│ Endpoint https://gw.example.com${KEY.slice(0, 20)}… │`], KEY).length).toBeGreaterThan(0);
  });

  it("finds a key drawn in any frame, not only the last", () => {
    expect(windowsOnScreen(["nothing here", `x ${KEY} x`, "nothing here either"], KEY).length).toBeGreaterThan(0);
  });

  it("finds a key with ANSI styling through it", () => {
    const styled = `${KEY.slice(0, 10)}\u001b[7m${KEY[10]}\u001b[27m${KEY.slice(11)}`;

    expect(windowsOnScreen([styled], KEY)).toHaveLength(KEY.length - WINDOW + 1);
  });

  it("finds nothing in a frame that holds no part of the key", () => {
    const frame = "│  ✦  API key          ••••••••                       │\n│  Stored in the credential store. │";

    expect(windowsOnScreen([frame], KEY)).toEqual([]);
  });

  it("flattens borders, padding and line breaks, and nothing else", () => {
    expect(flatten("│ a b │\n╰─c─╯")).toBe("abc");
  });
});
