import { Box, Text, useInput } from "ink";
import { type ReactElement, useState } from "react";

import { listWindow } from "../fit.js";
import { color } from "../theme.js";

/** `↑ 3 more` or `↓ 12 more`, where the list leaves items out. */
function More({ arrow, count, indent }: { arrow: "↑" | "↓"; count: number; indent: number }) {
  return (
    <Box paddingLeft={indent}>
      <Text color={color.muted} wrap="truncate-end">
        {`${arrow} ${count} more`}
      </Text>
    </Box>
  );
}

/**
 * Whether `count` items of `size` lines each are more than `rows` lines, so that a ScrollList of
 * them scrolls: for the screen, which offers ↑↓ in its hints only then.
 */
export function scrolls(count: number, size: number, rows: number | undefined): boolean {
  return rows !== undefined && count * size > rows;
}

/**
 * A list with no cursor - a table's rows, a summary to read before applying it - in `rows`
 * lines, when the screen knows the terminal's height. When its items, `size` lines each, do not
 * all fit, it shows a window of them, with a line above and below that says how many are left
 * out, and ↑↓ scroll it an item at a time. Without `rows`, or when they fit, it is every item and
 * takes no keys.
 */
export function ScrollList({
  items,
  rows,
  size = 1,
  indent = 0,
}: {
  items: ReactElement[];
  rows?: number;
  size?: number;
  /** The columns before a more line, to start it where the items' text does. */
  indent?: number;
}) {
  const [top, setTop] = useState(0);
  const scrolling = scrolls(items.length, size, rows);
  // The furthest the window goes: where the last item is in it.
  const last = scrolling ? listWindow(items.length, rows ?? 0, items.length - 1, 0, size).start : 0;
  const view = scrolling
    ? listWindow(items.length, rows ?? 0, null, Math.min(top, last), size)
    : { start: 0, end: items.length, above: 0, below: 0 };

  useInput(
    (_input, key) => {
      // From where the window is, which is never past the last: keys pressed faster than the
      // screen redraws each move it one more, rather than all from the same place.
      if (key.upArrow) setTop((at) => Math.max(0, Math.min(at, last) - 1));
      else if (key.downArrow) setTop((at) => Math.min(last, at + 1));
    },
    { isActive: scrolling },
  );

  return (
    <Box flexDirection="column">
      {view.above > 0 && <More arrow="↑" count={view.above} indent={indent} />}
      {items.slice(view.start, view.end)}
      {view.below > 0 && <More arrow="↓" count={view.below} indent={indent} />}
    </Box>
  );
}
