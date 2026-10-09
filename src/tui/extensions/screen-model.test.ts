import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import type { Inventory } from "../../extensions/model.js";
import { pathKey } from "../../extensions/read.js";
import { type ScopeEntry, scopesFor } from "../../extensions/scopes.js";
import { TestHome } from "../../extensions/test-home.js";
import {
  buildTable,
  CHROME_COLUMNS,
  CHROME_ROWS,
  columnText,
  DETAIL_LABEL_WIDTH,
  DIVIDER_COLUMNS,
  detailRows,
  detailWindow,
  KIND_LABEL,
  KINDS,
  listRoom,
  maxDetailTop,
  paneLayout,
  scopeLines,
  scrolled,
  type Table,
  type TableRow,
} from "./screen-model.js";

const DAY = 86_400_000;
/**
 * 200 days after the fixture's files were made. Moving `now` on rather than the files' times
 * back keeps "unused" the same on every OS: a skill's age is its folder's birth time, which
 * utimes moves on macOS only.
 */
const NOW = Date.now() + 200 * DAY;

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

type Seeded = { h: TestHome; inv: Inventory; app: string; web: string };

/**
 * Task 1's fixture. Two Claude accounts and a Codex one; projects app and web; a global and a
 * project eli5, and one skill only web has; a Codex eli5; `~/.mcp.json` with `tools`; a hook in
 * user settings. eli5 was used yesterday; every other skill was never used and is 200 days old.
 * `more` adds to the home before the inventory is read.
 */
async function seed(more?: (h: TestHome, app: string, web: string) => void): Promise<Seeded> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    projects: { [app]: {}, [web]: {} },
    skillUsage: { eli5: { usageCount: 4, lastUsedAt: NOW - DAY } },
  });
  h.claude("work", ".claude-work", { projects: { [app]: {} } });
  h.codex("personal", ".codex");
  h.skill(".claude/skills", "eli5", "Explain things simply");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "eli5");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".agents/skills", "eli5");
  h.write(".mcp.json", { mcpServers: { tools: { command: "tools-mcp" } } });
  h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
  more?.(h, app, web);
  const inv = await loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd: app,
    managedSettings: h.path("none.json"),
  });
  return { h, inv, app, web };
}

/** A home whose project app has nothing of its own, for the empty tables. */
async function bare(): Promise<Seeded> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", { projects: { [app]: {} } });
  const inv = await loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd: app,
    managedSettings: h.path("none.json"),
  });
  return { h, inv, app, web: "" };
}

const titles = (table: Table) => table.columns.map((c) => c.title);
const names = (table: Table) => table.rows.map((r) => r.row?.name ?? r.project?.name);
const cells = (row: TableRow | undefined) => row?.cells.map((c) => c.trim());
const byName = (table: Table, name: string) => table.rows.find((r) => r.row?.name === name);
/** A path as the screen shows it, in this OS's separators and case: compare with `pathKey`. */
const sameText = (a: string | undefined, b: string) => pathKey(a ?? "") === pathKey(b);

const LONG = `a-skill-with-a-name-long-enough-to-crowd-out-every-column-${"x".repeat(2)}`;

