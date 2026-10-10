import path from "node:path";

import {
  type Action,
  type ExtensionsCommand,
  fileWords,
  KEPT_COPY,
  LEFT_ALONE,
  stopText,
} from "../../extensions/actions.js";
import type { ApplyResult, UndoPreview, UndoResult, UndoSkip } from "../../extensions/apply.js";
import type { Plan, PlanLine } from "../../extensions/plan.js";
import { middleCut, shortProfile, tilde } from "../../extensions/present.js";
import { isWithin } from "../../extensions/read.js";
import { symbol } from "../theme.js";
import { cell } from "./view-model.js";

/**
 * The confirm dialog before a write or an undo, before ink draws it: its lines, each cut to the
 * width, as many as the height holds, and its key hints; and the status line once it is answered.
 * Pure: it reads what it is given and nothing else.
 */

export type Dialog =
  | {
      type: "plan";
      action: Action;
      command: ExtensionsCommand;
      tracked: ReadonlySet<string>;
      plan: Plan;
      /** The plan with every account chosen, for the picker's lines. */
      full: Plan;
      cursor: number;
      top: number;
      busy: boolean;
      /** rm with tracked refusals: o offers off here instead. */
      offerOff: boolean;
    }
  | { type: "undo"; preview: UndoPreview; top: number; busy: boolean };

export type DialogLine = {
  key: string;
  text: string;
  tone?: "text" | "muted" | "warning" | "error";
  bold?: boolean;
  cursor?: boolean;
};

export type DialogView = { lines: DialogLine[]; hints: { keys: string; action: string }[] };

/** `stashDir`: clausona's own kept copies, named in words, never by their path. */
type Opts = { width: number; height: number; homeDir: string; backupRoot: string; stashDir: string };

/** Refusal lines shown before the rest are counted on one line. */
const REFUSALS_SHOWN = 2;
const GAP = "  ";
/** The fewest columns a cut path keeps. */
const PATH_MIN = 12;
const UNDO_NOTE = "Puts back what changed, unless it changed since.";
const UNDO_HINT = "Press u afterwards to put them back.";

/** The columns `rows` take, two spaces apart: each as wide as its widest cell, and only those someone fills. */
function columnsOf(rows: string[][]): { used: number[]; widths: number[]; total: number } {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const used = Array.from({ length: count }, (_, c) => c).filter((c) => rows.some((row) => (row[c] ?? "") !== ""));
  const widths = used.map((c) => Math.max(...rows.map((row) => (row[c] ?? "").length)));
  return { used, widths, total: widths.reduce((sum, w) => sum + w, 0) + GAP.length * Math.max(0, used.length - 1) };
}

/**
 * Lines of cells, two spaces apart, every column but the last as wide as its widest cell, so each
 * starts at the same place on every line, as the CLI's columns do; a column nobody fills is left
 * out. When that is wider than `width`, the `path` column gives way first, down to PATH_MIN - a
 * path cut from its middle, a kept copy's words at their end - then each line is cut at its end.
 */
function aligned(rows: string[][], width: number, path?: number): string[] {
  const { used, widths, total } = columnsOf(rows);
  const at = path === undefined ? -1 : used.indexOf(path);
  const room = widths[at];
  if (room !== undefined && total > width) widths[at] = Math.max(Math.min(PATH_MIN, room), room - (total - width));
  return rows.map((row) => {
    const cells = used.map((c, i) => {
      const text = row[c] ?? "";
      const w = widths[i] ?? 0;
      const fitted =
        i !== at || text.length <= w ? text : text === KEPT_COPY ? cell(text, w).trimEnd() : middleCut(text, w);
      return i === used.length - 1 ? fitted : fitted.padEnd(w);
    });
    return cell(cells.join(GAP), width).trimEnd();
  });
}

/**
 * The change lines: one per plan line - file, what, note - or with several accounts to pick from,
 * one per account. A picker line too wide for its file leaves the file out: the account says whose
 * .claude.json it is, and what changes stays whole for as long as it fits.
 */
