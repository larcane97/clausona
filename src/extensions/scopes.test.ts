import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";
import { pathKey } from "./read.js";
import { homeScope, itemsIn, otherProjects, pluginContents, rowsIn, SCOPE_LABEL, scopesFor } from "./scopes.js";
import { TestHome } from "./test-home.js";

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
 * Two Claude accounts and a Codex one; projects app and web; a global and a project eli5, and
 * one skill only web has; a Codex eli5; `~/.mcp.json` with `tools`; a hook in user settings.
 * eli5 was used yesterday; every other skill was never used and is 200 days old. `more` adds
 * to the home before the inventory is read.
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

function find(inv: Inventory, test: (item: Inventory["items"][number]) => boolean, what: string) {
  const item = inv.items.find(test);
  if (!item) throw new Error(`no ${what}`);
  return item;
}

describe("scopes", () => {
  it("lists the Claude skill scopes in order, with counts, and leaves out the empty optional ones", async () => {
    const { inv, app } = await seed();
    expect(scopesFor(inv, "claude", "skill", app, NOW).map((s) => [s.id, s.count])).toEqual([
      ["loaded", 3],
      ["project", 2],
      ["global", 2],
      ["other", 1],
      ["unused", 3],
    ]);
    expect(scopesFor(inv, "claude", "skill", app, NOW).map((s) => s.label)).toEqual([
      "Loaded here",
      "Project",
      "Global",
      "Other projects",
      "Not used in 90 days",
    ]);
    // Never used and past the grace period, wherever they are; eli5 was used yesterday.
    expect(
      itemsIn(inv, "claude", "skill", "unused", app, NOW)
        .map((i) => i.name)
        .sort(),
    ).toEqual(["deploy-check", "old-one", "web-only"]);
  });

  it("loads one eli5 here: the global copy, which wins over the project's as Claude Code resolves a name", async () => {
    const { inv, app } = await seed();
    const loaded = itemsIn(inv, "claude", "skill", "loaded", app, NOW);
    expect(loaded.map((i) => i.name).sort()).toEqual(["deploy-check", "eli5", "old-one"]);
    // Claude Code: personal over project. The project's copy is hidden, so it is not loaded.
    expect(loaded.find((i) => i.name === "eli5")?.location.project).toBeUndefined();
    expect(itemsIn(inv, "claude", "skill", "project", app, NOW).map((i) => i.name)).toEqual(["deploy-check", "eli5"]);
    expect(itemsIn(inv, "claude", "skill", "global", app, NOW).map((i) => i.name)).toEqual(["eli5", "old-one"]);
  });

  it("says which scope an item is in, seen from the project", async () => {
    const { inv, app, h } = await seed();
    const globalEli5 = find(
      inv,
      (i) => i.name === "eli5" && i.location.tool === "claude" && !i.location.project,
      "eli5",
    );
    const tools = find(inv, (i) => i.kind === "mcp" && i.name === "tools", "tools");
    const webOnly = find(inv, (i) => i.name === "web-only", "web-only");
    expect(homeScope(globalEli5, app)).toBe("global");
    expect(homeScope(tools, app)).toBe("parents");
    // Seen from the home dir, ~/.mcp.json is that project's own.
    expect(homeScope(tools, h.home)).toBe("project");
    expect(homeScope(webOnly, app)).toBe("other");
    expect(itemsIn(inv, "claude", "mcp", "parents", app, NOW).map((i) => i.name)).toEqual(["tools"]);
    expect(scopesFor(inv, "claude", "mcp", app, NOW).map((s) => s.id)).toEqual(["loaded", "project", "parents"]);
    expect(scopesFor(inv, "claude", "hook", app, NOW).map((s) => [s.id, s.count])).toEqual([
      ["loaded", 1],
      ["project", 0],
      ["global", 1],
    ]);
  });

  it("lists the other projects that have items of the kind, and what each holds", async () => {
    const { inv, app, web } = await seed();
    expect(otherProjects(inv, "claude", "skill", app)).toEqual([{ path: web, name: "web", count: 1 }]);
    expect(itemsIn(inv, "claude", "skill", "other", app, NOW, web).map((i) => i.name)).toEqual(["web-only"]);
    // Without a project to open, "other" lists nothing: its rows are the projects.
    expect(itemsIn(inv, "claude", "skill", "other", app, NOW)).toEqual([]);
    expect(otherProjects(inv, "claude", "mcp", app)).toEqual([]);
  });

  it("gives Codex its own scopes, with no Not used scope", async () => {
    const { inv, app } = await seed((h) => h.skill(".codex/skills/.system", "plan-mode"));
    const scopes = scopesFor(inv, "codex", "skill", app, NOW);
    expect(scopes.map((s) => [s.id, s.count])).toEqual([
      ["loaded", 2],
      ["project", 0],
      ["global", 1],
      ["builtin", 1],
    ]);
    expect(scopes.find((s) => s.id === "builtin")?.label).toBe("Built into Codex");
    expect(scopes.map((s) => s.id)).not.toContain("unused");
    expect(itemsIn(inv, "codex", "skill", "unused", app, NOW)).toEqual([]);
  });

  it("shows Loaded here and Project at 0 when the project has nothing of a kind (Review Focus 1)", async () => {
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
    const scopes = scopesFor(inv, "claude", "hook", app, NOW);
    expect(scopes).toEqual([
      { id: "loaded", label: "Loaded here", count: 0 },
      { id: "project", label: "Project", count: 0 },
    ]);
  });

  it("with no project, counts nothing as the project's and loads only what no project owns (Review Focus 3)", async () => {
    const { inv } = await seed();
    const scopes = scopesFor(inv, "claude", "skill", undefined, NOW);
    expect(scopes.find((s) => s.id === "project")?.count).toBe(0);
    const loaded = itemsIn(inv, "claude", "skill", "loaded", undefined, NOW);
    expect(loaded.map((i) => i.name).sort()).toEqual(["eli5", "old-one"]);
    expect(loaded.filter((i) => i.location.project !== undefined)).toEqual([]);
    // Every project's own items are then another project's.
    expect(otherProjects(inv, "claude", "skill", undefined).map((p) => [p.name, p.count])).toEqual([
      ["app", 2],
      ["web", 1],
    ]);
  });

  it("lists a plugin under Plugins only where it is installed for everyone or for this project", async () => {
    const { inv, app, web } = await seed((h, _app, web) => {
      const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
      const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
      h.write(".claude/plugins/installed_plugins.json", {
        plugins: {
          "kit@m": [{ installPath: kit }],
          "sp@m": [{ scope: "local", projectPath: web, installPath: sp }],
        },
      });
      h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
      h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-skill");
      h.skill(".claude/plugins/cache/m/sp/1.0.0/skills", "sp-skill");
      h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }] },
      });
    });
    const kit = find(inv, (i) => i.kind === "plugin" && i.name === "kit@m", "kit@m");
    const sp = find(inv, (i) => i.kind === "plugin" && i.name === "sp@m", "sp@m");
    expect(homeScope(kit, app)).toBe("plugins");
    expect(homeScope(sp, app)).toBe("other");
    expect(homeScope(sp, web)).toBe("plugins");
    expect(scopesFor(inv, "claude", "skill", app, NOW).find((s) => s.id === "plugins")?.count).toBe(1);
    expect(itemsIn(inv, "claude", "skill", "plugins", app, NOW)).toEqual([kit]);
    // sp brings a hook, kit none: neither is listed under hooks' Plugins from app.
    expect(itemsIn(inv, "claude", "hook", "plugins", app, NOW)).toEqual([]);
    expect(itemsIn(inv, "claude", "hook", "plugins", web, NOW)).toEqual([sp]);
    // The enabled plugin's skill loads here; the plugin itself is a row of Plugins, not of Loaded here.
    const loaded = itemsIn(inv, "claude", "skill", "loaded", app, NOW).map((i) => i.name);
    expect(loaded).toContain("kit:kit-skill");
    expect(loaded).not.toContain("kit@m");
    expect(loaded).not.toContain("sp:sp-skill");
    // sp's skill is web's, among web's other items.
    expect(otherProjects(inv, "claude", "skill", app)).toEqual([{ path: web, name: "web", count: 2 }]);
  });

  it("labels every scope in the words the screen and the CLI use", () => {
    expect(SCOPE_LABEL.builtin("claude")).toBe("Built into Claude Code");
    expect(SCOPE_LABEL.builtin("codex")).toBe("Built into Codex");
    expect(SCOPE_LABEL.parents("claude")).toBe("Parent folders");
    expect(SCOPE_LABEL.managed("claude")).toBe("Managed");
    expect(SCOPE_LABEL.cloud("claude")).toBe("Cloud");
    expect(SCOPE_LABEL.plugins("claude")).toBe("Plugins");
  });

  it("keeps a broken link out of Loaded here, where it is still listed and counted unused", async () => {
    const { inv, app } = await seed((h) => h.link(h.path("gone", "lost"), ".claude/skills/lost"));
    const names = (scope: "loaded" | "global" | "unused") =>
      itemsIn(inv, "claude", "skill", scope, app, NOW).map((i) => i.name);
    expect(names("loaded")).not.toContain("lost");
    expect(names("global")).toContain("lost");
    expect(names("unused")).toContain("lost");
  });

  it("files a Claude built-in skill under its own scope, shown only when there is one", async () => {
    const { inv, app } = await seed((h) =>
      h.write(".claude/settings.json", { skillOverrides: { "claude-api": "off" } }),
    );
    const scopes = scopesFor(inv, "claude", "skill", app, NOW);
    expect(scopes.map((s) => s.id)).toEqual(["loaded", "project", "global", "builtin", "other", "unused"]);
    expect(itemsIn(inv, "claude", "skill", "builtin", app, NOW).map((i) => i.name)).toEqual(["claude-api"]);
    // It is off, so it does not load here.
    expect(itemsIn(inv, "claude", "skill", "loaded", app, NOW).map((i) => i.name)).not.toContain("claude-api");
    expect(path.basename(itemsIn(inv, "claude", "skill", "builtin", app, NOW)[0]?.location.file ?? "")).toBe(
      "settings.json",
    );
  });
});

