import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import { TestHome } from "../../extensions/test-home.js";
import {
  ago,
  buildMatrix,
  buildRows,
  cell,
  countItems,
  detailOf,
  detailWindow,
  listColumns,
  maxDetailTop,
  nameWidth,
  pickLayout,
  type Row,
} from "./view-model.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

/** `more` adds to the home before the inventory is read, for a test that needs one more file. */
async function seed(more?: (h: TestHome, app: string, web: string) => void) {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg" } } }, [web]: {} },
    skillUsage: { eli5: { usageCount: 7, lastUsedAt: Date.now() - 2 * 86_400_000 } },
  });
  h.claude("work", ".claude-work", {
    projects: { [app]: { disabledMcpServers: ["stitch"] } },
    mcpServers: { stitch: { command: "s" } },
  });
  h.link(".claude/skills", ".claude-work/skills");
  h.skill(".claude/skills", "eli5", "Explain things simply");
  h.skill(".agents/skills", "eli5", "Explain things simply");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "name-only" } });
  const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
  h.skill(".claude/plugins/cache/m/sp/1.0.0/skills", "brainstorming");
  h.write(".claude/settings.json", {
    enabledPlugins: { "sp@m": true },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
  });
  h.codex("personal", ".codex", '[mcp_servers.exa]\ncommand = "npx"\n');
  more?.(h, app, web);
  const inv = await loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd: app,
    managedSettings: h.path("none.json"),
  });
  return { h, app, web, inv };
}
const labels = (rows: Row[]) =>
  rows.map((r) =>
    r.type === "group"
      ? `# ${r.label} (${r.count})${r.open ? "" : " +"}`
      : `  ${r.name} ${r.tools.join(",")} ${r.state}`,
  );
const base = { filter: "all" as const, query: "", open: {}, now: Date.now() };

/** The seed's sp plugin, installed in the default account only, brings an MCP server. */
const pluginServer = (h: TestHome) => {
  h.write(".claude/plugins/cache/m/sp/1.0.0/.mcp.json", { mcpServers: { search: { command: "search-mcp" } } });
};
/** App's .mcp.json brings a server that no account has approved or denied. */
const projectServer = (h: TestHome) => {
  h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
};
const items = (rows: Row[]) => rows.filter((r) => r.type === "item");

