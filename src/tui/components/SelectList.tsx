import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";
import { useWidth } from "../use-width.js";

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

/** The cursor's column and the gap after it; the checkbox's, in a multi-select list. */
const MARK_COLUMN = 3;

/**
 * What a label keeps however long its badge and meta are: enough of a profile name to tell it
 * from the next one. Without a floor the label was the only part of a row allowed to shrink, so
 * a quota reading or a doctor summary beside it squeezed the name to `cl…`, or off the row.
 */
const LABEL_FLOOR = 16;

/** The columns each part of a row gets: the label, then the badge and the meta (0 for none). */
type RowFit = { label: number; badge: number; meta: number };

/**
 * How a row's label, badge and meta share `space` columns when they do not all fit: the label
 * keeps its floor, the badge comes next - `active` is short and says the most - then the meta,
 * and whatever is left goes back to the label. Worked out here rather than left to ink: yoga
 * does not honour a floor on one child of a row while it shrinks the others, and drew such a
 * row at its full width, past the panel's edge.
 */
function fitRow(label: number, badge: number, meta: number, space: number): RowFit {
  const floor = Math.min(label, LABEL_FLOOR, Math.max(0, space));
  let left = space - floor;
  // A part is only drawn with room for itself and the gap before it.
  const share = (want: number) => (want > 0 ? Math.max(0, Math.min(want, left - 1)) : 0);
  const badgeFit = share(badge);
  if (badgeFit > 0) left -= badgeFit + 1;
  const metaFit = share(meta);
  if (metaFit > 0) left -= metaFit + 1;
  return { label: Math.min(label, floor + Math.max(0, left)), badge: badgeFit, meta: metaFit };
}

export function SelectList({
  items,
  index,
  multi = false,
}: {
  items: SelectListItem[];
  index: number;
  multi?: boolean;
}) {
  const [list, width] = useWidth();
  const space = width - MARK_COLUMN - (multi ? MARK_COLUMN : 0);

  return (
    <Box ref={list} flexDirection="column" gap={0}>
      {items.map((item, i) => {
        const focused = i === index;
        const badge = item.badge ? `${symbol.dot} ${item.badge}` : "";
        const meta = item.meta ?? "";
        const whole = item.label.length + (badge ? badge.length + 1 : 0) + (meta ? meta.length + 1 : 0);
        // Only a row that has more than its label, and does not fit, is laid out by hand; a label
        // alone is cut by ink as it always was.
        const fit =
          (badge || meta) && whole > space ? fitRow(item.label.length, badge.length, meta.length, space) : null;

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
                <Box flexShrink={fit ? 0 : 1} width={fit ? fit.label : undefined} minWidth={0} overflow="hidden">
                  <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
                    {item.label}
                  </Text>
                </Box>

                {badge && (!fit || fit.badge > 0) ? (
                  <Box flexShrink={0} width={fit ? fit.badge : undefined} overflow="hidden">
                    <Text color={badgeColorMap[item.badgeVariant ?? "muted"] ?? color.muted} wrap="truncate-end">
                      {badge}
                    </Text>
                  </Box>
                ) : null}

                {meta && (!fit || fit.meta > 0) ? (
                  <Box flexShrink={0} width={fit ? fit.meta : undefined} overflow="hidden">
                    <Text color={badgeColorMap[item.metaVariant ?? "muted"] ?? color.muted} wrap="truncate-end">
                      {meta}
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