function changeLines(dialog: Extract<Dialog, { type: "plan" }>, opts: Opts): DialogLine[] {
  const { plan, full } = dialog;
  const home = (file: string) => fileWords(file, opts.homeDir, opts.stashDir);
  const lines = plan.changes.flatMap((change) => change.lines);
  const plain = (rows: PlanLine[], from: number): DialogLine[] =>
    aligned(
      rows.map((line) => [home(line.file), line.what, line.note ?? ""]),
      opts.width,
      0,
    ).map((text, at) => ({ key: `change-${from + at}`, text }));
  const accounts = plan.accounts ?? [];
  if (accounts.length <= 1) return plain(lines, 0);
  const fullLines = full.changes.flatMap((change) => change.lines);
  const rows = accounts.map((account, at) => {
    const own = fullLines.filter((line) => line.account === account.profile);
    const whats = [...new Set(own.map((line) => line.what))].join(", ");
    const box = account.chosen ? symbol.checkboxOn : symbol.checkboxOff;
    const lead = `${at === dialog.cursor ? symbol.cursor : " "} ${box} ${shortProfile(account.profile)}`;
    return [lead, own[0] ? home(own[0].file) : "", whats];
  });
  const fits = columnsOf(rows).total <= opts.width;
  const picker = aligned(fits ? rows : rows.map(([lead = "", , whats = ""]) => [lead, whats]), opts.width).map(
    (text, at): DialogLine => ({
      key: `account-${accounts[at]?.profile ?? at}`,
      text,
      ...(at === dialog.cursor ? { cursor: true } : {}),
    }),
  );
  // What no account owns - a project's settings file - is the same whichever accounts are picked.
  return [
    ...picker,
    ...plain(
      lines.filter((line) => line.account === undefined),
      picker.length,
    ),
  ];
}

type Parts = {
  head: DialogLine[];
  /** The first refusal line, kept to the last. */
  firstRefusal: DialogLine[];
  /** The other refusal lines, "and n more can't", and the notes: dropped before files are cut. */
  moreRefusals: DialogLine[];
  changes: DialogLine[];
  footer: DialogLine;
  /** "Press u afterwards…": plan only. */
  undoHint?: DialogLine;
  /** The first change line shown. */
  top: number;
  /** The picker's cursor line, kept in sight. */
  cursor?: number;
};

function muted(key: string, text: string, width: number): DialogLine {
  return { key, text: cell(text, width).trimEnd(), tone: "muted" };
}

function partsOf(dialog: Dialog, opts: Opts): Parts {
  const { width } = opts;
  if (dialog.type === "undo") {
    const { summary } = dialog.preview.operation;
    return {
      head: [{ key: "question", text: cell(`Undo: ${summary}?`, width).trimEnd(), tone: "text", bold: true }],
      firstRefusal: [],
      moreRefusals: [],
      changes: aligned(
        dialog.preview.files.map((file) => [tilde(file.path, opts.homeDir), file.action]),
        width,
        0,
      ).map((text, at) => ({ key: `file-${at}`, text })),
      footer: muted("footer", UNDO_NOTE, width),
      top: dialog.top,
    };
  }
  const { plan } = dialog;
  const head: DialogLine[] = [
    { key: "question", text: cell(plan.question, width).trimEnd(), tone: "text", bold: true },
  ];
  const tracked = plan.refused.filter((r) => r.code === "tracked");
  // With off on offer the warning speaks for the rows git tracks; their refusal would say it again.
  const told = dialog.offerOff ? plan.refused.filter((r) => r.code !== "tracked") : plan.refused;
  if (dialog.offerOff && tracked.length > 0) {
    const rows = new Set(tracked.map((r) => r.rowKey));
    const which = rows.size === 1 ? (tracked[0]?.name ?? "it") : `${rows.size} of these`;
    // The project the refusal itself names.
    const project = tracked[0]?.project;
    const where = project !== undefined ? ` in ${project}` : "";
    head.push({
      key: "warning",
      text: cell(`Git tracks ${which}${where}, so deleting changes the repo.`, width).trimEnd(),
      tone: "warning",
    });
  }
  const refusals = told
    .slice(0, REFUSALS_SHOWN)
    .map((r, at) => muted(`refused-${at}`, `${r.name} can't: ${r.reason}`, width));
  const beyond = told.length - REFUSALS_SHOWN;
  if (beyond > 0) refusals.push(muted("refused-more", `and ${beyond} more can't`, width));
  const notes = plan.notes.map((note, at) => muted(`note-${at}`, note, width));
  const picking = (plan.accounts?.length ?? 0) > 1;
  return {
    head,
    firstRefusal: refusals.slice(0, 1),
    moreRefusals: [...refusals.slice(1), ...notes],
    changes: changeLines(dialog, opts),
    footer: muted("footer", `Backup: ${tilde(opts.backupRoot, opts.homeDir)}${path.sep}`, width),
    undoHint: muted("undo-hint", UNDO_HINT, width),
    top: dialog.top,
    ...(picking ? { cursor: dialog.cursor } : {}),
  };
}

type Laid = { lines: DialogLine[]; top: number; shown: number; total: number };

/**
 * The lines in order - question, warning, refusals and notes, a blank line, the changes, a blank
 * line, the backup or what undo leaves, how to undo - with, while they are more than `height`:
 * the blank lines dropped, then how to undo, then the refusal lines beyond the first and the
 * notes, then the change lines cut down to one and a line saying how many more are below.
 */
