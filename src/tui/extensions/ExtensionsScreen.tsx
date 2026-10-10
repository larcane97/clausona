import { Spinner } from "@inkjs/ui";
import { Box, type Key, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Action, COMMAND_OF, type Reach, refusalText, toggleVerb } from "../../extensions/actions.js";
import { type DetailLine, detailsOf, NOUN } from "../../extensions/describe.js";
import type { ScreenWrites } from "../../extensions/load.js";
import type { Inventory } from "../../extensions/model.js";
import { actionsLine, type KeyName, keysFor, plan as planOf } from "../../extensions/plan.js";
import { isWithin } from "../../extensions/read.js";
import { type ScopeId, type ScopeRow, scopesFor } from "../../extensions/scopes.js";
import { Chrome } from "../components/Chrome.js";
import { color } from "../theme.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import {
  appliedStatus,
  type Dialog,
  dialogView,
  NOTHING_TO_UNDO,
  scrollDialog,
  trackedRepo,
  undoneStatus,
} from "./confirm-model.js";
import { DetailsView } from "./DetailsView.js";
import { ItemTable } from "./ItemTable.js";
import { McpMatrix } from "./McpMatrix.js";
import { ProjectList } from "./ProjectList.js";
import { ScopeList } from "./ScopeList.js";
import {
  buildTable,
  CHROME_COLUMNS,
  CURSOR_COLUMNS,
  DIVIDER_COLUMNS,
  detailRows,
  KINDS,
  type Kind,
  LIST_HEAD_ROWS,
  listRoom,
  maxDetailTop,
  NO_PROJECT,
  PANE_HEAD_ROWS,
  PROJECT_ROWS,
  type ProjectEntry,
  paneLayout,
  projectList,
  projectPaneWidth,
  scopeLines,
  scrolled,
  type Tool,
} from "./screen-model.js";
import { ToolKindBar } from "./ToolKindBar.js";
import { useTerminalSize } from "./use-terminal-size.js";
import { buildMatrix, tilde, took } from "./view-model.js";

type View = "main" | "matrix" | "warnings";
/**
 * Which pane the keys move: the project row above the scopes, the scope list, the table, or a
 * row's details in its place.
 */
type Focus = "project" | "scopes" | "table" | "details";
type Props = {
  load: () => Promise<Inventory>;
  onExit: () => void;
  now?: () => number;
  /** What the action keys write with. Left out, they say changes are not available here. */
  writes?: ScreenWrites;
};
type Hint = { keys: string; action: string };
type PlanDialog = Extract<Dialog, { type: "plan" }>;

const OTHER_TOOL: Record<Tool, Tool> = { claude: "codex", codex: "claude" };
const TOOL_LABEL: Record<Tool, string> = { claude: "Claude", codex: "Codex" };
/** The action keys, by what they type. */
const ACTION_KEYS: Record<string, KeyName> = { " ": "space", g: "g", d: "d", v: "v" };
const REACH: Record<Exclude<KeyName, "d" | "v">, Reach> = { space: "here", g: "everywhere" };

const NOT_AVAILABLE = "Changes are not available here.";
const TABLE_FIRST = "Open the table first: →";
const VISIBILITY_WHERE = "v changes a Claude skill's visibility, in its details.";
const NOTHING_CHANGED = "Nothing changed.";
const PICK_ONE = "Pick at least one account.";

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
 * Every skill, MCP server and hook across the user's accounts and projects: Claude and Codex on
 * tab, Skills, MCP and Hooks on 1 2 3, the scopes on the left and the chosen one's table on the
 * right, a row's details on enter. space, g, d and v change the marked rows (x) or the cursor's,
 * u undoes the newest change, each after a confirm dialog in the panes' place. The App hands
 * every key to this screen while it is open; esc leaves it.
 */