describe("tables", () => {
  it("lists Claude's global skills with their use, and the project's hidden copy with its tag", async () => {
    const { inv, app } = await seed();
    const global = buildTable(inv, "claude", "skill", "global", app, NOW, 100, "");
    expect(titles(global)).toEqual(["NAME", "USES", "LAST USED"]);
    expect(names(global)).toEqual(["eli5", "old-one"]);
    expect(cells(byName(global, "eli5"))).toEqual(["eli5", "4", "1d ago"]);
    // Never used: the count is 0, and LAST USED says never.
    expect(cells(byName(global, "old-one"))).toEqual(["old-one", "0", "never"]);
    expect(byName(global, "old-one")?.tag).toEqual({ text: "unused", tone: "warning" });
    expect(byName(global, "eli5")?.tag).toBeUndefined();
    // USES is right-aligned, its gap after it.
    const uses = global.columns[1];
    if (!uses) throw new Error("no USES column");
    expect(uses.align).toBe("right");
    expect(byName(global, "eli5")?.cells[1]).toBe(`${"4".padStart(uses.width - 2)}  `);
    expect(columnText("USES", uses)).toBe(`${"USES".padStart(uses.width - 2)}  `);

    const project = buildTable(inv, "claude", "skill", "project", app, NOW, 100, "");
    expect(names(project)).toEqual(["deploy-check", "eli5"]);
    expect(byName(project, "eli5")?.tag).toEqual({ text: "hidden by Global copy", tone: "muted" });
    // A hidden copy never loads: Claude counts its name's use under the copy that wins.
    expect(cells(byName(project, "eli5"))).toEqual(["eli5", "—", "—"]);
    expect(byName(project, "eli5")?.row?.items[0]?.location.project).toBe(app);
  });

  it("adds FROM after the first column in Loaded here", async () => {
    const { inv, app } = await seed();
    const loaded = buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "");
    expect(titles(loaded)).toEqual(["NAME", "FROM", "USES", "LAST USED"]);
    expect(names(loaded)).toEqual(["deploy-check", "eli5", "old-one"]);
    expect(byName(loaded, "eli5")?.cells[1]?.trim()).toBe("Global");
    expect(byName(loaded, "deploy-check")?.cells[1]?.trim()).toBe("Project");
    expect(loaded.header).toBe(
      `LOADED HERE — what Claude Code loads in ${path.join("~", "repos", "app")}, in at least one account`,
    );
    expect(loaded.count).toBe(3);
    expect(loaded.empty).toBe("");
  });

  it("gives Codex skills a muted DESCRIPTION and no use", async () => {
    const { inv, app } = await seed();
    const global = buildTable(inv, "codex", "skill", "global", app, NOW, 100, "");
    expect(titles(global)).toEqual(["NAME", "DESCRIPTION"]);
    expect(global.columns[1]?.muted).toBe(true);
    expect(cells(global.rows[0])).toEqual(["eli5", "eli5 skill"]);
    expect(titles(buildTable(inv, "codex", "skill", "loaded", app, NOW, 100, ""))).toEqual([
      "NAME",
      "FROM",
      "DESCRIPTION",
    ]);
  });

  it("says when a hook runs in plain words, and what it runs", async () => {
    const { inv, app } = await seed();
    const hooks = buildTable(inv, "claude", "hook", "global", app, NOW, 100, "");
    expect(titles(hooks)).toEqual(["WHEN", "RUNS"]);
    expect(hooks.rows[0]?.cells[0]?.trim()).toBe("When Claude finishes replying");
    expect(hooks.rows[0]?.cells[1]?.trim()).toBe("notify-me");
    expect(titles(buildTable(inv, "claude", "hook", "loaded", app, NOW, 100, ""))).toEqual(["WHEN", "FROM", "RUNS"]);
  });

  it("sorts hooks by when they run, two on one event in the inventory's order", async () => {
    const { inv, app } = await seed((h) =>
      h.write(".claude/settings.json", {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "second-by-name" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "zz-first" }] }],
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "b-one" },
                { type: "command", command: "a-two" },
              ],
            },
          ],
        },
      }),
    );
    const hooks = buildTable(inv, "claude", "hook", "global", app, NOW, 100, "");
    expect(hooks.rows.map((r) => [r.cells[0]?.trim(), r.cells[1]?.trim()])).toEqual([
      ["Before Bash runs", "b-one"],
      ["Before Bash runs", "a-two"],
      ["When a session starts", "zz-first"],
      ["When Claude finishes replying", "second-by-name"],
    ]);
  });

  it("lists other projects with their path and count, and opens one in the project's columns", async () => {
    const { inv, app, web } = await seed();
    const list = buildTable(inv, "claude", "skill", "other", app, NOW, 100, "");
    expect(titles(list)).toEqual(["PROJECT", "PATH", "COUNT"]);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.project).toEqual({ path: web, name: "web", count: 1 });
    expect(list.rows[0]?.row).toBeUndefined();
    expect(list.rows[0]?.key).toBe(web);
    expect(cells(list.rows[0])?.[0]).toBe("web");
    expect(sameText(cells(list.rows[0])?.[1], path.join("~", "repos", "web"))).toBe(true);
    expect(cells(list.rows[0])?.[2]).toBe("1");
    expect(list.columns[2]?.align).toBe("right");
    expect(list.count).toBe(1);

    const opened = buildTable(inv, "claude", "skill", "other", app, NOW, 100, "", web);
    expect(titles(opened)).toEqual(["NAME", "USES", "LAST USED"]);
    expect(names(opened)).toEqual(["web-only"]);
    expect(opened.header.startsWith("OTHER PROJECTS › web — ")).toBe(true);
    expect(opened.count).toBe(1);
  });

  it("lists what is not used in 90 days with where it is", async () => {
    const { inv, app } = await seed();
    const unused = buildTable(inv, "claude", "skill", "unused", app, NOW, 100, "");
    expect(titles(unused)).toEqual(["NAME", "WHERE", "LAST USED"]);
    // This project's reads Project, as FROM and the CLI's WHERE say it; another project's, its name.
    expect(unused.rows.map(cells)).toEqual([
      ["deploy-check", "Project", "never"],
      ["old-one", "Global", "never"],
      ["web-only", "web", "never"],
    ]);
    expect(unused.rows.every((r) => r.tag?.text === "unused" && r.tag.tone === "warning")).toBe(true);
    // A search reads WHERE as the row shows it.
    expect(names(buildTable(inv, "claude", "skill", "unused", app, NOW, 100, "global"))).toEqual(["old-one"]);
  });

  it("says which Claude accounts have an MCP server, and what a Codex one runs", async () => {
    const { inv, app } = await seed((h, app, web) => {
      h.claude("default", ".claude", {
        projects: { [app]: {}, [web]: {} },
        mcpServers: { github: { command: "gh-mcp" }, solo: { command: "solo-mcp" } },
      });
      h.claude("work", ".claude-work", { projects: { [app]: {} }, mcpServers: { github: { command: "gh-mcp" } } });
      h.codex("personal", ".codex", '[mcp_servers.exa]\ncommand = "npx"\n');
    });
    const claude = buildTable(inv, "claude", "mcp", "global", app, NOW, 100, "");
    expect(titles(claude)).toEqual(["NAME", "ACCOUNTS"]);
    // github is one row for both accounts' copies.
    expect(claude.rows.map(cells)).toEqual([
      ["github", "all"],
      ["solo", "default"],
    ]);
    expect(claude.count).toBe(2);
    expect(byName(claude, "github")?.row?.items).toHaveLength(2);
    expect(byName(claude, "github")?.key).toBe("mcp:claude:account:-:github");
    // A search reads ACCOUNTS as the row shows it.
    expect(names(buildTable(inv, "claude", "mcp", "global", app, NOW, 100, "default"))).toEqual(["solo"]);
    // A parent folder's .mcp.json is every account's.
    expect(cells(buildTable(inv, "claude", "mcp", "parents", app, NOW, 100, "").rows[0])).toEqual(["tools", "all"]);
    const codex = buildTable(inv, "codex", "mcp", "global", app, NOW, 100, "");
    expect(titles(codex)).toEqual(["NAME", "RUNS"]);
    expect(codex.rows.map(cells)).toEqual([["exa", "npx"]]);
  });

  it("says which parent folder's .mcp.json a loaded server is from, and still fits a narrow table", async () => {
    const { inv, app } = await seed((h, app, web) =>
      h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["tools"] }, [web]: {} } }),
    );
    const loaded = buildTable(inv, "claude", "mcp", "loaded", app, NOW, 100, "");
    expect(titles(loaded)).toEqual(["NAME", "FROM", "ACCOUNTS"]);
    expect(byName(loaded, "tools")?.cells[1]?.trim()).toBe(path.join("~", ".mcp.json"));
    const narrow = buildTable(inv, "claude", "mcp", "loaded", app, NOW, 30, "");
    expect(narrow.rows).toHaveLength(1);
    for (const row of narrow.rows) {
      expect(row.cells.join("").length + (row.tag?.text.length ?? 0)).toBeLessThanOrEqual(30);
    }
  });

  it("lists plugins with what they contain", async () => {
    const { inv, app } = await seed((h) => {
      const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
      h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
      h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
      h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-skill");
      h.write(".claude/plugins/cache/m/kit/1.0.0/hooks/hooks.json", {
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "kit-start" }] }] },
      });
    });
    const plugins = buildTable(inv, "claude", "skill", "plugins", app, NOW, 100, "");
    expect(titles(plugins)).toEqual(["NAME", "CONTAINS"]);
    expect(plugins.rows.map(cells)).toEqual([["kit@m", "1 skill · 1 hook"]]);
    expect(plugins.count).toBe(1);
    expect(names(buildTable(inv, "claude", "skill", "plugins", app, NOW, 100, "hook"))).toEqual(["kit@m"]);
    expect(
      byName(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, ""), "kit:kit-skill")?.cells[1]?.trim(),
    ).toBe("kit");
  });

  it("sums a Cloud skill's use over the accounts that have it, and takes the latest", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      projects: { [app]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
      skillUsage: { pdf: { usageCount: 2, lastUsedAt: NOW - 3 * DAY } },
    });
    h.claude("work", ".claude-work", {
      projects: { [app]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc2" },
      skillUsage: { pdf: { usageCount: 3, lastUsedAt: NOW - DAY } },
    });
    h.skill(".claude/skills/synced/org1_acc1", "pdf");
    h.skill(".claude/skills/synced/org1_acc2", "pdf");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const cloud = buildTable(inv, "claude", "skill", "cloud", app, NOW, 100, "");
    expect(cloud.rows).toHaveLength(1);
    expect(cloud.rows[0]?.row?.items).toHaveLength(2);
    expect(cells(cloud.rows[0])).toEqual(["pdf", "5", "1d ago"]);
  });

  it("names the scope in the header as scopeSentence says it", async () => {
    const { inv, app } = await seed();
    const global = buildTable(inv, "claude", "skill", "global", app, NOW, 100, "");
    expect(global.header.startsWith("GLOBAL — ")).toBe(true);
    expect(global.header).toContain(path.join("~", ".claude", "skills"));
  });
});