describe("buildRows", () => {
  it("groups skills by where they live, this project first, other projects and plugins closed", async () => {
    const { app, inv } = await seed();
    expect(labels(buildRows(inv, { ...base, tab: "skills", project: app }))).toEqual([
      "# Global (1)",
      "  eli5 claude,codex name-only / on",
      "# Project · app (1)",
      "  deploy-check claude on",
      "# Plugin · sp (1) +",
      "# Project · web (1) +",
    ]);
  });

  it("opens every group while searching or filtering, and searches names and descriptions", async () => {
    const { app, inv } = await seed();
    expect(labels(buildRows(inv, { ...base, tab: "skills", project: app, query: "simply" }))).toEqual([
      "# Global (1)",
      "  eli5 claude,codex name-only / on",
    ]);
    expect(labels(buildRows(inv, { ...base, tab: "skills", project: app, filter: "loaded" }))).toEqual([
      "# Global (1)",
      "  eli5 claude,codex name-only / on",
      "# Project · app (1)",
      "  deploy-check claude on",
      "# Plugin · sp (1)",
      "  sp:brainstorming claude on",
    ]);
    expect(countItems(inv, { ...base, tab: "skills", project: app })).toBe(4);
  });

  it("reads MCP state per account and hooks with their command", async () => {
    const { app, inv } = await seed();
    const mcp = buildRows(inv, { ...base, tab: "mcp", project: app });
    expect(labels(mcp)).toEqual([
      "# User (2)",
      "  exa codex on",
      "  stitch claude off",
      "# Project · app (1)",
      "  pg-dev claude on",
    ]);
    const hooks = buildRows(inv, { ...base, tab: "hooks", project: app });
    const stop = hooks.find((r) => r.type === "item");
    expect(stop?.type === "item" && stop.extra).toBe("notify");
  });

  it("reads another project's group in that project's own settings", async () => {
    const { web, app, inv } = await seed((h) => {
      h.write("repos/web/.claude/settings.local.json", { skillOverrides: { "web-only": "off" } });
    });
    const rows = buildRows(inv, { ...base, tab: "skills", project: app, open: { [`project:${web}`]: true } });
    expect(labels(rows)).toContain("  web-only claude off");
    const webOnly = rows.find((r) => r.type === "item" && r.name === "web-only");
    if (webOnly?.type !== "item") throw new Error("no web-only row");
    const here = {
      label: "Here",
      text: `C off (${path.join("~", "repos", "web", ".claude", "settings.local.json")})`,
      tone: "warning",
    };
    expect(detailOf(inv, webOnly, app, Date.now())).toContainEqual(here);
    // Seen from no project at all it is still read in web, so it is not called global.
    expect(detailOf(inv, webOnly, undefined, Date.now())).toContainEqual(here);
    // The Off filter reads it there too, so it lists web-only although app has no switch for it.
    expect(labels(buildRows(inv, { ...base, tab: "skills", project: app, filter: "off" }))).toContain(
      "  web-only claude off",
    );
  });

  it("reads a plugin installed for another project, header and rows, in that project", async () => {
    const { web, app, inv } = await seed((h, _app, web) => {
      const lp = h.path(".claude/plugins/cache/m/lp/1.0.0");
      h.write(".claude/plugins/installed_plugins.json", {
        plugins: {
          "sp@m": [{ installPath: h.path(".claude/plugins/cache/m/sp/1.0.0") }],
          "lp@m": [{ installPath: lp, scope: "local", projectPath: web }],
        },
      });
      h.skill(".claude/plugins/cache/m/lp/1.0.0/skills", "lint");
      h.write("repos/web/.claude/settings.local.json", { enabledPlugins: { "lp@m": true } });
    });
    const closed = buildRows(inv, { ...base, tab: "skills", project: app });
    // The project's install is a group of its own, apart from the user-wide sp, and starts closed.
    expect(closed.filter((r) => r.type === "group" && r.key.startsWith("plugin:"))).toMatchObject([
      { key: `plugin:lp@m|${web}`, label: "Plugin · lp · web", open: false, state: "on" },
      { key: "plugin:sp@m", label: "Plugin · sp", open: false },
    ]);
    const rows = buildRows(inv, { ...base, tab: "skills", project: app, open: { [`plugin:lp@m|${web}`]: true } });
    expect(labels(rows)).toContain("  lp:lint claude on");
  });

  it("gives each hook its own row, though two share an event", async () => {
    const { app, inv } = await seed((h) => {
      h.write(".claude/settings.json", {
        enabledPlugins: { "sp@m": true },
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "notify" },
                { type: "command", command: "say done" },
              ],
            },
          ],
        },
      });
    });
    const rows = buildRows(inv, { ...base, tab: "hooks", project: app });
    expect(rows.find((r) => r.type === "group")).toMatchObject({ label: "User settings", count: 2 });
    const stops = items(rows).map((r) => r.type === "item" && { name: r.name, extra: r.extra, ids: r.items.length });
    expect(stops).toEqual([
      { name: "Stop", extra: "notify", ids: 1 },
      { name: "Stop", extra: "say done", ids: 1 },
    ]);
    expect(new Set(items(rows).map((r) => r.key)).size).toBe(2);
    expect(countItems(inv, { ...base, tab: "hooks", project: app })).toBe(2);
  });

  it("counts a server's accounts: an owner's, or each with the plugin, and none for .mcp.json", async () => {
    const { app, inv } = await seed((h) => {
      pluginServer(h);
      projectServer(h);
    });
    const rows = items(buildRows(inv, { ...base, tab: "mcp", project: app, open: { "plugin:sp@m": true } }));
    const extra = Object.fromEntries(rows.map((r) => [r.name, r.type === "item" && r.extra]));
    expect(extra).toMatchObject({ "plugin:sp:search": "1 acct", docs: "shared", stitch: "1 acct" });
  });
});

