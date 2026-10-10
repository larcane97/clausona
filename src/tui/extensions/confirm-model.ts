import path from "node:path";

import { type Action, type ExtensionsCommand, KEPT_COPY, LEFT_ALONE, stopText } from "../../extensions/actions.js";
import type { ApplyResult, UndoPreview, UndoResult, UndoSkip } from "../../extensions/apply.js";
import type { Inventory } from "../../extensions/model.js";
import type { Plan, PlanLine } from "../../extensions/plan.js";
import { middleCut, projectName, shortProfile, tilde } from "../../extensions/present.js";
import { isWithin, samePath } from "../../extensions/read.js";
import type { ScopeRow } from "../../extensions/scopes.js";
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
      /** The project, by name, that git tracks the refused rows in: what the offerOff warning names. */
      trackedIn?: string;
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

type Opts = { width: number; height: number; homeDir: string; backupRoot: string };

/** Refusal lines shown before the rest are counted on one line. */
const REFUSALS_SHOWN = 2;
const GAP = "  ";
/** The fewest columns a cut path keeps. */
const PATH_MIN = 12;
const UNDO_NOTE = "Puts back what the change changed, unless it changed since.";
const UNDO_HINT = "Press u afterwards to put them back.";

/**
 * A path and what follows it, two spaces apart, in `width` columns: the path gives way first,
 * from its middle, down to PATH_MIN; then the line is cut at its end. `lead` goes before the path.
 */
function pathLine(lead: string, file: string, rest: string[], width: number): string {
  const after = rest.filter((part) => part !== "");
  const whole = (p: string) => [lead + p, ...after].join(GAP);
  const over = whole(file).length - width;
  const fitted = over > 0 ? middleCut(file, Math.max(PATH_MIN, file.length - over)) : file;
  return cell(whole(fitted), width).trimEnd();
}

/** The change lines: one per plan line, or with several accounts to pick from, one per account. */
function changeLines(dialog: Extract<Dialog, { type: "plan" }>, opts: Opts): DialogLine[] {
  const { plan, full } = dialog;
  const home = (file: string) => tilde(file, opts.homeDir);
  const lines = plan.changes.flatMap((change) => change.lines);
  const plain = (line: PlanLine, at: number): DialogLine => ({
    key: `change-${at}`,
    text: pathLine("", home(line.file), [line.what, line.note ?? ""], opts.width),
  });
  const accounts = plan.accounts ?? [];
  if (accounts.length <= 1) return lines.map(plain);
  const fullLines = full.changes.flatMap((change) => change.lines);
  // The names padded alike, so the files line up.
  const nameWidth = Math.max(...accounts.map((account) => shortProfile(account.profile).length));
  const picker = accounts.map((account, at): DialogLine => {
    const own = fullLines.filter((line) => line.account === account.profile);
    const whats = [...new Set(own.map((line) => line.what))].join(", ");
    const box = account.chosen ? symbol.checkboxOn : symbol.checkboxOff;
    const name = shortProfile(account.profile).padEnd(nameWidth);
    const lead = `${at === dialog.cursor ? symbol.cursor : " "} ${box} ${name}${GAP}`;
    return {
      key: `account-${account.profile}`,
      text: pathLine(lead, own[0] ? home(own[0].file) : "", [whats], opts.width),
      ...(at === dialog.cursor ? { cursor: true } : {}),
    };
  });
  // What no account owns - a project's settings file - is the same whichever accounts are picked.
  return [...picker, ...lines.filter((line) => line.account === undefined).map(plain)];
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
      changes: dialog.preview.files.map((file, at) => ({
        key: `file-${at}`,
        text: pathLine("", tilde(file.path, opts.homeDir), [file.action], width),
      })),
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
    const where = dialog.trackedIn !== undefined ? ` in ${dialog.trackedIn}` : "";
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

/** The status line after an apply: what was done and that u undoes it, why it stopped, or nothing. */
export function appliedStatus(result: ApplyResult, plan: Plan, homeDir: string): string {
  switch (result.status) {
    case "applied":
      return `${plan.done} · u to undo`;
    case "stopped": {
      const why = stopText(result.stop, "keys", homeDir, plan.command);
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

/**
 * The project, by name, that holds a row's files - the innermost recorded one that is not the
 * home dir, as plan.ts finds the project a tracked file is in - for the warning a delete of what
 * git tracks gives.
 */
export function trackedRepo(inv: Inventory, row: ScopeRow | undefined): string | undefined {
  const item = row?.items[0];
  if (!item) return undefined;
  const files = [item.location.file, ...(item.realFolder ? [item.realFolder] : [])];
  const holding = inv.projects
    .map((p) => p.path)
    .filter((dir) => !samePath(dir, inv.homeDir) && files.some((file) => isWithin(file, dir)))
    .sort((a, b) => b.length - a.length)[0];
  return holding === undefined ? undefined : projectName(holding, inv);
}