describe("empty tables", () => {
  it("says a sentence for an empty project and an empty Loaded here (Review Focus 1)", async () => {
    const { inv, app } = await bare();
    const project = buildTable(inv, "claude", "hook", "project", app, NOW, 80, "");
    expect(project.rows).toEqual([]);
    expect(project.count).toBe(0);
    expect(project.empty).toBe("Nothing in this project's own files.");
    expect(buildTable(inv, "claude", "hook", "loaded", app, NOW, 80, "").empty).toBe("Nothing is loaded here.");
    expect(buildTable(inv, "claude", "hook", "global", app, NOW, 80, "").empty).toBe("None.");
    expect(buildTable(inv, "claude", "hook", "other", app, NOW, 80, "").empty).toBe("None.");
  });

  it("with no project, leaves the Project sentence to the header alone (Review Focus 3)", async () => {
    const { inv } = await seed();
    const project = buildTable(inv, "claude", "skill", "project", undefined, NOW, 80, "");
    expect(project.header).toBe("PROJECT — no project · pick one with p");
    expect(project.rows).toEqual([]);
    expect(project.empty).toBe("");
  });

  it("says a search matched nothing, and still counts the scope's rows", async () => {
    const { inv, app } = await seed();
    const none = buildTable(inv, "claude", "skill", "loaded", app, NOW, 80, "zzz");
    expect(none.rows).toEqual([]);
    expect(none.count).toBe(3);
    expect(none.countText).toBe("0 of 3");
    expect(none.empty).toBe("Nothing matches /zzz.");
  });
});

