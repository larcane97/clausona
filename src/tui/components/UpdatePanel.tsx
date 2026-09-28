import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";

import type { UpdateOffer } from "../../core/update.js";
import { color, symbol } from "../theme.js";

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

export function UpdatePanel({ phase, offer }: { phase: UpdatePhase; offer: UpdateOffer }) {
  if (phase.kind === "idle") return null;

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
            Update clausona v{offer.current} → v{offer.latest}? (Y/n)
          </Text>
          <Text color={color.secondary}>
            csn restarts when it's done. Open a new shell afterwards to load the new shell hook.
          </Text>
        </>
      )}
      {phase.kind === "installing" && <Spinner label={`Updating to v${offer.latest}…`} />}
      {phase.kind === "failed" && (
        <>
          <Box gap={1}>
            <Text color={color.error}>{symbol.cross}</Text>
            <Text color={color.error} bold>
              Update failed
            </Text>
          </Box>
          <Text color={color.secondary}>{phase.message}</Text>
        </>
      )}
      {phase.kind === "manual" && (
        <>
          <Text color={color.text}>This clausona was not installed by the installer, so it cannot replace itself.</Text>
          <Text color={color.secondary}>To update, run:</Text>
          <Text color={color.brandLight}>{phase.command}</Text>
        </>
      )}
    </Box>
  );
}
