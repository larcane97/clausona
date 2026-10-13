import { type ReactElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import { writesFor } from "../../extensions/load.js";
import type { Inventory } from "../../extensions/model.js";
import { TestHome } from "../../extensions/test-home.js";
import { stripAnsi } from "../../lib/cli-style.js";
import {
  DOWN,
  ENTER,
  ESC,
  focusedOn,
  type Instance,
  moveTo,
  press,
  renderAt,
  type,
  typeSlowly,
  type WatchedInstance,
  waitForFrame,
} from "../test-drive.js";
import { windowsOnScreen } from "../test-frames.js";
import { color, symbol } from "../theme.js";
import { ExtensionsScreen } from "./ExtensionsScreen.js";
import { ItemTable } from "./ItemTable.js";
import { MARK_COLOR, McpMatrix } from "./McpMatrix.js";
import type { Table, TableRow } from "./screen-model.js";
import type { Matrix } from "./view-model.js";

vi.setConfig({ testTimeout: 15_000 });

const homes: TestHome[] = [];
/** Every instance a case drew, unmounted after it even when a wait in it failed. */
const instances: Instance[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  for (const home of homes.splice(0)) home.dispose();
});
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const TAB = "\t";
const UP = "\u001B[A";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const PAGE_UP = "\u001B[5~";
const PAGE_DOWN = "\u001B[6~";
const HOME = "\u001B[H";
const END = "\u001B[F";
const DAY = 86_400_000;

/** Waits for a frame whose text, colours aside, passes `check`, and returns that text. */
async function seen(instance: Instance, check: (text: string) => boolean): Promise<string> {
  return stripAnsi(await waitForFrame(instance.lastFrame, (frame) => check(stripAnsi(frame))));
}

/** `more` adds to the home before the inventory is read, for a case that needs one more file. */
async function seed(more?: (h: TestHome) => void): Promise<Inventory> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", {
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg", env: { PGPASSWORD: KEY } } } } },
    mcpServers: { github: { command: "gh-mcp", args: ["--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
  });
  h.claude("work", ".claude-work", {
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: { github: { command: "gh-mcp" } },
  });
  h.skill(".claude/skills", "eli5", "Explain things simply");
  h.skill(".claude/skills", `a-very-long-skill-name-${"x".repeat(50)}`);
  // work loads the primary's skills through the link clausona makes for every account.
  h.link(".claude/skills", ".claude-work/skills");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
  h.write("repos/app/.claude/settings.local.json", "{ broken");
  more?.(h);
  return loadInventory({ homeDir: h.home, registry: h.registry, cwd: app, managedSettings: h.path("none.json") });
}

function mount(tree: ReactElement, columns: number, rows?: number): WatchedInstance {
  const instance = renderAt(tree, columns, rows === undefined ? {} : { rows });
  instances.push(instance);
  return instance;
}

function screen(inv: Inventory, columns: number, rows?: number) {
  const onExit = vi.fn();
  const load = vi.fn(async () => inv);
  const instance = mount(<ExtensionsScreen load={load} onExit={onExit} />, columns, rows);
  return { instance, onExit, load };
}

/**
 * How many terminal lines a frame takes: ink's own count, the laid-out height. The frame's last
 * line is the Chrome's bottom padding, which is empty, so the text ends in a line break.
 */
function height(frame: string | undefined): number {
  return (frame ?? "").split("\n").length;
}

/**
 * What the screen's cases need besides seed's: a project eli5 the Global one hides, a Codex
 * account with an eli5 of its own, and a project web, which only Codex has recorded, with a skill
 * only it has.
 */
function more(h: TestHome): void {
  h.skill("repos/app/.claude/skills", "eli5");
  const web = h.project("repos/web");
  h.skill("repos/web/.claude/skills", "web-only");
  // A literal TOML key: a Windows path's backslashes are not escapes there.
  h.codex("personal", ".codex", `[projects.'${web}']\ntrust_level = "trusted"\n`);
  h.skill(".agents/skills", "eli5", "Explain things to Codex");
}

/** The key hints: the line that offers esc. */
function hintLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("esc ")) ?? "";
}

/** Walks the scope list, or the project list, down to `label`, so a test does not count keystrokes. */
async function scopeTo(instance: Instance, label: string) {
  for (let step = 0; step < 12; step++) {
    if (stripAnsi(instance.lastFrame() ?? "").includes(`▸ ${label}`)) return;
    await press(instance, DOWN);
  }
  throw new Error(`the list never reached '${label}'`);
}

/** Whether the frame shows the project list: its heading, PROJECT with the kind's noun. */
function listOpen(frame: string, noun = "skills"): boolean {
  return new RegExp(`PROJECT +${noun}`).test(frame);
}

/**
 * Whether the scope list is on its project row - Loaded, for the project named `name` - with the
 * project list closed: the list has a line for the project too.
 */
function onRow(frame: string, name = "app (here)"): boolean {
  return !/PROJECT +(skills|MCP servers|hooks)/.test(frame) && frame.includes(`▸ ${name}`);
}

/** What a frame shows right of the panes' divider, line by line: the table or the details. */
function rightPane(frame: string): string[] {
  return frame.split("\n").map((line) => line.slice(line.lastIndexOf("│ ") + 2));
}