describe("search", () => {
  it("finds global items by their file as the screen shows it, ~ for home", async () => {
    const { inv, app } = await seed();
    const found = buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, path.join("~", ".claude"));
    expect(names(found)).toEqual(["eli5", "old-one"]);
    expect(found.count).toBe(3);
  });

  it("counts the matches of the rows while a search is on, and the rows alone when not", async () => {
    const { inv, app } = await seed();
    expect(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "").countText).toBe("3");
    expect(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "ELI").countText).toBe("1 of 3");
    // Spaces alone are no search.
    expect(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "  ").countText).toBe("3");
  });

  it("matches names and descriptions in any case, and an other project's name", async () => {
    const { inv, app } = await seed();
    expect(names(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "ELI"))).toEqual(["eli5"]);
    expect(names(buildTable(inv, "claude", "skill", "global", app, NOW, 100, "simply"))).toEqual(["eli5"]);
    expect(names(buildTable(inv, "claude", "skill", "other", app, NOW, 100, "WEB"))).toEqual(["web"]);
    expect(names(buildTable(inv, "claude", "skill", "other", app, NOW, 100, "nope"))).toEqual([]);
  });

  it("matches what the row shows: a hook's WHEN, a FROM, but not a count or a time", async () => {
    const { inv, app } = await seed();
    const stop = buildTable(inv, "claude", "hook", "global", app, NOW, 100, "finishes");
    expect(stop.rows.map((r) => r.cells[0]?.trim())).toEqual(["When Claude finishes replying"]);
    expect(names(buildTable(inv, "claude", "skill", "loaded", app, NOW, 100, "project"))).toEqual(["deploy-check"]);
    // eli5 was used "1d ago": a time is no word to search for.
    expect(buildTable(inv, "claude", "skill", "global", app, NOW, 100, "d ago").rows).toEqual([]);
  });

  it("matches a summary value as read and with ~ for home", async () => {
    const { inv, app, h } = await seed((h) =>
      h.write(".claude/settings.json", {
        hooks: { Stop: [{ hooks: [{ type: "command", command: path.join(h.home, "bin", "notify") }] }] },
      }),
    );
    const shown = buildTable(inv, "claude", "hook", "global", app, NOW, 100, path.join("~", "bin"));
    expect(shown.rows).toHaveLength(1);
    expect(sameText(shown.rows[0]?.cells[1]?.trim(), path.join("~", "bin", "notify"))).toBe(true);
    expect(buildTable(inv, "claude", "hook", "global", app, NOW, 100, path.join(h.home, "bin")).rows).toHaveLength(1);
    expect(buildTable(inv, "claude", "hook", "global", app, NOW, 100, "notify").rows).toHaveLength(1);
  });
});

