import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { textLines } from "./use-width.js";

// The route form works out how tall a text field is before ink draws it, to keep its frame
// shorter than the terminal: the count has to be the lines ink draws, at every width.
describe("textLines", () => {
  it("is the lines ink wraps a text into, at every width", () => {
    const emails = "alice@work.example.com, bob@work.example.com, carol@work.example.com";
    const texts = [
      emails,
      // A focused field's cursor at its end: a cell after the text.
      `${emails} `,
      "acct-*,team-*,ops-*,build-*,release-*,staging-*, old",
      "a b  c   d",
      " ab",
      "x",
    ];
    for (const text of texts) {
      for (let width = 3; width <= 80; width++) {
        const instance = render(
          <Box width={width}>
            <Text>{text}</Text>
          </Box>,
        );
        const drawn = (instance.lastFrame() ?? "").split("\n").length;
        instance.unmount();
        expect(drawn, `${JSON.stringify(text)} at ${width}`).toBe(textLines(text, width));
      }
    }
  });
});