describe("detailOf", () => {
  it("says where each copy is, its state here, and its usage by account", async () => {
    const { app, inv } = await seed();
    const row = buildRows(inv, { ...base, tab: "skills", project: app }).find(
      (r) => r.type === "item" && r.name === "eli5",
    );
    if (row?.type !== "item") throw new Error("no eli5 row");
    const text = detailOf(inv, row, app, Date.now()).map((l) => `${l.label ?? ""}|${l.text}`);
    expect(text[0]).toBe("|Explain things simply");
    expect(text.filter((t) => t.startsWith("Where|"))).toHaveLength(2);
    expect(text.some((t) => t.startsWith("Here|C name-only"))).toBe(true);
    expect(text.some((t) => t === "Copies|2 copies · same content")).toBe(true);
    expect(text.some((t) => t.startsWith("Used|7 · 2d ago · default 7"))).toBe(true);
  });

  it("says how many copies and versions a name has, counting the project's copy the Where lines leave out", async () => {
    const { app, inv } = await seed((h) => {
      h.skill("repos/app/.claude/skills", "eli5", "The project's own take");
    });
    const global = items(buildRows(inv, { ...base, tab: "skills", project: app })).find(
      (r) => r.type === "item" && r.name === "eli5" && r.group === "global",
    );
    if (global?.type !== "item") throw new Error("no global eli5 row");
    // The Claude and Codex copies are alike; the project's is the one that differs.
    expect(detailOf(inv, global, app, Date.now()).find((l) => l.label === "Copies")).toEqual({
      label: "Copies",
      text: "3 copies · 2 versions",
      tone: "warning",
    });
  });

  it("gives a shadowed copy no usage of its own: Claude counts it under the copy that wins", async () => {
    const { app, inv } = await seed((h) => {
      h.skill("repos/app/.claude/skills", "eli5", "The project's own take");
    });
    const rows = items(buildRows(inv, { ...base, tab: "skills", project: app }));
    const row = (group: string) => {
      const found = rows.find((r) => r.type === "item" && r.name === "eli5" && r.group === group);
      if (found?.type !== "item") throw new Error(`no eli5 row in ${group}`);
      return found;
    };
    const shadowed = row(`project:${app}`);
    expect(shadowed.marks).toContain("shadowed");
    expect(shadowed.used).toBe("—");
    expect(detailOf(inv, shadowed, app, Date.now()).find((l) => l.label === "Used")).toEqual({
      label: "Used",
      text: "counted under the copy that wins",
      tone: "muted",
    });
    expect(row("global").used).toMatch(/^7 · \d+d$/);
  });

  it("gives a plugin's server one Here line per account that has the plugin, and lists those accounts", async () => {
    const { app, inv } = await seed(pluginServer);
    const row = buildRows(inv, { ...base, tab: "mcp", project: app, open: { "plugin:sp@m": true } }).find(
      (r) => r.type === "item" && r.name === "plugin:sp:search",
    );
    if (row?.type !== "item") throw new Error("no plugin:sp:search row");
    const text = detailOf(inv, row, app, Date.now()).map((l) => `${l.label ?? ""}|${l.text}`);
    // The work account has no sp install, so it has no line: it cannot start the server.
    expect(text.filter((t) => t.startsWith("Here|"))).toEqual(["Here|C default on"]);
    expect(text).toContain("Accounts|default");
  });

  it("shows each account's command for a server two accounts define differently", async () => {
    const { app, inv } = await seed((h) => {
      h.claude("a", ".claude-a", { mcpServers: { github: { command: "gh-mcp" } } });
      h.claude("b", ".claude-b", { mcpServers: { github: { command: "github-mcp-server" } } });
    });
    const row = items(buildRows(inv, { ...base, tab: "mcp", project: app })).find((r) => r.name === "github");
    if (row?.type !== "item") throw new Error("no github row");
    expect(row.items).toHaveLength(2);
    const text = detailOf(inv, row, app, Date.now()).map((l) => `${l.label ?? ""}|${l.text}`);
    expect(text.filter((t) => t.startsWith("Command|"))).toEqual(["Command|gh-mcp", "Command|github-mcp-server"]);
    // What both copies say alike is said once.
    expect(text.filter((t) => t.startsWith("Transport|"))).toEqual(["Transport|stdio"]);
    expect(text).toContain("Accounts|a, b");
  });

  it("names the account on the Here line of a server that one account holds", async () => {
    const { app, inv } = await seed((h, project) => {
      h.claude("a", ".claude-a", { mcpServers: { github: { command: "gh-mcp" } }, projects: {} });
      h.claude("b", ".claude-b", {
        mcpServers: { github: { command: "gh-mcp" } },
        projects: { [project]: { disabledMcpServers: ["github"] } },
      });
    });
    const row = items(buildRows(inv, { ...base, tab: "mcp", project: app })).find((r) => r.name === "github");
    if (row?.type !== "item") throw new Error("no github row");
    const here = detailOf(inv, row, app, Date.now()).filter((l) => l.label === "Here");
    expect(here.map((l) => l.text)).toEqual(["C a on", `C b off (${path.join("~", ".claude-b", ".claude.json")})`]);
  });

  it("shows the home dir as ~ in a hook's and a server's command, and leaves the items as read", async () => {
    let home = "";
    const { app, inv } = await seed((h) => {
      home = h.home;
      h.write(".claude/settings.json", {
        enabledPlugins: { "sp@m": true },
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: `${path.join(h.home, "bin", "notify")} --log ${h.home} ${h.home}-old` },
              ],
            },
          ],
        },
      });
      h.write("repos/app/.mcp.json", {
        mcpServers: { docs: { command: "node", args: [path.join(h.home, "mcp", "docs.js")] } },
      });
    });
    // Only where a path starts with the home dir: a sibling named like it is another folder.
    const hookCommand = `${path.join("~", "bin", "notify")} --log ~ ${home}-old`;
    const hook = items(buildRows(inv, { ...base, tab: "hooks", project: app }))[0];
    if (hook?.type !== "item") throw new Error("no hook row");
    expect(hook.extra).toBe(hookCommand);
    expect(detailOf(inv, hook, app, Date.now())).toContainEqual({ label: "Command", text: hookCommand });
    const docs = items(buildRows(inv, { ...base, tab: "mcp", project: app })).find((r) => r.name === "docs");
    if (docs?.type !== "item") throw new Error("no docs row");
    expect(detailOf(inv, docs, app, Date.now())).toContainEqual({
      label: "Command",
      text: `node ${path.join("~", "mcp", "docs.js")}`,
    });
    // Display only: what --json carries is the item's own summary, as it was read.
    expect(hook.items[0]?.summary?.command).toBe(`${path.join(home, "bin", "notify")} --log ${home} ${home}-old`);
    expect(docs.items[0]?.summary?.command).toBe(`node ${path.join(home, "mcp", "docs.js")}`);
  });

  it("says where else a skill is off only for one no project owns", async () => {
    const { web, app, inv } = await seed((h) => {
      h.write("repos/web/.claude/settings.local.json", {
        skillOverrides: { eli5: "off", "web-only": "off", "sp:brainstorming": "off" },
      });
    });
    const open = { [`project:${web}`]: true, "plugin:sp@m": true };
    const rows = items(buildRows(inv, { ...base, tab: "skills", project: app, open }));
    const offIn = (name: string) => {
      const row = rows.find((r) => r.name === name);
      if (row?.type !== "item") throw new Error(`no ${name} row`);
      return detailOf(inv, row, app, Date.now()).find((l) => l.label === "Off in")?.text;
    };
    expect(offIn("eli5")).toBe("web");
    // web-only's Here line already says it is off in web; a plugin's skill ignores skillOverrides.
    expect(offIn("web-only")).toBeUndefined();
    expect(offIn("sp:brainstorming")).toBeUndefined();
  });
});

