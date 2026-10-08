import { Box, Text } from "ink";

import type { Inventory } from "../../extensions/model.js";
import { color } from "../theme.js";
import { type DetailLine, detailOf, type Row } from "./view-model.js";

const TONE: Record<NonNullable<DetailLine["tone"]>, string> = {
  muted: color.muted,
  warning: color.warning,
  error: color.error,
  healthy: color.healthy,
};

type Props = { inv: Inventory; row: Row | undefined; project?: string; width: number; height: number; now: number };

/**
 * Each line keyed by what it says. Two copies of a server can both read `C on`, so a line that
 * repeats an earlier one is told apart by how many times it has come before.
 */
function withIds(lines: DetailLine[]): (DetailLine & { id: string })[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const content = `${line.label ?? ""}\0${line.text}`;
    const repeat = seen.get(content) ?? 0;
    seen.set(content, repeat + 1);
    return { ...line, id: `${content}\0${repeat}` };
  });
}

/** What the selected row is, where it lives and what it is here, cut to the pane's height. */
export function DetailPane({ inv, row, project, width, height, now }: Props) {
  const lines: DetailLine[] =
    row === undefined
      ? []
      : row.type === "group"
        ? [{ text: `${row.count} item(s) · enter to ${row.open ? "close" : "open"}`, tone: "muted" }]
        : detailOf(inv, row, project, now);
  // The border takes two lines and the title one, and every line is one row: this is what fits,
  // which at the 3-line floor is the title alone. Rows keep their height (a Text shrinks by
  // default), so anything that still overflows is cut at the bottom, not squeezed into the title.
  const keyed = withIds(lines.slice(0, Math.max(0, height - 3)));
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={color.dim}
      paddingX={1}
      flexShrink={0}
      overflow="hidden"
    >
      <Box flexShrink={0}>
        {row === undefined ? (
          <Text color={color.muted} wrap="truncate-end">
            Nothing to show.
          </Text>
        ) : (
          <Text color={color.text} bold wrap="truncate-end">
            {row.type === "group" ? row.label : row.name}
          </Text>
        )}
      </Box>
      {keyed.map((line) => (
        <Box key={line.id} flexDirection="row" flexShrink={0}>
          {line.label !== undefined ? (
            <Box width={10} flexShrink={0}>
              <Text color={color.muted} wrap="truncate-end">
                {line.label}
              </Text>
            </Box>
          ) : null}
          <Box flexGrow={1} flexShrink={1} minWidth={1}>
            <Text color={line.tone ? TONE[line.tone] : color.secondary} wrap="truncate-end">
              {line.text}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
