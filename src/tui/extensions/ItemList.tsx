import { Box, Text } from "ink";

import { color, symbol } from "../theme.js";
import {
  COLUMN_GAP,
  type Columns,
  cell,
  type GroupRow,
  type ItemRow,
  listRoom,
  MARK_LABEL,
  type Row,
  type Tab,
} from "./view-model.js";

const GAP = " ".repeat(COLUMN_GAP);

const STATE_COLOR: Record<string, string> = {
  on: color.healthy,
  off: color.muted,
  "name-only": color.info,
  "user-invocable-only": color.info,
  "pending-approval": color.warning,
  shadowed: color.muted,
};

function stateColor(state: string): string {
  return STATE_COLOR[state] ?? color.warning;
}

function header(tab: Tab, columns: Columns): string {
  const parts = [`  ${cell(tab === "hooks" ? "EVENT" : "NAME", columns.name)}`];
  if (columns.tool) parts.push(cell("TOOL", columns.tool));
  if (columns.extra) parts.push(cell(tab === "hooks" ? "COMMAND" : "ACCOUNTS", columns.extra));
  if (columns.used) parts.push(cell("USED", columns.used));
  if (columns.state) parts.push(cell("THIS PROJECT", columns.state));
  return parts.join(GAP);
}

function GroupLine({ row, active }: { row: GroupRow; active: boolean }) {
  return (
    <Text wrap="truncate-end">
      <Text color={active ? color.cursor : color.dim}>{active ? symbol.cursor : " "} </Text>
      <Text color={color.brandLight} bold>
        {row.open ? "▾" : "▸"} {row.label}
      </Text>
      <Text color={color.muted}> ({row.count})</Text>
      {row.state ? <Text color={stateColor(row.state)}> · plugin {row.state}</Text> : null}
    </Text>
  );
}

function ItemLine({ row, active, columns }: { row: ItemRow; active: boolean; columns: Columns }) {
  const tags = row.marks.map((m) => MARK_LABEL[m]).join(" ");
  // The name's part of its column, after the indent. The marks give way first: they are cut, or
  // left out when not even ` …` fits after the name, and the name is cut only when it does not
  // fit on its own. However many marks there are, the columns after them stay where the header
  // has them.
  const room = columns.name - 2;
  const name = cell(row.name, room).trimEnd();
  const left = room - name.length;
  const tagText = tags && name === row.name && left >= 2 ? cell(` ${tags}`, left).trimEnd() : "";
  const pad = Math.max(0, room - name.length - tagText.length);
  const tools = row.tools.map((t) => (t === "claude" ? "C" : "X")).join(" ");
  return (
    <Text wrap="truncate-end">
      <Text color={active ? color.cursor : color.dim}>{active ? symbol.cursor : " "} </Text>
      <Text color={active ? color.text : color.secondary} bold={active}>
        {"  "}
        {name}
      </Text>
      {tagText ? <Text color={row.marks.includes("broken-link") ? color.error : color.warning}>{tagText}</Text> : null}
      <Text>{" ".repeat(pad)}</Text>
      {/* Each column brings the gap before it, as the header joins them: a gap after the last
          one is a column past the list's width, which ink cuts to an ellipsis. */}
      {columns.tool ? (
        <Text color={color.muted}>
          {GAP}
          {cell(tools, columns.tool)}
        </Text>
      ) : null}
      {columns.extra ? (
        <Text color={color.muted}>
          {GAP}
          {cell(row.extra, columns.extra)}
        </Text>
      ) : null}
      {columns.used ? (
        <Text color={color.muted}>
          {GAP}
          {cell(row.used, columns.used)}
        </Text>
      ) : null}
      {columns.state ? (
        <Text color={stateColor(row.state)}>
          {GAP}
          {cell(row.state, columns.state)}
        </Text>
      ) : null}
    </Text>
  );
}

type Props = {
  rows: Row[];
  cursor: number;
  top: number;
  height: number;
  width: number;
  columns: Columns;
  tab: Tab;
  /** What an empty list says: that the tab has nothing, or that nothing matches. */
  empty: string;
  /** Take all `height` lines, however few rows there are: stacked, the detail starts below them. */
  fill?: boolean;
};

/** The list: a column header, the rows that fit from `top`, and how many more are below. */
export function ItemList({ rows, cursor, top, height, width, columns, tab, empty, fill = false }: Props) {
  const room = listRoom(height, rows.length);
  const visible = rows.slice(top, top + room);
  const below = rows.length - top - visible.length;
  return (
    <Box flexDirection="column" width={width} flexShrink={0} {...(fill ? { height } : {})}>
      <Text color={color.muted} wrap="truncate-end">
        {header(tab, columns)}
      </Text>
      {rows.length === 0 ? (
        <Text color={color.muted} wrap="truncate-end">
          {"  "}
          {empty}
        </Text>
      ) : null}
      {visible.map((row, i) =>
        row.type === "group" ? (
          <GroupLine key={row.key} row={row} active={top + i === cursor} />
        ) : (
          <ItemLine key={row.key} row={row} active={top + i === cursor} columns={columns} />
        ),
      )}
      {below > 0 ? (
        <Text color={color.dim} wrap="truncate-end">
          {"  "}↓ {below} more
        </Text>
      ) : null}
    </Box>
  );
}
