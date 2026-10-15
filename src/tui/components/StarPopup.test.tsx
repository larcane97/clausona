import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { STAR_URL } from "../../core/star.js";
import { StarPopup, type StarPopupState, starPopupRows } from "./StarPopup.js";

// The dashboard moves the popup up when the body under its title is short, so that it stays clear
// of the key hints: the count has to be the lines it draws, at every width (#182).
describe("starPopupRows", () => {
  const states: StarPopupState[] = [
    { phase: "ask", choice: "star", ready: true },
    { phase: "starring" },
    { phase: "done", outcome: { kind: "starred", login: "someone-with-a-long-login" } },
    { phase: "done", outcome: { kind: "starred", login: null } },
    { phase: "done", outcome: { kind: "opened", url: STAR_URL } },
    { phase: "done", outcome: { kind: "manual", url: STAR_URL } },
  ];

  for (const state of states) {
    it(`is the lines the popup draws, ${state.phase === "done" ? state.outcome.kind : state.phase}`, () => {
      for (const columns of [36, 44, 60, 80, 120]) {
        // In a body as wide as Chrome leaves, with the popup at its top and nothing else in it.
        const frame =
          render(
            <Box width={columns - 4} height={40} flexDirection="column">
              <StarPopup state={state} top={0} />
            </Box>,
          ).lastFrame() ?? "";
        const drawn = frame.trimEnd().split("\n").length;
        expect(drawn, `${columns} columns`).toBe(starPopupRows(state, columns));
      }
    });
  }
});
