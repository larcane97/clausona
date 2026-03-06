import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

type Hint = { keys: string; action: string };

export function KeyHints({ hints }: { hints: Hint[] }) {
  return (
    <Box gap={1}>
      {hints.map((hint, i) => (
        <Box key={hint.keys}>
          {i > 0 && <Text color={color.dim}>{symbol.sep} </Text>}
          <Text color={color.muted} bold>{hint.keys}</Text>
          <Text color={color.dim}> {hint.action}</Text>
        </Box>
      ))}
    </Box>
  );
}
