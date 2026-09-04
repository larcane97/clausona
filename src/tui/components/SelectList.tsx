import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

export type SelectListItem = {
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
  badge?: string;
  badgeVariant?: "active" | "healthy" | "warning" | "error" | "muted" | "primary";
  /** Short status text shown after the badge, coloured by metaVariant. */
  meta?: string;
  metaVariant?: "healthy" | "warning" | "error" | "muted";
};

const badgeColorMap: Record<string, string> = {
  active: color.brandLight,
  healthy: color.healthy,
  warning: color.warning,
  error: color.error,
  muted: color.muted,
  primary: color.accent,
};

export function SelectList({
  items,
  index,
  multi = false,
}: {
  items: SelectListItem[];
  index: number;
  multi?: boolean;
}) {
  return (
    <Box flexDirection="column" gap={0}>
      {items.map((item, i) => {
        const focused = i === index;

        return (
          <Box key={item.id} gap={1} width="100%" flexWrap="nowrap">
            {/* Cursor */}
            <Box width={2} flexShrink={0}>
              <Text color={focused ? color.cursor : color.dim}>{focused ? symbol.cursor : " "}</Text>
            </Box>

            {/* Checkbox for multi */}
            {multi && (
              <Box width={2} flexShrink={0}>
                <Text color={item.selected ? color.selected : color.dim}>
                  {item.selected ? symbol.checkboxOn : symbol.checkboxOff}
                </Text>
              </Box>
            )}

            {/* minWidth={0} lets this column shrink below its content width, which is what
                allows the label to truncate instead of wrapping into the badge and meta. */}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              {/* Label + Badge + Meta — one line, never wrapped */}
              <Box gap={1} width="100%" flexWrap="nowrap" overflow="hidden">
                <Box flexShrink={1} minWidth={0} overflow="hidden">
                  <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
                    {item.label}
                  </Text>
                </Box>

                {item.badge ? (
                  <Box flexShrink={0}>
                    <Text color={badgeColorMap[item.badgeVariant ?? "muted"] ?? color.muted} wrap="truncate-end">
                      {symbol.dot} {item.badge}
                    </Text>
                  </Box>
                ) : null}

                {item.meta ? (
                  <Box flexShrink={0}>
                    <Text color={badgeColorMap[item.metaVariant ?? "muted"] ?? color.muted} wrap="truncate-end">
                      {item.meta}
                    </Text>
                  </Box>
                ) : null}
              </Box>

              {/* Detail on its own line */}
              {item.detail ? (
                <Text color={focused ? color.secondary : color.muted} wrap="truncate-end">
                  {item.detail}
                </Text>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