export function ExtensionsScreen({ load, onExit, now = Date.now, writes }: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("claude");
  const [kind, setKind] = useState<Kind>("skill");
  /** The chosen scope. The list's cursor is where it is in the list: one that has gone reads as Loaded. */
  const [scope, setScope] = useState<ScopeId>("loaded");
  const [focus, setFocus] = useState<Focus>("scopes");
  const [rowCursor, setRowCursor] = useState(0);
  /**
   * The key of the row the cursor is on, which it follows when a reload moves the row; undefined
   * for a new table, where it starts at the top.
   */
  const [rowKey, setRowKey] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  /** Where `/` was pressed: esc while typing goes back there. */
  const [searchFrom, setSearchFrom] = useState<Focus>("scopes");
  /** null until the user picks: until then the project csn was started in. */
  const [picked, setPicked] = useState<{ project?: string } | null>(null);
  const [view, setView] = useState<View>("main");
  /**
   * Whether the project list is open, in the scope list's place. The focus under it stays as it
   * was, for esc to go back to.
   */
  const [listOpen, setListOpen] = useState(false);
  const [listCursor, setListCursor] = useState(0);
  const [matrixCursor, setMatrixCursor] = useState(0);
  const [matrixOffset, setMatrixOffset] = useState(0);
  /** The details' first row. */
  const [detailTop, setDetailTop] = useState(0);
  /** One line about the last thing done, shown until the next key. */
  const [status, setStatus] = useState("");
  /** The keys of the rows marked with x, which the next action changes. */
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  /** The confirm dialog, in the panes' place while it is open. */
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /**
   * Whether the status was set by a reload after a change: kept over "That item is gone." for
   * the row the change took, until the next key.
   */
  const keepStatus = useRef(false);
  /** A plan or the newest change being read: keys wait for it. */
  const pending = useRef(false);
  const scopeTop = useRef(0);
  const listTop = useRef(0);
  const rowTop = useRef(0);
  const matrixTop = useRef(0);
  /** The selected row's key as last drawn, kept by a reload for the cursor to follow. */
  const selectedKey = useRef<string | undefined>(undefined);
  const { columns, rows: terminalRows } = useTerminalSize();

  // The latest props, read when a load starts. A caller that passes a new `load` on every render
  // - an inline lambda - must not start a read on every render: the screen reads on mount and on r.
  const source = useRef({ load, now });
  source.current = { load, now };
  /** Which read is the latest: an older one that settles late is dropped. */
  const request = useRef(0);
  /** Reads the files again; `after`, the status a change left, stays instead of how long it took. */
  const reload = useCallback((after?: string) => {
    const id = ++request.current;
    const { load: read, now: clock } = source.current;
    setRowKey(selectedKey.current);
    setInventory(null);
    setError(null);
    keepStatus.current = after !== undefined;
    const started = clock();
    read().then(
      (inv) => {
        if (id !== request.current) return;
        setInventory(inv);
        setLoadedAt(clock());
        setStatus(after ?? `Read ${inv.items.length} items in ${took(clock() - started)}`);
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
  const projects = useMemo(
    () => (inventory ? projectList(inventory, tool, kind, project, inventory.currentProject) : []),
    [inventory, tool, kind, project],
  );
  /** The project everything is seen from, as the row names it: No project until the files are read. */
  const seenFrom: ProjectEntry = projects.find((entry) => entry.current) ?? {
    key: "none",
    name: NO_PROJECT,
    here: false,
    current: true,
    count: 0,
  };
  const scopeAt = Math.max(
    0,
    scopes.findIndex((s) => s.id === scope),
  );
  const current = scopes[scopeAt]?.id ?? "loaded";
  const layout = paneLayout(columns, terminalRows, scopes, projectPaneWidth(projects, NOUN[kind]));
  const table = useMemo(
    () =>
      inventory
        ? buildTable(inventory, tool, kind, current, project, loadedAt, layout.tableWidth - CURSOR_COLUMNS, query)
        : null,
    [inventory, tool, kind, current, project, loadedAt, layout.tableWidth, query],
  );
  const rows = table?.rows ?? [];
  const markedRows = rows.filter((row) => marked.has(row.key)).map((row) => row.row);
  const found = rowKey === undefined ? -1 : rows.findIndex((row) => row.key === rowKey);
  const at = found >= 0 ? found : Math.min(rowCursor, Math.max(0, rows.length - 1));
  const selected = rows[at];
  selectedKey.current = selected?.key;
  if (table !== null && rowKey !== undefined && found < 0) {
    // The row the cursor was on has gone, as a reload can take it: the cursor stays where it was,
    // on the row that took its place, and its details close rather than show that row's. Set
    // while drawing, so no frame shows them first.
    setRowKey(selected?.key);
    setRowCursor(at);
    if (focus === "details") setFocus("table");
    // A change that took the row has said so already.
    if (!keepStatus.current && (focus === "table" || focus === "details")) setStatus("That item is gone.");
  }
  // Details only for a row there is: an empty table keeps the focus on itself.
  const shown = focus === "details" && !selected ? "table" : focus;
  const stashDir = writes?.stashDir;
  const details = useMemo(() => {
    if (!inventory || shown !== "details" || !selected) return null;
    const [title, ...lines] = detailsOf(inventory, selected.row, project, loadedAt);
    // The action keys that apply to this row, last, after a blank row.
    const ctx = { inv: inventory, project, now: loadedAt, tracked: new Set<string>() };
    const actions =
      stashDir === undefined ? "" : actionsLine(keysFor({ ...ctx, stashDir }, COMMAND_OF[kind], selected.row));
    const all: DetailLine[] = actions === "" ? lines : [...lines, { text: "" }, { text: actions, tone: "muted" }];
    return { title: title?.text ?? "", rows: detailRows(all, layout.tableWidth) };
  }, [inventory, shown, selected, project, loadedAt, layout.tableWidth, stashDir, kind]);
  // The details' rows under their title and the blank line after it, and how far they scroll.
  const detailRoom = Math.max(0, layout.height - PANE_HEAD_ROWS);
  const detailMax = details ? maxDetailTop(details.rows.length, detailRoom) : 0;
  const detailPage = Math.max(1, detailRoom - 2);
  const rowRoom = listRoom(Math.max(0, layout.height - PANE_HEAD_ROWS), rows.length);
  const projectRoom = listRoom(Math.max(0, layout.height - LIST_HEAD_ROWS), projects.length);
  const matrix = useMemo(() => (inventory && project ? buildMatrix(inventory, project) : null), [inventory, project]);

  /** Another table: the row cursor goes back to the top and a search, which was for the last one, ends. */
  const freshTable = () => {
    pointAt(0);
    setQuery("");
    setTyping(false);
    setDetailTop(0);
    setMarked(new Set());
  };
  const toScope = (id: ScopeId) => {
    setScope(id);
    freshTable();
  };
  const moveScope = (delta: number) => {
    const next = scopes[Math.max(0, Math.min(scopes.length - 1, scopeAt + delta))];
    if (next && next.id !== current) toScope(next.id);
  };
  /** The cursor on row `index` of this table, or at `index` of a table to come when `key` is undefined. */
  function pointAt(index: number, key?: string) {
    setRowCursor(index);
    setRowKey(key);
  }
  const moveRow = (delta: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, at + delta));
    pointAt(next, rows[next]?.key);
  };
  const scrollDetail = (delta: number) =>
    setDetailTop((t) => Math.max(0, Math.min(detailMax, Math.min(t, detailMax) + delta)));
  /** The project list, its cursor on the project everything is seen from. */
  const openList = () => {
    setListCursor(Math.max(0, projects.indexOf(seenFrom)));
    setListOpen(true);
  };
  const moveList = (delta: number) => setListCursor((c) => Math.max(0, Math.min(projects.length - 1, c + delta)));

  // ─── Changes: the action keys, the confirm dialog, undo ───

  const command = COMMAND_OF[kind];
  const innerWidth = Math.max(1, columns - CHROME_COLUMNS);
  const dialogOpts = writes
    ? { width: innerWidth, height: layout.height, homeDir: writes.homeDir, backupRoot: writes.backupRoot }
    : undefined;
  const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** The plan's context as the screen sees it: the project picked, the files as last read. */
  const contextFor = (inv: Inventory, w: ScreenWrites, tracked: ReadonlySet<string>) => ({
    inv,
    project,
    now: loadedAt,
    tracked,
    stashDir: w.stashDir,
  });

  /**
   * The plan for `action`, checked against what git tracks, then: a delete of what git tracks
   * asks with off on offer (rule A); nothing it can change says why on the status line; else the
   * dialog asks.
   */
  const openPlan = async (action: Action) => {
    if (!writes || !inventory) return;
    pending.current = true;
    try {
      const { plan, tracked } = await writes.planChecked({ inv: inventory, project, now: loadedAt }, command, action);
      const fresh = {
        type: "plan",
        action,
        command,
        tracked,
        plan,
        full: plan,
        cursor: 0,
        top: 0,
        busy: false,
      } as const;
      const refused = plan.refused;
      if (action.verb === "rm" && refused.length > 0 && refused.every((r) => r.code === "tracked")) {
        const repo = trackedRepo(
          inventory,
          action.rows.find((row) => row.key === refused[0]?.rowKey),
        );
        setDialog({ ...fresh, offerOff: true, ...(repo !== undefined ? { trackedIn: repo } : {}) });
        return;
      }
      if (plan.changes.length > 0) {
        setDialog({ ...fresh, offerOff: false });
        return;
      }
      setDialog(null);
      const [first] = refused;
      const why = plan.unchanged[0]?.why;
      if (!first) setStatus(why === undefined ? "Nothing to do." : `Nothing to do: ${why}.`);
      else if (action.rows.length === 1) setStatus(refusalText(first, "keys"));
      else setStatus(`${new Set(refused.map((r) => r.rowKey)).size} can't: ${refusalText(first, "keys")}`);
    } catch (e) {
      setDialog(null);
      setStatus(`Could not plan the change: ${failed(e)}`);
    } finally {
      pending.current = false;
    }
  };

  /**
   * space, g, d or v on `targets`. One row's refusal for the key says itself, as its details'
   * actions line leaves the key out; marked rows go to the plan, which lists theirs.
   */
  const startAction = (keyName: KeyName, targets: ScopeRow[]) => {
    const [only] = targets;
    if (!writes || !inventory || !only) return;
    let action: Action;
    if (targets.length === 1) {
      const choice = keysFor(contextFor(inventory, writes, new Set()), command, only).find((c) => c.key === keyName);
      if (!choice) return;
      if ("refused" in choice) {
        setStatus(choice.refused);
        return;
      }
      action = choice.action;
    } else if (keyName === "space" || keyName === "g") {
      const reach = REACH[keyName];
      const allOff = targets.every((row) => toggleVerb(inventory, row, project, reach) === "on");
      action = { verb: allOff ? "on" : "off", reach, rows: targets };
    } else action = { verb: "rm", reach: "here", rows: targets };
    // The dialog is the consent to change what git tracks, but for a delete (rule A).
    void openPlan(action.verb === "rm" ? action : { ...action, tracked: true });
  };

  /** The newest change not undone yet, of any kind (rule F), in a dialog; clausona's own kept copies left out. */
  const startUndo = async () => {
    if (!writes) return;
    pending.current = true;
    try {
      const preview = await writes.lastOperation();
      if (!preview) setStatus(NOTHING_TO_UNDO);
      else {
        const files = preview.files.filter((file) => !isWithin(file.path, writes.stashDir));
        setDialog({ type: "undo", preview: { ...preview, files }, top: 0, busy: false });
      }
    } catch (e) {
      setStatus(`Could not read the last change: ${failed(e)}`);
    } finally {
      pending.current = false;
    }
  };

  /** The dialog answered: closed, the marks gone, the files read again under the status it left. */
  const finish = (after: string) => {
    setDialog(null);
    setMarked(new Set());
    reload(after);
  };

  /** y: the plan applied - deleted anyway, with off on offer - or the change undone. */
  const confirm = async (open: Dialog) => {
    if (!writes || !inventory) return;
    if (open.type === "undo") {
      setDialog({ ...open, busy: true });
      let after: string;
      try {
        after = undoneStatus(await writes.undo(), writes.stashDir);
      } catch (e) {
        after = `Could not undo it: ${failed(e)}`;
      }
      finish(after);
      return;
    }
    const accounts = open.plan.accounts ?? [];
    if (accounts.length > 1 && !accounts.some((a) => a.chosen)) {
      setStatus(PICK_ONE);
      return;
    }
    setDialog({ ...open, busy: true });
    const chosen = open.offerOff
      ? planOf(contextFor(inventory, writes, open.tracked), open.command, { ...open.action, tracked: true })
      : open.plan;
    let after: string;
    try {
      after = appliedStatus(await writes.apply(chosen), chosen, writes.homeDir);
    } catch (e) {
      after = `Could not apply it: ${failed(e)}`;
    }
    finish(after);
  };

  /** The dialog's keys: y, n or esc, a page of lines, o for off instead, and the account picker's. */
  const dialogKeys = (open: Dialog, input: string, key: Key) => {
    if (open.busy || !writes || !inventory || !dialogOpts) return;
    if (key.escape || input === "n") {
      setDialog(null);
      setStatus(NOTHING_CHANGED);
    } else if (input === "y") void confirm(open);
    else if (key.pageUp || key.pageDown) setDialog(scrollDialog(open, key.pageDown ? 1 : -1, dialogOpts));
    else if (open.type === "plan") pickerKeys(open, input, key, writes, inventory);
  };

  const pickerKeys = (open: PlanDialog, input: string, key: Key, w: ScreenWrites, inv: Inventory) => {
    if (input === "o" && open.offerOff) {
      setDialog({ ...open, busy: true });
      void openPlan({ verb: "off", reach: "here", rows: open.action.rows, tracked: true });
      return;
    }
    const accounts = open.plan.accounts ?? [];
    if (accounts.length <= 1) return;
    if (key.upArrow) setDialog({ ...open, cursor: Math.max(0, open.cursor - 1) });
    else if (key.downArrow) setDialog({ ...open, cursor: Math.min(accounts.length - 1, open.cursor + 1) });
    else if (input === " ") {
      // The cursor's account in or out; the plan again, pure, with what git tracks as read.
      const chosen = accounts.flatMap((a, at) => ((at === open.cursor) !== a.chosen ? [a.profile] : []));
      const action = { ...open.action, accounts: chosen };
      setDialog({ ...open, action, plan: planOf(contextFor(inv, w, open.tracked), open.command, action) });
    }
  };

  const toggleMark = (rowKeyToMark: string) =>
    setMarked((was) => {
      const next = new Set(was);
      if (!next.delete(rowKeyToMark)) next.add(rowKeyToMark);
      return next;
    });

  /** space g d v u x outside the dialog. */
  const actionKey = (input: string) => {
    const left = shown === "scopes" || shown === "project";
    if (input === "x") {
      if (left) setStatus(TABLE_FIRST);
      else if (shown === "table" && selected) toggleMark(selected.key);
      return;
    }
    if (!writes) {
      setStatus(NOT_AVAILABLE);
      return;
    }
    if (input === "u") {
      void startUndo();
      return;
    }
    const keyName = ACTION_KEYS[input] as KeyName;
    const item = selected?.row.items[0];
    if (keyName === "v") {
      const claudeSkill = item?.kind === "skill" && item.location.tool === "claude";
      if (shown === "details" && selected && claudeSkill) startAction("v", [selected.row]);
      else setStatus(VISIBILITY_WHERE);
      return;
    }
    if (left) setStatus(TABLE_FIRST);
    else if (selected) startAction(keyName, shown === "table" && markedRows.length > 0 ? markedRows : [selected.row]);
  };

  useInput((input, key) => {
    // A plan or the newest change is being read: what it says comes before the next key.
    if (pending.current) return;
    // A status line answers the key before this one; any key moves on from it.
    setStatus("");
    if (!inventory) {
      if (key.escape) onExit();
      else if (error && input === "r") reload();
      return;
    }
    // Once the files are read again, that is: a change's status stays over the read it starts.
    keepStatus.current = false;
    if (dialog) {
      dialogKeys(dialog, input, key);
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
      pointAt(0);
      return;
    }
    if (listOpen) {
      // esc and ← leave everything as it was; enter sees every scope from the project picked.
      if (key.escape || key.leftArrow) setListOpen(false);
      else if (key.upArrow) moveList(-1);
      else if (key.downArrow) moveList(1);
      else if (key.pageUp) moveList(-Math.max(1, projectRoom - 1));
      else if (key.pageDown) moveList(Math.max(1, projectRoom - 1));
      else if (key.return) {
        const chosen = projects[listCursor]?.path;
        setPicked(chosen === undefined ? {} : { project: chosen });
        toScope("loaded");
        setFocus("scopes");
        setListOpen(false);
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
      setFocus("scopes");
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
      openList();
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
    if (!key.ctrl && !key.meta && (Object.hasOwn(ACTION_KEYS, input) || input === "u" || input === "x")) {
      actionKey(input);
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
      // esc clears the marks first, then a search, then goes back to the scopes.
      if (key.escape && marked.size > 0) setMarked(new Set());
      else if (key.escape && query !== "") {
        setQuery("");
        pointAt(0);
      } else if (key.escape || key.leftArrow) setFocus("scopes");
      else if (key.upArrow) moveRow(-1);
      else if (key.downArrow) moveRow(1);
      else if (key.pageUp) moveRow(-Math.max(1, rowRoom - 1));
      else if (key.pageDown) moveRow(Math.max(1, rowRoom - 1));
      else if (key.return && selected) {
        pointAt(at, selected.key);
        setDetailTop(0);
        setFocus("details");
      }
      return;
    }
    // The left pane: esc leaves the screen from the project row as from the scopes.
    if (key.escape) {
      if (query !== "") setQuery("");
      else onExit();
    } else if (shown === "project") {
      if (key.downArrow) setFocus("scopes");
      else if (key.return || key.rightArrow) openList();
    } else if (key.upArrow) {
      // Up from the first scope is the project row.
      if (scopeAt === 0) setFocus("project");
      else moveScope(-1);
    } else if (key.downArrow) moveScope(1);
    else if (key.pageUp) moveScope(-Math.max(1, layout.height - 1));
    else if (key.pageDown) moveScope(Math.max(1, layout.height - 1));
    else if (key.rightArrow || key.return) setFocus("table");
  });

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
  scopeTop.current = scrolled(
    scopeTop.current,
    scopeLine,
    listRoom(Math.max(0, layout.height - PROJECT_ROWS), lines.length),
    lines.length,
  );
  listTop.current = scrolled(listTop.current, listCursor, projectRoom, projects.length);
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
  const shownDialog = dialog && dialogOpts ? dialogView(dialog, dialogOpts) : null;
  // The action keys, where there is something to write with; those on a row, where there is one.
  const canWrite = writes !== undefined;
  const onRows = canWrite && rows.length > 0;
  const shownItem = selected?.row.items[0];
  const claudeSkill = shownItem?.kind === "skill" && shownItem.location.tool === "claude";
  const paneHints = typing
    ? inOrder([
        { keys: "type", action: "search" },
        { keys: "enter", action: "keep" },
        { keys: "esc", action: "clear" },
      ])
    : listOpen
      ? inOrder([
          { keys: "↑↓", action: "move" },
          { keys: "enter", action: "pick" },
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
                ...(canWrite
                  ? [
                      { keys: "space", action: "on/off", rank: 2 },
                      { keys: "g", action: "everywhere", rank: 6 },
                      { keys: "d", action: "delete", rank: 3 },
                      ...(claudeSkill ? [{ keys: "v", action: "visibility", rank: 5 }] : []),
                      { keys: "u", action: "undo", rank: 4 },
                    ]
                  : []),
                ...unreadable.map((hint) => ({ ...hint, rank: 7 })),
                { keys: "esc", action: "back", rank: 1 },
              ]
            : shown === "table"
              ? // The changes come right after esc; the matrix, the one key on Claude's MCP tab that
                // shows what the table cannot, account by account, before search.
                [
                  { keys: "↑↓", action: "move", rank: 0 },
                  // An empty table has no row to open, nor to change.
                  ...(rows.length > 0 ? [{ keys: "enter", action: "details", rank: 1 }] : []),
                  ...(onRows
                    ? [
                        { keys: "space", action: "on/off", rank: 3 },
                        { keys: "g", action: "everywhere", rank: 10 },
                        { keys: "d", action: "delete", rank: 4 },
                        { keys: "x", action: "mark", rank: 9 },
                      ]
                    : []),
                  ...(canWrite ? [{ keys: "u", action: "undo", rank: 5 }] : []),
                  { keys: "←", action: "scopes", rank: 11 },
                  { keys: "/", action: "search", rank: 8 },
                  ...(tool === "claude" && kind === "mcp" ? [{ keys: "m", action: "matrix", rank: 7 }] : []),
                  { keys: "p", action: "project", rank: 12 },
                  ...unreadable.map((hint) => ({ ...hint, rank: 6 })),
                  { keys: "esc", action: "back", rank: 2 },
                ]
              : // The kinds come before search and the tools: the bar names them, but no key. On
                // the project row, enter opens the project list where → opens a scope's table.
                [
                  { keys: "↑↓", action: "move", rank: 0 },
                  shown === "project"
                    ? { keys: "enter", action: "projects", rank: 1 }
                    : { keys: "→", action: "open", rank: 1 },
                  { keys: "tab", action: TOOL_LABEL[OTHER_TOOL[tool]], rank: 7 },
                  { keys: "1 2 3", action: "kind", rank: 5 },
                  { keys: "/", action: "search", rank: 6 },
                  { keys: "p", action: "project", rank: 8 },
                  ...unreadable.map((hint) => ({ ...hint, rank: 4 })),
                  { keys: "esc", action: "back", rank: 2 },
                  ...(canWrite ? [{ keys: "u", action: "undo", rank: 3 }] : []),
                ];

  const hints = shownDialog ? inOrder(shownDialog.hints) : paneHints;

  // The left pane: the project list while it is open, else the project row and the scopes.
  const left = listOpen ? (
    <ProjectList
      entries={projects}
      noun={NOUN[kind]}
      cursor={listCursor}
      width={layout.scopeWidth}
      height={layout.height}
      top={listTop.current}
    />
  ) : (
    <ScopeList
      project={seenFrom}
      projectFocused={shown === "project"}
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
      focused={!listOpen && shown === "table"}
      marked={marked}
    />
  );
  // One pane: the one the focus is on - the project list while it is open - at the full width.
  // Two: the left pane, the divider and the table or the details. The panes keep their height,
  // so the footer stays put.
  const panes =
    layout.mode === "one" ? (
      listOpen || shown === "scopes" || shown === "project" ? (
        left
      ) : (
        right
      )
    ) : (
      <>
        {left}
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
      {view === "matrix" && matrix ? (
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
      ) : shownDialog ? (
        <Box flexDirection="column" height={layout.height} overflow="hidden">
          <ConfirmDialog lines={shownDialog.lines} width={innerWidth} />
        </Box>
      ) : (
        <Box flexDirection="row" height={layout.height} overflow="hidden">
          {panes}
        </Box>
      )}
    </Chrome>
  );
}
