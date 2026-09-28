import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

type Hint = { keys: string; action: string };

export function KeyHints({ hints }: { hints: Hint[] }) {
  // A hint that does not fit goes to the next line whole. Left shrinkable, every hint took a
  // share of the shortfall and wrapped inside itself - `ent r` over `switch`, `↑` without `↓`.
  return (
    <Box columnGap={1} flexWrap="wrap">
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
