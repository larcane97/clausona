import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";

export type SelectListItem = {
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
  badge?: string;
  badgeVariant?: "active" | "healthy" | "warning" | "error" | "muted" | "primary";
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
          <Box key={item.id} gap={1}>
            {/* Cursor */}
            <Box width={2}>
              <Text color={focused ? color.cursor : color.dim}>
                {focused ? symbol.cursor : " "}
              </Text>
            </Box>

            {/* Checkbox for multi */}
            {multi && (
              <Box width={2}>
                <Text color={item.selected ? color.selected : color.dim}>
                  {item.selected ? symbol.checkboxOn : symbol.checkboxOff}
                </Text>
              </Box>
            )}

            <Box flexDirection="column">
              {/* Label + Badge */}
              <Box gap={1}>
                <Text color={focused ? color.text : color.secondary} bold={focused}>
                  {item.label}
                </Text>

                {item.badge ? (
                  <Text color={badgeColorMap[item.badgeVariant ?? "muted"] ?? color.muted}>
                    {symbol.dot} {item.badge}
                  </Text>
                ) : null}
              </Box>

              {/* Detail on its own line */}
              {item.detail ? (
                <Text color={focused ? color.secondary : color.muted} wrap="wrap">
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
