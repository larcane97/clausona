import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";
import { homeScope, itemsIn, otherProjects, SCOPE_LABEL, scopesFor } from "./scopes.js";
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