describe("rows", () => {
  /**
   * Two accounts that each define github (user scope) and pg-dev (local, for app); work turned
   * github off for app. Only default has solo.
   */
  async function servers(): Promise<Seeded> {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    h.claude("default", ".claude", {
      projects: { [app]: { mcpServers: { "pg-dev": { command: "pg" } } }, [web]: {} },
      mcpServers: { github: { command: "gh-mcp" }, solo: { command: "solo-mcp" } },
    });
    h.claude("work", ".claude-work", {
      projects: { [app]: { disabledMcpServers: ["github"], mcpServers: { "pg-dev": { command: "pg" } } } },
      mcpServers: { github: { command: "gh-mcp" } },
    });
    h.skill(".claude/skills", "eli5");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    return { h, inv, app, web };
  }

  const shape = (rows: ReturnType<typeof rowsIn>) =>
    rows.map((r) => ({ key: r.key, name: r.name, accounts: r.items.map((i) => i.location.profile) }));

  it("makes one row of a server that several accounts define, with every account's copy", async () => {
    const { inv, app } = await servers();
    expect(shape(rowsIn(inv, "claude", "mcp", "global", app, NOW))).toEqual([
      { key: "mcp:claude:account:-:github", name: "github", accounts: ["claude:default", "claude:work"] },
      // One account's server keeps the same kind of key, so a key does not change as accounts add it.
      { key: "mcp:claude:account:-:solo", name: "solo", accounts: ["claude:default"] },
    ]);
    expect(shape(rowsIn(inv, "claude", "mcp", "project", app, NOW))).toEqual([
      { key: `mcp:claude:local:${pathKey(app)}:pg-dev`, name: "pg-dev", accounts: ["claude:default", "claude:work"] },
    ]);
    // Counted as rows: github is one server, not two.
    expect(itemsIn(inv, "claude", "mcp", "global", app, NOW)).toHaveLength(3);
    expect(scopesFor(inv, "claude", "mcp", app, NOW).map((s) => [s.id, s.count])).toEqual([
      ["loaded", 3],
      ["project", 1],
      ["global", 2],
    ]);
  });

  it("lists a server in Loaded here with every copy when it loads in one account", async () => {
    const { inv, app } = await servers();
    const github = rowsIn(inv, "claude", "mcp", "loaded", app, NOW).find((r) => r.name === "github");
    expect(github?.key).toBe("mcp:claude:account:-:github");
    expect(github?.items.map((i) => i.location.profile)).toEqual(["claude:default", "claude:work"]);
  });

  it("keys every other row by its item's id", async () => {
    const { inv, app } = await servers();
    const rows = rowsIn(inv, "claude", "skill", "global", app, NOW);
    expect(rows.map((r) => [r.key, r.items.length])).toEqual(
      itemsIn(inv, "claude", "skill", "global", app, NOW).map((i) => [i.id, 1]),
    );
  });

  it("keys a server's row the same from every project", async () => {
    const { inv, app, web } = await servers();
    const fromApp = rowsIn(inv, "claude", "mcp", "project", app, NOW).find((r) => r.name === "pg-dev");
    const fromWeb = rowsIn(inv, "claude", "mcp", "other", web, NOW, app).find((r) => r.name === "pg-dev");
    expect(fromApp?.key).toBeDefined();
    expect(fromWeb?.key).toBe(fromApp?.key);
  });

  it("counts an other project's servers as rows too", async () => {
    const { inv, app, web } = await servers();
    expect(otherProjects(inv, "claude", "mcp", web)).toEqual([{ path: app, name: "app", count: 1 }]);
    expect(shape(rowsIn(inv, "claude", "mcp", "other", web, NOW, app))).toEqual([
      { key: `mcp:claude:local:${pathKey(app)}:pg-dev`, name: "pg-dev", accounts: ["claude:default", "claude:work"] },
    ]);
  });
});

