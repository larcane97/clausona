import { afterEach, describe, expect, it } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import { TestHome } from "../../extensions/test-home.js";
import { ago, buildMatrix, cell, wrapText } from "./view-model.js";

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

/** The seed's sp plugin, installed in the default account only, brings an MCP server. */
const pluginServer = (h: TestHome) => {
  h.write(".claude/plugins/cache/m/sp/1.0.0/.mcp.json", { mcpServers: { search: { command: "search-mcp" } } });
};
/** App's .mcp.json brings a server that no account has approved or denied. */
const projectServer = (h: TestHome) => {
  h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
};

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

describe("buildMatrix, one server per name", () => {
  /** App's .mcp.json has a stitch, which work has as a user server too, and a pg-dev, which default has as a local one. */
  const sameNames = (h: TestHome) =>
    h.write("repos/app/.mcp.json", { mcpServers: { stitch: { command: "team" }, "pg-dev": { command: "team" } } });

  it("takes in each account the copy Claude Code takes: local, then an approved .mcp.json one, then the user's", async () => {
    const pending = await seed(sameNames);
    const cells = (m: ReturnType<typeof buildMatrix>) => Object.fromEntries(m.rows.map((r) => [r.name, r.cells]));
    // In work the .mcp.json stitch waits for approval, so work's own stitch is the one: off for app.
    expect(cells(buildMatrix(pending.inv, pending.app))).toMatchObject({
      stitch: ["pending", "off", "absent"],
      "pg-dev": ["on", "pending", "absent"],
    });
    const approved = await seed((h) => {
      sameNames(h);
      h.write("repos/app/.claude/settings.json", { enabledMcpjsonServers: ["stitch", "pg-dev"] });
    });
    // Approved, the .mcp.json stitch wins over work's; default's local pg-dev still wins over it.
    expect(cells(buildMatrix(approved.inv, approved.app))).toMatchObject({
      stitch: ["on", "on", "absent"],
      "pg-dev": ["on", "on", "absent"],
    });
  });
});

describe("a .mcp.json in a parent dir", () => {
  async function ancestorSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["tools"] } } });
    h.claude("work", ".claude-work", { projects: { [app]: {} } });
    h.write(".mcp.json", { mcpServers: { tools: { command: "tools-mcp" }, notes: { command: "home-notes" } } });
    h.write("repos/app/.mcp.json", { mcpServers: { notes: { command: "app-notes" } } });
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    return { h, app, inv };
  }

  it("puts in the matrix the copy that wins, each account's approval in this project", async () => {
    const { app, inv } = await ancestorSeed();
    const matrix = buildMatrix(inv, app);
    expect(matrix.columns.map((c) => c.label)).toEqual(["default", "work"]);
    expect(Object.fromEntries(matrix.rows.map((r) => [r.name, r.cells]))).toEqual({
      notes: ["pending", "pending"],
      tools: ["on", "pending"],
    });
  });
});

describe("text helpers", () => {
  it("wraps text at spaces within a width, and a word longer than a line inside it", () => {
    expect(wrapText("npx -y @acme/server --flag value", 12)).toEqual(["npx -y", "@acme/server", "--flag value"]);
    expect(wrapText(`node ${"a".repeat(25)}`, 10)).toEqual(["node", "a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    expect(wrapText("short", 40)).toEqual(["short"]);
    expect(wrapText("", 40)).toEqual([""]);
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
