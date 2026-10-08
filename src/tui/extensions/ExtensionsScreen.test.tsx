import { type ReactElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
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
import { ItemList } from "./ItemList.js";
import { MARK_COLOR, McpMatrix } from "./McpMatrix.js";
import { type ItemRow, listColumns, type Matrix } from "./view-model.js";

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
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
  h.write("repos/app/.claude/settings.local.json", "{ broken");
  more?.(h);
  return loadInventory({ homeDir: h.home, registry: h.registry, cwd: app, managedSettings: h.path("none.json") });
}

/** An item row as ItemList draws it, for the cases that draw the list alone. */
function itemRow(name: string, marks: ItemRow["marks"] = [], more: Partial<ItemRow> = {}): ItemRow {
  return {
    type: "item",
    key: `global|${name}`,
    group: "global",
    name,
    items: [],
    tools: ["claude"],
    state: "on",
    used: "0",
    extra: "",
    marks,
    ...more,
  };
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

describe("ExtensionsScreen", () => {
  it("lists skills by group with the project in the header", async () => {
    const { instance } = screen(await seed(), 140);
    const frame = await seen(instance, (f) => f.includes("eli5"));
    expect(frame).toContain("Extensions");
    // tilde keeps the platform's separator: ~\\repos\\app on Windows.
    expect(frame).toMatch(/repos[\\/]app/);
    expect(frame).toContain("Global");
    expect(frame).toContain("Project · app");
    expect(frame).toMatch(/Skills 3/);
  });

  it("switches tabs and shows MCP state per account without a secret", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    const frame = await seen(instance, (f) => f.includes("github"));
    expect(frame).toContain("1/2 on");
    // The frames that could hold the key: each server's own detail, beside the list.
    await moveTo(instance, "github");
    expect(await seen(instance, (f) => f.includes("Command"))).toContain("--api-key <hidden>");
    await moveTo(instance, "pg-dev");
    expect(await seen(instance, (f) => f.includes("Env"))).toContain("PGPASSWORD");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("shows no secret in the detail view at 60 columns either", async () => {
    const { instance } = screen(await seed(), 60, 30);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Command"))).toContain("--api-key <hidden>");
    await press(instance, ESC);
    await moveTo(instance, "pg-dev");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Env"))).toContain("PGPASSWORD");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("draws a hook's short command whole, with no ellipsis past the list's edge", async () => {
    const { instance } = screen(await seed(), 60);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    await press(instance, TAB);
    const frame = await seen(instance, (f) => f.includes("[Hooks 1]"));
    const row = frame.split("\n").find((line) => line.includes("notify-me"));
    expect(row).toMatch(/Stop +C +notify-me *$/);
  });

  it("opens the MCP matrix for the project", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    await seen(instance, (f) => f.includes("github"));
    await press(instance, "m");
    const frame = await seen(instance, (f) => f.includes("SERVER"));
    expect(frame).toContain("default");
    expect(frame).toContain("work");
  });

  it("searches, filters and closes a group", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "/");
    await type(instance, "simply");
    const searched = await seen(instance, (f) => f.includes("/simply"));
    expect(searched).not.toContain("deploy-check");
    await press(instance, ESC);
    await press(instance, "f");
    await seen(instance, (f) => f.includes("Loaded here"));
    for (let i = 0; i < 4; i++) await press(instance, "f");
    await seen(instance, (f) => f.includes("Filter: All"));
    await press(instance, ENTER);
    const closed = await seen(instance, (f) => f.includes("▸ Global"));
    expect(closed).toContain("deploy-check");
  });

  it("picks no project, which closes every project's group", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "p");
    await seen(instance, (f) => f.includes("No project — user settings only"));
    await press(instance, UP);
    await press(instance, ENTER);
    const frame = await seen(instance, (f) => f.includes("No project") && f.includes("▸ Project · app"));
    expect(frame).not.toContain("deploy-check");
  });

  it("lists unreadable files and goes back on esc, then leaves", async () => {
    const { instance, onExit } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "w");
    await seen(instance, (f) => f.includes("settings.local.json"));
    await press(instance, ESC);
    await seen(instance, (f) => f.includes("eli5"));
    // Leaving draws nothing here: the App would unmount the screen, and onExit is a stand-in.
    await type(instance, ESC);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stacks the detail under the list at 90 columns and opens it on enter at 60", async () => {
    const inv = await seed();
    const mid = screen(inv, 90, 40).instance;
    await seen(mid, (f) => f.includes("eli5"));
    await press(mid, DOWN);
    const stacked = (await seen(mid, (f) => f.includes("Where"))).split("\n");
    expect(stacked.findIndex((l) => l.includes("Where"))).toBeGreaterThan(stacked.findIndex((l) => l.includes("eli5")));

    const narrow = screen(inv, 60).instance;
    const first = await seen(narrow, (f) => f.includes("Global"));
    expect(first).not.toContain("Where");
    for (const line of first.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    await press(narrow, DOWN);
    await press(narrow, ENTER);
    await seen(narrow, (f) => f.includes("Where"));
  });

  it("says so when a tab has nothing", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const { instance } = screen(inv, 100);
    const frame = await seen(instance, (f) => f.includes("Nothing here"));
    expect(frame).toContain("No project");
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
    const { instance } = screen(inv, 140);
    await seen(instance, (f) => f.includes("Skills"));
    await press(instance, TAB);
    await seen(instance, (f) => f.includes("docs"));
    await press(instance, "m");
    const frame = await seen(instance, (f) => f.includes("No account has opened this project yet."));
    expect(frame).not.toContain("SERVER");
  });

  it("lays the screen out again when the terminal is resized", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("enter to close"));
    instance.resize(60);
    const narrow = await seen(instance, (f) => f.includes("Global") && !f.includes("enter to close"));
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("shows the list alone at 80 by 18, and on enter a detail that says how many lines are below", async () => {
    const { instance } = screen(await seed(), 80, 18);
    await seen(instance, (f) => f.includes("Global"));
    await moveTo(instance, "eli5");
    expect(stripAnsi(instance.lastFrame() ?? "")).not.toMatch(/Where|╭/);
    await press(instance, ENTER);
    const lines = (await seen(instance, (f) => /│ eli5 +│/.test(f))).split("\n");
    const title = lines.findIndex((line) => /│ eli5 +│/.test(line));
    expect(lines[title - 1]).toMatch(/╭─+╮/);
    // Four lines of detail, room for three: two of them and a line that says how many more.
    expect(lines[title + 2]).toMatch(/│ Where /);
    expect(lines[title + 3]).toMatch(/│ ↓ 2 more +│/);
    expect(lines[title + 4]).toMatch(/╰─+╯/);
  });

  it("stacks the detail under the list at 100 columns from 28 rows, not 27", async () => {
    const inv = await seed();
    const tall = screen(inv, 100, 28).instance;
    await seen(tall, (f) => f.includes("Global"));
    await moveTo(tall, "eli5");
    await seen(tall, (f) => f.includes("Where"));
    const short = screen(inv, 100, 27).instance;
    await seen(short, (f) => f.includes("Global"));
    await moveTo(short, "eli5");
    expect(stripAnsi(short.lastFrame() ?? "")).not.toContain("Where");
  });

  it("hints the keys nothing else points to: enter and search at 60 columns, the unreadable files and search at 80", async () => {
    const inv = await seed();
    const hintLine = (frame: string) => frame.split("\n").find((line) => line.includes("↑↓ move")) ?? "";
    const narrow = screen(inv, 60, 20).instance;
    const narrowHints = hintLine(await seen(narrow, (f) => f.includes("eli5")));
    expect(narrowHints).toContain("enter open");
    expect(narrowHints).toContain("/ search");
    expect(inv.warnings).toHaveLength(1);
    const mid = screen(inv, 80, 24).instance;
    const midHints = hintLine(await seen(mid, (f) => f.includes("eli5")));
    expect(midHints).toContain("w 1 unreadable");
    expect(midHints).toContain("/ search");
  });

  it.each([
    [60, 20],
    [80, 24],
    [100, 24],
    [100, 28],
    [140, 32],
  ])("keeps every frame inside a %i by %i terminal, its hints on one line", async (columns, rows) => {
    const { instance } = screen(await seed(), columns, rows);
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, DOWN);
    await seen(instance, (f) => focusedOn(f, "a-very-long"));
    // The tallest frame: a row selected, its detail drawn, and a status line under the list.
    await press(instance, "m");
    const last = await seen(instance, (f) => f.includes("The matrix is on the MCP tab."));
    // Shorter than the terminal: ink 6 redraws a frame as tall as it by clearing the screen.
    for (const frame of instance.frames) expect(height(frame)).toBeLessThan(rows);
    expect(last.split("\n").some((line) => line.includes("↑↓ move") && line.includes("esc back"))).toBe(true);
    for (const line of last.split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
  });

  it("takes every key as search text while typing", async () => {
    const { instance, load } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "/");
    await typeSlowly(instance, "fpmrw");
    const frame = await seen(instance, (f) => f.includes("/fpmrw"));
    expect(frame).toContain("Filter: All");
    expect(frame).toContain("Nothing matches.");
    expect(frame).not.toContain("Show the inventory as seen from");
    expect(frame).not.toContain("SERVER");
    expect(frame).not.toContain("could not be read");
    expect(load).toHaveBeenCalledTimes(1);
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

  it("moves the list's window up when a group closes, so no blank line is left below it", async () => {
    const { instance } = screen(await seed((h) => h.skill(".claude/skills", "zz-last")), 60, 20);
    await seen(instance, (f) => f.includes("Global"));
    await moveTo(instance, "deploy-check");
    // Six rows do not fit under the header, so four do with the line that says how many more:
    // the last has scrolled the first away.
    expect(stripAnsi(instance.lastFrame() ?? "")).not.toContain("▾ Global");
    await press(instance, UP);
    await press(instance, ENTER);
    const frame = await seen(instance, (f) => f.includes("▸ Project · app"));
    expect(frame).toContain("▾ Global");
  });

  it("leaves a group open while a filter holds it", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, "f");
    const before = await seen(instance, (f) => f.includes("2 items · open while a filter or search is on"));
    await type(instance, ENTER);
    expect(stripAnsi(instance.lastFrame() ?? "")).toBe(before);
    // Nor was it closed underneath, to show closed once the filter is off.
    for (let i = 0; i < 4; i++) await press(instance, "f");
    expect(await seen(instance, (f) => f.includes("Filter: All"))).toContain("▾ Global");
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
    expect(frame).toContain("+3 more");
    expect(frame.split("\n").filter((line) => line.includes("settings.local.json"))).toHaveLength(4);
    expect(height(instance.lastFrame())).toBeLessThan(20);
  });

  it("fills the stacked body, so a long detail is not cut while the terminal has room", async () => {
    const inv = await seed();
    const githubAt = async (columns: number) => {
      const { instance } = screen(inv, columns, 40);
      await seen(instance, (f) => f.includes("eli5"));
      await press(instance, TAB);
      await moveTo(instance, "github");
      return seen(instance, (f) => f.includes("Accounts"));
    };
    const stacked = await githubAt(100);
    expect(stacked).not.toMatch(/│ … +│/);
    // As tall as the side-by-side frame, whose detail always takes the whole body.
    expect(height(stacked)).toBe(height(await githubAt(140)));
  });

  it("puts two spaces between columns, in the header and the rows alike", async () => {
    const row = itemRow("eli5", [], { tools: ["claude", "codex"], used: "207 · 3h" });
    const list = mount(
      <ItemList
        rows={[row]}
        cursor={0}
        top={0}
        height={6}
        width={96}
        columns={listColumns("skills", 96, 12)}
        tab="skills"
        empty=""
      />,
      100,
    );
    const lines = (await seen(list, (f) => f.includes("THIS PROJECT"))).split("\n");
    const header = lines.find((line) => line.includes("THIS PROJECT")) ?? "";
    const line = lines.find((l) => l.includes("eli5")) ?? "";
    expect(header).toMatch(/NAME {10}TOOL {2}USED {11}THIS PROJECT/);
    expect(line.indexOf("C X")).toBe(header.indexOf("TOOL"));
    expect(line.indexOf("207")).toBe(header.indexOf("USED"));
    expect(line.indexOf(" on") + 1).toBe(header.indexOf("THIS PROJECT"));
  });

  it("cuts a row's marks before its name, and the name only when no marks fit", async () => {
    // Twenty columns for the name and its marks, after the indent.
    const columns = listColumns("skills", 60, 22);
    const rows = [itemRow("gone-helper", ["broken-link", "cleanup"]), itemRow("a-name-that-has-22-chr", ["cleanup"])];
    const list = mount(
      <ItemList rows={rows} cursor={0} top={0} height={6} width={60} columns={columns} tab="skills" empty="" />,
      60,
    );
    const frame = await seen(list, (f) => f.includes("gone-helper"));
    expect(frame).toContain("gone-helper broken …");
    expect(frame).toContain("a-name-that-has-22-…  C");
    expect(frame).not.toMatch(/a-name.*cleanup/);
  });

  it("hints the matrix on the MCP tab before search, so it fits at 80 by 24 beside an unreadable file", async () => {
    const inv = await seed();
    expect(inv.warnings).toHaveLength(1);
    const { instance } = screen(inv, 80, 24);
    await seen(instance, (f) => f.includes("Skills"));
    await press(instance, TAB);
    const hints = (await seen(instance, (f) => f.includes("[MCP 2]"))).split("\n").find((l) => l.includes("↑↓ move"));
    expect(hints).toContain("w 1 unreadable");
    expect(hints).toContain("m matrix");
  });

  it("scrolls the full-screen detail with ↑↓ and says how many lines are hidden either way", async () => {
    const { instance } = screen(await seed(), 80, 24);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    const first = await seen(instance, (f) => f.includes("Where"));
    expect(first).not.toContain("Env");
    expect(first).toMatch(/↓ \d+ more/);
    expect(first).toContain("↑↓ scroll │ esc back");
    let frame = first;
    for (let i = 0; i < 10 && !frame.includes("Env"); i++) {
      await press(instance, DOWN);
      frame = stripAnsi(instance.lastFrame() ?? "");
    }
    expect(frame).toContain("Env");
    expect(frame).toMatch(/↑ \d+ more/);
    await press(instance, ESC);
    expect(await seen(instance, (f) => f.includes("ACCOUNTS"))).toContain("github");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("hints no scrolling for a full-screen detail that fits", async () => {
    const { instance } = screen(await seed(), 60, 30);
    await seen(instance, (f) => f.includes("Global"));
    await moveTo(instance, "deploy-check");
    await press(instance, ENTER);
    const frame = await seen(instance, (f) => f.includes("Where"));
    expect(frame).not.toMatch(/more/);
    expect(frame).not.toContain("scroll");
    expect(frame).toContain("esc back");
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

  it("says how long the read took in milliseconds under a second", async () => {
    const inv = await seed();
    // The screen reads the clock when the read starts, when it ends, and for the status line.
    let calls = 0;
    const now = () => 1_000_000 + 6 * calls++;
    const instance = mount(<ExtensionsScreen load={async () => inv} onExit={vi.fn()} now={now} />, 100);
    expect(await seen(instance, (f) => f.includes("Read "))).toContain(`Read ${inv.items.length} items in 12 ms`);
  });

  it("cuts a row's marks, not its columns, however many it has", async () => {
    const columns = listColumns("skills", 56);
    const row: ItemRow = {
      type: "item",
      key: "global|a-long-skill-name",
      group: "global",
      name: "a-long-skill-name",
      items: [],
      tools: ["claude"],
      state: "on",
      used: "0",
      extra: "",
      marks: ["cleanup", "shadowed", "broken-link", "differs"],
    };
    const list = mount(
      <ItemList rows={[row]} cursor={0} top={0} height={6} width={56} columns={columns} tab="skills" empty="" />,
      60,
    );
    const lines = (await seen(list, (f) => f.includes("THIS PROJECT"))).split("\n");
    const header = lines.find((line) => line.includes("THIS PROJECT")) ?? "";
    const line = lines.find((l) => l.includes("a-long-skill-name")) ?? "";
    expect(line.slice(header.indexOf("THIS PROJECT")).trimEnd()).toBe("on");
    expect(line.length).toBeLessThanOrEqual(56);
  });
});
