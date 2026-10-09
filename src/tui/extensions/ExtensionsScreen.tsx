import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { detailsOf } from "../../extensions/describe.js";
import type { Inventory } from "../../extensions/model.js";
import { samePath } from "../../extensions/read.js";
import { type ScopeId, scopesFor } from "../../extensions/scopes.js";
import { Chrome } from "../components/Chrome.js";
import { color } from "../theme.js";
import { DetailsView } from "./DetailsView.js";
import { ItemTable } from "./ItemTable.js";
import { McpMatrix } from "./McpMatrix.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { ScopeList } from "./ScopeList.js";
import {
  buildTable,
  CHROME_COLUMNS,
  CURSOR_COLUMNS,
  DIVIDER_COLUMNS,
  detailRows,
  KINDS,
  type Kind,
  listRoom,
  maxDetailTop,
  paneLayout,
  scopeLines,
  scrolled,
  type Tool,
} from "./screen-model.js";
import { ToolKindBar } from "./ToolKindBar.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { buildMatrix, tilde, took } from "./view-model.js";

type View = "main" | "picker" | "matrix" | "warnings";
/** Which pane the keys move: the scope list, the table, or a row's details in its place. */
type Focus = "scopes" | "table" | "details";
type Props = { load: () => Promise<Inventory>; onExit: () => void; now?: () => number };
type Hint = { keys: string; action: string };

const OTHER_TOOL: Record<Tool, Tool> = { claude: "codex", codex: "claude" };
const TOOL_LABEL: Record<Tool, string> = { claude: "Claude", codex: "Codex" };

/** Hints in the order given, the first the most needed. */
function inOrder(hints: Hint[]): (Hint & { rank: number })[] {
  return hints.map((hint, rank) => ({ ...hint, rank }));
}

/**
 * The hints that fit on one line `width` wide, as KeyHints draws them: `keys action` each, with
 * ` │ ` between two. They are taken by `rank`, lowest first, and shown in their own order, so a
 * narrow terminal drops the least needed ones instead of wrapping onto a line the layout has no
 * room for.
 */
function fitHints(hints: (Hint & { rank: number })[], width: number): Hint[] {
  const kept = new Set<Hint>();
  let used = 0;
  for (const hint of [...hints].sort((a, b) => a.rank - b.rank)) {
    const cost = (kept.size > 0 ? 3 : 0) + hint.keys.length + 1 + hint.action.length;
    if (used + cost > width) continue;
    kept.add(hint);
    used += cost;
  }
  return hints.filter((hint) => kept.has(hint)).map(({ keys, action }) => ({ keys, action }));
}

/**
 * Every skill, MCP server and hook across the user's accounts and projects, read-only: Claude
 * and Codex on tab, Skills, MCP and Hooks on 1 2 3, the scopes on the left and the chosen one's
 * table on the right, a row's details on enter. The App hands every key to this screen while it
 * is open; esc leaves it.
 */
