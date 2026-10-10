import path from "node:path";

import { describe, expect, it } from "vitest";

import { refusal } from "../../extensions/actions.js";
import type { ApplyResult, UndoPreview, UndoResult } from "../../extensions/apply.js";
import type { FileChange, Plan, PlanLine } from "../../extensions/plan.js";
import { appliedStatus, type Dialog, dialogView, scrollDialog, undoneStatus } from "./confirm-model.js";

const HOME = path.join(path.sep, "h");
const at = (...parts: string[]) => path.join(HOME, ...parts);
/** How a path under HOME reads: from ~, with the platform's separator. */
const tilded = (...parts: string[]) => path.join("~", ...parts);
const BACKUP = at(".clausona", "backups", "extensions");
const STASH = at(".clausona", "extensions", "stash");
const OPTS = { homeDir: HOME, backupRoot: BACKUP, stashDir: STASH };
const BACKUP_LINE = `Backup: ${tilded(".clausona", "backups", "extensions")}${path.sep}`;
/** notes's line under old-one's: its note starts where it would after old-one's longer path. */
const NOTES_LINE = `${tilded(".claude", "skills", "notes").padEnd(tilded(".claude", "skills", "old-one").length)}  link only, target kept`;
const PRESS_U = "Press u afterwards to put them back.";

function line(file: string, more: Partial<PlanLine> = {}): PlanLine {
  return { file, change: "delete", what: "", tracked: false, rows: [file], ...more };
}

function removal(...lines: PlanLine[]): FileChange {
  return { kind: "remove", file: lines[0]?.file ?? "", what: "folder", expect: [], lines };
}

function planOf(more: Partial<Plan> = {}): Plan {
  return {
    command: "skills",
    verb: "rm",
    reach: "here",
    question: "Delete 2 skills?",
    done: "Deleted 2 skills",
    changes: [],
    unchanged: [],
    refused: [],
    notes: [],
    project: at("repos", "app"),
    ...more,
  };
}

function dialogOf(plan: Plan, more: Partial<Extract<Dialog, { type: "plan" }>> = {}): Dialog {
  return {
    type: "plan",
    action: { verb: plan.verb, reach: plan.reach, rows: [] },
    command: plan.command,
    tracked: new Set(),
    plan,
    full: plan,
    cursor: 0,
    top: 0,
    busy: false,
    offerOff: false,
    ...more,
  };
}

/** Delete old-one and the link notes. */
const DELETE_TWO = planOf({
  changes: [
    removal(line(at(".claude", "skills", "old-one"))),
    removal(line(at(".claude", "skills", "notes"), { change: "unlink", note: "link only, target kept" })),
  ],
});

/** Delete six skills, one line each. */
const DELETE_SIX = planOf({
  question: "Delete 6 skills?",
  changes: ["a", "b", "c", "d", "e", "f"].map((name) => removal(line(at(".claude", "skills", name)))),
});

const texts = (dialog: Dialog, width: number, height: number) =>
  dialogView(dialog, { width, height, ...OPTS }).lines.map((l) => l.text);

