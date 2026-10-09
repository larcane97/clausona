import { Box, Text } from "ink";

import { color } from "../theme.js";
import { LIST_HEAD_ROWS, listRoom, type ProjectEntry, projectListLines } from "./screen-model.js";

/** The cursor's marker, as the scope list marks its selected scope. */
const MARKER = "▸";

type Props = {
  entries: ProjectEntry[];
  /** The kind's items in a word, on the right of the heading: skills, MCP servers, hooks. */
  noun: string;
  cursor: number;
  width: number;
  height: number;
  /** The first project shown, when they do not all fit under the heading. */
  top: number;
};

/**
 * The project list, in the scope list's place: the heading - PROJECT, and the kind's noun over
 * the counts - then one line per project, its name on the left and the count of its own rows on
 * the right, the cursor's marked. Lines that do not fit end in a line that says how many more are
 * below. The model lays the lines out; this draws them.
 */
export function ProjectList({ entries, noun, cursor, width, height, top }: Props) {
  const list = projectListLines(entries, noun, width);
  const room = listRoom(Math.max(0, height - LIST_HEAD_ROWS), list.lines.length);
  const visible = list.lines.slice(top, top + room);
  const below = list.lines.length - top - visible.length;
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color.text} bold>
          {list.title}
        </Text>
        <Text color={color.muted}>{list.noun}</Text>
      </Text>
      {visible.map((line, i) => {
        const active = top + i === cursor;
        return (
          <Text key={line.key} wrap="truncate-end">
            <Text color={color.accent}>{active ? MARKER : " "}</Text>{" "}
            <Text color={active ? color.text : color.secondary} bold={active}>
              {line.name}
            </Text>
            <Text color={color.muted}>
              {line.here}
              {line.count}
            </Text>
          </Text>
        );
      })}
      {below > 0 ? (
        <Text color={color.muted} wrap="truncate-end">
          {"  "}↓ {below} more
        </Text>
      ) : null}
    </Box>
  );
}