export function ExtensionsScreen({ load, onExit, now = Date.now }: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("claude");
  const [kind, setKind] = useState<Kind>("skill");
  /** The chosen scope. The list's cursor is where it is in the list: one that has gone reads as Loaded here. */
  const [scope, setScope] = useState<ScopeId>("loaded");
  /** The project opened from the Other projects list. */
  const [otherProject, setOtherProject] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<Focus>("scopes");
  const [rowCursor, setRowCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  /** Where `/` was pressed: esc while typing goes back there. */
  const [searchFrom, setSearchFrom] = useState<Focus>("scopes");
  /** null until the user picks: until then the project csn was started in. */
  const [picked, setPicked] = useState<{ project?: string } | null>(null);
  const [view, setView] = useState<View>("main");
  const [pickerCursor, setPickerCursor] = useState(0);
  const [matrixCursor, setMatrixCursor] = useState(0);
  const [matrixOffset, setMatrixOffset] = useState(0);
  /** The details' first row. */
  const [detailTop, setDetailTop] = useState(0);
  /** One line about the last thing done, shown until the next key. */
  const [status, setStatus] = useState("");
  const scopeTop = useRef(0);
  const rowTop = useRef(0);
  const matrixTop = useRef(0);
  /** The Other projects list's cursor when a project was opened from it, to come back to. */
  const listCursor = useRef(0);
  const { columns, rows: terminalRows } = useTerminalSize();

  // The latest props, read when a load starts. A caller that passes a new `load` on every render
  // - an inline lambda - must not start a read on every render: the screen reads on mount and on r.
  const source = useRef({ load, now });
  source.current = { load, now };
  /** Which read is the latest: an older one that settles late is dropped. */
  const request = useRef(0);
  const reload = useCallback(() => {
    const id = ++request.current;
    const { load: read, now: clock } = source.current;
    setInventory(null);
    setError(null);
    const started = clock();
    read().then(
      (inv) => {
        if (id !== request.current) return;
        setInventory(inv);
        setLoadedAt(clock());
        setStatus(`Read ${inv.items.length} items in ${took(clock() - started)}`);
      },
      (e: unknown) => {
        if (id === request.current) setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const project = picked === null ? inventory?.currentProject : picked.project;
  const scopes = useMemo(
    () => (inventory ? scopesFor(inventory, tool, kind, project, loadedAt) : []),
    [inventory, tool, kind, project, loadedAt],
  );
  const scopeAt = Math.max(
    0,
    scopes.findIndex((s) => s.id === scope),
  );
  const current = scopes[scopeAt]?.id ?? "loaded";
  const opened = current === "other" ? otherProject : undefined;
  const layout = paneLayout(columns, terminalRows, scopes);
  const table = useMemo(
    () =>
      inventory
        ? buildTable(
            inventory,
            tool,
            kind,
            current,
            project,
            loadedAt,
            layout.tableWidth - CURSOR_COLUMNS,
            query,
            opened,
          )
        : null,
    [inventory, tool, kind, current, project, loadedAt, layout.tableWidth, query, opened],
  );
  const rows = table?.rows ?? [];
  const at = Math.min(rowCursor, Math.max(0, rows.length - 1));
  const selected = rows[at];
  // Details only for a row of the inventory: a line of the Other projects list opens that project.
  const shown = focus === "details" && selected?.row ? "details" : focus === "details" ? "table" : focus;
  const details = useMemo(() => {
    if (!inventory || shown !== "details" || !selected?.row) return null;
    const [title, ...lines] = detailsOf(inventory, selected.row, project, loadedAt);
    return { title: title?.text ?? "", rows: detailRows(lines, layout.tableWidth) };
  }, [inventory, shown, selected, project, loadedAt, layout.tableWidth]);
  // The details' rows under their title and the blank line after it, and how far they scroll.
  const detailRoom = Math.max(0, layout.height - 2);
  const detailMax = details ? maxDetailTop(details.rows.length, detailRoom) : 0;
  const detailPage = Math.max(1, detailRoom - 2);
  const rowRoom = listRoom(Math.max(0, layout.height - 2), rows.length);
  const matrix = useMemo(() => (inventory && project ? buildMatrix(inventory, project) : null), [inventory, project]);

  /** Another table: the row cursor goes back to the top and a search, which was for the last one, ends. */
  const freshTable = () => {
    setRowCursor(0);
    setQuery("");
    setTyping(false);
    setDetailTop(0);
  };
  const toScope = (id: ScopeId) => {
    setScope(id);
    setOtherProject(undefined);
    freshTable();
  };
  const moveScope = (delta: number) => {
    const next = scopes[Math.max(0, Math.min(scopes.length - 1, scopeAt + delta))];
    if (next && next.id !== current) toScope(next.id);
  };
  const moveRow = (delta: number) => setRowCursor(Math.max(0, Math.min(rows.length - 1, at + delta)));
  const scrollDetail = (delta: number) =>
    setDetailTop((t) => Math.max(0, Math.min(detailMax, Math.min(t, detailMax) + delta)));

  useInput((input, key) => {
    // A status line answers the key before this one; any key moves on from it.
    setStatus("");
    if (!inventory) {
      if (key.escape) onExit();
      else if (error && input === "r") reload();
      return;
    }
    if (typing) {
      if (key.escape) {
        // A search given up: nothing of it stays, and the keys go back to where it began.
        setTyping(false);
        setQuery("");
        setFocus(searchFrom);
      } else if (key.return) setTyping(false);
      else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow)
        setQuery((q) => q + input);
      setRowCursor(0);
      return;
    }
    if (view === "picker") {
      const count = inventory.projects.length + 1;
      if (key.escape) setView("main");
      else if (key.upArrow) setPickerCursor((c) => (c - 1 + count) % count);
      else if (key.downArrow) setPickerCursor((c) => (c + 1) % count);
      else if (key.return) {
        const chosen = pickerCursor === 0 ? undefined : inventory.projects[pickerCursor - 1]?.path;
        setPicked(chosen === undefined ? {} : { project: chosen });
        toScope("loaded");
        setFocus("scopes");
        setView("main");
      }
      return;
    }
    if (view === "matrix") {
      const count = matrix?.rows.length ?? 0;
      if (key.escape || input === "m") setView("main");
      else if (key.upArrow) setMatrixCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setMatrixCursor((c) => Math.min(Math.max(0, count - 1), c + 1));
      else if (key.leftArrow) setMatrixOffset((o) => Math.max(0, o - 1));
      else if (key.rightArrow) setMatrixOffset((o) => Math.min(Math.max(0, (matrix?.columns.length ?? 1) - 1), o + 1));
      return;
    }
    if (view === "warnings") {
      if (key.escape || key.return) setView("main");
      return;
    }

    // Keys that work wherever the focus is.
    const kindKey = KINDS[Number(input) - 1];
    if (key.tab) {
      setTool(OTHER_TOOL[tool]);
      toScope("loaded");
      setFocus("scopes");
      return;
    }
    if (kindKey !== undefined && /^[123]$/.test(input)) {
      setKind(kindKey);
      toScope("loaded");
      if (focus === "details") setFocus("table");
      return;
    }
    if (input === "r") {
      reload();
      return;
    }
    if (input === "w") {
      if (inventory.warnings.length > 0) setView("warnings");
      return;
    }
    if (input === "p") {
      const index = inventory.projects.findIndex((p) => samePath(p.path, project));
      setPickerCursor(index + 1);
      setView("picker");
      return;
    }
    if (input === "m") {
      if (tool !== "claude" || kind !== "mcp") setStatus("The matrix is on Claude's MCP tab.");
      else if (!project) setStatus("Pick a project first: p");
      else {
        setMatrixCursor(0);
        setMatrixOffset(0);
        setView("matrix");
      }
      return;
    }

    if (shown === "details") {
      if (key.escape || key.leftArrow) setFocus("table");
      else if (key.upArrow) scrollDetail(-1);
      else if (key.downArrow) scrollDetail(1);
      else if (key.pageUp) scrollDetail(-detailPage);
      else if (key.pageDown) scrollDetail(detailPage);
      return;
    }
    if (input === "/") {
      setSearchFrom(shown);
      setFocus("table");
      setTyping(true);
      return;
    }
    if (shown === "table") {
      if (key.escape && query !== "") {
        setQuery("");
        setRowCursor(0);
      } else if (key.escape || key.leftArrow) {
        if (opened !== undefined) {
          setOtherProject(undefined);
          freshTable();
          setRowCursor(listCursor.current);
        } else setFocus("scopes");
      } else if (key.upArrow) moveRow(-1);
      else if (key.downArrow) moveRow(1);
      else if (key.pageUp) moveRow(-Math.max(1, rowRoom - 1));
      else if (key.pageDown) moveRow(Math.max(1, rowRoom - 1));
      else if (key.return) {
        if (selected?.project) {
          listCursor.current = at;
          setOtherProject(selected.project.path);
          freshTable();
        } else if (selected?.row) {
          setDetailTop(0);
          setFocus("details");
        }
      }
      return;
    }
    // The scope list.
    if (key.escape) {
      if (query !== "") setQuery("");
      else onExit();
    } else if (key.upArrow) moveScope(-1);
    else if (key.downArrow) moveScope(1);
    else if (key.pageUp) moveScope(-Math.max(1, layout.height - 1));
    else if (key.pageDown) moveScope(Math.max(1, layout.height - 1));
    else if (key.rightArrow || key.return) setFocus("table");
  });

  const innerWidth = Math.max(1, columns - CHROME_COLUMNS);
  if (error) {
    return (
      <Chrome
        title="Extensions"
        hints={fitHints(
          inOrder([
            { keys: "r", action: "retry" },
            { keys: "esc", action: "back" },
          ]),
          innerWidth,
        )}
      >
        <Text color={color.error} wrap="truncate-end">
          Could not read the inventory: {error}
        </Text>
      </Chrome>
    );
  }
  if (!inventory || !table) {
    return (
      <Chrome title="Extensions">
        <Spinner label="Reading skills, MCP servers and hooks..." />
      </Chrome>
    );
  }

  const subtitle = project ? tilde(project, inventory.homeDir) : "No project — pick one with p";
  const lines = scopeLines(scopes);
  const scopeLine = Math.max(
    0,
    lines.findIndex((line) => line.type === "scope" && line.entry.id === current),
  );
  scopeTop.current = scrolled(scopeTop.current, scopeLine, listRoom(layout.height, lines.length), lines.length);
  rowTop.current = scrolled(rowTop.current, at, rowRoom, rows.length);
  const matrixRoom = Math.max(1, layout.height - 3);
  matrixTop.current = scrolled(matrixTop.current, matrixCursor, matrixRoom, matrix?.rows.length ?? 0);
  // The warnings below their heading; when they do not all fit, the last line says how many more.
  const warningRoom = Math.max(1, layout.height - 1);
  const warnings =
    inventory.warnings.length > warningRoom
      ? inventory.warnings.slice(0, Math.max(0, warningRoom - 1))
      : inventory.warnings;

  // w, the one sign that some files could not be read once the status line has gone, comes
  // right after esc in every focus.
  const unreadable =
    inventory.warnings.length > 0 ? [{ keys: "w", action: `${inventory.warnings.length} unreadable` }] : [];
  const hints = typing
    ? inOrder([
        { keys: "type", action: "search" },
        { keys: "enter", action: "keep" },
        { keys: "esc", action: "clear" },
      ])
    : view === "picker"
      ? inOrder([
          { keys: "↑↓", action: "move" },
          { keys: "enter", action: "choose" },
          { keys: "esc", action: "cancel" },
        ])
      : view === "matrix"
        ? inOrder([
            { keys: "↑↓", action: "move" },
            { keys: "←→", action: "scroll" },
            { keys: "m", action: "list" },
            { keys: "esc", action: "back" },
          ])
        : view === "warnings"
          ? inOrder([{ keys: "esc", action: "back" }])
          : shown === "details"
            ? [
                ...(detailMax > 0 ? [{ keys: "↑↓", action: "scroll", rank: 0 }] : []),
                ...unreadable.map((hint) => ({ ...hint, rank: 2 })),
                { keys: "esc", action: "back", rank: 1 },
              ]
            : shown === "table"
              ? // The matrix, the one key on Claude's MCP tab that shows what the table cannot,
                // account by account, comes before search.
                [
                  { keys: "↑↓", action: "move", rank: 0 },
                  { keys: "enter", action: selected?.project ? "open" : "details", rank: 1 },
                  { keys: "←", action: opened !== undefined ? "projects" : "scopes", rank: 6 },
                  { keys: "/", action: "search", rank: 5 },
                  ...(tool === "claude" && kind === "mcp" ? [{ keys: "m", action: "matrix", rank: 4 }] : []),
                  ...unreadable.map((hint) => ({ ...hint, rank: 3 })),
                  { keys: "esc", action: "back", rank: 2 },
                ]
              : // The kinds come before search and the tools: the bar names them, but no key.
                [
                  { keys: "↑↓", action: "move", rank: 0 },
                  { keys: "→", action: "open", rank: 1 },
                  { keys: "tab", action: TOOL_LABEL[OTHER_TOOL[tool]], rank: 6 },
                  { keys: "1 2 3", action: "kind", rank: 4 },
                  { keys: "/", action: "search", rank: 5 },
                  { keys: "p", action: "project", rank: 7 },
                  ...unreadable.map((hint) => ({ ...hint, rank: 3 })),
                  { keys: "esc", action: "back", rank: 2 },
                ];

  const scopeList = (
    <ScopeList
      scopes={scopes}
      selected={current}
      focused={shown === "scopes"}
      width={layout.scopeWidth}
      height={layout.height}
      top={scopeTop.current}
    />
  );
  const right = details ? (
    <DetailsView
      title={details.title}
      rows={details.rows}
      width={layout.tableWidth}
      height={layout.height}
      top={Math.min(detailTop, detailMax)}
    />
  ) : (
    <ItemTable
      table={table}
      width={layout.tableWidth}
      height={layout.height}
      cursor={at}
      top={rowTop.current}
      focused={shown === "table"}
    />
  );
  // One pane: the one the focus is on, at the full width. Two: the scope list, the divider and
  // the table or the details. The panes keep their height, so the footer stays put.
  const panes =
    layout.mode === "one" ? (
      shown === "scopes" ? (
        scopeList
      ) : (
        right
      )
    ) : (
      <>
        {scopeList}
        <Box
          borderStyle="single"
          borderColor={color.dim}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={DIVIDER_COLUMNS - 1}
          flexShrink={0}
        >
          {right}
        </Box>
      </>
    );

  return (
    <Chrome title="Extensions" subtitle={subtitle} footer={status || undefined} hints={fitHints(hints, innerWidth)}>
      <Box marginBottom={1}>
        <ToolKindBar tool={tool} kind={kind} query={query} typing={typing} width={innerWidth} />
      </Box>
      {view === "picker" ? (
        <ProjectPicker
          projects={inventory.projects}
          {...(project ? { current: project } : {})}
          {...(inventory.currentProject ? { here: inventory.currentProject } : {})}
          cursor={pickerCursor}
          height={layout.height}
          homeDir={inventory.homeDir}
        />
      ) : view === "matrix" && matrix ? (
        <McpMatrix
          matrix={matrix}
          cursor={matrixCursor}
          top={matrixTop.current}
          height={layout.height}
          width={innerWidth}
          offset={matrixOffset}
        />
      ) : view === "warnings" ? (
        <Box flexDirection="column">
          <Text color={color.muted} wrap="truncate-end">
            These files could not be read; everything else was:
          </Text>
          {warnings.map((w) => (
            <Text key={`${w.file}\0${w.message}`} wrap="truncate-end">
              <Text color={color.warning}>{tilde(w.file, inventory.homeDir)}</Text>
              <Text color={color.muted}> {w.message}</Text>
            </Text>
          ))}
          {warnings.length < inventory.warnings.length ? (
            <Text color={color.muted} wrap="truncate-end">
              +{inventory.warnings.length - warnings.length} more
            </Text>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="row" height={layout.height} overflow="hidden">
          {panes}
        </Box>
      )}
    </Chrome>
  );
}
