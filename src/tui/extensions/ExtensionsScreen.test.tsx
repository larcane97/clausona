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
import { MARK_COLOR, McpMatrix } from "./McpMatrix.js";
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

/** Walks the scope list down to `label`, so a test does not count keystrokes. */
async function scopeTo(instance: Instance, label: string) {
  for (let step = 0; step < 12; step++) {
    if (stripAnsi(instance.lastFrame() ?? "").includes(`▸ ${label}`)) return;
    await press(instance, DOWN);
  }
  throw new Error(`the scope list never reached '${label}'`);
}

/** What a frame shows right of the panes' divider, line by line: the table or the details. */
function rightPane(frame: string): string[] {
  return frame.split("\n").map((line) => line.slice(line.lastIndexOf("│ ") + 2));
}

describe("ExtensionsScreen", () => {
  it("opens on Claude's skills with Loaded here selected and its table beside it", async () => {
    const { instance } = screen(await seed(), 140, 40);
    const frame = await seen(instance, (f) => f.includes("deploy-check"));
    expect(frame).toContain("Extensions");
    // tilde keeps the platform's separator: ~\\repos\\app on Windows.
    expect(frame).toMatch(/Extensions │ ~[\\/]repos[\\/]app/);
    expect(frame).toContain("[Claude]  Codex");
    expect(frame).toContain("Skills · MCP · Hooks");
    expect(frame).toContain("▸ Loaded here");
    expect(frame).toContain("LOADED HERE — ");
    expect(frame).toContain("eli5");
    // The scope list has the focus, so no row has the cursor yet.
    expect(frame).not.toContain(symbol.cursor);
    expect(hintLine(frame)).toContain("→ open");
    expect(hintLine(frame)).toContain("tab Codex");
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
    // 200 days on, every skill but none of Codex's is old enough to be called unused.
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
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("PROJECT › deploy-check"));
    // The scope list stays beside the details, so it is clear where they are from.
    expect(details).toContain("▸ Loaded here");
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

  it("opens an other project from its list, and goes back to the list on esc", async () => {
    const { instance } = screen(await seed(more), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await scopeTo(instance, "Other projects");
    const list = await seen(instance, (f) => f.includes("OTHER PROJECTS — "));
    expect(list).toMatch(/repos[\\/]web/);
    await press(instance, RIGHT);
    await moveTo(instance, "web");
    expect(hintLine(stripAnsi(instance.lastFrame() ?? ""))).toContain("enter open");
    await press(instance, ENTER);
    const opened = await seen(instance, (f) => f.includes("OTHER PROJECTS › web"));
    expect(opened).toContain("web-only");
    await press(instance, ESC);
    const back = await seen(instance, (f) => f.includes("OTHER PROJECTS — "));
    expect(focusedOn(back, "web")).toBe(true);
    expect(back).not.toContain("web-only");
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
    await press(instance, ESC);
    const cleared = await seen(instance, (f) => !f.includes("/eli"));
    expect(cleared).toContain("deploy-check");
    expect(cleared).toContain("eli5");
  });

  it("takes every key as search text while typing", async () => {
    const { instance, load } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "/");
    await typeSlowly(instance, "fpmrw123");
    const frame = await seen(instance, (f) => f.includes("/fpmrw123"));
    expect(frame).toContain("[Claude]  Codex");
    expect(frame).toContain("Nothing matches /fpmrw123.");
    expect(frame).not.toContain("Show the inventory as seen from");
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
    await moveTo(instance, "github");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Runs"))).toContain("--api-key <hidden>");
    await press(instance, ESC);
    await moveTo(instance, "pg-dev");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Secrets"))).toContain("PGPASSWORD (value hidden)");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("shows no secret in the details at 60 columns either", async () => {
    const { instance } = screen(await seed(), 60, 30);
    await seen(instance, (f) => f.includes("Loaded here"));
    await press(instance, "2");
    await press(instance, ENTER);
    await moveTo(instance, "github");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Runs"))).toContain("--api-key <hidden>");
    await press(instance, ESC);
    await moveTo(instance, "pg-dev");
    await press(instance, ENTER);
    expect(await seen(instance, (f) => f.includes("Secrets"))).toContain("PGPASSWORD (value hidden)");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it.each([
    [60, 24],
    [72, 30],
    [80, 24],
    [100, 30],
    [140, 40],
  ])("keeps every frame inside a %i by %i terminal: opened, in the table and in a long name's details", async (columns, rows) => {
    const { instance } = screen(await seed(), columns, rows);
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, RIGHT);
    await seen(instance, (f) => focusedOn(f, "a-very-long"));
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("GLOBAL › a-very-long"));
    // Shorter than the terminal by two: ink 6 redraws a frame as tall as it by clearing the screen.
    for (const frame of instance.frames) {
      expect(height(frame)).toBeLessThanOrEqual(rows - 2);
      for (const line of stripAnsi(frame).split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
    expect(hintLine(details)).toContain("esc back");
  });

  it("shows one pane at a time at 80 by 24: the scopes, enter for the table, esc back", async () => {
    const { instance } = screen(await seed(), 80, 24);
    const first = await seen(instance, (f) => f.includes("Loaded here"));
    expect(first).not.toContain("LOADED HERE");
    expect(first).not.toContain("deploy-check");
    await press(instance, ENTER);
    const table = await seen(instance, (f) => f.includes("LOADED HERE"));
    expect(table).toContain("deploy-check");
    expect(table).not.toContain("Loaded here");
    expect(hintLine(table)).toContain("← scopes");
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("GLOBAL › a-very-long"));
    expect(details).not.toContain("LOADED HERE");
    await press(instance, ESC);
    await seen(instance, (f) => f.includes("LOADED HERE"));
    await press(instance, ESC);
    const back = await seen(instance, (f) => f.includes("Loaded here"));
    expect(back).not.toContain("LOADED HERE");
  });

  it("picks no project: the subtitle and the Project table say to pick one (Review Focus 3)", async () => {
    const { instance } = screen(await seed(), 140, 40);
    await seen(instance, (f) => f.includes("deploy-check"));
    await press(instance, "p");
    await seen(instance, (f) => f.includes("No project — user settings only"));
    await press(instance, UP);
    await press(instance, ENTER);
    const none = await seen(instance, (f) => f.includes("No project — pick one with p"));
    expect(none).toContain("Extensions │ No project — pick one with p");
    // Loaded here lists only what loads with no project.
    expect(none).not.toContain("deploy-check");
    expect(none).toContain("eli5");
    await scopeTo(instance, "Project");
    const project = await seen(instance, (f) => f.includes("PROJECT — "));
    expect(project.split("\n").find((line) => line.includes("PROJECT — "))).toContain("pick one with p");
    // The header has said it: no second line says it again.
    expect(project.split("\n").filter((line) => line.includes("pick one with p"))).toHaveLength(2);
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
    expect(frame).toMatch(/Loaded here +0/);
    expect(frame).toMatch(/Project +0/);
    await press(instance, DOWN);
    expect(await seen(instance, (f) => f.includes("PROJECT — "))).toContain("Nothing in this project's own files.");
  });

  it("hints the keys that work where the focus is, fitted to one line", async () => {
    const inv = await seed();
    expect(inv.warnings).toHaveLength(1);
    const { instance } = screen(inv, 80, 24);
    const scopes = hintLine(await seen(instance, (f) => f.includes("Loaded here")));
    expect(scopes).toContain("↑↓ move");
    expect(scopes).toContain("→ open");
    expect(scopes).toContain("1 2 3 kind");
    expect(scopes).toContain("w 1 unreadable");
    expect(scopes).toContain("esc back");
    expect(scopes).not.toContain("enter details");
    await press(instance, "2");
    await press(instance, ENTER);
    const table = hintLine(await seen(instance, (f) => f.includes("LOADED HERE")));
    expect(table).toContain("enter details");
    expect(table).toContain("m matrix");
    expect(table).toContain("/ search");
    expect(table).toContain("w 1 unreadable");
    expect(table).not.toContain("→ open");
    const narrow = screen(inv, 60, 20).instance;
    const narrowHints = hintLine(await seen(narrow, (f) => f.includes("Loaded here")));
    expect(narrowHints).toContain("→ open");
    expect(narrowHints).toContain("/ search");
    expect(narrowHints.length).toBeLessThanOrEqual(60);
  });

  it("lays the screen out again when the terminal is resized", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("LOADED HERE") && f.includes("Loaded here"));
    instance.resize(60);
    const narrow = await seen(instance, (f) => f.includes("Loaded here") && !f.includes("LOADED HERE"));
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("lists the home dir in the picker as ~, the project it was started in", async () => {
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
    await seen(instance, (f) => f.includes("Extensions │ ~"));
    await press(instance, "p");
    const picker = await seen(instance, (f) => f.includes("Show the inventory as seen from:"));
    expect(picker).toMatch(new RegExp(`${symbol.cursor} ${symbol.checkboxOn} ~ here · 1 Claude acct`));
    expect(picker).toMatch(/○ ~[\\/]repos[\\/]app/);
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
    await seen(instance, (f) => f.includes("Loaded here"));
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
    await seen(instance, (f) => f.includes("Loaded here"));
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
    /** Opens long-cmd's details: a .mcp.json server not yet approved is in Project, not Loaded here. */
    const openLongCmd = async (instance: Instance, twoPanes: boolean) => {
      await seen(instance, (f) => f.includes("Loaded here"));
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
