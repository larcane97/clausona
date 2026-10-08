import { Box, Text } from "ink";

import type { Project } from "../../extensions/model.js";
import { samePath } from "../../extensions/read.js";
import { color, symbol } from "../theme.js";
import { tilde } from "./view-model.js";

type Props = { projects: Project[]; current?: string; here?: string; cursor: number; height: number; homeDir: string };

/** Row 0 is "No project"; then every known project, the one csn was started in marked. */
export function ProjectPicker({ projects, current, here, cursor, height, homeDir }: Props) {
  const entries = [{ key: "none", label: "No project — user settings only", note: "" }].concat(
    projects.map((p) => {
      const claude = p.profiles.filter((id) => id.startsWith("claude:")).length;
      return {
        key: p.path,
        label: tilde(p.path, homeDir),
        note: [
          samePath(p.path, here) ? "here" : "",
          claude > 0 ? `${claude} Claude acct` : "",
          p.tools.includes("codex") ? "Codex" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  );
  const room = Math.max(1, height - 1);
  const top = Math.max(0, Math.min(cursor - Math.floor(room / 2), entries.length - room));
  return (
    <Box flexDirection="column">
      <Text color={color.muted} wrap="truncate-end">
        Show the inventory as seen from:
      </Text>
      {entries.slice(top, top + room).map((entry, i) => {
        const active = top + i === cursor;
        const chosen = entry.key === "none" ? current === undefined : samePath(entry.key, current);
        return (
          <Text key={entry.key} wrap="truncate-end">
            <Text color={active ? color.cursor : color.dim}>{active ? symbol.cursor : " "} </Text>
            <Text color={active ? color.text : color.secondary} bold={active}>
              {chosen ? `${symbol.checkboxOn} ` : `${symbol.checkboxOff} `}
              {entry.label}
            </Text>
            {entry.note ? <Text color={color.muted}> {entry.note}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}
