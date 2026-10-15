import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";

import type { UpdateOffer } from "../../core/update.js";
import { color, symbol } from "../theme.js";
import { textLines } from "../use-width.js";

/**
 * The dashboard's update, once Update has been chosen. It can be a question, under way, failed,
 * or impossible in place. A failure is shown here rather than in the one-line footer, which cuts
 * a long message off at the terminal's edge.
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "installing" }
  | { kind: "failed"; message: string }
  | { kind: "manual"; command: string };

/** What the panel says in each phase that says something, a line of text each: drawn, and counted. */
function panelTexts(phase: UpdatePhase, offer: UpdateOffer): string[] {
  switch (phase.kind) {
    case "idle":
      return [];
    case "confirm":
      return [
        `Update clausona v${offer.current} → v${offer.latest}? (Y/n)`,
        "csn restarts when it's done. Open a new shell afterwards to load the new shell hook.",
      ];
    case "installing":
      return [`Updating to v${offer.latest}…`];
    case "failed":
      return ["Update failed", phase.message];
    case "manual":
      return [
        "This clausona was not installed by the installer, so it cannot replace itself.",
        "To update, run:",
        phase.command,
      ];
  }
}

/** The columns the panel's text loses of the terminal's: Chrome's padding, the border and its own. */
const PANEL_INSET = 8;

/**
 * The lines the panel takes `columns` wide, for the dashboard above it to leave room for: none
 * while idle; else the blank line above it, its border and padding, and its texts as they wrap.
 * The spinner's and the failure's first lines have an icon and a space before them.
 */
export function updatePanelRows(phase: UpdatePhase, offer: UpdateOffer, columns: number): number {
  if (phase.kind === "idle") return 0;
  const width = columns - PANEL_INSET;
  const iconed = phase.kind === "installing" || phase.kind === "failed";
  const [first = "", ...rest] = panelTexts(phase, offer);
  return (
    1 +
    2 +
    2 +
    textLines(first, iconed ? width - 2 : width) +
    rest.reduce((sum, text) => sum + textLines(text, width), 0)
  );
}

export function UpdatePanel({ phase, offer }: { phase: UpdatePhase; offer: UpdateOffer }) {
  if (phase.kind === "idle") return null;
  const text = panelTexts(phase, offer);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={phase.kind === "failed" ? color.error : color.brand}
      paddingX={1}
      paddingY={1}
      marginTop={1}
    >
      {phase.kind === "confirm" && (
        <>
          <Text color={color.text} bold>
            {text[0]}
          </Text>
          <Text color={color.secondary}>{text[1]}</Text>
        </>
      )}
      {phase.kind === "installing" && <Spinner label={text[0]} />}
      {phase.kind === "failed" && (
        <>
          <Box gap={1}>
            <Text color={color.error}>{symbol.cross}</Text>
            <Text color={color.error} bold>
              {text[0]}
            </Text>
          </Box>
          <Text color={color.secondary}>{text[1]}</Text>
        </>
      )}
      {phase.kind === "manual" && (
        <>
          <Text color={color.text}>{text[0]}</Text>
          <Text color={color.secondary}>{text[1]}</Text>
          <Text color={color.brandLight}>{text[2]}</Text>
        </>
      )}
    </Box>
  );
}
