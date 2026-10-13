import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../lib/cli-style.js";
import { KeyHints, keyHintLines } from "./KeyHint.js";

// The Profiles screen's hints for a profile that can be removed, re-logged and re-sessioned.
const HINTS = [
  { keys: "↑↓", action: "nav" },
  { keys: "enter", action: "switch" },
  { keys: "a", action: "add" },
  { keys: "d", action: "remove" },
  { keys: "l", action: "re-login" },
  { keys: "s", action: "sessions" },
  { keys: "esc", action: "back" },
];

describe("KeyHints", () => {
  // Each hint shrank with the others, so below about 95 columns every one of them wrapped
  // inside itself: `ent r` over `switch`, and `↑↓` lost its second arrow.
  it("moves a hint that does not fit to the next line whole, rather than breaking every hint", () => {
    const frame = stripAnsi(
      render(
        <Box width={56}>
          <KeyHints hints={HINTS} />
        </Box>,
      ).lastFrame() ?? "",
    );

    for (const hint of HINTS) expect(frame).toContain(`${hint.keys} ${hint.action}`);
  });

  // A screen that fits itself to the terminal's height works out how tall the hints are before
  // ink draws them: the count has to be the lines ink draws, at every width.
  it("takes the lines keyHintLines says it takes, at every width", () => {
    for (let width = 10; width <= 90; width++) {
      const instance = render(
        <Box width={width}>
          <KeyHints hints={HINTS} />
        </Box>,
      );
      expect((instance.lastFrame() ?? "").split("\n").length, `${width} columns`).toBe(keyHintLines(HINTS, width));
      instance.unmount();
    }
  });
});