describe("widths", () => {
  it("cuts a long name with … and keeps every row within the width (Review Focus 4)", async () => {
    const { inv, app } = await seed((h) => h.skill(".claude/skills", LONG));
    expect(LONG).toHaveLength(60);
    const table = buildTable(inv, "claude", "skill", "global", app, NOW, 40, "");
    for (const row of table.rows) expect(row.cells.join("").length).toBeLessThanOrEqual(40);
    expect(byName(table, LONG)?.cells[0]?.trimEnd().endsWith("…")).toBe(true);
    // The tag still fits beside the cells.
    for (const row of table.rows) {
      expect(row.cells.join("").length + (row.tag?.text.length ?? 0)).toBeLessThanOrEqual(40);
    }
  });

  it("sizes the name to its widest cell and leaves the rest to the tag", async () => {
    const { inv, app } = await seed();
    const table = buildTable(inv, "claude", "skill", "global", app, NOW, 100, "");
    // "old-one" and its gap.
    expect(table.columns[0]?.width).toBe("old-one".length + 2);
    // The columns stay put while a search narrows the rows.
    expect(buildTable(inv, "claude", "skill", "global", app, NOW, 100, "eli").columns).toEqual(table.columns);
  });

  it("fits every table of every scope at every width: cells as wide as their column, cells and tag within the width", async () => {
    const { inv, app, web } = await seed((h) => {
      h.skill(".claude/skills", LONG, `${"a long description ".repeat(8)}`);
      h.skill(".agents/skills", LONG, `${"a long description ".repeat(8)}`);
      h.write(".claude/settings.json", {
        hooks: { Stop: [{ hooks: [{ type: "command", command: `run ${"x".repeat(120)}` }] }] },
      });
    });
    for (const tool of ["claude", "codex"] as const) {
      for (const kind of KINDS) {
        const scopes = scopesFor(inv, tool, kind, app, NOW);
        const tables = scopes.map((s) => s.id).map((scope) => ({ scope, other: undefined as string | undefined }));
        tables.push({ scope: "other", other: web });
        for (const { scope, other } of tables) {
          for (const width of [16, 30, 40, 60, 80, 100, 140]) {
            const table = buildTable(inv, tool, kind, scope, app, NOW, width, "", other);
            const what = `${tool} ${kind} ${scope} ${other ?? ""} at ${width}`;
            expect(
              table.columns.reduce((sum, c) => sum + c.width, 0),
              what,
            ).toBeLessThanOrEqual(width);
            for (const row of table.rows) {
              expect(
                row.cells.map((c) => c.length),
                what,
              ).toEqual(table.columns.map((c) => c.width));
              expect(row.cells.join("").length + (row.tag?.text.length ?? 0), what).toBeLessThanOrEqual(width);
            }
          }
        }
      }
    }
  });
});

