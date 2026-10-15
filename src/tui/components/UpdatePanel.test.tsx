import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { UpdateOffer } from "../../core/update.js";
import { UpdatePanel, type UpdatePhase, updatePanelRows } from "./UpdatePanel.js";

const offer = { current: "0.9.0-beta", latest: "0.10.0-beta" } as UpdateOffer;

// The dashboard leaves the panel its lines before ink draws it, so that the frame stays shorter
// than the terminal: the count has to be the lines it draws, at every width (#182).
describe("updatePanelRows", () => {
  const phases: UpdatePhase[] = [
    { kind: "idle" },
    { kind: "confirm" },
    { kind: "installing" },
    {
      kind: "failed",
      message: "npm ERR! code EACCES: permission denied, rename '/usr/local/lib/node_modules/clausona'",
    },
    { kind: "manual", command: "curl -fsSL https://raw.githubusercontent.com/larcane97/clausona/main/install.sh | sh" },
  ];

  for (const phase of phases) {
    it(`is the lines the panel draws ${phase.kind}`, () => {
      for (const columns of [40, 60, 80, 120]) {
        const frame =
          render(
            <Box width={columns - 4} flexDirection="column">
              <UpdatePanel phase={phase} offer={offer} />
            </Box>,
          ).lastFrame() ?? "";
        const drawn = frame === "" ? 0 : frame.split("\n").length;
        expect(drawn, `${columns} columns`).toBe(updatePanelRows(phase, offer, columns));
      }
    });
  }
});
