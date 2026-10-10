import { Box, Text } from "ink";

import { color, symbol } from "../theme.js";
import { columnText, listRoom, PANE_HEAD_ROWS, type Table, type TagTone, tableLines } from "./screen-model.js";
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
  /** The first line shown - a row or a place's heading - when they do not all fit. */
  top: number;
  /** Whether the table has the focus: only then does the selected row carry the cursor. */
  focused: boolean;
  /** The keys of the rows marked with x: a ◉ where the cursor goes, and a count in the header. */
  marked?: ReadonlySet<string>;
};

/**
 * The right pane: the scope's header line with its count on the right, the column titles, and
 * the lines that fit from `top`, each row cut to the width by the model. In Loaded, a heading
 * before each place's rows names it - bold, its count, and a rule to the edge - and starts where
 * the cursor does, so it stands out from the rows. When lines do not fit, the last says how many
 * more rows are below; when there are none, the table's sentence says why, and an empty sentence -
 * the header has said it - is no line at all. A marked row has a ◉ in the cursor's column; under
 * the cursor, the ✦ and its name in the accent colour.
 */
export function ItemTable({ table, width, height, cursor, top, focused, marked }: Props) {
  const marks = marked === undefined ? 0 : table.rows.filter((row) => marked.has(row.key)).length;
  const count = marks > 0 ? `${table.countText} · ${marks} marked` : table.countText;
  // The header's words cut to what the count leaves, then the count after a space.
  const words = cell(table.header, Math.max(0, width - count.length - 1));
  const dash = words.indexOf(DASH);
  const name = dash < 0 ? words : words.slice(0, dash);
  const sentence = dash < 0 ? "" : words.slice(dash);
  const lines = tableLines(table.rows);
  const room = listRoom(Math.max(0, height - PANE_HEAD_ROWS), lines.length);
  const window = lines.slice(top, top + room);
  // A heading with none of its rows under it is left for the line that says how many more.
  const visible = window.at(-1)?.type === "group" && top + room < lines.length ? window.slice(0, -1) : window;
  const below = lines.slice(top + visible.length).filter((line) => line.type === "row").length;
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
      {visible.map((line) => {
        if (line.type === "group") {
          const count = ` ${line.count} `;
          return (
            <Text key={line.key} wrap="truncate-end">
              <Text color={color.text} bold>
                {line.label}
              </Text>
              <Text color={color.muted}>{count}</Text>
              <Text color={color.dim}>
                {symbol.lineH.repeat(Math.max(0, width - line.label.length - count.length))}
              </Text>
            </Text>
          );
        }
        const { row } = line;
        const active = focused && line.index === cursor;
        const isMarked = marked?.has(row.key) === true;
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text color={active ? color.cursor : isMarked ? color.accent : color.dim}>
              {active ? symbol.cursor : isMarked ? symbol.checkboxOn : " "}{" "}
            </Text>
            {row.cells.map((text, c) => {
              const col = table.columns[c];
              const lead = c === 0;
              const tone = col?.muted ? color.muted : lead ? color.text : color.secondary;
              return (
                <Text key={col?.key} color={lead && active && isMarked ? color.accent : tone} bold={lead && active}>
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
