import type { Key } from "ink";
import { useRef, useState } from "react";

import {
  type Action,
  COMMAND_OF,
  type Reach,
  type Refusal,
  type RefusalCode,
  refusalText,
  toggleVerb,
} from "../../extensions/actions.js";
import type { ScreenWrites } from "../../extensions/load.js";
import type { Inventory } from "../../extensions/model.js";
import { type IgnoreFacts, type KeyName, keysFor, plan as planOf } from "../../extensions/plan.js";
import { isWithin } from "../../extensions/read.js";
import type { ScopeRow } from "../../extensions/scopes.js";
import {
  appliedStatus,
  type Dialog,
  type DialogView,
  dialogView,
  NOTHING_TO_UNDO,
  scrollDialog,
  undoneStatus,
} from "./confirm-model.js";
import type { Kind, TableRow } from "./screen-model.js";
import { type CellTarget, matrixRefusal } from "./view-model.js";

/**
 * The Extensions screen's write flow: the rows marked with x, the action keys and the plan each
 * asks for, the confirm dialog and its keys - the account picker's among them - the apply, undo,
 * and the status line each leaves. The screen hands it what it shows, and draws the dialog it
 * gives back in the panes' place.
 */

/** What the screen shows, as of this render: what the write flow reads. */
export type WritesFrom = {
  /** What the action keys write with. Left out, they say changes are not available here. */
  writes: ScreenWrites | undefined;
  /** The files as last read; null while they are read again. */
  inventory: Inventory | null;
  kind: Kind;
  /** The project everything is seen from. */
  project: string | undefined;
  /** When the files were read, the plans' clock. */
  loadedAt: number;
  /** The table's rows, as a search leaves them: the marks that count are among them. */
  rows: readonly TableRow[];
  /** The row under the cursor, where there is one. */
  selected: TableRow | undefined;
  /** The pane the keys move: the scope list, the table or a row's details. */
  focus: "scopes" | "table" | "details";
  /** Reads the files again, with `after` on the status line instead of how long it took. */
  reload: (after: string) => void;
  setStatus: (status: string) => void;
  /** The dialog's room: the width inside the frame, and the panes' height. */
  width: number;
  height: number;
};

/** What the write flow gives the screen. */
export type Writes = {
  /** The keys of the rows marked with x, which the next action changes. */
  marked: ReadonlySet<string>;
  /** The rows shown that are marked. */
  markedRows: ScopeRow[];
  clearMarks(): void;
  /** Whether a plan or the newest change is being read: keys wait for it. */
  waiting(): boolean;
  /** The confirm dialog's lines and key hints while it is open, else null. */
  dialog: DialogView | null;
  /** A key while the dialog is open, which takes every key; false when none is open. */
  dialogKey(input: string, key: Key): boolean;
  /** space g d v u x outside the dialog; false for any other key, which is the screen's. */
  actionKey(input: string, key: Key): boolean;
  /**
   * space and u in the account × server matrix: `cell`, the one under the cursor, off or on
   * here, or the newest change undone. False for any other key.
   */
  matrixKey(input: string, key: Key, cell: CellTarget | undefined): boolean;
};

type PlanDialog = Extract<Dialog, { type: "plan" }>;

/** The action keys, by what they type. */
const ACTION_KEYS: Record<string, KeyName> = { " ": "space", g: "g", d: "d", v: "v" };
const REACH: Record<Exclude<KeyName, "d" | "v">, Reach> = { space: "here", g: "everywhere" };

const NOT_AVAILABLE = "Changes are not available here.";
const TABLE_FIRST = "Open the table first: →";
const VISIBILITY_WHERE = "v changes a Claude skill's visibility, in its details.";
const NOTHING_CHANGED = "Nothing changed.";
const PICK_ONE = "Pick at least one account.";

/**
 * Why a cell can't change here that everywhere answers: an account's server clausona keeps aside,
 * off in every project, comes back only into its file; and in the home folder Codex's project
 * config is the user's own.
 */
const EVERYWHERE_ONLY: ReadonlySet<RefusalCode> = new Set(["stashed-here", "codex-home-here"]);

