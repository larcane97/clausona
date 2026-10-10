import { Box, Text } from "ink";

import type { DetailLine } from "../../extensions/describe.js";
import { color } from "../theme.js";
import { DETAIL_LABEL_WIDTH, type DetailRow, detailWindow, PANE_HEAD_ROWS } from "./screen-model.js";
import { cell } from "./view-model.js";

const TONE: Record<NonNullable<DetailLine["tone"]>, string> = {
  muted: color.muted,
  warning: color.warning,
  error: color.error,
  healthy: color.healthy,
};

type Props = {
  /** The first of `detailsOf`'s lines: where the row is and its name, "GLOBAL › eli5". */
  title: string;
  /** The rest, wrapped to `width` by `detailRows`. */
  rows: DetailRow[];
  width: number;
  height: number;
  /** The first row shown, scrolled with ↑↓. */
  top: number;
};

/**
 * A row's details in place of the table: the title, a blank line, and the rows from `top`, the
 * labels in a column of their own. What is hidden above and below is counted on a line of its own.
 */
export function DetailsView({ title, rows, width, height, top }: Props) {
  const scroll = detailWindow(rows.length, Math.max(0, height - PANE_HEAD_ROWS), top);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text color={color.text} bold wrap="truncate-end">
        {cell(title, width).trimEnd()}
      </Text>
      <Text> </Text>
      {scroll.above > 0 ? <Text color={color.muted}>↑ {scroll.above} more</Text> : null}
      {rows.slice(scroll.start, scroll.end).map((row) => (
        <Text key={row.id} wrap="truncate-end">
          {row.label !== undefined ? <Text color={color.muted}>{cell(row.label, DETAIL_LABEL_WIDTH)}</Text> : null}
          {/* A blank row, as before the actions line, is a line still: ink draws an empty one as none. */}
          <Text color={row.tone ? TONE[row.tone] : color.secondary}>{row.text === "" ? " " : row.text}</Text>
        </Text>
      ))}
      {scroll.below > 0 ? <Text color={color.muted}>↓ {scroll.below} more</Text> : null}
    </Box>
  );
}
