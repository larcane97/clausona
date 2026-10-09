import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Inventory } from "../../extensions/model.js";
import { samePath } from "../../extensions/read.js";
import { Chrome } from "../components/Chrome.js";
import { color } from "../theme.js";
import { DetailPane, paneLines } from "./DetailPane.js";
import { ItemList } from "./ItemList.js";
import { McpMatrix } from "./McpMatrix.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { useTerminalSize } from "./use-terminal-size.js";
import {
  buildMatrix,
  buildRows,
  countItems,
  FILTER_LABEL,
  FILTERS,
  type Filter,
  listColumns,
  listRoom,
  maxDetailTop,
  nameWidth,
  pickLayout,
  TAB_LABEL,
  TABS,
  type Tab,
  tilde,
  took,
} from "./view-model.js";

type View = "list" | "detail" | "matrix" | "picker" | "warnings";
type Props = { load: () => Promise<Inventory>; onExit: () => void; now?: () => number };
type Hint = { keys: string; action: string };

/**
 * Keeps `cursor` inside a window `room` rows tall that starts at `top`, and the window inside the
 * `total` rows there are: when a group closes or a search narrows the list, the window moves up
 * rather than show blank lines below the last row.
 */
function scrolled(top: number, cursor: number, room: number, total: number): number {
  const kept = cursor < top ? cursor : cursor >= top + room ? cursor - room + 1 : top;
  return Math.max(0, Math.min(kept, total - room));
}

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
 * Every skill, MCP server and hook across the user's accounts and projects, read-only. The
 * App hands every key to this screen while it is open; esc leaves it.
 */