describe("tag width", () => {
  const HIDDEN = "hidden by Global copy";
  const widths = (table: Table) => table.columns.map((c) => c.width);
  /** What the columns leave the tag. */
  const tagRoom = (table: Table, width: number) => width - table.columns.reduce((sum, c) => sum + c.width, 0);
  /**
   * The project table: NAME as wide as "deploy-check" and its gap (14), USES (6), LAST USED (11).
   * At its least NAME keeps 10, 8 characters and the gap, so the columns take 27 at least.
   */
  const project = (inv: Inventory, app: string, width: number) =>
    buildTable(inv, "claude", "skill", "project", app, NOW, width, "");

  it("shows a tag whole where it fits", async () => {
    const { inv, app } = await seed();
    for (const width of [14 + 6 + 11 + HIDDEN.length, 100]) {
      expect(byName(project(inv, app, width), "eli5")?.tag).toEqual({ text: HIDDEN, tone: "muted" });
    }
    expect(widths(project(inv, app, 52))).toEqual([14, 6, 11]);
  });

  it("cuts a tag with … and keeps it 12 wide at a narrow width, NAME giving way first", async () => {
    // github is off for app in work only.
    const { inv, app } = await seed((h, app, web) => {
      h.claude("default", ".claude", { projects: { [app]: {}, [web]: {} }, mcpServers: { github: { command: "gh" } } });
      h.claude("work", ".claude-work", {
        projects: { [app]: { disabledMcpServers: ["github"] } },
        mcpServers: { github: { command: "gh" } },
      });
    });
    const servers = buildTable(inv, "claude", "mcp", "global", app, NOW, 30, "");
    const tag = byName(servers, "github")?.tag;
    expect(tag?.text).toBe("off in 1 of…");
    expect(tag?.text).toHaveLength(12);
    // NAME (8) and ACCOUNTS (10) fit whole beside it.
    expect(widths(servers)).toEqual([8, 10]);
    // The project table at 40: NAME is cut to 11 so the tag keeps its 12.
    const skills = project(inv, app, 40);
    expect(widths(skills)).toEqual([11, 6, 11]);
    expect(byName(skills, "eli5")?.tag?.text).toBe("hidden by G…");
    expect(byName(skills, "deploy-check")?.cells[0]?.trimEnd()).toBe("deploy-c…");
    // At every width: at least 12 whenever the columns at their least leave 12, else all they leave.
    for (let width = 16; width <= 80; width++) {
      const table = project(inv, app, width);
      const room = tagRoom(table, width);
      if (width >= 27 + 12) expect(room, `at ${width}`).toBeGreaterThanOrEqual(12);
      else expect(room, `at ${width}`).toBe(Math.max(0, width - 27));
      const text = byName(table, "eli5")?.tag?.text ?? "";
      expect(text, `at ${width}`).toHaveLength(Math.min(HIDDEN.length, room));
      if (text !== "" && text.length < HIDDEN.length) expect(text.endsWith("…"), `at ${width}`).toBe(true);
    }
  });

  it("lets the tag give way once NAME is down to 10, then drops it, then cuts columns from the right", async () => {
    const { inv, app } = await seed();
    // The tag takes what is left: 3 at 30.
    const at30 = project(inv, app, 30);
    expect(widths(at30)).toEqual([10, 6, 11]);
    expect(byName(at30, "eli5")?.tag).toEqual({ text: "hi…", tone: "muted" });
    // Nothing left at 27: no tag, every column at its least.
    const at27 = project(inv, app, 27);
    expect(widths(at27)).toEqual([10, 6, 11]);
    expect(at27.rows.every((r) => r.tag === undefined)).toBe(true);
    // Narrower, the last column gives way; NAME keeps its 10.
    const at20 = project(inv, app, 20);
    expect(widths(at20)).toEqual([10, 6, 4]);
    expect(at20.rows.every((r) => r.tag === undefined && r.cells.join("").length <= 20)).toBe(true);
  });
});