describe("rows across accounts", () => {
  /**
   * Three accounts. default and work each have Cloud's pdf. kit is installed for everyone in
   * default and in work, each from its own folder; sp for everyone in both from one folder; lp
   * for app and, separately, for web. solo and work each have a skills folder of their own.
   */
  async function shared(): Promise<Seeded> {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    h.claude("default", ".claude", {
      projects: { [app]: {}, [web]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
    });
    h.claude("work", ".claude-work", {
      projects: { [app]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc2" },
    });
    h.claude("solo", ".claude-solo");
    h.skill(".claude/skills/synced/org1_acc1", "pdf");
    h.skill(".claude/skills/synced/org1_acc2", "pdf");
    h.skill(".claude-work/skills", "mine");
    h.skill(".claude-solo/skills", "mine");
    const kitA = h.path(".claude/plugins/cache/m/kit/1.0.0");
    const kitB = h.path(".claude-work/plugins/cache/m/kit/1.0.0");
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    const lp = h.path(".claude/plugins/cache/m/lp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: {
        "kit@m": [{ installPath: kitA }],
        "sp@m": [{ installPath: sp }],
        "lp@m": [
          { scope: "project", projectPath: app, installPath: lp },
          { scope: "project", projectPath: web, installPath: lp },
        ],
      },
    });
    h.write(".claude-work/plugins/installed_plugins.json", {
      plugins: { "kit@m": [{ installPath: kitB }], "sp@m": [{ installPath: sp }] },
    });
    h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true, "sp@m": true, "lp@m": true } });
    for (const dir of [".claude/plugins/cache/m/kit/1.0.0", ".claude-work/plugins/cache/m/kit/1.0.0"]) {
      h.skill(`${dir}/skills`, "plan");
      // Two hooks on one event: two rows, each holding both installs' copy.
      h.write(`${dir}/hooks/hooks.json`, {
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "one" },
                { type: "command", command: "two" },
              ],
            },
          ],
        },
      });
    }
    h.skill(".claude/plugins/cache/m/sp/1.0.0/skills", "search");
    h.skill(".claude/plugins/cache/m/lp/1.0.0/skills", "lint");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    return { h, inv, app, web };
  }

  const shape = (rows: ReturnType<typeof rowsIn>) => rows.map((r) => [r.key, r.items.length]);

  it("makes one row of a Cloud skill that several accounts have", async () => {
    const { inv, app } = await shared();
    const rows = rowsIn(inv, "claude", "skill", "cloud", app, NOW);
    expect(shape(rows)).toEqual([["skill:claude:synced:-:pdf", 2]]);
    expect(rows[0]?.items.map((i) => i.location.profile)).toEqual(["claude:default", "claude:work"]);
    expect(itemsIn(inv, "claude", "skill", "cloud", app, NOW)).toHaveLength(2);
    expect(scopesFor(inv, "claude", "skill", app, NOW).find((s) => s.id === "cloud")?.count).toBe(1);
  });

  it("makes one row of a plugin installed for everyone in several accounts, from one folder or two", async () => {
    const { inv, app, web } = await shared();
    expect(shape(rowsIn(inv, "claude", "skill", "plugins", app, NOW))).toEqual([
      ["plugin:claude:user:-:kit@m", 2],
      [`plugin:claude:project:${pathKey(app)}:lp@m`, 1],
      ["plugin:claude:user:-:sp@m", 1],
    ]);
    // One folder in two accounts is one install already, which both accounts have.
    const sp = rowsIn(inv, "claude", "skill", "plugins", app, NOW)[2];
    expect(sp?.items[0]?.location.accounts).toEqual(["claude:default", "claude:work"]);
    expect(itemsIn(inv, "claude", "skill", "plugins", app, NOW)).toHaveLength(4);
    expect(scopesFor(inv, "claude", "skill", app, NOW).find((s) => s.id === "plugins")?.count).toBe(3);
    // The install for web is web's own row.
    expect(rowsIn(inv, "claude", "skill", "plugins", web, NOW).map((r) => r.key)).toContain(
      `plugin:claude:project:${pathKey(web)}:lp@m`,
    );
  });

  it("makes one row of what a plugin brings, across its installs, and keeps two hooks on one event apart", async () => {
    const { inv, app, web } = await shared();
    const loaded = rowsIn(inv, "claude", "skill", "loaded", app, NOW);
    // By name, as the inventory sorts; each account's own "mine" stays a row of its own.
    expect(shape(loaded)).toEqual([
      ["skill:claude:plugin:user:-:kit@m:kit:plan", 2],
      [`skill:claude:plugin:project:${pathKey(app)}:lp@m:lp:lint`, 1],
      ["skill:claude:account:claude:solo:mine", 1],
      ["skill:claude:account:claude:work:mine", 1],
      ["skill:claude:synced:-:pdf", 2],
      ["skill:claude:plugin:user:-:sp@m:sp:search", 1],
    ]);
    expect(shape(rowsIn(inv, "claude", "hook", "loaded", app, NOW))).toEqual([
      ["hook:claude:plugin:user:-:kit@m:SessionStart#0.0", 2],
      ["hook:claude:plugin:user:-:kit@m:SessionStart#0.1", 2],
    ]);
    // web's lp skill is web's, in a row apart from app's.
    expect(shape(rowsIn(inv, "claude", "skill", "other", app, NOW, web))).toEqual([
      [`skill:claude:plugin:project:${pathKey(web)}:lp@m:lp:lint`, 1],
    ]);
    const kit = rowsIn(inv, "claude", "skill", "plugins", app, NOW)[0];
    if (!kit) throw new Error("no kit row");
    const contents = pluginContents(inv, kit);
    expect(shape(contents.skill)).toEqual([["skill:claude:plugin:user:-:kit@m:kit:plan", 2]]);
    expect(contents.hook).toHaveLength(2);
    expect(contents.mcp).toEqual([]);
  });

  it("keeps an account's own skills folder per account", async () => {
    const { inv, app } = await shared();
    const mine = rowsIn(inv, "claude", "skill", "global", app, NOW).filter((r) => r.name === "mine");
    expect(mine.map((r) => [r.items[0]?.location.profile, r.key === r.items[0]?.id])).toEqual([
      ["claude:solo", true],
      ["claude:work", true],
    ]);
  });
});
