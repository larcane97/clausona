import { Box, Text } from "ink";

import type { Inventory } from "../../extensions/model.js";
import { color } from "../theme.js";
import { type DetailLine, detailOf, detailWindow, type Row, wrapText } from "./view-model.js";

const TONE: Record<NonNullable<DetailLine["tone"]>, string> = {
  muted: color.muted,
  warning: color.warning,
  error: color.error,
  healthy: color.healthy,
};

type Props = {
  inv: Inventory;
  row: Row | undefined;
  project?: string;
  width: number;
  height: number;
  now: number;
  /** A filter or search holds every group open, so enter does nothing to one. */
  held?: boolean;
  /**
   * The full-screen view's first line, scrolled with ↑↓: what is hidden above and below is
   * counted on a line of its own. Without it, as beside or under the list, the pane keeps to its
   * height and a cut ends in a line that says how many more are below.
   */
  top?: number;
};

/** The column a line's label takes. */
const LABEL_WIDTH = 10;

/** The lines whose text is wrapped, not cut: what a server or a hook runs, read in full. */
const WRAPPED: ReadonlySet<string> = new Set(["Command", "Url"]);

function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** What a group's pane says: how many it holds, and what enter does to it, if anything. */
function groupLine(count: number, open: boolean, held: boolean): string {
  if (held) return `${itemCount(count)} · open while a filter or search is on`;
  return `${itemCount(count)} · enter to ${open ? "close" : "open"}`;
}

/**
 * The lines a pane `width` wide shows for `row`, under its title, one row each: a Command or Url
 * line over as many rows as its text takes inside the pane's border, padding and label column.
 */
export function paneLines(
  inv: Inventory,
  row: Row | undefined,
  project: string | undefined,
  now: number,
  held: boolean,
  width: number,
): DetailLine[] {
  if (row === undefined) return [];
  if (row.type === "group") return [{ text: groupLine(row.count, row.open, held), tone: "muted" }];
  const room = width - 4 - LABEL_WIDTH;
  return detailOf(inv, row, project, now).flatMap((line) =>
    line.label !== undefined && WRAPPED.has(line.label)
      ? wrapText(line.text, room).map((text, i) => ({ ...line, label: i === 0 ? line.label : "", text }))
      : [line],
  );
}

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
export function DetailPane({ inv, row, project, width, height, now, held = false, top }: Props) {
  const lines = paneLines(inv, row, project, now, held, width);
  // The border takes two lines and the title one, and every line is one row: this is what fits,
  // which at the 3-line floor is the title alone. Rows keep their height (a Text shrinks by
  // default), so anything that still overflows is cut at the bottom, not squeezed into the title.
  const room = Math.max(0, height - 3);
  const scroll = top === undefined ? undefined : detailWindow(lines.length, room, top);
  // A cut list ends in a line that says how many more there are. With room for one line only,
  // that line is the first one: the count alone would say nothing about the row.
  const cut = scroll === undefined && lines.length > room && room >= 2;
  const keyed = withIds(scroll ? lines.slice(scroll.start, scroll.end) : lines.slice(0, cut ? room - 1 : room));
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
      {scroll && scroll.above > 0 ? (
        <Box flexShrink={0}>
          <Text color={color.muted}>↑ {scroll.above} more</Text>
        </Box>
      ) : null}
      {keyed.map((line) => (
        <Box key={line.id} flexDirection="row" flexShrink={0}>
          {line.label !== undefined ? (
            <Box width={LABEL_WIDTH} flexShrink={0}>
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
      {cut ? (
        <Box flexShrink={0}>
          <Text color={color.muted}>↓ {lines.length - (room - 1)} more</Text>
        </Box>
      ) : null}
      {scroll && scroll.below > 0 ? (
        <Box flexShrink={0}>
          <Text color={color.muted}>↓ {scroll.below} more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