describe("ExtensionsScreen", () => {
  it("opens on Claude's skills with the project row selected - Loaded - and its table beside it", async () => {
    const { instance } = screen(await seed(), 140, 40);
    const frame = await seen(instance, (f) => f.includes("deploy-check"));
    expect(frame).toContain("Extensions");
    // tilde keeps the platform's separator: ~\\repos\\app on Windows.
    expect(frame).toMatch(/Extensions │ ~[\\/]repos[\\/]app/);
    expect(frame).toContain("[Claude]  Codex");
    expect(frame).toContain("Skills · MCP · Hooks");
    // The project everything is seen from, the folder's own, is the first line and Loaded: what
    // loads there, counted. A rule sets the scopes under it apart; no line of its own says Loaded.
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => /▸ app \(here\) +3 +│/.test(line));
    expect(row).toBeGreaterThan(0);
    expect(lines[row + 1]).toMatch(/^ +─{4,} +│/);
    expect(lines[row + 2]).toMatch(/^ {4}Project +\d+ +│/);
    expect(frame).not.toMatch(/Loaded +\d/);
    expect(frame).toContain("LOADED — ");
    expect(frame).toContain("eli5");
    // The scope list has the focus, so no row has the cursor yet.
    expect(frame).not.toContain(symbol.cursor);
    expect(hintLine(frame)).toContain("→ open");
    expect(hintLine(frame)).toContain("tab Codex");
    expect(hintLine(frame)).toContain("p project");
  });

  it("follows the scope list with the table: Project and its hidden copy, then Global", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, DOWN);
    const project = await seen(instance, (f) => f.includes("PROJECT — "));
    expect(project).toContain("▸ Project");
    expect(project.split("\n").find((line) => line.includes("eli5"))).toContain("hidden by Global copy");
    await press(instance, DOWN);
    const global = await seen(instance, (f) => f.includes("GLOBAL — "));
    expect(global).toContain("▸ Global");
    expect(global.split("\n").find((line) => line.includes("eli5"))).not.toContain("hidden");
  });

  it("switches to Codex on tab, whose list has no Not used in 90 days", async () => {
    const inv = await seed(more);
    // 200 days on, Claude's skills are old enough to be called unused. Codex keeps no record of
    // use, so none of its skills is ever called that.
    const later = () => Date.now() + 200 * DAY;
    const instance = mount(<ExtensionsScreen load={async () => inv} onExit={vi.fn()} now={later} />, 140, 40);
    expect(await seen(instance, (f) => f.includes("deploy-check"))).toContain("Not used in 90 days");
    await press(instance, TAB);
    const codex = await seen(instance, (f) => f.includes("[Codex]"));
    expect(codex).toContain("Claude  [Codex]");
    expect(codex).toContain("Explain things to Codex");
    expect(codex).not.toContain("deploy-check");
    expect(codex).not.toContain("Not used in 90 days");
    expect(hintLine(codex)).toContain("tab Claude");
    // shift+tab goes back.
    await press(instance, "\u001B[Z");
    expect(await seen(instance, (f) => f.includes("[Claude]"))).toContain("deploy-check");
  });

  it("shows the hooks on 3, when each runs in plain words", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "3");
    const hooks = await seen(instance, (f) => f.includes("When Claude finishes replying"));
    expect(hooks).toContain("notify-me");
    expect(hooks).not.toContain("deploy-check");
  });

  it("opens a row's details on enter, and steps back one level on each esc", async () => {
    const { instance, onExit } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    await moveTo(instance, "deploy-check");
    expect(hintLine(stripAnsi(instance.lastFrame() ?? ""))).toContain("enter details");
    expect(hintLine(stripAnsi(instance.lastFrame() ?? ""))).toContain("p project");
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    // The scope list stays beside the details, so it is clear where they are from.
    expect(details).toContain("▸ app (here)");
    expect(details).toContain("File");
    expect(hintLine(details)).toContain("esc back");
    expect(hintLine(details)).not.toContain("enter");
    await press(instance, ESC);
    const table = await seen(instance, (f) => focusedOn(f, "deploy-check"));
    expect(table).not.toContain("PROJECT › deploy-check");
    await press(instance, ESC);
    const scopes = await seen(instance, (f) => !f.includes(symbol.cursor));
    expect(hintLine(scopes)).toContain("→ open");
    expect(onExit).not.toHaveBeenCalled();
    // Leaving draws nothing here: the App would unmount the screen, and onExit is a stand-in.
    await type(instance, ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stays on the project row on ↑, opens its table on → or enter, and the project list on p", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    const first = await seen(instance, (f) => f.includes("deploy-check"));
    expect(hintLine(first)).toContain("→ open");
    expect(hintLine(first)).toContain("p project");
    // Nothing is above the row.
    await press(instance, UP);
    expect(onRow(stripAnsi(instance.lastFrame() ?? ""))).toBe(true);
    for (const open of [RIGHT, ENTER]) {
      await press(instance, open);
      const table = await seen(instance, (f) => f.includes("← scopes"));
      // Loaded's first row: the project's own, under its heading.
      expect(focusedOn(table, "deploy-check")).toBe(true);
      expect(table).toMatch(/│ Project 1 ─+/);
      expect(table).toContain("LOADED — ");
      await press(instance, LEFT);
      await seen(instance, (f) => !f.includes(symbol.cursor));
    }
    await press(instance, "p");
    const list = await seen(instance, (f) => listOpen(f));
    // The current project first, the cursor on it; every other recorded one; no No project.
    const lines = list.split("\n");
    const head = lines.findIndex((line) => listOpen(line));
    expect(lines[head + 1]).toMatch(/▸ app \(here\) +2/);
    expect(lines[head + 2]).toMatch(/ {3}web +1/);
    expect(lines[head + 3]).not.toMatch(/\S.*│/);
    expect(list).not.toContain("No project");
    expect(hintLine(list)).toMatch(/↑↓ move │ pgup pgdn page │ type search │ enter pick │ esc cancel/);
    // In place of the scope list; beside it, the own rows of the project under the cursor.
    expect(list).not.toMatch(/^ {4}Global +\d+ +│/m);
    expect(list).toMatch(/PROJECT — .*~[\\/]repos[\\/]app/);
    expect(list).not.toContain(symbol.cursor);
  });

  it("opens the project list on p from every focus, and leaves everything as it was on esc or ←", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "2");
    await scopeTo(instance, "Project");
    await press(instance, RIGHT);
    await moveTo(instance, "pg-dev");
    const before = stripAnsi(instance.lastFrame() ?? "");
    for (const cancel of [ESC, LEFT]) {
      await press(instance, "p");
      const list = await seen(instance, (f) => listOpen(f, "MCP servers"));
      // Counted in this kind's rows: app's own server.
      expect(list).toMatch(/▸ app \(here\) +1/);
      await press(instance, cancel);
      expect(await seen(instance, (f) => !listOpen(f, "MCP servers"))).toBe(before);
    }
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("PROJECT › pg-dev"));
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f, "MCP servers"));
    await press(instance, ESC);
    expect(await seen(instance, (f) => !listOpen(f, "MCP servers"))).toBe(details);
  });

  it("picks another project from the list, from the table: every scope seen from it, its own table, the scope list focused", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    const first = await seen(instance, (f) => f.includes("deploy-check"));
    // web has a skill of its own, and the scope list has no Other projects: the list is for that.
    expect(first).not.toContain("Other projects");
    await press(instance, RIGHT);
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    await scopeTo(instance, "web");
    await press(instance, ENTER);
    const picked = await seen(instance, (f) => !listOpen(f) && /Extensions │ ~[\\/]repos[\\/]web/.test(f));
    expect(picked).not.toContain("(here)");
    expect(picked).toMatch(/PROJECT — .*~[\\/]repos[\\/]web/);
    expect(picked).toContain("▸ Project");
    // The row names web, and Loaded is one ↑ away.
    expect(picked).toMatch(/^ {4}web +\d+ +│/m);
    expect(picked).toContain("web-only");
    expect(picked).not.toContain("deploy-check");
    // The scope list has the focus.
    expect(picked).not.toContain(symbol.cursor);
    expect(hintLine(picked)).toContain("→ open");
    // The list now starts with web, and app keeps its (here).
    await press(instance, "p");
    const list = (await seen(instance, (f) => listOpen(f))).split("\n");
    const head = list.findIndex((line) => listOpen(line));
    expect(list[head + 1]).toMatch(/▸ web +1/);
    expect(list[head + 2]).toMatch(/ {3}app \(here\) +2/);
  });

  it("shows the own rows of the project the list's cursor is on: esc puts everything back, enter keeps them", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "p");
    // The list counts each project's own rows; beside it, the rows of the one under the cursor.
    const onApp = await seen(instance, (f) => listOpen(f) && f.includes("PROJECT — "));
    expect(onApp).toMatch(/▸ app \(here\) +2/);
    expect(onApp).toMatch(/PROJECT — .*~[\\/]repos[\\/]app +2/);
    expect(onApp).toContain("deploy-check");
    expect(onApp).toContain("hidden by Global copy");
    await press(instance, DOWN);
    const onWeb = await seen(instance, (f) => f.includes("web-only"));
    expect(onWeb).toMatch(/PROJECT — .*~[\\/]repos[\\/]web +1/);
    expect(onWeb).not.toContain("deploy-check");
    // The title bar names the project seen from until another is picked.
    expect(onWeb).toMatch(/Extensions │ ~[\\/]repos[\\/]app/);
    await press(instance, ESC);
    const back = await seen(instance, (f) => !listOpen(f));
    expect(back).toContain("LOADED — ");
    expect(back).not.toContain("web-only");
    expect(onRow(back)).toBe(true);
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    await press(instance, DOWN);
    await seen(instance, (f) => f.includes("web-only"));
    await press(instance, ENTER);
    const picked = await seen(instance, (f) => !listOpen(f) && /Extensions │ ~[\\/]repos[\\/]web/.test(f));
    expect(picked).toContain("▸ Project");
    expect(picked).toContain("web-only");
  });

  it("picks a project onto its own table from any scope", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await scopeTo(instance, "Global");
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    await scopeTo(instance, "web");
    await press(instance, ENTER);
    const web = await seen(instance, (f) => !listOpen(f) && /Extensions │ ~[\\/]repos[\\/]web/.test(f));
    expect(web).toContain("▸ Project");
    expect(web).toContain("web-only");
  });

  it("leaves no place's heading at the foot of the table without a row of its own under it", () => {
    const row = (key: string, group: string): TableRow => ({
      key,
      cells: [key.padEnd(8)],
      row: { key, name: key, items: [] },
      group,
    });
    const table: Table = {
      header: "LOADED — what Claude Code loads in ~/app",
      count: 4,
      countText: "4",
      columns: [{ key: "name", title: "NAME", width: 8 }],
      rows: [row("one", "Project"), row("two", "Project"), row("three", "Global"), row("four", "Global")],
      empty: "",
    };
    // Seven rows: the header, the titles, Project 2, one, two - and Global's heading would be the
    // last of the four lines the body has, its rows below: the line that says how many more is
    // what follows two instead.
    const frame = stripAnsi(
      mount(<ItemTable table={table} width={40} height={7} cursor={0} top={0} focused={false} />, 40).lastFrame() ?? "",
    );
    expect(frame).toContain("Project 2");
    expect(frame).not.toContain("Global");
    expect(frame).toContain("↓ 2 more");
  });

  it("names the home dir ~ in the row and the list, the project it was started in", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      projects: { [h.home]: { mcpServers: { "home-db": { command: "db-mcp" } } }, [app]: {} },
    });
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const { instance } = screen(inv, 140);
    expect(await seen(instance, (f) => f.includes("Extensions │ ~"))).toContain("▸ ~ (here)");
    await press(instance, "2");
    await press(instance, "p");
    const list = await seen(instance, (f) => listOpen(f, "MCP servers"));
    expect(list).toMatch(/▸ ~ \(here\) +1/);
    expect(list).toMatch(/ {3}app +—/);
  });

  it("takes no key but its own while the project list is open: tab and / change nothing, r, m and w are typed", async () => {
    const { instance, load } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "p");
    const list = await seen(instance, (f) => listOpen(f));
    // A / before anything is typed is the table's way to start a search: here typing is enough.
    for (const key of [TAB, "/"]) {
      await type(instance, key);
      expect(stripAnsi(instance.lastFrame() ?? ""), JSON.stringify(key)).toBe(list);
    }
    // Nor does it move the cursor from where it is.
    await press(instance, DOWN);
    const onWeb = await seen(instance, (f) => f.includes("▸ web"));
    await type(instance, "/");
    expect(stripAnsi(instance.lastFrame() ?? "")).toBe(onWeb);
    await press(instance, UP);
    await seen(instance, (f) => f.includes("▸ app (here)"));
    // The keys of the screen are letters of a search here: nothing is read again, no matrix.
    await typeSlowly(instance, "rmw1");
    const typed = await seen(instance, (f) => f.includes("/rmw1▏"));
    expect(typed).toContain("No matches.");
    expect(typed).toContain("[Claude]  Codex");
    expect(load).toHaveBeenCalledTimes(1);
    await press(instance, ESC);
    await seen(instance, (f) => listOpen(f) && !f.includes("/rmw1"));
    // Still Claude's skills, seen from app, when it closes.
    await press(instance, ESC);
    const after = await seen(instance, (f) => !listOpen(f));
    expect(after).toContain("[Claude]  Codex");
    expect(onRow(after)).toBe(true);
    expect(after).toContain("deploy-check");
    expect(after).not.toContain("/▏");
  });

  it("fits Claude's skill scopes on a 24-row terminal, Not used in 90 days and all, with no more line", async () => {
    // Every scope Claude's skills have here: Cloud and Plugins too, and 200 days on, Not used.
    const everyScope = (h: TestHome) => {
      const app = h.path("repos", "app");
      h.claude("default", ".claude", {
        projects: { [app]: {} },
        oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
      });
      h.skill(".claude/skills/synced/org1_acc1", "pdf");
      const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
      h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
      h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
      h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-skill");
    };
    const inv = await seed(everyScope);
    const later = () => Date.now() + 200 * DAY;
    const instance = mount(<ExtensionsScreen load={async () => inv} onExit={vi.fn()} now={later} />, 80, 24);
    const frame = await seen(instance, (f) => onRow(f));
    for (const label of ["▸ app (here)", "Project", "Global", "Cloud", "Plugins", "Not used in 90 days"]) {
      expect(frame, label).toContain(label);
    }
    expect(frame).not.toMatch(/↓ \d+ more/);
    expect(height(frame)).toBeLessThanOrEqual(22);
  });

  it("scrolls a long project list, and says how many more are below", async () => {
    const many = (h: TestHome) => {
      const dirs = Array.from({ length: 12 }, (_, n) => h.project(`repos/p${String(n + 1).padStart(2, "0")}`));
      h.claude("work", ".claude-work", { projects: Object.fromEntries(dirs.map((dir) => [dir, {}])) });
    };
    // Nine rows for the panes at 80 by 24: the heading, seven projects and the line that says the rest.
    const { instance } = screen(await seed(many), 80, 24);
    await seen(instance, (f) => onRow(f));
    await press(instance, "p");
    const top = await seen(instance, (f) => listOpen(f));
    expect(top).toMatch(/↓ 6 more/);
    expect(top).toContain("▸ app (here)");
    // A page is the list's room less one: app, then p06, then p12, the last.
    await press(instance, PAGE_DOWN);
    await press(instance, PAGE_DOWN);
    const end = await seen(instance, (f) => f.includes("▸ p12"));
    expect(end).not.toMatch(/↓ \d+ more/);
    expect(end).not.toContain("app (here)");
    for (const frame of instance.frames) expect(height(frame)).toBeLessThanOrEqual(22);
    await press(instance, PAGE_UP);
    await press(instance, PAGE_UP);
    expect(await seen(instance, (f) => f.includes("▸ app (here)"))).toMatch(/↓ 6 more/);
    // home and end: the first and the last at once.
    await press(instance, END);
    await seen(instance, (f) => f.includes("▸ p12"));
    await press(instance, HOME);
    expect(await seen(instance, (f) => f.includes("▸ app (here)"))).toMatch(/↓ 6 more/);
  });

  it("keeps every key of a search that comes in before the list is drawn again", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => onRow(f));
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    // ink takes the list's keys from the next tick on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Two writes in one tick, as a fast typist or a slow link sends them, then a ↓ with nothing below.
    instance.stdin.write("w");
    instance.stdin.write("e");
    instance.stdin.write(DOWN);
    const typed = await seen(instance, (f) => f.includes("/we▏"));
    expect(typed).toMatch(/▸ web +1/);
    expect(typed).toContain("web-only");
  });

  it("narrows the project list as it is typed, by name or path: esc clears it, then closes the list", async () => {
    const clients = (h: TestHome) => {
      const dirs = ["clients/acme", "clients/beta", "repos/site"].map((dir) => h.project(dir));
      h.claude("work", ".claude-work", { projects: Object.fromEntries(dirs.map((dir) => [dir, {}])) });
      h.skill("clients/acme/.claude/skills", "acme-only");
    };
    const { instance } = screen(await seed(clients), 140, 40);
    await seen(instance, (f) => onRow(f));
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    // In any case, the path's folders too: the cursor on the first it leaves, its rows beside.
    await typeSlowly(instance, "CLIENT");
    const narrowed = await seen(instance, (f) => f.includes("/CLIENT▏") && f.includes("acme-only"));
    const lines = narrowed.split("\n");
    const head = lines.findIndex((line) => line.includes("/CLIENT▏"));
    expect(lines[head + 1]).toMatch(/▸ acme +1/);
    expect(lines[head + 2]).toMatch(/ {3}beta +—/);
    expect(narrowed).not.toContain("app (here)");
    expect(narrowed).not.toContain("site");
    expect(hintLine(narrowed)).toContain("esc clear");
    // Backspace gives a letter back; a search that matches none says so, with nothing to pick.
    await typeSlowly(instance, "zz");
    const none = await seen(instance, (f) => f.includes("/CLIENTzz▏") && f.includes("No matches."));
    expect(none).not.toContain("acme");
    expect(hintLine(none)).not.toContain("enter");
    await type(instance, ENTER);
    expect(stripAnsi(instance.lastFrame() ?? "")).toBe(none);
    await press(instance, "\u007F");
    await press(instance, "\u007F");
    await seen(instance, (f) => f.includes("/CLIENT▏") && f.includes("▸ acme"));
    // esc clears the search: every project again, the cursor back on the first.
    await press(instance, ESC);
    const all = await seen(instance, (f) => listOpen(f) && !f.includes("/CLIENT"));
    expect(all).toContain("▸ app (here)");
    expect(all).toContain("site");
    expect(hintLine(all)).toContain("esc cancel");
    // Typed again, enter picks the one under the cursor.
    await typeSlowly(instance, "bet");
    await seen(instance, (f) => f.includes("▸ beta"));
    await press(instance, ENTER);
    const picked = await seen(instance, (f) => !listOpen(f) && /Extensions │ ~[\\/]clients[\\/]beta/.test(f));
    expect(picked).toContain("▸ Project");
    // The list opens with nothing typed.
    await press(instance, "p");
    const again = await seen(instance, (f) => listOpen(f));
    expect(again).toMatch(/▸ beta +—/);
    expect(again).not.toContain("/bet▏");
    expect(again).toMatch(/PROJECT +skills/);
    // With nothing typed, one esc closes it, and beta's Project is where it was.
    await press(instance, ESC);
    expect(await seen(instance, (f) => !listOpen(f))).toBe(picked);
  });

  it("searches the table: enter keeps the search, esc clears it", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "/");
    await seen(instance, (f) => f.includes("/▏"));
    await typeSlowly(instance, "eli");
    await press(instance, ENTER);
    const searched = await seen(instance, (f) => f.includes("/eli") && !f.includes("▏"));
    expect(searched).toContain("eli5");
    expect(searched).not.toContain("deploy-check");
    expect(searched).not.toContain("a-very-long");
    // The header counts the matches of the rows, right-aligned at the pane's edge.
    expect(searched.split("\n").find((line) => line.includes("LOADED — "))).toMatch(/ 1 of 3$/);
    await press(instance, ESC);
    const cleared = await seen(instance, (f) => !f.includes("/eli"));
    expect(cleared).toContain("deploy-check");
    expect(cleared).toContain("eli5");
    expect(cleared.split("\n").find((line) => line.includes("LOADED — "))).toMatch(/[^f] 3$/);
  });

  it("takes every key as search text while typing", async () => {
    const { instance, load } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "/");
    await typeSlowly(instance, "fpmrw123");
    const frame = await seen(instance, (f) => f.includes("/fpmrw123"));
    expect(frame).toContain("[Claude]  Codex");
    expect(frame).toContain("Nothing matches /fpmrw123.");
    expect(listOpen(frame)).toBe(false);
    expect(frame).not.toContain("SERVER");
    expect(frame).not.toContain("could not be read");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens the MCP matrix on Claude's MCP tab, and says where it is from anywhere else", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "2");
    await seen(instance, (f) => f.includes("github"));
    await press(instance, "m");
    const matrix = await seen(instance, (f) => f.includes("SERVER"));
    expect(matrix).toContain("default");
    expect(matrix).toContain("work");
    // The legend says pending approval in the tag's words.
    expect(matrix).toContain("? pending approval");
    await press(instance, ESC);
    await press(instance, "1");
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "m");
    const status = await seen(instance, (f) => f.includes("The matrix is on Claude's MCP tab."));
    expect(status).not.toContain("SERVER");
  });

  it("says so when no account has opened the project the matrix is for", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude");
    h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs" } } });
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const { instance } = screen(inv, 140, 40);
    await seen(instance, (f) => f.includes("Skills"));
    await press(instance, "2");
    await press(instance, "m");
    const frame = await seen(instance, (f) => f.includes("No account has opened this project yet."));
    expect(frame).not.toContain("SERVER");
  });

  it("shows an MCP server's secrets by name only, in its details", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "2");
    await press(instance, RIGHT);
    // pg-dev, the project's own, comes first; github, a user server, under Global.
    await moveTo(instance, "pg-dev");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Secrets"))).toContain("PGPASSWORD (value hidden)");
    await press(instance, ESC);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Runs"))).toContain("--api-key <hidden>");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("shows no secret in the details at 60 columns either", async () => {
    const { instance } = screen(await seed(), 60, 30);
    await seen(instance, (f) => onRow(f));
    await press(instance, "2");
    await press(instance, ENTER);
    // pg-dev, the project's own, comes first; github, a user server, under Global.
    await moveTo(instance, "pg-dev");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Secrets"))).toContain("PGPASSWORD (value hidden)");
    await press(instance, ESC);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Runs"))).toContain("--api-key <hidden>");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it.each([
    [60, 24],
    [72, 30],
    [80, 24],
    [100, 30],
    [140, 40],
  ])("keeps every frame inside a %i by %i terminal: opened, in the table, in a long name's details and in the project list", async (columns, rows) => {
    const { instance } = screen(await seed(), columns, rows);
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, RIGHT);
    await moveTo(instance, "a-very-long");
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("GLOBAL › a-very-long"));
    expect(hintLine(details)).toContain("esc back");
    await press(instance, "p");
    expect(hintLine(await seen(instance, (f) => listOpen(f)))).toContain("esc cancel");
    // Shorter than the terminal by two: ink 6 redraws a frame as tall as it by clearing the screen.
    for (const frame of instance.frames) {
      expect(height(frame)).toBeLessThanOrEqual(rows - 2);
      for (const line of stripAnsi(frame).split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("shows one pane at a time at 80 by 24: the scopes, enter for the table, esc back", async () => {
    const { instance, onExit } = screen(await seed(), 80, 24);
    const first = await seen(instance, (f) => onRow(f));
    expect(first).not.toContain("LOADED — ");
    expect(first).not.toContain("deploy-check");
    await press(instance, ENTER);
    const table = await seen(instance, (f) => f.includes("LOADED — "));
    expect(table).toContain("deploy-check");
    expect(table).not.toContain("app (here)");
    expect(hintLine(table)).toContain("← scopes");
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    expect(details).not.toContain("LOADED — ");
    await press(instance, ESC);
    await seen(instance, (f) => f.includes("LOADED — "));
    await press(instance, ESC);
    const back = await seen(instance, (f) => onRow(f));
    expect(back).not.toContain("LOADED — ");
    expect(onExit).not.toHaveBeenCalled();
    // Leaving draws nothing here: the App would unmount the screen, and onExit is a stand-in.
    await type(instance, ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("keeps the scope list narrow on a narrow terminal, each count next to its label", async () => {
    const { instance } = screen(await seed(), 80, 24);
    const frame = await seen(instance, (f) => onRow(f));
    const line = frame.split("\n").find((l) => l.includes("▸ app (here)")) ?? "";
    const start = line.indexOf("▸");
    const count = line.search(/\d+ *$/);
    expect(count).toBeGreaterThan(start);
    expect(count - start).toBeLessThan(32);
  });

  it("shows the project list as the one pane at 80 by 24, and the scope list once one is picked", async () => {
    const { instance } = screen(await seed(more), 80, 24);
    await seen(instance, (f) => onRow(f));
    await press(instance, "p");
    const list = await seen(instance, (f) => listOpen(f));
    expect(list).toMatch(/▸ app \(here\) +2/);
    expect(list).toMatch(/ {3}web +1/);
    expect(list).not.toMatch(/Global +\d/);
    expect(list).not.toContain("LOADED — ");
    for (const line of list.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    await press(instance, DOWN);
    await press(instance, ENTER);
    const picked = await seen(instance, (f) => !listOpen(f) && f.includes("▸ Project"));
    expect(picked).toMatch(/^ {4}web +\d+/m);
    expect(picked).not.toContain("PROJECT — ");
  });

  it("keeps the open details on their row across a reload, wherever the row has moved to", async () => {
    const inv = await seed();
    // The row above deploy-check goes: deploy-check moves up one, and eli5 takes its old place.
    const moved: Inventory = { ...inv, items: inv.items.filter((i) => !i.name.startsWith("a-very-long")) };
    const load = vi.fn<() => Promise<Inventory>>().mockResolvedValueOnce(inv).mockResolvedValue(moved);
    const instance = mount(<ExtensionsScreen load={load} onExit={vi.fn()} />, 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    await moveTo(instance, "deploy-check");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    await press(instance, "r");
    const after = await seen(instance, (f) => f.includes("Read "));
    expect(after).toContain("PROJECT › deploy-check");
    expect(hintLine(after)).not.toContain("enter details");
    // And the table under them has its cursor on the row too.
    await press(instance, ESC);
    expect(focusedOn(await seen(instance, (f) => f.includes("LOADED — ")), "deploy-check")).toBe(true);
  });

  it("keeps the table's cursor on its row across a reload", async () => {
    const inv = await seed();
    const moved: Inventory = { ...inv, items: inv.items.filter((i) => !i.name.startsWith("a-very-long")) };
    const load = vi.fn<() => Promise<Inventory>>().mockResolvedValueOnce(inv).mockResolvedValue(moved);
    const instance = mount(<ExtensionsScreen load={load} onExit={vi.fn()} />, 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    await moveTo(instance, "deploy-check");
    await press(instance, "r");
    const after = await seen(instance, (f) => f.includes("Read "));
    expect(after).not.toContain("a-very-long");
    expect(focusedOn(after, "deploy-check")).toBe(true);
  });

  it("goes back to the table when a reload takes the open row away, and says so", async () => {
    const inv = await seed();
    const gone: Inventory = { ...inv, items: inv.items.filter((i) => i.name !== "deploy-check") };
    const load = vi.fn<() => Promise<Inventory>>().mockResolvedValueOnce(inv).mockResolvedValue(gone);
    const instance = mount(<ExtensionsScreen load={load} onExit={vi.fn()} />, 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    await moveTo(instance, "deploy-check");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    await press(instance, "r");
    const frame = await seen(instance, (f) => f.includes("That item is gone."));
    expect(frame).not.toContain("deploy-check");
    // The nearest row, the one that took its place, has the cursor; no row's details are open.
    expect(focusedOn(frame, "a-very-long")).toBe(true);
    expect(frame).not.toContain("GLOBAL › a-very-long");
    expect(hintLine(frame)).toContain("enter details");
    // No frame showed another row's details in its place.
    expect(instance.frames.some((f) => stripAnsi(f).includes("GLOBAL › a-very-long"))).toBe(false);
  });

  it("goes back to Loaded and the scope list on tab and on 1 2 3, from another scope's table", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    for (const keys of [TAB, TAB, "2", "3", "1"]) {
      await press(instance, DOWN);
      await press(instance, RIGHT);
      const inTable = await seen(instance, (f) => f.includes("▸ Project") && f.includes("← scopes"));
      expect(hintLine(inTable)).not.toContain("→ open");
      await press(instance, keys);
      const back = await seen(instance, (f) => onRow(f));
      expect(back, `after ${JSON.stringify(keys)}`).not.toContain(symbol.cursor);
      expect(hintLine(back), `after ${JSON.stringify(keys)}`).toContain("→ open");
    }
  });

  it("says where the matrix is on Codex's MCP tab", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, TAB);
    await press(instance, "2");
    await press(instance, "m");
    const frame = await seen(instance, (f) => f.includes("The matrix is on Claude's MCP tab."));
    expect(frame).toContain("Claude  [Codex]");
    expect(frame).not.toContain("SERVER");
  });

  it("moves the table's cursor a page at a time on pgdn and pgup", async () => {
    const many = (h: TestHome) => {
      for (let n = 1; n <= 12; n++) h.skill(".claude/skills", `s${String(n).padStart(2, "0")}`);
    };
    const { instance } = screen(await seed(many), 80, 24);
    await seen(instance, (f) => onRow(f));
    await press(instance, ENTER);
    await seen(instance, (f) => focusedOn(f, "deploy-check"));
    // Fifteen rows under two headings; six lines show at 80 by 24, over the line that says how
    // many more. A page moves five lines, Global's heading among them.
    await press(instance, PAGE_DOWN);
    await seen(instance, (f) => focusedOn(f, "s02"));
    await press(instance, PAGE_DOWN);
    await seen(instance, (f) => focusedOn(f, "s07"));
    await press(instance, PAGE_UP);
    await seen(instance, (f) => focusedOn(f, "s02"));
    await press(instance, PAGE_UP);
    await seen(instance, (f) => focusedOn(f, "deploy-check"));
  });

  it("goes from the details to the table and from the table to the scopes on ←", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    await moveTo(instance, "deploy-check");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    await press(instance, LEFT);
    const table = await seen(instance, (f) => !f.includes("PROJECT › deploy-check"));
    expect(focusedOn(table, "deploy-check")).toBe(true);
    await press(instance, LEFT);
    const scopes = await seen(instance, (f) => !f.includes(symbol.cursor));
    expect(hintLine(scopes)).toContain("→ open");
  });

  it("keeps the cursor on a row when a search leaves fewer rows than it was down", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, RIGHT);
    // The last row of three.
    await moveTo(instance, "eli5");
    await press(instance, "/");
    await typeSlowly(instance, "deploy");
    await press(instance, ENTER);
    const searched = await seen(instance, (f) => f.includes("/deploy") && !f.includes("▏"));
    expect(searched).not.toContain("eli5");
    expect(focusedOn(searched, "deploy-check")).toBe(true);
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
  });

  it.each([
    [60, 24],
    [80, 24],
    [140, 40],
  ])("keeps every frame inside a %i by %i terminal through Codex, Hooks, the project list and a search", async (columns, rows) => {
    const { instance } = screen(await seed(more), columns, rows);
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, TAB);
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("Explain things to Codex"));
    await press(instance, TAB);
    await press(instance, "3");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("When Claude finishes replying"));
    await press(instance, "1");
    await press(instance, "p");
    await seen(instance, (f) => listOpen(f));
    await scopeTo(instance, "web");
    await press(instance, ENTER);
    await seen(instance, (f) => !listOpen(f) && f.includes("▸ Project"));
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("web-only"));
    await press(instance, "/");
    await typeSlowly(instance, "web");
    await seen(instance, (f) => f.includes("/web▏"));
    for (const frame of instance.frames) {
      expect(height(frame)).toBeLessThanOrEqual(rows - 2);
      for (const line of stripAnsi(frame).split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("starts outside every project: the row, the subtitle and the Project table say so (Review Focus 3)", async () => {
    // As at the filesystem root: no project is here.
    const { currentProject: _, ...outside } = await seed();
    const { instance } = screen(outside, 140, 40);
    const none = await seen(instance, (f) => f.includes("No project — pick one with p"));
    expect(none).toContain("Extensions │ No project — pick one with p");
    expect(none).toMatch(/▸ No project +\d+ +│/);
    expect(none).not.toContain("(here)");
    // Loaded lists only what loads with no project.
    expect(none).not.toContain("deploy-check");
    expect(none).toContain("eli5");
    await scopeTo(instance, "Project");
    const project = await seen(instance, (f) => f.includes("PROJECT — "));
    expect(project.split("\n").find((line) => line.includes("PROJECT — "))).toContain("pick one with p");
    // The header has said it: no second line says it again.
    expect(project.split("\n").filter((line) => line.includes("pick one with p"))).toHaveLength(2);
    // The list has the projects only, the cursor on the first.
    await press(instance, "p");
    const list = (await seen(instance, (f) => listOpen(f))).split("\n");
    const head = list.findIndex((line) => listOpen(line));
    expect(list[head + 1]).toMatch(/▸ app +1/);
    expect(list.slice(head).join("\n")).not.toContain("No project");
  });

  it("says so on p where no project is recorded, rather than open an empty list", async () => {
    const { currentProject: _, ...outside } = await seed();
    const none = { ...outside, projects: [] };
    // With the writes, for what a change that needs a project says.
    const tree = <ExtensionsScreen load={async () => none} onExit={vi.fn()} writes={writesFor(none.homeDir)} />;
    const instance = mount(tree, 140, 40);
    const title = await seen(instance, (f) => f.includes("Read "));
    expect(title).toContain("Extensions │ No project\n");
    await press(instance, "p");
    const frame = await seen(instance, (f) => f.includes("No projects to pick"));
    expect(frame).toContain("No projects to pick: Claude Code and Codex have recorded none.");
    expect(listOpen(frame)).toBe(false);
    // With none to pick, nothing says to pick one with p: the Project table, a change, the matrix.
    await scopeTo(instance, "Project");
    const project = await seen(instance, (f) => f.includes("PROJECT — "));
    expect(project.split("\n").find((line) => line.includes("PROJECT — "))).toMatch(/PROJECT — no project +0$/);
    await scopeTo(instance, "Global");
    await press(instance, RIGHT);
    await moveTo(instance, "eli5");
    await press(instance, " ");
    await seen(instance, (f) => f.includes("There is no project to change it in. Run csn in a project."));
    await press(instance, "2");
    await press(instance, "m");
    await seen(instance, (f) => f.includes("Run csn in a project first."));
    for (const shown of instance.frames) expect(stripAnsi(shown)).not.toMatch(/pick one with p|first: p/i);
  });

  it("says a sentence for a scope with nothing in it, never a blank pane (Review Focus 1)", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const { instance } = screen(inv, 100, 30);
    const frame = await seen(instance, (f) => f.includes("Nothing is loaded here."));
    // Started in the home dir, which is a project for what Claude Code keys by it.
    expect(frame).toMatch(/Extensions │ ~\n/);
    expect(frame).toMatch(/▸ ~ \(here\) +0/);
    expect(frame).toMatch(/Project +0/);
    // The empty table has the focus: there is no row to open, so enter is not offered.
    await press(instance, RIGHT);
    const empty = hintLine(await seen(instance, (f) => f.includes("← scopes")));
    expect(empty).not.toContain("enter");
    expect(empty).toContain("esc back");
    await press(instance, LEFT);
    await press(instance, DOWN);
    expect(await seen(instance, (f) => f.includes("PROJECT — "))).toContain("Nothing in this project's own files.");
  });

  it("hints the keys that work where the focus is, fitted to one line", async () => {
    const inv = await seed();
    expect(inv.warnings).toHaveLength(1);
    const { instance } = screen(inv, 80, 24);
    const scopes = hintLine(await seen(instance, (f) => onRow(f)));
    expect(scopes).toContain("↑↓ move");
    expect(scopes).toContain("→ open");
    expect(scopes).toContain("1 2 3 kind");
    expect(scopes).toContain("w 1 unreadable");
    expect(scopes).toContain("esc back");
    expect(scopes).not.toContain("enter details");
    await press(instance, "2");
    await press(instance, ENTER);
    const table = hintLine(await seen(instance, (f) => f.includes("LOADED — ")));
    expect(table).toContain("enter details");
    expect(table).toContain("m matrix");
    expect(table).toContain("/ search");
    expect(table).toContain("w 1 unreadable");
    expect(table).not.toContain("→ open");
    const narrow = screen(inv, 60, 20).instance;
    const narrowHints = hintLine(await seen(narrow, (f) => onRow(f)));
    expect(narrowHints).toContain("→ open");
    expect(narrowHints).toContain("/ search");
    expect(narrowHints.length).toBeLessThanOrEqual(60);
  });

  it("lays the screen out again when the terminal is resized", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("LOADED — ") && onRow(f));
    instance.resize(60);
    const narrow = await seen(instance, (f) => onRow(f) && !f.includes("LOADED — "));
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("lists unreadable files and goes back on esc, then leaves", async () => {
    const { instance, onExit } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "w");
    await seen(instance, (f) => f.includes("settings.local.json"));
    await press(instance, ESC);
    await seen(instance, (f) => f.includes("eli5"));
    await type(instance, ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("says how many more files could not be read than fit", async () => {
    const h = new TestHome();
    homes.push(h);
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const projects = names.map((name) => h.project(`repos/${name}`));
    h.claude("default", ".claude", { projects: Object.fromEntries(projects.map((p) => [p, {}])) });
    for (const name of names) h.write(`repos/${name}/.claude/settings.local.json`, "{ broken");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    expect(inv.warnings).toHaveLength(7);
    const { instance } = screen(inv, 60, 20);
    await seen(instance, (f) => f.includes("Skills"));
    await press(instance, "w");
    const frame = await seen(instance, (f) => f.includes("could not be read"));
    // Five lines for the panes at 20 rows: the heading, three files and the line that says the rest.
    expect(frame).toContain("+4 more");
    expect(frame.split("\n").filter((line) => line.includes("settings.local.json"))).toHaveLength(3);
    expect(height(instance.lastFrame())).toBeLessThanOrEqual(18);
  });

  it("scrolls a detail with ↑↓ and says how many lines are hidden either way", async () => {
    // Five rows for the panes: the title, a blank line, and three of github's seven.
    const { instance } = screen(await seed(), 80, 20);
    await seen(instance, (f) => onRow(f));
    await press(instance, "2");
    await press(instance, ENTER);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    const first = await seen(instance, (f) => f.includes("Runs"));
    expect(first).toMatch(/↓ \d+ more/);
    expect(first).not.toMatch(/↑ \d+ more/);
    expect(hintLine(first)).toMatch(/^ *↑↓ scroll │ .*esc back/);
    let frame = first;
    for (let i = 0; i < 20 && /↓ \d+ more/.test(frame); i++) {
      await press(instance, DOWN);
      frame = stripAnsi(instance.lastFrame() ?? "");
    }
    expect(frame).not.toMatch(/↓ \d+ more/);
    expect(frame).toMatch(/↑ \d+ more/);
    await press(instance, ESC);
    expect(focusedOn(await seen(instance, (f) => f.includes("ACCOUNTS")), "github")).toBe(true);
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("hints no scrolling for a detail that fits", async () => {
    const { instance } = screen(await seed(), 60, 30);
    await seen(instance, (f) => onRow(f));
    await press(instance, ENTER);
    await moveTo(instance, "deploy-check");
    await press(instance, ENTER);
    const frame = await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    expect(frame).not.toMatch(/more/);
    expect(frame).not.toContain("scroll");
    expect(frame).toContain("esc back");
  });

  describe("a long command", () => {
    const words = [
      "/opt/servers/long-command-mcp/dist/index.js",
      "--config",
      "/etc/long-command-mcp/config.json",
      "--workspace",
      "/srv/projects/a-workspace-with-a-rather-long-name",
      "--log-level",
      "debug",
      "--end-marker-zz",
    ];
    const longServer = (h: TestHome) => {
      h.write("repos/app/.mcp.json", { mcpServers: { "long-cmd": { command: "node", args: words } } });
    };
    /** Opens long-cmd's details: a .mcp.json server not yet approved is in Project, not Loaded. */
    const openLongCmd = async (instance: Instance, twoPanes: boolean) => {
      await seen(instance, (f) => onRow(f));
      await press(instance, "2");
      await scopeTo(instance, "Project");
      await press(instance, twoPanes ? RIGHT : ENTER);
      await moveTo(instance, "long-cmd");
      await press(instance, ENTER);
      return seen(instance, (f) => f.includes("PROJECT › long-cmd"));
    };

    it("wraps it in the details, every word shown and every line inside the pane", async () => {
      const { instance } = screen(await seed(longServer), 140, 40);
      const frame = await openLongCmd(instance, true);
      const rows = rightPane(frame);
      const runs = rows.findIndex((row) => row.startsWith("Runs"));
      expect(runs).toBeGreaterThan(0);
      // The Runs line and the lines it runs on to, under its label's column.
      const end = rows.findIndex((row, i) => i > runs && !row.startsWith(" "));
      const wrapped = rows.slice(runs, end < 0 ? undefined : end);
      expect(wrapped.length).toBeGreaterThan(1);
      // Every character in order across the lines: a word longer than a line is broken inside it.
      expect(wrapped.join("").replace(/^Runs/, "").replace(/\s+/g, "")).toBe(`node${words.join("")}`);
      expect(frame).not.toMatch(/…/);
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(140);
    });

    it("says how many lines are below when the details cannot hold them", async () => {
      const { instance } = screen(await seed(longServer), 140, 20);
      const frame = await openLongCmd(instance, true);
      expect(frame).toMatch(/↓ \d+ more/);
      for (const shown of instance.frames) expect(height(shown)).toBeLessThanOrEqual(18);
    });

    it("scrolls to the end of it at 60 columns", async () => {
      const { instance } = screen(await seed(longServer), 60, 24);
      let frame = await openLongCmd(instance, false);
      for (let i = 0; i < 20 && !frame.includes("--end-marker-zz"); i++) {
        await press(instance, DOWN);
        frame = stripAnsi(instance.lastFrame() ?? "");
      }
      expect(frame).toContain("--end-marker-zz");
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    });
  });

  it("shows a failed read and reads again on r", async () => {
    const inv = await seed();
    const load = vi
      .fn<() => Promise<Inventory>>()
      .mockRejectedValueOnce(new Error("disk on fire"))
      .mockResolvedValue(inv);
    const instance = mount(<ExtensionsScreen load={load} onExit={vi.fn()} />, 100);
    await seen(instance, (f) => f.includes("Could not read the inventory: disk on fire"));
    await press(instance, "r");
    await seen(instance, (f) => f.includes("eli5"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves on esc while the inventory is still being read", async () => {
    const onExit = vi.fn();
    const instance = mount(<ExtensionsScreen load={() => new Promise<Inventory>(() => {})} onExit={onExit} />, 100);
    await seen(instance, (f) => f.includes("Reading skills"));
    await type(instance, ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("reads once for a caller that passes a new load on every render, and again on r", async () => {
    const inv = await seed();
    const read = vi.fn(async () => inv);
    let settled = () => {};
    const rendered = new Promise<void>((resolve) => {
      settled = resolve;
    });
    function Host() {
      const [renders, setRenders] = useState(0);
      useEffect(() => {
        if (renders < 3) setRenders(renders + 1);
        else settled();
      }, [renders]);
      return <ExtensionsScreen load={() => read()} onExit={() => {}} />;
    }
    const instance = mount(<Host />, 140);
    await rendered;
    await seen(instance, (f) => f.includes("eli5"));
    expect(read).toHaveBeenCalledTimes(1);
    // The read again ends on the frame it started from, so there is no redraw to wait for.
    await type(instance, "r");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("says how long the read took in milliseconds under a second", async () => {
    const inv = await seed();
    // The screen reads the clock when the read starts, when it ends, and for the status line.
    let calls = 0;
    const now = () => 1_000_000 + 6 * calls++;
    const instance = mount(<ExtensionsScreen load={async () => inv} onExit={vi.fn()} now={now} />, 100);
    expect(await seen(instance, (f) => f.includes("Read "))).toContain(`Read ${inv.items.length} items in 12 ms`);
  });

  it("draws a server that is not in an account in the legend's muted colour, not the border's", () => {
    expect(MARK_COLOR.absent).toBe(color.muted);
  });

  it("keeps two spaces after every matrix cell it cuts, so long account names never run together", async () => {
    const matrix: Matrix = {
      columns: [
        { key: "claude:alexandra-personal", label: "alexandra-personal" },
        { key: "claude:benjamin-workplace", label: "benjamin-workplace" },
      ],
      rows: [{ name: `a-server-with-a-long-name-${"x".repeat(12)}`, cells: ["on", "off"] }],
    };
    const instance = mount(<McpMatrix matrix={matrix} cursor={0} top={0} height={8} width={100} offset={0} />, 104);
    const lines = (await seen(instance, (f) => f.includes("SERVER"))).split("\n");
    const header = lines.find((line) => line.includes("SERVER")) ?? "";
    const row = lines.find((line) => line.includes("a-server")) ?? "";
    expect(header).toContain("alexandra…  benjamin-…");
    expect(row).toMatch(/… {2}●/);
    // Each mark still sits under its account's label.
    expect(row.indexOf(symbol.dot)).toBe(header.indexOf("alexandra"));
    expect(row.indexOf(symbol.circle)).toBe(header.indexOf("benjamin"));
  });
});
