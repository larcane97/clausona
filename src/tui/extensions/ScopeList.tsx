import { Box, Text } from "ink";

import type { ScopeEntry, ScopeId } from "../../extensions/scopes.js";
import { color } from "../theme.js";
import { listRoom, PROJECT_ROWS, type ProjectEntry, projectRow, scopeLines } from "./screen-model.js";
import { cell } from "./view-model.js";

/** The marker before the selected line, and the two columns kept before the divider. */
const MARKER = "▸";
const EDGES = 4;

type Props = {
  /** The project everything is seen from, or No project: the row on top, which is Loaded. */
  project: ProjectEntry;
  scopes: ScopeEntry[];
  selected: ScopeId;
  /** Whether the list has the focus: its marker is lit then, and muted when the table has it. */
  focused: boolean;
  width: number;
  height: number;
  /** The first scope line shown, when the scopes are taller than the room under the row. */
  top: number;
};

/**
 * The left pane: the project row - the project everything is seen from, "(here)" for the
 * folder's own, and the count of what loads there, for the row is Loaded - then one line per
 * scope under it, its label on the left and its count on the right, the selected line marked. A
 * rule sets the places apart from the row, and from Not used in 90 days. Scopes that do not fit
 * end in a line that says how many more are below.
 */
export function ScopeList({ project, scopes, selected, focused, width, height, top }: Props) {
  const lines = scopeLines(scopes);
  const room = listRoom(Math.max(0, height - PROJECT_ROWS), lines.length);
  const visible = lines.slice(top, top + room);
  const below = lines.slice(top + room).filter((line) => line.type === "scope").length;
  const inner = Math.max(0, width - EDGES);
  const row = projectRow(project, scopes.find((s) => s.id === "loaded")?.count ?? 0, width);
  const onRow = selected === "loaded";
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={focused ? color.accent : color.muted}>{onRow ? MARKER : " "}</Text>{" "}
        <Text color={onRow ? color.text : color.secondary} bold={onRow}>
          {row.name}
        </Text>
        <Text color={color.muted}>{row.here}</Text>
        <Text color={color.muted}>{row.count}</Text>
      </Text>
      {visible.map((line) => {
        if (line.type === "rule") {
          return (
            <Text key={line.key} color={color.dim} wrap="truncate-end">
              {"  "}
              {"─".repeat(inner)}
            </Text>
          );
        }
        const { entry } = line;
        const active = entry.id === selected;
        const count = String(entry.count);
        // The label is cut before the count is: a count is short, and says what is there.
        const label = cell(entry.label, Math.max(0, inner - count.length - 1));
        return (
          <Text key={line.key} wrap="truncate-end">
            <Text color={focused ? color.accent : color.muted}>{active ? MARKER : " "}</Text>{" "}
            <Text color={active ? color.text : color.secondary} bold={active}>
              {label}
            </Text>{" "}
            <Text color={color.muted}>{count}</Text>
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