describe("buildMatrix", () => {
  it("has a column per account that has the project, and Codex", async () => {
    const { app, inv } = await seed();
    const matrix = buildMatrix(inv, app);
    expect(matrix.columns.map((c) => c.label)).toEqual(["default", "work", "Codex"]);
    expect(Object.fromEntries(matrix.rows.map((r) => [r.name, r.cells]))).toEqual({
      exa: ["absent", "absent", "on"],
      "pg-dev": ["on", "absent", "absent"],
      stitch: ["absent", "off", "absent"],
    });
  });

  it("puts a plugin's server only under the accounts that have the plugin", async () => {
    const { app, inv } = await seed(pluginServer);
    const matrix = buildMatrix(inv, app);
    expect(matrix.columns.map((c) => c.label)).toEqual(["default", "work", "Codex"]);
    expect(matrix.rows.find((r) => r.name === "plugin:sp:search")?.cells).toEqual(["on", "absent", "absent"]);
  });

  it("marks a .mcp.json server that no approval names as pending in each account", async () => {
    const { app, inv } = await seed(projectServer);
    expect(buildMatrix(inv, app).rows.find((r) => r.name === "docs")?.cells).toEqual(["pending", "pending", "absent"]);
  });
});

describe("layout helpers", () => {
  it("picks side, stacked and list layouts by width", () => {
    expect(pickLayout(140, 40).mode).toBe("side");
    expect(pickLayout(100, 40).mode).toBe("stacked");
    expect(pickLayout(60, 40).mode).toBe("list");
    const side = pickLayout(140, 40);
    expect(side.listWidth + side.detailWidth + 2).toBe(136);
  });

  it("switches layout at 64 and 110 columns", () => {
    expect(pickLayout(63, 40).mode).toBe("list");
    expect(pickLayout(64, 40).mode).toBe("stacked");
    expect(pickLayout(109, 40).mode).toBe("stacked");
    expect(pickLayout(110, 40).mode).toBe("side");
  });

  it("stacks only when the list and the detail both get 7 lines, inside the body", () => {
    expect(pickLayout(80, 18)).toMatchObject({ mode: "list", listHeight: 6 });
    for (let rows = 0; rows <= 60; rows++) {
      const layout = pickLayout(80, rows);
      const body = Math.max(6, rows - 12);
      if (layout.mode === "stacked") {
        expect(layout.listHeight + layout.detailHeight).toBeLessThanOrEqual(body);
        expect(layout.listHeight).toBeGreaterThanOrEqual(7);
        expect(layout.detailHeight).toBeGreaterThanOrEqual(7);
      } else {
        expect(layout).toMatchObject({ mode: "list", listHeight: body, detailHeight: body });
      }
    }
  });

  it("stacks from a body of 14 lines: 26 rows here, 28 in the terminal the screen is in", () => {
    // The screen keeps two of the terminal's rows back (ExtensionsScreen), so it asks for rows - 2.
    expect(pickLayout(100, 24).mode).toBe("list");
    expect(pickLayout(100, 25).mode).toBe("list");
    expect(pickLayout(100, 26)).toMatchObject({ mode: "stacked", listHeight: 7, detailHeight: 7 });
  });

  it("fills a stacked body: the list takes the lines it needs, from 7 to body - 7, and the detail the rest", () => {
    for (let rows = 26; rows <= 60; rows++) {
      const body = rows - 12;
      for (const lines of [1, 5, 7, 12, 30, 100]) {
        const layout = pickLayout(100, rows, lines);
        expect(layout.mode).toBe("stacked");
        expect(layout.listHeight).toBe(Math.min(Math.max(lines, 7), body - 7));
        expect(layout.detailHeight).toBeGreaterThanOrEqual(7);
        expect(layout.listHeight + layout.detailHeight).toBe(body);
      }
    }
  });

  it("reads a size it cannot know as 80 by 24", () => {
    expect(pickLayout(Number.NaN, Number.POSITIVE_INFINITY)).toEqual(pickLayout(80, 24));
    expect(pickLayout(Number.NaN, 24).mode).toBe("list");
  });

  it("drops columns before the name gets too short", () => {
    expect(listColumns("skills", 120)).toMatchObject({ tool: 4, used: 13, state: 20 });
    expect(listColumns("skills", 60).used).toBe(0);
    expect(listColumns("skills", 40)).toMatchObject({ tool: 0, used: 0, state: 12 });
    // pending-approval is the longest state word, and the MCP state column fits it whole.
    expect(listColumns("mcp", 120).state).toBe("pending-approval".length);
    expect(listColumns("mcp", 40).state).toBe(16);
  });

  it("sizes the name column to the widest name and marks in the whole tab, two spaces before each column", async () => {
    const { app, inv } = await seed();
    // sp:brainstorming is in the plugin's group, which starts closed: the column does not move when it opens.
    expect(nameWidth(inv, "skills", app, Date.now())).toBe(2 + "sp:brainstorming".length);
    // What the name does not need goes after the last column.
    expect(listColumns("skills", 96, 18)).toMatchObject({ name: 18, tool: 4, used: 13, state: 20 });
    expect(listColumns("mcp", 96, 10)).toMatchObject({ name: 10, tool: 4, extra: 8, state: 16 });
    expect(listColumns("hooks", 96, 17)).toMatchObject({ name: 17, tool: 4, extra: 94 - 17 - 2 - (4 + 2) });
    // Capped by what the other columns leave, each with its two spaces.
    expect(listColumns("skills", 60, 80).name).toBe(58 - (4 + 2) - (20 + 2));
  });

  it("scrolls a long detail a line at a time, with a line for what is hidden above and below", () => {
    // Nine lines in seven rows: six and the line below, then the line above, five and the line below.
    expect(detailWindow(9, 7, 0)).toEqual({ start: 0, end: 6, above: 0, below: 3 });
    expect(detailWindow(9, 7, 1)).toEqual({ start: 1, end: 6, above: 1, below: 3 });
    expect(detailWindow(9, 7, 2)).toEqual({ start: 2, end: 7, above: 2, below: 2 });
    // The last top shows the last line, after the line above; a later one is read as it.
    expect(maxDetailTop(9, 7)).toBe(3);
    expect(detailWindow(9, 7, 3)).toEqual({ start: 3, end: 9, above: 3, below: 0 });
    expect(detailWindow(9, 7, 50)).toEqual(detailWindow(9, 7, 3));
    // What fits does not scroll.
    expect(maxDetailTop(7, 7)).toBe(0);
    expect(detailWindow(7, 7, 2)).toEqual({ start: 0, end: 7, above: 0, below: 0 });
  });

  it("cuts long text with an ellipsis on one line, and pads short text", () => {
    expect(cell("a".repeat(70), 10)).toBe(`${"a".repeat(9)}…`);
    expect(cell("ok", 5)).toBe("ok   ");
    expect(cell("anything", 0)).toBe("");
  });

  it("says how long ago in one unit", () => {
    const now = 1_000_000_000_000;
    expect(ago(now - 5 * 60_000, now)).toBe("5m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
    expect(ago(now - 100 * 86_400_000, now)).toBe("3mo");
    expect(ago(now - 800 * 86_400_000, now)).toBe("2y");
  });
});
