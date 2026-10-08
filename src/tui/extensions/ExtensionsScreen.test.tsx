import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import type { Inventory } from "../../extensions/model.js";
import { TestHome } from "../../extensions/test-home.js";
import { stripAnsi } from "../../lib/cli-style.js";
import { DOWN, ENTER, ESC, type Instance, press, renderAt, type, waitForFrame } from "../test-drive.js";
import { windowsOnScreen } from "../test-frames.js";
import { DetailPane } from "./DetailPane.js";
import { ExtensionsScreen } from "./ExtensionsScreen.js";
import { buildRows, pickLayout } from "./view-model.js";

vi.setConfig({ testTimeout: 15_000 });

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const TAB = "\t";
const UP = "\u001B[A";

/** Waits for a frame whose text, colours aside, passes `check`, and returns that text. */
async function seen(instance: Instance, check: (text: string) => boolean): Promise<string> {
  return stripAnsi(await waitForFrame(instance.lastFrame, (frame) => check(stripAnsi(frame))));
}

async function seed(): Promise<Inventory> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", {
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg", env: { PGPASSWORD: KEY } } } } },
    mcpServers: { github: { command: "gh-mcp", args: ["--api-key", KEY] } },
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
  return loadInventory({ homeDir: h.home, registry: h.registry, cwd: app, managedSettings: h.path("none.json") });
}

function screen(inv: Inventory, columns: number, onExit = vi.fn()) {
  const instance = renderAt(<ExtensionsScreen load={async () => inv} onExit={onExit} />, columns);
  return { instance, onExit };
}

describe("ExtensionsScreen", () => {
  it("lists skills by group with the project in the header", async () => {
    const { instance } = screen(await seed(), 140);
    const frame = await seen(instance, (f) => f.includes("eli5"));
    expect(frame).toContain("Extensions");
    expect(frame).toContain("repos/app");
    expect(frame).toContain("Global");
    expect(frame).toContain("Project · app");
    expect(frame).toMatch(/Skills 3/);
    instance.unmount();
  });

  it("switches tabs and shows MCP state per account without a secret", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    const frame = await seen(instance, (f) => f.includes("github"));
    expect(frame).toContain("1/2 on");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
    instance.unmount();
  });

  it("draws a hook's short command whole, with no ellipsis past the list's edge", async () => {
    const { instance } = screen(await seed(), 60);
    await seen(instance, (f) => f.includes("eli5"));
    await press(instance, TAB);
    await press(instance, TAB);
    const frame = await seen(instance, (f) => f.includes("[Hooks 1]"));
    const row = frame.split("\n").find((line) => line.includes("notify-me"));
    expect(row).toMatch(/Stop +C +notify-me *$/);
    instance.unmount();
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
    instance.unmount();
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
    instance.unmount();
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
    instance.unmount();
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
    instance.unmount();
  });

  it("stacks the detail under the list at 90 columns and opens it on enter at 60", async () => {
    const inv = await seed();
    const mid = screen(inv, 90).instance;
    await seen(mid, (f) => f.includes("eli5"));
    await press(mid, DOWN);
    const stacked = (await seen(mid, (f) => f.includes("Where"))).split("\n");
    expect(stacked.findIndex((l) => l.includes("Where"))).toBeGreaterThan(stacked.findIndex((l) => l.includes("eli5")));
    mid.unmount();

    const narrow = screen(inv, 60).instance;
    const first = await seen(narrow, (f) => f.includes("Global"));
    expect(first).not.toContain("Where");
    for (const line of first.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    await press(narrow, DOWN);
    await press(narrow, ENTER);
    await seen(narrow, (f) => f.includes("Where"));
    narrow.unmount();
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
    instance.unmount();
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
    instance.unmount();
  });

  it("lays the screen out again when the terminal is resized", async () => {
    const { instance } = screen(await seed(), 140);
    await seen(instance, (f) => f.includes("enter to close"));
    instance.resize(60);
    const narrow = await seen(instance, (f) => f.includes("Global") && !f.includes("enter to close"));
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    instance.unmount();
  });

  it("keeps the title inside the stacked detail's border at its 3-line floor, 80 by 18", async () => {
    const inv = await seed();
    const layout = pickLayout(80, 18);
    expect(layout).toMatchObject({ mode: "stacked", detailHeight: 3 });
    const project = inv.currentProject;
    const row = buildRows(inv, {
      tab: "skills",
      filter: "all",
      query: "",
      open: {},
      now: 0,
      ...(project ? { project } : {}),
    }).find((r) => r.type === "item" && r.name === "eli5");
    const pane = renderAt(
      <DetailPane
        inv={inv}
        row={row}
        {...(project ? { project } : {})}
        width={layout.detailWidth}
        height={layout.detailHeight}
        now={0}
      />,
      80,
    );
    const lines = (await seen(pane, (f) => f.includes("eli5"))).split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^│ eli5 +│$/);
    pane.unmount();
  });
});
