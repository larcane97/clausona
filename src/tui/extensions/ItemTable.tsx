import { Box, Text } from "ink";

import { color, symbol } from "../theme.js";
import { columnText, listRoom, type Table, type TagTone } from "./screen-model.js";
import { cell } from "./view-model.js";

const TONE: Record<TagTone, string> = { muted: color.muted, warning: color.warning, error: color.error };
/** What sets the scope's name apart from its sentence in the header. */
const DASH = " — ";
/** The column titles and the rows start after the cursor's column, as the header does not. */
const INDENT = "  ";

type Props = {
  table: Table;
  /** The pane's width: the cursor's column and the table's. */
  width: number;
  height: number;
  cursor: number;
  /** The first row shown, when the rows do not all fit. */
  top: number;
  /** Whether the table has the focus: only then does the selected row carry the cursor. */
  focused: boolean;
};

/**
 * The right pane: the scope's header line with its count on the right, the column titles, and
 * the rows that fit from `top`, each cut to the width by the model. When rows do not fit, the
 * last line says how many more are below; when there are none, the table's sentence says why,
 * and an empty sentence - the header has said it - is no line at all.
 */
export function ItemTable({ table, width, height, cursor, top, focused }: Props) {
  const count = String(table.count);
  // The header's words cut to what the count leaves, then the count after a space.
  const words = cell(table.header, Math.max(0, width - count.length - 1));
  const dash = words.indexOf(DASH);
  const name = dash < 0 ? words : words.slice(0, dash);
  const sentence = dash < 0 ? "" : words.slice(dash);
  const room = listRoom(Math.max(0, height - 2), table.rows.length);
  const visible = table.rows.slice(top, top + room);
  const below = table.rows.length - top - visible.length;
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color.text} bold>
          {name}
        </Text>
        <Text color={color.muted}>
          {sentence} {count}
        </Text>
      </Text>
      {table.rows.length > 0 ? (
        <Text color={color.muted} wrap="truncate-end">
          {INDENT}
          {table.columns.map((col) => columnText(col.title, col)).join("")}
        </Text>
      ) : table.empty !== "" ? (
        <Text color={color.muted} wrap="truncate-end">
          {INDENT}
          {cell(table.empty, Math.max(0, width - INDENT.length)).trimEnd()}
        </Text>
      ) : null}
      {visible.map((row, i) => {
        const active = focused && top + i === cursor;
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text color={active ? color.cursor : color.dim}>{active ? symbol.cursor : " "} </Text>
            {row.cells.map((text, c) => {
              const col = table.columns[c];
              const lead = c === 0;
              return (
                <Text
                  key={col?.key}
                  color={col?.muted ? color.muted : lead ? color.text : color.secondary}
                  bold={lead && active}
                >
                  {text}
                </Text>
              );
            })}
            {row.tag ? <Text color={TONE[row.tag.tone]}>{row.tag.text}</Text> : null}
          </Text>
        );
      })}
      {below > 0 ? (
        <Text color={color.muted} wrap="truncate-end">
          {INDENT}↓ {below} more
        </Text>
      ) : null}
    </Box>
  );
}
