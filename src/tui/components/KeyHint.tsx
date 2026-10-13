import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";
import { wrappedLines } from "../use-width.js";

type Hint = { keys: string; action: string };

/** The columns between two hints on a line: the row's gap. */
const HINT_GAP = 1;

export function KeyHints({ hints }: { hints: Hint[] }) {
  // A hint that does not fit goes to the next line whole. Left shrinkable, every hint took a
  // share of the shortfall and wrapped inside itself - `ent r` over `switch`, `↑` without `↓`.
  return (
    <Box columnGap={HINT_GAP} flexWrap="wrap">
      {hints.map((hint, i) => (
        <Box key={hint.keys} flexShrink={0}>
          {i > 0 && <Text color={color.dim}>{symbol.sep} </Text>}
          <Text color={color.muted} bold>
            {hint.keys}
          </Text>
          <Text color={color.dim}> {hint.action}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The lines KeyHints takes `width` columns wide: each hint `keys action`, after the separator
 * and its space from the second on. Every character the hints are written in takes one column.
 */
export function keyHintLines(hints: Hint[], width: number): number {
  const widths = hints.map(
    (hint, i) => (i > 0 ? symbol.sep.length + 1 : 0) + hint.keys.length + 1 + hint.action.length,
  );
  return wrappedLines(widths, HINT_GAP, width);
}
