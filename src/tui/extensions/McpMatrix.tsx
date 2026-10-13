import { Box, Text } from "ink";

import { color, symbol } from "../theme.js";
import { COLUMN_GAP, cell, column, type Matrix, type MatrixCell, matrixFit, matrixWidths } from "./view-model.js";

const MARK: Record<MatrixCell, string> = { on: symbol.dot, off: symbol.circle, pending: "?", absent: "·" };
/** Not here is muted, as the legend says it: the border's dim grey all but vanishes on the ground. */
export const MARK_COLOR: Record<MatrixCell, string> = {
  on: color.healthy,
  off: color.muted,
  pending: color.warning,
  absent: color.muted,
};

type Props = {
  matrix: Matrix;
  cursor: number;
  /** The account column the cursor is in, where it moves across cells. */
  column?: number;
  top: number;
  height: number;
  width: number;
  offset: number;
};

/**
 * `text` in brackets where the cursor is, as the tool bar brackets the tool it is on, cut so the
 * brackets keep the column's gap: the cursor stays plain to read without colour.
 */
function bracketed(text: string, width: number): string {
  return column(`[${cell(text, Math.max(1, width - COLUMN_GAP - 2)).trimEnd()}]`, width);
}

/**
 * Servers down, accounts across: which account starts which server in this project. The ✦ is
 * on the cursor's server; with `column`, its account's label and the cell where they meet are
 * in brackets.
 */
export function McpMatrix({ matrix, cursor, column: at, top, height, width, offset }: Props) {
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
  const { nameWidth, colWidth } = matrixWidths(matrix, width);
  const columns = matrix.columns.slice(offset, offset + matrixFit(matrix, width, offset));
  const hidden = matrix.columns.length - offset - columns.length;
  const room = Math.max(1, height - 3);
  const rows = matrix.rows.slice(top, top + room);
  return (
    <Box flexDirection="column">
      <Text color={color.muted} wrap="truncate-end">
        {"  "}
        {column("SERVER", nameWidth)}
        {columns.map((c, i) => (offset + i === at ? bracketed(c.label, colWidth) : column(c.label, colWidth))).join("")}
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
              const here = active && offset + c === at;
              return (
                <Text key={`${row.name}|${account.key}`} color={MARK_COLOR[value]} bold={here}>
                  {here ? bracketed(MARK[value], colWidth) : column(MARK[value], colWidth)}
                </Text>
              );
            })}
          </Text>
        );
      })}
      <Text color={color.muted} wrap="truncate-end">
        {"  "}
        {symbol.dot} on {symbol.circle} off ? pending approval · not here
      </Text>
    </Box>
  );
}
