import { Box, Text } from "ink";

import type { ScopeEntry, ScopeId } from "../../extensions/scopes.js";
import { color } from "../theme.js";
import { listRoom, PROJECT_ROWS, type ProjectEntry, projectLabel, scopeLines } from "./screen-model.js";
import { cell } from "./view-model.js";

/** The marker before a label, the project row's, and the two columns kept before the divider. */
const MARKER = "▸";
const ROW_MARKER = "▾";
const EDGES = 4;

type Props = {
  /** The project everything is seen from, or No project: the row on top. */
  project: ProjectEntry;
  /** Whether the project row has the focus: its marker is lit then. */
  projectFocused: boolean;
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
 * folder's own - and a rule, then one line per scope, its label on the left and its count on the
 * right, the selected one marked. A rule sets Loaded apart from the places, and the places from
 * Not used in 90 days. Scopes that do not fit end in a line that says how many more are below.
 */
export function ScopeList({ project, projectFocused, scopes, selected, focused, width, height, top }: Props) {
  const lines = scopeLines(scopes);
  const room = listRoom(Math.max(0, height - PROJECT_ROWS), lines.length);
  const visible = lines.slice(top, top + room);
  const below = lines.slice(top + room).filter((line) => line.type === "scope").length;
  const inner = Math.max(0, width - EDGES);
  const rule = (key: string) => (
    <Text key={key} color={color.dim} wrap="truncate-end">
      {"  "}
      {"─".repeat(inner)}
    </Text>
  );
  const row = projectLabel(project.name, project.here, inner);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={projectFocused ? color.accent : color.muted}>{ROW_MARKER}</Text>{" "}
        <Text color={color.text} bold={projectFocused}>
          {row.name}
        </Text>
        <Text color={color.muted}>{row.here}</Text>
      </Text>
      {rule("rule-project")}
      {visible.map((line) => {
        if (line.type === "rule") return rule(line.key);
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
