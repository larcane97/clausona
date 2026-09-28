import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../lib/cli-style.js";
import { KeyHints } from "./KeyHint.js";

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
});
