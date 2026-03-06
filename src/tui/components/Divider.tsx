import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

export function Divider({ title, cols }: { title?: string; cols?: number }) {
  // Use explicit width or fallback
  const w = cols ?? 300;

  if (!title) {
    return (
    <Box width="100%" flexDirection="row" overflow="hidden" height={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={1}>
        <Text color={color.dim}>{symbol.lineH.repeat(w)}</Text>
      </Box>
    </Box>
    );
  }

  return (
    <Box width="100%" flexDirection="row" alignItems="center" overflow="hidden" height={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={1}>
        <Text color={color.dim}>
          {symbol.lineH.repeat(w)}
        </Text>
      </Box>
      <Box paddingX={1} flexShrink={0}>
        <Text color={color.secondary} bold wrap="truncate-end">
          {title}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={1}>
        <Text color={color.dim}>
          {symbol.lineH.repeat(w)}
        </Text>
      </Box>
    </Box>
  );
}
