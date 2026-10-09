import { Text } from "ink";

import { color } from "../theme.js";
import { KIND_LABEL, KINDS, type Kind, type Tool } from "./screen-model.js";

const TOOL_LABEL: Record<Tool, string> = { claude: "Claude", codex: "Codex" };
const TOOLS: readonly Tool[] = ["claude", "codex"];
/** Between the two tools, and between the kinds and a search. */
const GAP = "  ";
const KIND_SEP = " · ";

type Props = { tool: Tool; kind: Kind; query: string; typing: boolean; width: number };

/**
 * The line under the title: `[Claude]  Codex` on the left, `Skills · MCP · Hooks` on the right,
 * and a search at the end. The search is the one part that gives way: it keeps its end, where
 * the typing is, and is left out when there is no room for it at all. One line, `width` wide at
 * most, laid out here rather than by ink, so it never wraps.
 */
export function ToolKindBar({ tool, kind, query, typing, width }: Props) {
  const tools = TOOLS.map((t) => (t === tool ? `[${TOOL_LABEL[t]}]` : TOOL_LABEL[t]));
  const left = tools.join(GAP).length;
  const right = KINDS.map((k) => KIND_LABEL[k]).join(KIND_SEP).length;
  const search = typing || query !== "" ? `/${query}${typing ? "▏" : ""}` : "";
  // At least a gap between the tools and the kinds, and one before the search.
  const room = Math.max(0, width - left - right - GAP.length * 2);
  const shown = search.length <= room ? search : room >= 2 ? `…${search.slice(search.length - room + 1)}` : "";
  const pad = Math.max(GAP.length, width - left - right - (shown ? GAP.length + shown.length : 0));
  return (
    <Text wrap="truncate-end">
      {TOOLS.map((t, i) => (
        <Text key={t}>
          {i > 0 ? GAP : ""}
          <Text color={t === tool ? color.text : color.muted} bold={t === tool}>
            {tools[i]}
          </Text>
        </Text>
      ))}
      {" ".repeat(pad)}
      {KINDS.map((k, i) => (
        <Text key={k}>
          {i > 0 ? <Text color={color.muted}>{KIND_SEP}</Text> : ""}
          <Text color={k === kind ? color.accent : color.muted} bold={k === kind}>
            {KIND_LABEL[k]}
          </Text>
        </Text>
      ))}
      {shown ? (
        <Text color={color.accent}>
          {GAP}
          {shown}
        </Text>
      ) : null}
    </Text>
  );
}
