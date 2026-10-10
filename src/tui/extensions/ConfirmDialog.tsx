import { Box, Text } from "ink";

import { color } from "../theme.js";
import type { DialogLine } from "./confirm-model.js";

const TONE: Record<NonNullable<DialogLine["tone"]>, string> = {
  text: color.text,
  muted: color.muted,
  warning: color.warning,
  error: color.error,
};

type Props = {
  /** dialogView's lines: already cut to the width, and no more than the panes' height. */
  lines: DialogLine[];
  width: number;
};

/**
 * The confirm dialog in the panes' place: each of its lines on one row, the picker's cursor in
 * the cursor's colour. It draws the lines it is given and no more.
 */
export function ConfirmDialog({ lines, width }: Props) {
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {lines.map((line) => {
        const tone = TONE[line.tone ?? "text"];
        if (line.text === "") return <Text key={line.key}> </Text>;
        return (
          <Text key={line.key} wrap="truncate-end" color={tone} bold={line.bold === true}>
            {line.cursor ? (
              <>
                <Text color={color.cursor}>{line.text.slice(0, 1)}</Text>
                {line.text.slice(1)}
              </>
            ) : (
              line.text
            )}
          </Text>
        );
      })}
    </Box>
  );
}