function laidOut(dialog: Dialog, opts: Opts): Laid {
  const parts = partsOf(dialog, opts);
  const total = parts.changes.length;
  const height = Math.max(0, opts.height);
  let blanks = true;
  let undoHint = parts.undoHint !== undefined;
  let moreRefusals = true;
  const fixed = () =>
    parts.head.length +
    parts.firstRefusal.length +
    (moreRefusals ? parts.moreRefusals.length : 0) +
    (blanks ? (total > 0 ? 2 : 1) : 0) +
    1 +
    (undoHint ? 1 : 0);
  const steps = [() => (blanks = false), () => (undoHint = false), () => (moreRefusals = false)];
  for (const step of steps) {
    if (fixed() + total <= height) break;
    step();
  }
  const room = height - fixed();
  // Every change line, or as many as leave a line for how many more, from `top`, the cursor in sight.
  const shown = total <= room ? total : Math.max(1, room - 1);
  let top = Math.max(0, Math.min(parts.top, total - shown));
  if (parts.cursor !== undefined) {
    if (parts.cursor < top) top = parts.cursor;
    else if (parts.cursor >= top + shown) top = parts.cursor - shown + 1;
  }
  const below = total - top - shown;
  const blank = (key: string): DialogLine[] => (blanks ? [{ key, text: "" }] : []);
  const lines = [
    ...parts.head,
    ...parts.firstRefusal,
    ...(moreRefusals ? parts.moreRefusals : []),
    ...blank("blank-1"),
    ...parts.changes.slice(top, top + shown),
    ...(below > 0 ? [muted("more", `↓ ${below} more`, opts.width)] : []),
    ...(total > 0 ? blank("blank-2") : []),
    parts.footer,
    ...(undoHint && parts.undoHint ? [parts.undoHint] : []),
  ];
  return { lines: lines.slice(0, height), top, shown, total };
}

/** Exactly `height` lines or fewer, none wider than `width`. */
export function dialogView(dialog: Dialog, opts: Opts): DialogView {
  const { lines } = laidOut(dialog, opts);
  if (dialog.busy) return { lines, hints: [] };
  if (dialog.type === "undo") {
    return {
      lines,
      hints: [
        { keys: "y", action: "undo" },
        { keys: "n/esc", action: "cancel" },
      ],
    };
  }
  const picking = (dialog.plan.accounts?.length ?? 0) > 1;
  return {
    lines,
    hints: [
      { keys: "y", action: "apply" },
      { keys: "n/esc", action: "cancel" },
      ...(dialog.offerOff ? [{ keys: "o", action: "off instead" }] : []),
      ...(picking
        ? [
            { keys: "space", action: "pick" },
            { keys: "↑↓", action: "move" },
          ]
        : []),
    ],
  };
}

/** The dialog with its change lines scrolled `pages` pages down (up when negative), kept inside them. */
export function scrollDialog<D extends Dialog>(dialog: D, pages: number, opts: Opts): D {
  const { top, shown, total } = laidOut(dialog, opts);
  return { ...dialog, top: Math.max(0, Math.min(total - shown, top + pages * Math.max(1, shown))) };
}

/**
 * The status line after an apply: what was done and that u undoes it, why it stopped - a kept
 * copy in words - or nothing.
 */
export function appliedStatus(result: ApplyResult, plan: Plan, homeDir: string, stashDir: string): string {
  switch (result.status) {
    case "applied":
      return `${plan.done} · u to undo`;
    case "stopped": {
      const why = stopText(result.stop, "keys", homeDir, plan.command, stashDir);
      // What was made before the stop is one operation, which u puts back.
      return result.done > 0 ? `${why.replace(/\.$/, "")}, ${result.done} of ${result.total} done · u to undo` : why;
    }
    case "nothing":
      return "Nothing changed.";
  }
}

export const NOTHING_TO_UNDO = "Nothing to undo.";

/**
 * The status line after an undo: what it undid, and when it left files alone, how many and why,
 * as the CLI says it. A path in `stashDir` is clausona's own kept copy, which goes with its edit:
 * it is never counted or named, only said in words when it is all that was left.
 */
export function undoneStatus(result: UndoResult | null, stashDir: string): string {
  if (!result) return NOTHING_TO_UNDO;
  const { summary } = result.operation;
  if (result.skipped.length === 0) return `Undid: ${summary}`;
  const own = (file: string) => isWithin(file, stashDir);
  const words = (skips: UndoSkip[]) => [...new Set(skips.map((skip) => LEFT_ALONE[skip.reason]))].join(", ");
  const theirs = result.skipped.filter((skip) => !own(skip.file));
  const left =
    theirs.length > 0
      ? `${new Set(theirs.map((skip) => skip.file)).size} left alone: ${words(theirs)}`
      : `${KEPT_COPY} was left alone: ${words(result.skipped)}`;
  const retry = result.skipped.some((skip) => skip.reason === "locked") ? " · try again in a moment" : "";
  const some = result.restored.some((file) => !own(file));
  return `${some ? "Undid part of it" : "Could not undo"}: ${summary} · ${left}${retry}`;
}