describe("kinds", () => {
  it("names the kinds in the bar's order", () => {
    expect(KINDS).toEqual(["skill", "mcp", "hook"]);
    expect(KINDS.map((k) => KIND_LABEL[k])).toEqual(["Skills", "MCP", "Hooks"]);
  });
});

describe("paneLayout", () => {
  it("puts two panes side by side from 100 columns, the scope list as wide as its widest line", async () => {
    const { inv, app } = await seed();
    const list = scopesFor(inv, "claude", "skill", app, NOW);
    const two = paneLayout(140, 40, list);
    expect(two.mode).toBe("two");
    // "Not used in 90 days" + two spaces + "3", and 4 for the marker and the room before the divider.
    expect(two.scopeWidth).toBe("Not used in 90 days".length + 2 + 1 + 4);
    expect(two.scopeWidth).toBeLessThanOrEqual(32);
    expect(two.scopeWidth + DIVIDER_COLUMNS + two.tableWidth).toBe(140 - CHROME_COLUMNS);
    expect(paneLayout(100, 40, list).mode).toBe("two");
  });

  it("keeps the scope pane to 32 columns", () => {
    const wide: ScopeEntry[] = [{ id: "loaded", label: "x".repeat(40), count: 12345 }];
    expect(paneLayout(140, 40, wide).scopeWidth).toBe(32);
  });

  it("shows one pane at a time under 100 columns: the table at the full width, the scope list as narrow as beside it", () => {
    const scopes: ScopeEntry[] = [
      { id: "loaded", label: "Loaded here", count: 162 },
      { id: "project", label: "Project", count: 35 },
    ];
    const one = paneLayout(99, 40, scopes);
    expect(one.mode).toBe("one");
    expect(one.tableWidth).toBe(99 - CHROME_COLUMNS);
    // Each count stays next to its label: "Loaded here  162" and 4 for the marker and the edge.
    expect(one.scopeWidth).toBe("Loaded here  162".length + 4);
    expect(one.scopeWidth).toBe(paneLayout(140, 40, scopes).scopeWidth);
    expect(paneLayout(80, 24, [{ id: "loaded", label: "x".repeat(40), count: 1 }]).scopeWidth).toBe(32);
    // Never wider than the terminal leaves.
    expect(paneLayout(20, 24, [{ id: "loaded", label: "x".repeat(40), count: 1 }]).scopeWidth).toBe(
      20 - CHROME_COLUMNS,
    );
  });

  it("leaves the chrome its rows and the frame two rows short of the terminal", () => {
    // Title, tool and kind bar, status and hints.
    expect(CHROME_ROWS).toBe(13);
    expect(paneLayout(140, 40, []).height).toBe(40 - 2 - CHROME_ROWS);
    expect(paneLayout(80, 24, []).height).toBe(24 - 2 - CHROME_ROWS);
    // A size that is not a number, as from a stream that is no terminal, reads as 80 by 24.
    expect(paneLayout(Number.NaN, Number.NaN, [])).toEqual(paneLayout(80, 24, []));
  });
});

