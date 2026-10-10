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

it("marks the selected scope, and the project row, in the accent colour while it has the focus, muted when not", async () => {
  const { render } = await import("ink-testing-library");
  const { ScopeList } = await import("./ScopeList.js");
  const { color } = await import("../theme.js");
  const scopes = [
    { id: "loaded" as const, label: "Loaded", count: 3 },
    { id: "project" as const, label: "Project", count: 1 },
  ];
  const project = { key: "app", path: "app", name: "app", here: true, current: true, count: 1 };
  const draw = (focused: boolean, projectFocused = false) =>
    render(
      <ScopeList
        project={project}
        projectFocused={projectFocused}
        scopes={scopes}
        selected="project"
        focused={focused}
        width={20}
        height={6}
        top={0}
      />,
    ).lastFrame() ?? "";
  expect(painted(draw(true), color.accent, "▸")).toBe(true);
  expect(painted(draw(false), color.muted, "▸")).toBe(true);
  expect(painted(draw(true), color.muted, "▾")).toBe(true);
  expect(painted(draw(false, true), color.accent, "▾")).toBe(true);
  // The name is the text's colour, its (here) muted.
  expect(painted(draw(true), color.text, "app")).toBe(true);
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

it("marks a row with ◉ in the accent colour, and under the cursor its name too", async () => {
  const { render } = await import("ink-testing-library");
  const { ItemTable } = await import("./ItemTable.js");
  const { color } = await import("../theme.js");
  const line = (key: string, name: string) => ({
    key,
    cells: [name.padEnd(8)],
    row: { key, name, items: [] },
  });
  const table: Table = {
    header: "GLOBAL — loads in every project",
    count: 3,
    countText: "3",
    columns: [{ key: "name", title: "NAME", width: 8 }],
    rows: [line("a", "first"), line("b", "second"), line("c", "third")],
    empty: "",
  };
  const frame =
    render(
      <ItemTable table={table} width={40} height={8} cursor={0} top={0} focused={true} marked={new Set(["a", "b"])} />,
    ).lastFrame() ?? "";
  expect(frame).toContain("3 · 2 marked");
  expect(painted(frame, color.cursor, "✦")).toBe(true);
  expect(painted(frame, color.accent, "first")).toBe(true);
  expect(painted(frame, color.accent, "◉")).toBe(true);
  expect(painted(frame, color.text, "second")).toBe(true);
  expect(painted(frame, color.text, "third")).toBe(true);
});

it("draws the confirm dialog's lines in their tones, the picker's cursor in the cursor colour", async () => {
  const { render } = await import("ink-testing-library");
  const { ConfirmDialog } = await import("./ConfirmDialog.js");
  const { color } = await import("../theme.js");
  const frame =
    render(
      <ConfirmDialog
        width={50}
        lines={[
          { key: "q", text: "Delete deploy-check?", tone: "text", bold: true },
          { key: "w", text: "Git tracks deploy-check in app", tone: "warning" },
          { key: "b", text: "" },
          { key: "a", text: "✦ ◉ default  ~/.claude.json", cursor: true },
          { key: "f", text: "Backup: ~/.clausona/backups/extensions/", tone: "muted" },
        ]}
      />,
    ).lastFrame() ?? "";
  expect(painted(frame, color.text, "Delete deploy-check?")).toBe(true);
  expect(painted(frame, color.warning, "Git tracks")).toBe(true);
  expect(painted(frame, color.cursor, "✦")).toBe(true);
  expect(painted(frame, color.text, " ◉ default")).toBe(true);
  expect(painted(frame, color.muted, "Backup:")).toBe(true);
  expect(frame.split("\n")).toHaveLength(5);
});