describe("dialogView: a plan", () => {
  it("says the question, one line per file, the backup and how to undo", () => {
    expect(texts(dialogOf(DELETE_TWO), 56, 9)).toEqual([
      "Delete 2 skills?",
      "",
      tilded(".claude", "skills", "old-one"),
      NOTES_LINE,
      "",
      BACKUP_LINE,
      PRESS_U,
    ]);
    const view = dialogView(dialogOf(DELETE_TWO), { width: 56, height: 9, ...OPTS });
    expect(view.lines[0]).toMatchObject({ bold: true });
    expect(view.lines.find((l) => l.text === PRESS_U)?.tone).toBe("muted");
    expect(view.hints).toEqual([
      { keys: "y", action: "apply" },
      { keys: "n/esc", action: "cancel" },
    ]);
  });

  it("drops the blank lines first, then the undo line, when the height is short", () => {
    expect(texts(dialogOf(DELETE_TWO), 56, 5)).toEqual([
      "Delete 2 skills?",
      tilded(".claude", "skills", "old-one"),
      NOTES_LINE,
      BACKUP_LINE,
      PRESS_U,
    ]);
    expect(texts(dialogOf(DELETE_TWO), 56, 4)).toEqual([
      "Delete 2 skills?",
      tilded(".claude", "skills", "old-one"),
      NOTES_LINE,
      BACKUP_LINE,
    ]);
  });

  it("keeps one change line and says how many more when even that is short", () => {
    expect(texts(dialogOf(DELETE_SIX), 56, 4)).toEqual([
      "Delete 6 skills?",
      tilded(".claude", "skills", "a"),
      "↓ 5 more",
      BACKUP_LINE,
    ]);
    // Lines that do not fit scroll a page at a time.
    const opts = { width: 56, height: 6, ...OPTS };
    const down = scrollDialog(dialogOf(DELETE_SIX), 1, opts);
    expect(down.top).toBe(3);
    expect(texts(down, 56, 6)).toEqual([
      "Delete 6 skills?",
      tilded(".claude", "skills", "d"),
      tilded(".claude", "skills", "e"),
      tilded(".claude", "skills", "f"),
      BACKUP_LINE,
    ]);
    expect(scrollDialog(down, 1, opts).top).toBe(3);
    expect(scrollDialog(down, -1, opts).top).toBe(0);
  });

  it("never draws a line wider than the width, nor more lines than the height", () => {
    for (const [width, height] of [
      [20, 9],
      [12, 3],
      [56, 1],
      [8, 2],
    ] as const) {
      const lines = texts(dialogOf(DELETE_SIX), width, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      for (const text of lines) expect(text.length).toBeLessThanOrEqual(width);
    }
  });

  it("cuts a long path from its middle, so what changes stays in sight", () => {
    const file = at("repos", "a-long-project-name", ".claude", "settings.local.json");
    const plan = planOf({
      verb: "off",
      question: "Turn off eli5 in this project?",
      changes: [removal(line(file, { change: "edit", what: "skillOverrides.eli5 → off" }))],
    });
    const change = texts(dialogOf(plan), 50, 9)[2] ?? "";
    expect(change.length).toBeLessThanOrEqual(50);
    expect(change).toContain("…");
    expect(change.endsWith("settings.local.json  skillOverrides.eli5 → off")).toBe(true);
  });

  it("lists two refusals, then how many more, and the notes after them; drops all but the first before cutting files", () => {
    const row = (name: string) => ({ key: `skill:claude:cloud:-:${name}`, name });
    const refused = ["pdf", "docx", "xlsx", "pptx"].map((name) => refusal("cloud-delete", row(name), "claude", {}));
    const plan = planOf({ ...DELETE_TWO, refused, notes: ["work has not opened this project"] });
    const view = dialogView(dialogOf(plan), { width: 80, height: 20, ...OPTS });
    expect(view.lines.map((l) => l.text)).toEqual([
      "Delete 2 skills?",
      "pdf can't: It comes back from claude.ai.",
      "docx can't: It comes back from claude.ai.",
      "and 2 more can't",
      "work has not opened this project",
      "",
      tilded(".claude", "skills", "old-one"),
      NOTES_LINE,
      "",
      BACKUP_LINE,
      PRESS_U,
    ]);
    expect(view.lines.slice(1, 5).every((l) => l.tone === "muted")).toBe(true);
    expect(texts(dialogOf(plan), 80, 5)).toEqual([
      "Delete 2 skills?",
      "pdf can't: It comes back from claude.ai.",
      tilded(".claude", "skills", "old-one"),
      NOTES_LINE,
      BACKUP_LINE,
    ]);
  });

  it("warns that a delete changes the repo, and offers off instead", () => {
    const row = { key: "skill:claude:project:app:deploy-check", name: "deploy-check" };
    const tracked = refusal("tracked", row, "claude", { "project name": "app" });
    const plan = planOf({ question: "Delete deploy-check?", refused: [tracked] });
    const view = dialogView(dialogOf(plan, { offerOff: true }), { width: 80, height: 12, ...OPTS });
    expect(view.lines.map((l) => l.text)).toEqual([
      "Delete deploy-check?",
      "Git tracks deploy-check in app, so deleting changes the repo.",
      "",
      BACKUP_LINE,
      PRESS_U,
    ]);
    expect(view.lines[1]?.tone).toBe("warning");
    expect(view.hints).toEqual([
      { keys: "y", action: "apply" },
      { keys: "n/esc", action: "cancel" },
      { keys: "o", action: "off instead" },
    ]);
    const two = planOf({
      question: "Delete 2 skills?",
      refused: [tracked, refusal("tracked", { key: "b", name: "lint" }, "claude", { "project name": "app" })],
    });
    expect(texts(dialogOf(two, { offerOff: true }), 80, 12)[1]).toBe(
      "Git tracks 2 of these in app, so deleting changes the repo.",
    );
  });

  it("lets the user pick accounts: one line each from the full plan, the cursor on one", () => {
    const one = at(".claude.json");
    const two = at(".claude-work", ".claude.json");
    const edit = (file: string, account: string): FileChange => ({
      kind: "json",
      file,
      edits: [],
      expect: [],
      create: false,
      lock: true,
      lines: [{ file, change: "edit", what: "disabledMcpServers + figma", account, tracked: false, rows: ["figma"] }],
    });
    const full = planOf({
      command: "mcp",
      verb: "off",
      question: "Turn off figma in this project, for default and work?",
      changes: [edit(one, "claude:default"), edit(two, "claude:work")],
      accounts: [
        { profile: "claude:default", chosen: true },
        { profile: "claude:work", chosen: true },
      ],
    });
    const plan = {
      ...full,
      question: "Turn off figma in this project, for default?",
      changes: [edit(one, "claude:default")],
      accounts: [
        { profile: "claude:default", chosen: true },
        { profile: "claude:work", chosen: false },
      ],
    };
    const view = dialogView(dialogOf(plan, { full, cursor: 1 }), { width: 80, height: 12, ...OPTS });
    expect(view.lines.map((l) => l.text)).toEqual([
      "Turn off figma in this project, for default?",
      "",
      `  ◉ default  ${tilded(".claude.json").padEnd(tilded(".claude-work", ".claude.json").length)}  disabledMcpServers + figma`,
      `✦ ○ work     ${tilded(".claude-work", ".claude.json")}  disabledMcpServers + figma`,
      "",
      BACKUP_LINE,
      PRESS_U,
    ]);
    expect(view.lines[3]?.cursor).toBe(true);
    expect(view.lines[2]?.cursor).toBeFalsy();
    expect(view.hints.map((h) => `${h.keys} ${h.action}`)).toEqual([
      "y apply",
      "n/esc cancel",
      "space pick",
      "↑↓ move",
    ]);
    // Too narrow for the files: the account says whose .claude.json it is, and what changes stays whole.
    const narrow = texts(dialogOf(plan, { full, cursor: 1 }), 56, 12);
    expect(narrow.slice(2, 4)).toEqual([
      "  ◉ default  disabledMcpServers + figma",
      "✦ ○ work     disabledMcpServers + figma",
    ]);
    for (const text of narrow) expect(text).not.toContain("…");
    // Narrower still: what changes is cut at its end.
    expect(texts(dialogOf(plan, { full, cursor: 1 }), 30, 12)[3]).toBe("✦ ○ work     disabledMcpServe…");
  });

  it("starts each column at the same place on every change line", () => {
    const edit = (file: string, what: string, note?: string): FileChange =>
      removal(line(file, { change: "edit", what, ...(note !== undefined ? { note } : {}) }));
    const plan = planOf({
      verb: "off",
      question: "Turn off 2 skills in this project?",
      changes: [
        edit(at("repos", "app", ".claude", "settings.local.json"), "skillOverrides.eli5 → off", "changes the repo"),
        edit(at(".codex", "config.toml"), "skills.config eli5 → off"),
      ],
    });
    const [first = "", second = ""] = texts(dialogOf(plan), 100, 9).slice(2, 4);
    expect(first.indexOf("skillOverrides")).toBe(second.indexOf("skills.config"));
    expect(first.endsWith("→ off  changes the repo")).toBe(true);
    expect(second.endsWith("skills.config eli5 → off")).toBe(true);
  });

  it("names a copy clausona kept in words, never by its path", () => {
    const kept = (name: string, account: string) =>
      removal(line(path.join(STASH, `${name}.json`), { change: "delete", account, rows: ["github"] }));
    const plain = planOf({ command: "mcp", question: "Delete github?", changes: [kept("a", "claude:default")] });
    expect(texts(dialogOf(plain), 80, 9)).toEqual([
      "Delete github?",
      "",
      "the copy clausona kept",
      "",
      BACKUP_LINE,
      PRESS_U,
    ]);
    const both = planOf({
      command: "mcp",
      question: "Delete github?",
      changes: [kept("a", "claude:default"), kept("b", "claude:work")],
      accounts: [
        { profile: "claude:default", chosen: true },
        { profile: "claude:work", chosen: true },
      ],
    });
    const picker = texts(dialogOf(both), 80, 9);
    expect(picker.slice(2, 4)).toEqual(["✦ ◉ default  the copy clausona kept", "  ◉ work     the copy clausona kept"]);
    // Not cut from its middle as a path is.
    expect(texts(dialogOf(plain), 14, 9)[2]).toBe("the copy clau…");
    for (const text of [...picker, ...texts(dialogOf(plain), 14, 9)]) expect(text).not.toContain("stash");
  });

  it("offers no keys while it applies", () => {
    expect(dialogView(dialogOf(DELETE_TWO, { busy: true }), { width: 56, height: 9, ...OPTS }).hints).toEqual([]);
  });
});

describe("dialogView: undo", () => {
  const preview: UndoPreview = {
    operation: {
      id: "20261010T043648123Z-skills-off",
      dir: at(".clausona", "backups", "extensions", "20261010T043648123Z-skills-off"),
      command: "skills",
      summary: "Turned off eli5 in this project",
      createdAt: "2026-10-10T04:36:48.123Z",
    },
    files: [
      { path: at("repos", "app", ".claude", "settings.local.json"), action: "remove" },
      { path: at(".claude.json"), action: "edit back" },
    ],
  };

  it("asks, lists each file and what undo does to it, and says what it leaves alone", () => {
    const view = dialogView({ type: "undo", preview, top: 0, busy: false }, { width: 80, height: 9, ...OPTS });
    expect(view.lines.map((l) => l.text)).toEqual([
      "Undo: Turned off eli5 in this project?",
      "",
      `${tilded("repos", "app", ".claude", "settings.local.json")}  remove`,
      `${tilded(".claude.json").padEnd(tilded("repos", "app", ".claude", "settings.local.json").length)}  edit back`,
      "",
      "Puts back what the change changed, unless it changed since.",
    ]);
    expect(view.lines[0]?.bold).toBe(true);
    expect(view.lines.at(-1)?.tone).toBe("muted");
    expect(view.hints).toEqual([
      { keys: "y", action: "undo" },
      { keys: "n/esc", action: "cancel" },
    ]);
  });
});

describe("the status after an apply or an undo", () => {
  const operation = {
    id: "20261010T043648123Z-mcp-off",
    dir: at(".clausona", "backups", "extensions", "20261010T043648123Z-mcp-off"),
    command: "mcp" as const,
    summary: "Turned off figma in this project",
    createdAt: "2026-10-10T04:36:48.123Z",
  };
  const plan = planOf({ command: "mcp", verb: "off", done: "Turned off figma in this project" });
  const kept = path.join(STASH, "mcp-figma.json");

  it("says what was done and how to undo it, why an apply stopped, or that nothing changed", () => {
    expect(appliedStatus({ status: "applied", operation, done: 2 }, plan, HOME, STASH)).toBe(
      "Turned off figma in this project · u to undo",
    );
    const stop = { file: at(".claude.json"), reason: "locked" as const };
    const stopped = (done: number): ApplyResult => ({ status: "stopped", operation, done, total: 2, stop });
    expect(appliedStatus(stopped(0), plan, HOME, STASH)).toBe(
      `Claude Code is saving ${tilded(".claude.json")}. Try again in a moment.`,
    );
    expect(appliedStatus(stopped(1), plan, HOME, STASH)).toBe(
      `Claude Code is saving ${tilded(".claude.json")}. Try again in a moment, 1 of 2 done · u to undo`,
    );
    expect(appliedStatus({ status: "nothing" }, plan, HOME, STASH)).toBe("Nothing changed.");
    // A kept copy that went before the delete got to it: said in words.
    const gone: ApplyResult = {
      status: "stopped",
      operation,
      done: 0,
      total: 1,
      stop: { file: kept, reason: "changed" },
    };
    expect(appliedStatus(gone, plan, HOME, STASH)).toBe(
      "The copy clausona kept changed since it was read. Press r and try again.",
    );
  });

  it("says what undo did, and what it left alone and why, never a path of clausona's own", () => {
    const result = (more: Partial<UndoResult>): UndoResult => ({ operation, restored: [], skipped: [], ...more });
    const json = at(".claude.json");
    const work = at(".claude-work", ".claude.json");
    expect(undoneStatus(result({ restored: [json, kept] }), STASH)).toBe("Undid: Turned off figma in this project");
    expect(undoneStatus(null, STASH)).toBe("Nothing to undo.");
    expect(
      undoneStatus(
        result({
          restored: [json],
          skipped: [
            { file: work, reason: "changed" },
            { file: kept, reason: "changed" },
          ],
        }),
        STASH,
      ),
    ).toBe("Undid part of it: Turned off figma in this project · 1 left alone: changed since");
    expect(
      undoneStatus(
        result({
          skipped: [
            { file: json, reason: "locked" },
            { file: work, reason: "failed" },
          ],
        }),
        STASH,
      ),
    ).toBe(
      "Could not undo: Turned off figma in this project · 2 left alone: Claude Code is saving it, could not be put back · try again in a moment",
    );
    expect(undoneStatus(result({ restored: [json], skipped: [{ file: kept, reason: "occupied" }] }), STASH)).toBe(
      "Undid part of it: Turned off figma in this project · the copy clausona kept was left alone: something is there again",
    );
  });
});
