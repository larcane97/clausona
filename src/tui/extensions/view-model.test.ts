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
  listColumns,
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
    expect(text.some((t) => t === "Copies|same content")).toBe(true);
    expect(text.some((t) => t.startsWith("Used|7 · 2d ago · default 7"))).toBe(true);
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
