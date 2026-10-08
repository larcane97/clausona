import { Box, Text } from "ink";

import { color, symbol } from "../theme.js";
import { COLUMN_GAP, column, type Matrix, type MatrixCell } from "./view-model.js";

const MARK: Record<MatrixCell, string> = { on: symbol.dot, off: symbol.circle, pending: "?", absent: "·" };
/** Not here is muted, as the legend says it: the border's dim grey all but vanishes on the ground. */
export const MARK_COLOR: Record<MatrixCell, string> = {
  on: color.healthy,
  off: color.muted,
  pending: color.warning,
  absent: color.muted,
};
/** Room kept at the header's end for ` ← → 99 more`, so a scrolled matrix says so in full. */
const SCROLL_NOTE = 12;

type Props = { matrix: Matrix; cursor: number; top: number; height: number; width: number; offset: number };

/** Servers down, accounts across: which account starts which server in this project. */
export function McpMatrix({ matrix, cursor, top, height, width, offset }: Props) {
  if (matrix.rows.length === 0) {
    return (
      <Text color={color.muted} wrap="truncate-end">
        {"  "}No MCP servers in this project.
      </Text>
    );
  }
  if (matrix.columns.length === 0) {
    return (
      <Text color={color.muted} wrap="truncate-end">
        {"  "}No account has opened this project yet.
      </Text>
    );
  }
  // Each column's width counts the gap after it, so a name or label that is cut keeps it.
  const nameWidth = Math.min(24, Math.max(8, ...matrix.rows.map((r) => r.name.length), 6)) + COLUMN_GAP;
  const colWidth = Math.max(6, Math.min(12, Math.max(0, ...matrix.columns.map((c) => c.label.length)) + COLUMN_GAP));
  const across = width - 2 - nameWidth;
  const all = Math.floor(across / colWidth);
  const fit =
    offset === 0 && all >= matrix.columns.length ? all : Math.max(1, Math.floor((across - SCROLL_NOTE) / colWidth));
  const columns = matrix.columns.slice(offset, offset + fit);
  const hidden = matrix.columns.length - offset - columns.length;
  const room = Math.max(1, height - 3);
  const rows = matrix.rows.slice(top, top + room);
  return (
    <Box flexDirection="column">
      <Text color={color.muted} wrap="truncate-end">
        {"  "}
        {column("SERVER", nameWidth)}
        {columns.map((c) => column(c.label, colWidth)).join("")}
        {offset > 0 ? " ←" : ""}
        {hidden > 0 ? ` → ${hidden} more` : ""}
      </Text>
      {rows.map((row, i) => {
        const active = top + i === cursor;
        return (
          <Text key={row.name} wrap="truncate-end">
            <Text color={active ? color.cursor : color.dim}>{active ? symbol.cursor : " "} </Text>
            <Text color={active ? color.text : color.secondary} bold={active}>
              {column(row.name, nameWidth)}
            </Text>
            {columns.map((account, c) => {
              const value = row.cells[offset + c] ?? "absent";
              return (
                <Text key={`${row.name}|${account.key}`} color={MARK_COLOR[value]}>
                  {column(MARK[value], colWidth)}
                </Text>
              );
            })}
          </Text>
        );
      })}
      <Text color={color.muted} wrap="truncate-end">
        {"  "}
        {symbol.dot} on {symbol.circle} off ? pending-approval · not here
      </Text>
    </Box>
  );
}