describe("scopeLines", () => {
  const entry = (id: ScopeEntry["id"], count = 1): ScopeEntry => ({ id, label: id, count });

  it("puts a rule after Loaded here and another before Not used in 90 days", () => {
    const lines = scopeLines([entry("loaded"), entry("project"), entry("global"), entry("unused")]);
    expect(lines.map((l) => (l.type === "rule" ? "─" : l.entry.id))).toEqual([
      "loaded",
      "─",
      "project",
      "global",
      "─",
      "unused",
    ]);
    // Each rule has a key of its own.
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });

  it("draws no rule before an unused scope that is not there", () => {
    expect(scopeLines([entry("loaded"), entry("project")]).map((l) => l.type)).toEqual(["scope", "rule", "scope"]);
  });
});

describe("windows", () => {
  it("shows every line that fits, else one fewer for the line that says how many more", () => {
    expect(listRoom(5, 5)).toBe(5);
    expect(listRoom(5, 6)).toBe(4);
    expect(listRoom(1, 6)).toBe(1);
    expect(listRoom(0, 6)).toBe(0);
  });

  it("keeps the cursor in view, and the window inside the lines there are", () => {
    expect(scrolled(0, 2, 4, 10)).toBe(0);
    expect(scrolled(0, 6, 4, 10)).toBe(3);
    expect(scrolled(5, 2, 4, 10)).toBe(2);
    // A search narrowed the list: the window moves up rather than show blank lines.
    expect(scrolled(6, 2, 4, 3)).toBe(0);
  });

  it("scrolls a detail to where its last line shows under the line that says how many are above", () => {
    expect(detailWindow(9, 7, 0)).toEqual({ start: 0, end: 6, above: 0, below: 3 });
    expect(detailWindow(9, 7, 1)).toEqual({ start: 1, end: 6, above: 1, below: 3 });
    expect(detailWindow(9, 7, 2)).toEqual({ start: 2, end: 7, above: 2, below: 2 });
    expect(maxDetailTop(9, 7)).toBe(3);
    expect(detailWindow(9, 7, 3)).toEqual({ start: 3, end: 9, above: 3, below: 0 });
    expect(detailWindow(9, 7, 50)).toEqual(detailWindow(9, 7, 3));
    // All of it fits, or there is no room for a line between the two markers: nothing scrolls.
    expect(maxDetailTop(7, 7)).toBe(0);
    expect(detailWindow(7, 7, 2)).toEqual({ start: 0, end: 7, above: 0, below: 0 });
    expect(maxDetailTop(9, 2)).toBe(0);
  });
});

describe("detailRows", () => {
  it("wraps a long value under its label's column, and a line with no label at the full width", () => {
    const rows = detailRows(
      [
        { text: "a description that runs on past the width" },
        { label: "Runs", text: "node /opt/long/index.js --flag", tone: "muted" },
        { label: "File", text: "short" },
      ],
      30,
    );
    expect(DETAIL_LABEL_WIDTH).toBe(10);
    expect(rows.map(({ label, text }) => [label, text])).toEqual([
      [undefined, "a description that runs on"],
      [undefined, "past the width"],
      ["Runs", "node"],
      ["", "/opt/long/index.js"],
      ["", "--flag"],
      ["File", "short"],
    ]);
    // Every row fits: its label's column and its text.
    for (const row of rows) {
      expect((row.label === undefined ? 0 : DETAIL_LABEL_WIDTH) + row.text.length).toBeLessThanOrEqual(30);
    }
    // A wrapped line keeps its tone.
    expect(rows[3]?.tone).toBe("muted");
  });

  it("gives two lines that read the same each an id of its own", () => {
    const rows = detailRows(
      [
        { label: "", text: "on" },
        { label: "", text: "on" },
      ],
      40,
    );
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it("breaks a word longer than the room inside it, so a command is read in full", () => {
    const word = "x".repeat(45);
    const rows = detailRows([{ label: "Runs", text: word }], 30);
    expect(rows.map((r) => r.text).join("")).toBe(word);
    expect(rows.every((r) => r.text.length <= 20)).toBe(true);
  });
});