export function ExtensionsScreen({ load, onExit, now = Date.now }: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("skills");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  /** null until the user picks: until then the project csn was started in. */
  const [picked, setPicked] = useState<{ project?: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<View>("list");
  const [pickerCursor, setPickerCursor] = useState(0);
  const [matrixCursor, setMatrixCursor] = useState(0);
  const [matrixOffset, setMatrixOffset] = useState(0);
  /** The full-screen detail's first line. */
  const [detailTop, setDetailTop] = useState(0);
  /** One line about the last thing done, shown until the next key. */
  const [status, setStatus] = useState("");
  const listTop = useRef(0);
  const matrixTop = useRef(0);
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
  // A filter or search opens every group and keeps it open: enter on a group does nothing then.
  const held = query.trim() !== "" || filter !== "all";
  const rows = useMemo(
    () =>
      inventory
        ? buildRows(inventory, { tab, filter, query, open, now: loadedAt, ...(project ? { project } : {}) })
        : [],
    [inventory, tab, filter, query, open, loadedAt, project],
  );
  // The header, and every row or the line that says there are none.
  const listLines = 1 + Math.max(1, rows.length);
  // One row is kept for the status line, which is there only while it has something to say. One
  // more is kept because ink 6 draws a frame as tall as the terminal by clearing the whole screen,
  // and its scrollback, on every redraw (ink.js, the isFullscreen branch of onRender).
  const layout = pickLayout(columns, terminalRows - 2, listLines);
  // The matrix, the picker and the warnings take the list's place and the stacked detail's too.
  const fullHeight = layout.mode === "stacked" ? layout.listHeight + layout.detailHeight : layout.listHeight;
  const need = useMemo(
    () => (inventory ? nameWidth(inventory, tab, project, loadedAt) : 0),
    [inventory, tab, project, loadedAt],
  );
  const counts = useMemo(() => {
    const count: Record<Tab, number> = { skills: 0, mcp: 0, hooks: 0 };
    if (!inventory) return count;
    for (const t of TABS) {
      count[t] = countItems(inventory, {
        tab: t,
        filter,
        query,
        open: {},
        now: loadedAt,
        ...(project ? { project } : {}),
      });
    }
    return count;
  }, [inventory, filter, query, loadedAt, project]);
  const matrix = useMemo(() => (inventory && project ? buildMatrix(inventory, project) : null), [inventory, project]);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const selected = rows[at];
  // The full-screen detail's rows inside its border and under its title, and how far it scrolls.
  const detailRoom = Math.max(0, layout.detailHeight - 3);
  const detailMax =
    inventory && view === "detail"
      ? maxDetailTop(paneLines(inventory, selected, project, loadedAt, held, layout.detailWidth).length, detailRoom)
      : 0;
  const detailPage = Math.max(1, detailRoom - 2);

  const move = (delta: number) =>
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, Math.min(c, rows.length - 1) + delta)));
  const switchTab = (delta: number) => {
    setTab((t) => TABS[(TABS.indexOf(t) + delta + TABS.length) % TABS.length] ?? t);
    setCursor(0);
    setView("list");
  };

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
        setTyping(false);
        setQuery("");
      } else if (key.return) setTyping(false);
      else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow)
        setQuery((q) => q + input);
      setCursor(0);
      return;
    }
    if (view === "picker") {
      const count = inventory.projects.length + 1;
      if (key.escape) setView("list");
      else if (key.upArrow) setPickerCursor((c) => (c - 1 + count) % count);
      else if (key.downArrow) setPickerCursor((c) => (c + 1) % count);
      else if (key.return) {
        const chosen = pickerCursor === 0 ? undefined : inventory.projects[pickerCursor - 1]?.path;
        setPicked(chosen === undefined ? {} : { project: chosen });
        setCursor(0);
        setView("list");
      }
      return;
    }
    if (view === "matrix") {
      const count = matrix?.rows.length ?? 0;
      if (key.escape || input === "m") setView("list");
      else if (key.upArrow) setMatrixCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setMatrixCursor((c) => Math.min(Math.max(0, count - 1), c + 1));
      else if (key.leftArrow) setMatrixOffset((o) => Math.max(0, o - 1));
      else if (key.rightArrow) setMatrixOffset((o) => Math.min(Math.max(0, (matrix?.columns.length ?? 1) - 1), o + 1));
      return;
    }
    if (view === "detail") {
      if (key.escape || key.return) setView("list");
      else if (key.upArrow) setDetailTop((t) => Math.max(0, Math.min(t, detailMax) - 1));
      else if (key.downArrow) setDetailTop((t) => Math.min(detailMax, t + 1));
      else if (key.pageUp) setDetailTop((t) => Math.max(0, Math.min(t, detailMax) - detailPage));
      else if (key.pageDown) setDetailTop((t) => Math.min(detailMax, t + detailPage));
      return;
    }
    if (view === "warnings") {
      if (key.escape || key.return) setView("list");
      return;
    }
    if (key.escape) {
      if (query) setQuery("");
      else onExit();
      return;
    }
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-Math.max(1, layout.listHeight - 2));
    else if (key.pageDown) move(Math.max(1, layout.listHeight - 2));
    else if (key.tab && key.shift) switchTab(-1);
    else if (key.tab || key.rightArrow) switchTab(1);
    else if (key.leftArrow) switchTab(-1);
    else if (key.return || input === " ") {
      if (selected?.type === "group") {
        if (!held) setOpen((o) => ({ ...o, [selected.key]: !selected.open }));
      } else if (selected && key.return && layout.mode === "list") {
        setDetailTop(0);
        setView("detail");
      }
    } else if (input === "f") {
      setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length] ?? "all");
      setCursor(0);
    } else if (input === "/") setTyping(true);
    else if (input === "p") {
      const index = inventory.projects.findIndex((p) => samePath(p.path, project));
      setPickerCursor(index + 1);
      setView("picker");
    } else if (input === "m") {
      if (tab !== "mcp") setStatus("The matrix is on the MCP tab.");
      else if (!project) setStatus("Pick a project first: p");
      else {
        setMatrixCursor(0);
        setMatrixOffset(0);
        setView("matrix");
      }
    } else if (input === "r") reload();
    else if (input === "w" && inventory.warnings.length > 0) setView("warnings");
  });

  // Chrome's padding takes two columns a side.
  const hintWidth = columns - 4;
  if (error) {
    return (
      <Chrome
        title="Extensions"
        hints={fitHints(
          inOrder([
            { keys: "r", action: "retry" },
            { keys: "esc", action: "back" },
          ]),
          hintWidth,
        )}
      >
        <Text color={color.error} wrap="truncate-end">
          Could not read the inventory: {error}
        </Text>
      </Chrome>
    );
  }
  if (!inventory) {
    return (
      <Chrome title="Extensions">
        <Spinner label="Reading skills, MCP servers and hooks..." />
      </Chrome>
    );
  }

  const subtitle = project ? tilde(project, inventory.homeDir) : "No project — pick one with p";
  const columnsFor = listColumns(tab, layout.listWidth, need, project !== undefined);
  const room = listRoom(layout.listHeight, rows.length);
  listTop.current = scrolled(listTop.current, at, room, rows.length);
  const matrixRoom = Math.max(1, fullHeight - 3);
  matrixTop.current = scrolled(matrixTop.current, matrixCursor, matrixRoom, matrix?.rows.length ?? 0);
  // The warnings below their heading; when they do not all fit, the last line says how many more.
  const warningRoom = Math.max(1, fullHeight - 1);
  const warnings =
    inventory.warnings.length > warningRoom
      ? inventory.warnings.slice(0, Math.max(0, warningRoom - 1))
      : inventory.warnings;
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
        : view === "detail" && detailMax > 0
          ? inOrder([
              { keys: "↑↓", action: "scroll" },
              { keys: "esc", action: "back" },
            ])
          : view !== "list"
            ? inOrder([{ keys: "esc", action: "back" }])
            : // The keys nothing else on screen points to come first: enter, when the detail has no
              // pane of its own, and w, the one sign that some files could not be read once the status
              // line has gone. Search comes before the filter: the tab bar shows the filter's label at
              // all times, but nothing there points to search until one is typed. On the MCP tab the
              // matrix, that tab's main view, comes before search: it is the one key there that
              // shows what the list cannot, account by account.
              [
                { keys: "↑↓", action: "move", rank: 0 },
                { keys: "tab", action: "section", rank: 2 },
                layout.mode === "list"
                  ? { keys: "enter", action: "open", rank: 1 }
                  : { keys: "enter", action: "group", rank: 9 },
                { keys: "f", action: "filter", rank: 7 },
                ...(tab === "mcp" ? [{ keys: "m", action: "matrix", rank: 5 }] : []),
                { keys: "/", action: "search", rank: tab === "mcp" ? 6 : 5 },
                { keys: "p", action: "project", rank: 8 },
                { keys: "r", action: "reload", rank: 10 },
                ...(inventory.warnings.length > 0
                  ? [{ keys: "w", action: `${inventory.warnings.length} unreadable`, rank: 4 }]
                  : []),
                { keys: "esc", action: "back", rank: 3 },
              ];

  return (
    <Chrome title="Extensions" subtitle={subtitle} footer={status || undefined} hints={fitHints(hints, hintWidth)}>
      <Box marginBottom={1} gap={2} width="100%">
        {TABS.map((t) => (
          <Box key={t} flexShrink={0}>
            <Text color={t === tab ? color.text : color.muted} bold={t === tab}>
              {t === tab ? `[${TAB_LABEL[t]} ${counts[t]}]` : `${TAB_LABEL[t]} ${counts[t]}`}
            </Text>
          </Box>
        ))}
        <Box flexGrow={1} />
        <Box flexShrink={0}>
          <Text color={color.muted}>
            Filter: <Text color={filter === "all" ? color.muted : color.accent}>{FILTER_LABEL[filter]}</Text>
          </Text>
        </Box>
        {typing || query ? (
          // The one part of the bar that gives way: a long search is cut, the tabs never are.
          <Box flexShrink={1} minWidth={1}>
            <Text color={color.accent} wrap="truncate-end">
              /{query}
              {typing ? "▏" : ""}
            </Text>
          </Box>
        ) : null}
      </Box>
      {view === "picker" ? (
        <ProjectPicker
          projects={inventory.projects}
          {...(project ? { current: project } : {})}
          {...(inventory.currentProject ? { here: inventory.currentProject } : {})}
          cursor={pickerCursor}
          height={fullHeight}
          homeDir={inventory.homeDir}
        />
      ) : view === "matrix" && matrix ? (
        <McpMatrix
          matrix={matrix}
          cursor={matrixCursor}
          top={matrixTop.current}
          height={fullHeight}
          width={layout.listWidth + (layout.mode === "side" ? layout.detailWidth + 2 : 0)}
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
      ) : view === "detail" ? (
        <DetailPane
          inv={inventory}
          row={selected}
          {...(project ? { project } : {})}
          width={layout.detailWidth}
          height={layout.detailHeight}
          now={loadedAt}
          held={held}
          top={Math.min(detailTop, detailMax)}
        />
      ) : (
        <Box flexDirection={layout.mode === "side" ? "row" : "column"} gap={layout.mode === "side" ? 2 : 0}>
          <ItemList
            rows={rows}
            cursor={at}
            top={listTop.current}
            height={layout.listHeight}
            width={layout.listWidth}
            columns={columnsFor}
            tab={tab}
            empty={held ? "Nothing matches." : "Nothing here."}
            fill={layout.mode === "stacked"}
          />
          {layout.mode !== "list" ? (
            <DetailPane
              inv={inventory}
              row={selected}
              {...(project ? { project } : {})}
              width={layout.detailWidth}
              height={layout.detailHeight}
              now={loadedAt}
              held={held}
            />
          ) : null}
        </Box>
      )}
    </Chrome>
  );
}
