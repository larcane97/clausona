import { expect, it } from "vitest";

import type { Table } from "./screen-model.js";

/**
 * What the screen's other tests cannot see: which colour the bar, the scope list's marker and a
 * tag are painted. chalk is level 0 under a plain `vitest run`; with FORCE_COLOR set before the
 * modules load it is level 3 and the codes are in the frame, so this file sets it and imports
 * the components dynamically - static imports are hoisted above the assignment. As
 * doctor-colour.test.tsx does.
 */
process.env.FORCE_COLOR = "3";

/** The 24-bit foreground sequence chalk emits for a hex from the theme. */
function ansiFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
}

/**
 * Whether `text` is painted `hex`: the last colour set before it is that one, and not reset
 * since. ink runs a colour on over neighbours that share it - " · Hooks" is one muted run.
 */
function painted(frame: string, hex: string, text: string): boolean {
  const at = frame.indexOf(text);
  if (at < 0) return false;
  const before = frame.slice(0, at);
  const set = before.lastIndexOf("\u001b[38;2;");
  return set >= 0 && before.startsWith(ansiFor(hex), set) && !before.slice(set).includes("\u001b[39m");
}

it("lights the current tool and kind: the tool in brackets, the kind in the accent colour", async () => {
  const { render } = await import("ink-testing-library");
  const { ToolKindBar } = await import("./ToolKindBar.js");
  const { color } = await import("../theme.js");
  const frame = render(<ToolKindBar tool="claude" kind="mcp" query="" typing={false} width={60} />).lastFrame() ?? "";
  expect(painted(frame, color.text, "[Claude]")).toBe(true);
  expect(painted(frame, color.muted, "Codex")).toBe(true);
  expect(painted(frame, color.accent, "MCP")).toBe(true);
  expect(painted(frame, color.muted, "Skills")).toBe(true);
  expect(painted(frame, color.muted, "Hooks")).toBe(true);
});

it("marks the selected line, the project row or a scope, in the accent colour while the list has the focus, muted when not", async () => {
  const { render } = await import("ink-testing-library");
  const { ScopeList } = await import("./ScopeList.js");
  const { color } = await import("../theme.js");
  const scopes = [
    { id: "loaded" as const, label: "Loaded", count: 3 },
    { id: "project" as const, label: "Project", count: 1 },
  ];
  const project = { key: "app", path: "app", name: "app", here: true, current: true, count: 1 };
  const draw = (focused: boolean, selected: "loaded" | "project" = "project") =>
    render(
      <ScopeList
        project={project}
        scopes={scopes}
        selected={selected}
        focused={focused}
        width={20}
        height={6}
        top={0}
      />,
    ).lastFrame() ?? "";
  expect(painted(draw(true), color.accent, "▸")).toBe(true);
  expect(painted(draw(false), color.muted, "▸")).toBe(true);
  // On the row, the marker is before the project's name: the row is Loaded.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the colour codes are taken out to read the text.
  expect(draw(true, "loaded").replace(/\u001b\[[0-9;]*m/g, "")).toMatch(/▸ app \(here\) +3/);
  expect(painted(draw(true, "loaded"), color.accent, "▸")).toBe(true);
  // The selected line's name is the text's colour, another's the secondary; (here) and the counts muted.
  expect(painted(draw(true, "loaded"), color.text, "app")).toBe(true);
  expect(painted(draw(true), color.secondary, "app")).toBe(true);
  expect(painted(draw(true), color.text, "Project")).toBe(true);
  expect(painted(draw(true), color.muted, "(here)")).toBe(true);
});

it("colours a tag by its tone: unused amber, a broken link red", async () => {
  const { render } = await import("ink-testing-library");
  const { ItemTable } = await import("./ItemTable.js");
  const { color } = await import("../theme.js");
  const table: Table = {
    header: "GLOBAL — loads in every project",
    count: 2,
    countText: "2",
    columns: [{ key: "name", title: "NAME", width: 8 }],
    rows: [
      {
        key: "a",
        cells: ["old     "],
        tag: { text: "unused", tone: "warning" },
        row: { key: "a", name: "old", items: [] },
      },
      {
        key: "b",
        cells: ["gone    "],
        tag: { text: "broken link", tone: "error" },
        row: { key: "b", name: "gone", items: [] },
      },
    ],
    empty: "",
  };
  const frame =
    render(<ItemTable table={table} width={40} height={6} cursor={0} top={0} focused={true} />).lastFrame() ?? "";
  expect(painted(frame, color.warning, "unused")).toBe(true);
  expect(painted(frame, color.error, "broken link")).toBe(true);
});

it("sets a place's heading apart in Loaded: its name bold in the text's colour, its count muted, a dim rule", async () => {
  const { render } = await import("ink-testing-library");
  const { ItemTable } = await import("./ItemTable.js");
  const { color } = await import("../theme.js");
  const row = (key: string, group: string) => ({
    key,
    cells: [`${key.padEnd(8)}`],
    row: { key, name: key, items: [] },
    group,
  });
  const table: Table = {
    header: "LOADED — what Claude Code loads in ~/app",
    count: 2,
    countText: "2",
    columns: [{ key: "name", title: "NAME", width: 8 }],
    rows: [row("mine", "Project"), row("theirs", "Global")],
    empty: "",
  };
  const frame =
    render(<ItemTable table={table} width={40} height={8} cursor={0} top={0} focused={true} />).lastFrame() ?? "";
  expect(painted(frame, color.text, "Project")).toBe(true);
  // Bold, then the colour, then the name.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the codes are what is checked.
  expect(frame).toMatch(/\u001b\[1m(\u001b\[[0-9;]*m)*Project/);
  expect(painted(frame, color.muted, " 1 ")).toBe(true);
  expect(painted(frame, color.dim, "───")).toBe(true);
  // The heading starts where the cursor does; the rows after the cursor's column.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the colour codes are taken out to read the text.
  const text = frame.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  expect(text.find((line) => line.includes("Project"))).toMatch(/^Project 1 ─+$/);
  expect(text.find((line) => line.includes("theirs"))).toMatch(/^ {2}theirs/);
});
