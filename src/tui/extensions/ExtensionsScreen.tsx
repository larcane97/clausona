import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Inventory } from "../../extensions/model.js";
import { samePath } from "../../extensions/read.js";
import { Chrome } from "../components/Chrome.js";
import { color } from "../theme.js";
import { DetailPane } from "./DetailPane.js";
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
  pickLayout,
  TAB_LABEL,
  TABS,
  type Tab,
  tilde,
} from "./view-model.js";

type View = "list" | "detail" | "matrix" | "picker" | "warnings";
type Props = { load: () => Promise<Inventory>; onExit: () => void; now?: () => number };

/** Keeps `cursor` inside a window `room` rows tall that starts at `top`. */
function scrolled(top: number, cursor: number, room: number): number {
  if (cursor < top) return cursor;
  if (cursor >= top + room) return cursor - room + 1;
  return top;
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
  const [status, setStatus] = useState("");
  const listTop = useRef(0);
  const matrixTop = useRef(0);
  const { columns, rows: terminalRows } = useTerminalSize();

  const reload = useCallback(() => {
    setInventory(null);
    setError(null);
    const started = now();
    load().then(
      (inv) => {
        setInventory(inv);
        setLoadedAt(now());
        setStatus(`Read ${inv.items.length} items in ${((now() - started) / 1000).toFixed(1)}s`);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [load, now]);
  useEffect(() => {
    reload();
  }, [reload]);

  const project = picked === null ? inventory?.currentProject : picked.project;
  const layout = pickLayout(columns, terminalRows);
  const rows = useMemo(
    () =>
      inventory
        ? buildRows(inventory, { tab, filter, query, open, now: loadedAt, ...(project ? { project } : {}) })
        : [],
    [inventory, tab, filter, query, open, loadedAt, project],
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

  const move = (delta: number) =>
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, Math.min(c, rows.length - 1) + delta)));
  const switchTab = (delta: number) => {
    setTab((t) => TABS[(TABS.indexOf(t) + delta + TABS.length) % TABS.length] ?? t);
    setCursor(0);
    setView("list");
  };

  useInput((input, key) => {
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
    if (view === "warnings" || view === "detail") {
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
      if (selected?.type === "group") setOpen((o) => ({ ...o, [selected.key]: !selected.open }));
      else if (selected && key.return && layout.mode === "list") setView("detail");
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

  if (error) {
    return (
      <Chrome
        title="Extensions"
        hints={[
          { keys: "r", action: "retry" },
          { keys: "esc", action: "back" },
        ]}
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

  const subtitle = project ? tilde(project, inventory.homeDir) : "No project";
  const columnsFor = listColumns(tab, layout.listWidth);
  const room = Math.max(1, layout.listHeight - 2);
  listTop.current = scrolled(listTop.current, at, room);
  matrixTop.current = scrolled(matrixTop.current, matrixCursor, Math.max(1, layout.listHeight - 3));
  const hints = typing
    ? [
        { keys: "type", action: "search" },
        { keys: "enter", action: "keep" },
        { keys: "esc", action: "clear" },
      ]
    : view === "picker"
      ? [
          { keys: "↑↓", action: "move" },
          { keys: "enter", action: "choose" },
          { keys: "esc", action: "cancel" },
        ]
      : view === "matrix"
        ? [
            { keys: "↑↓", action: "move" },
            { keys: "←→", action: "scroll" },
            { keys: "m", action: "list" },
            { keys: "esc", action: "back" },
          ]
        : view !== "list"
          ? [{ keys: "esc", action: "back" }]
          : [
              { keys: "↑↓", action: "move" },
              { keys: "tab", action: "section" },
              { keys: "enter", action: layout.mode === "list" ? "open" : "group" },
              { keys: "f", action: "filter" },
              { keys: "/", action: "search" },
              { keys: "p", action: "project" },
              ...(tab === "mcp" ? [{ keys: "m", action: "matrix" }] : []),
              { keys: "r", action: "reload" },
              ...(inventory.warnings.length > 0
                ? [{ keys: "w", action: `${inventory.warnings.length} unreadable` }]
                : []),
              { keys: "esc", action: "back" },
            ];

  return (
    <Chrome title="Extensions" subtitle={subtitle} footer={status || undefined} hints={hints}>
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
          height={layout.listHeight}
          homeDir={inventory.homeDir}
        />
      ) : view === "matrix" && matrix ? (
        <McpMatrix
          matrix={matrix}
          cursor={matrixCursor}
          top={matrixTop.current}
          height={layout.listHeight}
          width={layout.listWidth + (layout.mode === "side" ? layout.detailWidth + 2 : 0)}
          offset={matrixOffset}
        />
      ) : view === "warnings" ? (
        <Box flexDirection="column">
          <Text color={color.muted} wrap="truncate-end">
            These files could not be read; everything else was:
          </Text>
          {inventory.warnings.slice(0, layout.listHeight - 1).map((w) => (
            <Text key={`${w.file}\0${w.message}`} wrap="truncate-end">
              <Text color={color.warning}>{tilde(w.file, inventory.homeDir)}</Text>
              <Text color={color.muted}> {w.message}</Text>
            </Text>
          ))}
        </Box>
      ) : view === "detail" ? (
        <DetailPane
          inv={inventory}
          row={selected}
          {...(project ? { project } : {})}
          width={layout.detailWidth}
          height={layout.detailHeight}
          now={loadedAt}
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
          />
          {layout.mode !== "list" ? (
            <DetailPane
              inv={inventory}
              row={selected}
              {...(project ? { project } : {})}
              width={layout.detailWidth}
              height={layout.detailHeight}
              now={loadedAt}
            />
          ) : null}
        </Box>
      )}
    </Chrome>
  );
}