/**
 * The write flow, for the screen's current render. Its handlers are made again on every render,
 * as the screen's are, so the one ink calls reads what that render shows; what a key must see of
 * a key before it, the dialog and the marks, goes through state updaters or a ref.
 */
export function useWrites(from: WritesFrom): Writes {
  const { writes, inventory, kind, project, loadedAt, rows, selected, focus, reload, setStatus } = from;
  /** The keys of the rows marked with x, which the next action changes. */
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  /** The confirm dialog, in the panes' place while it is open. */
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** A plan or the newest change being read: keys wait for it. */
  const pending = useRef(false);

  const markedRows = rows.filter((row) => marked.has(row.key)).map((row) => row.row);
  const command = COMMAND_OF[kind];
  const dialogOpts = writes
    ? {
        width: from.width,
        height: from.height,
        homeDir: writes.homeDir,
        backupRoot: writes.backupRoot,
        stashDir: writes.stashDir,
      }
    : undefined;
  const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /**
   * The plan's context as the screen sees it: the project picked, the files as last read, and
   * what planChecked found of git, so a plan made again keeps what it showed.
   */
  const contextFor = (inv: Inventory, w: ScreenWrites, tracked: ReadonlySet<string>, ignore?: IgnoreFacts) => ({
    inv,
    project,
    now: loadedAt,
    tracked,
    stashDir: w.stashDir,
    ...(ignore !== undefined ? { ignore } : {}),
  });

  /**
   * The plan for `action`, checked against what git tracks, then: a delete of what git tracks
   * asks with off on offer (rule A); nothing it can change says why on the status line, in
   * `words`; else the dialog asks.
   */
  const openPlan = async (action: Action, words = (r: Refusal) => refusalText(r, "keys")) => {
    if (!writes || !inventory) return;
    pending.current = true;
    try {
      const checked = await writes.planChecked({ inv: inventory, project, now: loadedAt }, command, action);
      const { plan, tracked, ignore } = checked;
      // The picker draws each account's line from the plan with every account chosen: a cell's
      // plan has its own account alone.
      const { accounts, ...every } = action;
      const full =
        accounts === undefined ? plan : planOf(contextFor(inventory, writes, tracked, ignore), command, every);
      const fresh = {
        type: "plan",
        action,
        command,
        tracked,
        ...(ignore !== undefined ? { ignore } : {}),
        plan,
        full,
        cursor: 0,
        top: 0,
        busy: false,
      } as const;
      const refused = plan.refused;
      if (action.verb === "rm" && refused.length > 0 && refused.every((r) => r.code === "tracked")) {
        setDialog({ ...fresh, offerOff: true });
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
      else if (action.rows.length === 1) setStatus(words(first));
      else setStatus(`${new Set(refused.map((r) => r.rowKey)).size} can't: ${words(first)}`);
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

  /**
   * space on a matrix cell: its row off or on here, as space on the row, for the cell's account
   * alone - the account picker's choice, preset. Where only everywhere can change it
   * (EVERYWHERE_ONLY), everywhere, as g on the row would, for that account alone: the matrix has no
   * g. A cell that can't change says why, as a row does, sending to the row for a key the matrix
   * does not take.
   */
  const startCell = (row: ScopeRow, accounts: readonly string[] | undefined) => {
    if (!writes || !inventory) return;
    const ctx = contextFor(inventory, writes, new Set());
    const toggle = (reach: Reach): Action => ({
      verb: toggleVerb(inventory, row, project, reach, accounts),
      reach,
      rows: [row],
      ...(accounts !== undefined ? { accounts } : {}),
    });
    let action = toggle("here");
    let first = planOf(ctx, command, action);
    if (first.changes.length === 0 && first.refused.some((r) => EVERYWHERE_ONLY.has(r.code))) {
      action = toggle("everywhere");
      first = planOf(ctx, command, action);
    }
    const [refused] = first.refused;
    if (first.changes.length === 0 && refused) {
      setStatus(matrixRefusal(refused));
      return;
    }
    void openPlan({ ...action, tracked: true }, matrixRefusal);
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

  /**
   * y: the plan applied - deleted anyway, with off on offer - or the change undone. Keys wait
   * meanwhile, so a second y, however the terminal delivers it, never applies or undoes twice.
   */
  const confirm = async (open: Dialog) => {
    if (!writes || !inventory) return;
    if (open.type === "plan") {
      const accounts = open.plan.accounts ?? [];
      if (accounts.length > 1 && !accounts.some((a) => a.chosen)) {
        setStatus(PICK_ONE);
        return;
      }
    }
    pending.current = true;
    setDialog({ ...open, busy: true });
    let after: string;
    try {
      if (open.type === "undo") after = undoneStatus(await writes.undo(), writes.stashDir);
      else {
        const chosen = open.offerOff
          ? planOf(contextFor(inventory, writes, open.tracked, open.ignore), open.command, {
              ...open.action,
              tracked: true,
            })
          : open.plan;
        after = appliedStatus(await writes.apply(chosen), chosen, writes.homeDir, writes.stashDir);
      }
    } catch (e) {
      after = `${open.type === "undo" ? "Could not undo it" : "Could not apply it"}: ${failed(e)}`;
    } finally {
      pending.current = false;
    }
    finish(after);
  };

  /**
   * The dialog's keys: y, n or esc, a page of lines, o for off instead, and the account picker's.
   * A letter or space with ctrl or meta is none of them.
   */
  const dialogKeys = (open: Dialog, input: string, key: Key) => {
    if (open.busy || !writes || !inventory || !dialogOpts) return;
    const typed = key.ctrl || key.meta ? "" : input;
    if (key.escape || typed === "n") {
      setDialog(null);
      setStatus(NOTHING_CHANGED);
    } else if (typed === "y") void confirm(open);
    else if (key.pageUp || key.pageDown) setDialog(scrollDialog(open, key.pageDown ? 1 : -1, dialogOpts));
    else if (open.type === "plan") pickerKeys(open, typed, key, writes, inventory);
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
      const again = planOf(contextFor(inv, w, open.tracked, open.ignore), open.command, action);
      setDialog({ ...open, action, plan: again });
    }
  };

  const toggleMark = (rowKeyToMark: string) =>
    setMarked((was) => {
      const next = new Set(was);
      if (!next.delete(rowKeyToMark)) next.add(rowKeyToMark);
      return next;
    });

  /** space g d v u x outside the dialog. */
  const actionKeyFor = (input: string) => {
    const left = focus === "scopes";
    if (!writes) {
      setStatus(NOT_AVAILABLE);
      return;
    }
    if (input === "x") {
      if (left) setStatus(TABLE_FIRST);
      else if (focus === "table" && selected) toggleMark(selected.key);
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
      if (focus === "details" && selected && claudeSkill) startAction("v", [selected.row]);
      else setStatus(VISIBILITY_WHERE);
      return;
    }
    if (left) setStatus(TABLE_FIRST);
    else if (selected) startAction(keyName, focus === "table" && markedRows.length > 0 ? markedRows : [selected.row]);
  };

  return {
    marked,
    markedRows,
    clearMarks: () => setMarked(new Set()),
    waiting: () => pending.current,
    dialog: dialog && dialogOpts ? dialogView(dialog, dialogOpts) : null,
    dialogKey(input, key) {
      if (!dialog) return false;
      dialogKeys(dialog, input, key);
      return true;
    },
    actionKey(input, key) {
      if (key.ctrl || key.meta || !(Object.hasOwn(ACTION_KEYS, input) || input === "u" || input === "x")) return false;
      actionKeyFor(input);
      return true;
    },
    matrixKey(input, key, cell) {
      if (key.ctrl || key.meta || (input !== " " && input !== "u")) return false;
      if (!writes) setStatus(NOT_AVAILABLE);
      else if (input === "u") void startUndo();
      else if (cell && "refused" in cell) setStatus(cell.refused);
      else if (cell) startCell(cell.row, cell.accounts);
      return true;
    },
  };
}
