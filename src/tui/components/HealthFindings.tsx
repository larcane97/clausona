import { Box, Text } from "ink";

import type { DoctorIssue } from "../../types.js";
import { color, symbol } from "../theme.js";
import { textLines, useWidth } from "../use-width.js";

/** A finding's arrow and the space after it: what its message does not get of the pane's width. */
const ARROW_COLUMNS = 2;

/**
 * A profile's findings in Health check's pane, each message wrapped under its arrow. `rows`, when
 * the screen knows the terminal's height, is the most lines they may take: the findings that fit,
 * from the first, then a line that says how many more there are and that `clausona doctor` lists
 * them all - the pane has no cursor to scroll them with, and its ↑↓ move between profiles. The
 * command takes no profile, so the line names none.
 */
export function HealthFindings({ issues, rows }: { issues: DoctorIssue[]; rows?: number }) {
  const [pane, width] = useWidth();
  // Until ink has laid the pane out, a message's lines are unknown: none is counted as fitting,
  // rather than one counted short pushing the frame past the terminal. The width is measured a
  // moment later, and the findings drawn.
  const lines = issues.map((issue) =>
    Number.isFinite(width) ? textLines(issue.message, width - ARROW_COLUMNS) : Number.POSITIVE_INFINITY,
  );
  let shown = issues.length;
  if (rows !== undefined) {
    const taken = (count: number) =>
      lines.slice(0, count).reduce((sum, each) => sum + each, 0) + (count < issues.length ? 1 : 0);
    while (shown > 0 && taken(shown) > rows) shown -= 1;
  }
  const left = issues.length - shown;

  return (
    <Box ref={pane} flexDirection="column">
      {issues.slice(0, shown).map((issue) => (
        <Box key={issue.message} gap={1}>
          {/* Fixed, as every icon beside a message here is: shrinkable, it took its share of a
              long message's overflow, rounded to no width, and the message ran into it. */}
          <Box flexShrink={0}>
            <Text color={color.warning}>{symbol.arrow}</Text>
          </Box>
          <Text color={color.secondary}>{issue.message}</Text>
        </Box>
      ))}
      {left > 0 && (
        <Text color={color.muted} wrap="truncate-end">
          {`… ${left} more · clausona doctor`}
        </Text>
      )}
    </Box>
  );
}
