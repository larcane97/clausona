import { Box, Text } from "ink";

import type { ScopeEntry, ScopeId } from "../../extensions/scopes.js";
import { color } from "../theme.js";
import { listRoom, scopeLines } from "./screen-model.js";
import { cell } from "./view-model.js";

/** The marker before a label, and the two columns kept before the divider. */
const MARKER = "▸";
const EDGES = 4;

type Props = {
  scopes: ScopeEntry[];
  selected: ScopeId;
  /** Whether the list has the focus: its marker is lit then, and muted when the table has it. */
  focused: boolean;
  width: number;
  height: number;
  /** The first line shown, when the list is taller than `height`. */
  top: number;
};

/**
 * The left pane: one line per scope, its label on the left and its count on the right, the
 * selected one marked. A rule sets Loaded here apart from the places, and the places from Not
 * used in 90 days. Lines that do not fit end in a line that says how many more scopes are below.
 */
export function ScopeList({ scopes, selected, focused, width, height, top }: Props) {
  const lines = scopeLines(scopes);
  const room = listRoom(height, lines.length);
  const visible = lines.slice(top, top + room);
  const below = lines.slice(top + room).filter((line) => line.type === "scope").length;
  const inner = Math.max(0, width - EDGES);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
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
