import { realpathSync, utimesSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import { duplicateGroups, loadInventory, marksOf, usageOf } from "./inventory.js";
import { relevantIn, stateOf } from "./state.js";
import { TestHome } from "./test-home.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});
const DAY = 86_400_000;

function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", {
    projects: { [app]: {} },
    skillUsage: { eli5: { usageCount: 3, lastUsedAt: 1_000 }, "old-tool": { usageCount: 1, lastUsedAt: 10 } },
  });
  h.claude("work", ".claude-work", { skillUsage: { eli5: { usageCount: 181, lastUsedAt: 5_000 } } });
  h.link(".claude/skills", ".claude-work/skills");
  h.skill(".claude/skills", "eli5", "Explain", "one");
  h.skill(".agents/skills", "eli5", "Explain", "one");
  h.skill(".claude/skills", "plannotator", "Plan", "claude copy");
  h.skill(".agents/skills", "plannotator", "Plan", "codex copy");
  h.skill(".claude/skills", "old-tool");
  h.skill(".claude/skills", "never-used");
  h.codex("personal", ".codex", "");
  return { h, app };
}

describe("loadInventory", () => {
  it("wires every source and sums usage across accounts", async () => {
    const { h, app } = seed();
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    expect(inv.currentProject).toBe(app);
    expect(inv.claudeProfiles).toEqual(["claude:default", "claude:work"]);
    expect(inv.usage.eli5).toEqual({
      total: 184,
      lastUsedAt: 5_000,
      byProfile: { "claude:default": 3, "claude:work": 181 },
    });
    const eli5 = inv.items.filter((i) => i.name === "eli5");
    expect(eli5.map((i) => i.location.tool).sort()).toEqual(["claude", "codex"]);
    expect(usageOf(inv, eli5)?.total).toBe(184);
  });

  it("hashes only duplicated skills and marks copies that differ", async () => {
    const { h, app } = seed();
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const hashed = Object.keys(inv.hashes)
      .map((id) => inv.items.find((i) => i.id === id)?.name)
      .sort();
    expect(hashed).toEqual(["eli5", "eli5", "plannotator", "plannotator"]);
    expect(
      duplicateGroups(inv.items)
        .map((g) => g[0]?.name)
        .sort(),
    ).toEqual(["eli5", "plannotator"]);
    const plannotator = inv.items.find((i) => i.name === "plannotator" && i.location.tool === "claude");
    const eli5 = inv.items.find((i) => i.name === "eli5" && i.location.tool === "claude");
    if (!plannotator || !eli5) throw new Error("missing items");
    expect(marksOf(inv, plannotator, Date.now())).toContain("differs");
    expect(marksOf(inv, eli5, Date.now())).not.toContain("differs");
  });

  it("does not call two projects' copies differs: they never load together", async () => {
    const { h, app } = seed();
    const web = h.project("repos/web");
    h.claude("default", ".claude", { projects: { [app]: {}, [web]: {} } });
    h.skill("repos/app/.claude/skills", "deploy", "Deploy", "the app's way");
    h.skill("repos/web/.claude/skills", "deploy", "Deploy", "the web's way");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const copies = inv.items.filter((i) => i.name === "deploy");
    expect(copies.map((i) => i.location.project).sort()).toEqual([app, web].sort());
    // Still one duplicate group, hashed apart, for the Duplicates filter and the Copies line.
    expect(duplicateGroups(inv.items).find((g) => g[0]?.name === "deploy")).toHaveLength(2);
    expect(new Set(copies.map((i) => inv.hashes[i.id])).size).toBe(2);
    for (const copy of copies) expect(marksOf(inv, copy, Date.now())).not.toContain("differs");
  });

  it("calls a project's copy and the global one differs when they differ, as they load together", async () => {
    const { h, app } = seed();
    const web = h.project("repos/web");
    h.claude("default", ".claude", { projects: { [app]: {}, [web]: {} } });
    h.skill(".claude/skills", "deploy", "Deploy", "the usual way");
    h.skill("repos/app/.claude/skills", "deploy", "Deploy", "the app's way");
    h.skill("repos/web/.claude/skills", "deploy", "Deploy", "the usual way");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const copy = (project: string | undefined) => {
      const found = inv.items.find((i) => i.name === "deploy" && i.location.project === project);
      if (!found) throw new Error(`no deploy in ${project ?? "global"}`);
      return marksOf(inv, found, Date.now());
    };
    expect(copy(app)).toContain("differs");
    // The global copy loads in app too, beside the copy that differs.
    expect(copy(undefined)).toContain("differs");
    // web's copy matches the global one, and app's copy never loads in web.
    expect(copy(web)).not.toContain("differs");
  });

  it("calls a skill cleanup when no account used it for 90 days, after a 14-day grace for new folders", async () => {
    const { h, app } = seed();
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const byName = (name: string) => {
      const item = inv.items.find((i) => i.name === name && i.location.tool === "claude");
      if (!item) throw new Error(name);
      return item;
    };
    const now = Date.now();
    // old-tool was last used at t=10ms: long past 90 days, so cleanup whatever the folder's age.
    expect(marksOf(inv, byName("old-tool"), now)).toContain("cleanup");
    // never-used was just created: inside the grace period.
    expect(marksOf(inv, byName("never-used"), now)).not.toContain("cleanup");
    expect(marksOf(inv, byName("never-used"), now + 15 * DAY)).toContain("cleanup");
    expect(marksOf(inv, byName("eli5"), 5_000 + 30 * DAY)).not.toContain("cleanup");
  });

  it("does not call a skill cleanup when another account used it recently", async () => {
    const h = new TestHome();
    homes.push(h);
    const now = Date.now();
    h.claude("default", ".claude", { skillUsage: { shared: { usageCount: 9, lastUsedAt: now - 200 * DAY } } });
    h.claude("work", ".claude-work", { skillUsage: { shared: { usageCount: 1, lastUsedAt: now - 2 * DAY } } });
    h.skill(".claude/skills", "shared");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const shared = inv.items.find((i) => i.name === "shared");
    if (!shared) throw new Error("shared");
    expect(marksOf(inv, shared, now)).not.toContain("cleanup");
  });

  it("does not call a skill cleanup when it was used at no recorded time, or its age is unknown", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude", { skillUsage: { "no-time": { usageCount: 2 } } });
    h.skill(".claude/skills", "no-time");
    h.skill(".claude/skills", "no-age");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const byName = (name: string) => {
      const item = inv.items.find((i) => i.name === name);
      if (!item) throw new Error(name);
      return item;
    };
    const later = Date.now() + 365 * DAY;
    expect(marksOf(inv, byName("no-time"), later)).not.toContain("cleanup");
    // The same never-used folder, once with its age and once without.
    const { createdAt, ...noAge } = byName("no-age");
    expect(createdAt).toBeDefined();
    expect(marksOf(inv, byName("no-age"), later)).toContain("cleanup");
    expect(marksOf(inv, noAge, later)).not.toContain("cleanup");
  });

  it("dates a skill that is a link by the link, so a fresh link to an old folder is in its grace period", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const old = new Date(Date.now() - 60 * DAY);
    // An old folder of skills kept outside Claude Code's dir. On macOS an earlier mtime moves the
    // birth time back too; elsewhere the folder may still read as new, and the case holds anyway.
    const folder = h.skill("library", "brand-new-here");
    utimesSync(path.join(folder, "SKILL.md"), old, old);
    utimesSync(folder, old, old);
    h.link("library/brand-new-here", ".claude/skills/brand-new-here");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const item = inv.items.find((i) => i.name === "brand-new-here");
    if (!item) throw new Error("brand-new-here");
    expect(item.link?.broken).toBe(false);
    expect(marksOf(inv, item, Date.now())).not.toContain("cleanup");
    expect(marksOf(inv, item, Date.now() + 15 * DAY)).toContain("cleanup");
  });

  it("counts a link to another listed folder as that folder, not a second copy", async () => {
    const { h, app } = seed();
    h.skill(".agents/skills", "linked");
    h.link(".agents/skills/linked", ".claude/skills/linked");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const linked = inv.items.filter((i) => i.name === "linked");
    expect(linked.map((i) => i.location.tool).sort()).toEqual(["claude", "codex"]);
    // eli5's two real copies, alike as they are, still make a group.
    expect(
      duplicateGroups(inv.items)
        .map((g) => g[0]?.name)
        .sort(),
    ).toEqual(["eli5", "plannotator"]);
    expect(linked.filter((i) => inv.hashes[i.id] !== undefined)).toEqual([]);
  });

  it("counts the skills of a whole skills dir that is a link as the folders it leads to, not second copies", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    h.codex("personal", ".codex", "");
    h.skill(".agents/skills", "eli5");
    h.skill(".agents/skills", "plannotator");
    // The natural way to end the drift: one folder of skills, which Claude Code reads through a link.
    h.link(".agents/skills", ".claude/skills");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: h.home,
      managedSettings: h.path("none.json"),
    });
    const eli5 = inv.items.filter((i) => i.name === "eli5");
    expect(eli5.map((i) => i.location.tool).sort()).toEqual(["claude", "codex"]);
    // Each copy keeps the path its tool reads it by.
    expect(eli5.map((i) => i.location.file).sort()).toEqual(
      [h.path(".agents/skills/eli5"), h.path(".claude/skills/eli5")].sort(),
    );
    expect(duplicateGroups(inv.items)).toEqual([]);
    expect(inv.hashes).toEqual({});
    for (const item of eli5) expect(marksOf(inv, item, Date.now())).not.toContain("differs");
  });

  it("marks a skill link whose target is gone broken-link and cleanup, and does not hash it", async () => {
    const { h, app } = seed();
    h.skill(".agents/skills", "ghost");
    h.link(h.path("gone", "ghost"), ".claude/skills/ghost");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const ghost = inv.items.find((i) => i.name === "ghost" && i.location.tool === "claude");
    const copy = inv.items.find((i) => i.name === "ghost" && i.location.tool === "codex");
    if (!ghost || !copy) throw new Error("missing items");
    expect(ghost.link?.broken).toBe(true);
    expect(marksOf(inv, ghost, Date.now())).toEqual(["broken-link", "cleanup"]);
    // Its group with the real copy is hashed, but a folder that is gone has nothing to hash.
    expect(inv.hashes[copy.id]).toBeDefined();
    expect(inv.hashes[ghost.id]).toBeUndefined();
  });

  it("keeps reading past malformed files", async () => {
    const { h, app } = seed();
    h.write("repos/app/.claude/settings.local.json", "{ nope");
    h.write(".codex/config.toml", "[broken\n");
    h.write(".claude/skills/no-front/SKILL.md", "# just a title\n");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    expect(inv.warnings.map((w) => w.file).sort()).toEqual(
      [h.path(".codex/config.toml"), h.path("repos/app/.claude/settings.local.json")].sort(),
    );
    expect(inv.items.some((i) => i.name === "no-front")).toBe(true);
    expect(inv.items.some((i) => i.name === "never-used")).toBe(true);
  });

  it("warns once for a bad file that two installs of one plugin share", async () => {
    const { h, app } = seed();
    // Installed at user and at local scope: one installPath, so one hooks/hooks.json read twice.
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "sp@m": [{ installPath: sp }, { scope: "local", projectPath: app, installPath: sp }] },
    });
    h.write(".claude/plugins/cache/m/sp/1.0.0/.claude-plugin/plugin.json", { name: "sp", description: "Skills pack" });
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", "{ nope");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    expect(inv.items.filter((i) => i.kind === "plugin")).toHaveLength(2);
    // Install paths are realpaths: on macOS the temp dir sits behind the /var link.
    expect(inv.warnings.map((w) => w.file)).toEqual([path.join(realpathSync.native(sp), "hooks", "hooks.json")]);
  });

  it("reads a few hundred items quickly", async () => {
    const { h, app } = seed();
    for (let i = 0; i < 300; i++) h.skill(".claude/skills", `bulk-${i}`);
    const started = performance.now();
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    expect(inv.items.length).toBeGreaterThan(300);
    // Windows runners open fresh files many times slower (Defender scans each one), so their bound is wider.
    expect(performance.now() - started).toBeLessThan(process.platform === "win32" ? 8000 : 3000);
  });
});

describe("loadInventory, the home dir as a project", () => {
  /**
   * What Claude Code keys by cwd when it starts in the home dir: the account's projects[<home>]
   * entry, ~/.mcp.json and ~/.claude/settings.local.json. Beside them, what is the user's own
   * config there and must not be read a second time as the home project's.
   */
  function homeSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const home = h.home;
    const main = h.claude("default", ".claude", {
      mcpServers: { github: { command: "gh-mcp" } },
      projects: {
        [home]: {
          mcpServers: { "home-db": { command: "db-mcp" } },
          disabledMcpServers: ["github"],
          enabledMcpjsonServers: ["notes"],
        },
        [app]: {},
      },
    });
    h.claude("work", ".claude-work", { projects: { [home]: {} } });
    h.write(".mcp.json", { mcpServers: { notes: { command: "notes-mcp" } } });
    const local = h.write(".claude/settings.local.json", {
      skillOverrides: { eli5: "off" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "home-notify" }] }] },
    });
    h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "user-notify" }] }] } });
    h.skill(".claude/skills", "eli5");
    h.write(".claude/commands/hello.md", "# hello\n");
    const tomlHome = home.replaceAll("\\", "\\\\");
    h.codex(
      "personal",
      ".codex",
      `[projects."${tomlHome}"]\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\n`,
    );
    h.skill(".agents/skills", "agents-only");
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "codex-notify" }] }] } });
    return { h, app, home, main, local };
  }
  const load = (h: TestHome, cwd: string) =>
    loadInventory({ homeDir: h.home, registry: h.registry, cwd, managedSettings: h.path("none.json") });
  const find = (inv: Awaited<ReturnType<typeof load>>, name: string, scope?: string) => {
    const found = inv.items.filter((i) => i.name === name && (scope === undefined || i.location.scope === scope));
    if (found.length !== 1) throw new Error(`${found.length} items named ${name}`);
    return found[0] as (typeof found)[number];
  };

  it("is the current project in the home dir, and a known project once an account recorded it", async () => {
    const { h, app, home } = homeSeed();
    const inv = await load(h, home);
    expect(inv.currentProject).toBe(home);
    expect(inv.projects.find((p) => p.path === home)?.profiles).toEqual([
      "claude:default",
      "claude:work",
      "codex:personal",
    ]);
    // Seen from another project the home dir is still one of the projects, as the picker lists them.
    expect((await load(h, app)).projects.map((p) => p.path)).toEqual([home, app]);
  });

  it("reads the account's projects[<home>] entry: its local servers, its switches and its .mcp.json approvals", async () => {
    const { h, app, home, main } = homeSeed();
    const inv = await load(h, home);
    const homeDb = find(inv, "home-db");
    expect(homeDb.location).toMatchObject({ scope: "local", profile: "claude:default", project: home });
    const github = find(inv, "github");
    expect(stateOf(inv, github, home)).toEqual({
      value: "off",
      setBy: { file: main.jsonPath, key: "disabledMcpServers" },
    });
    expect(stateOf(inv, github, app).value).toBe("on");
    const notes = find(inv, "notes");
    expect(stateOf(inv, notes, home, "claude:default")).toEqual({
      value: "on",
      setBy: { file: main.jsonPath, key: "enabledMcpjsonServers" },
    });
    expect(stateOf(inv, notes, home, "claude:work").value).toBe("pending-approval");
  });

  it("reads ~/.mcp.json as the home project's .mcp.json", async () => {
    const { h, home } = homeSeed();
    const notes = find(await load(h, home), "notes");
    expect(notes.location).toEqual({ tool: "claude", scope: "project", project: home, file: h.path(".mcp.json") });
  });

  it("reads ~/.claude/settings.local.json as the home project's local settings", async () => {
    const { h, app, home, local } = homeSeed();
    const inv = await load(h, home);
    const eli5 = find(inv, "eli5");
    expect(stateOf(inv, eli5, home)).toEqual({ value: "off", setBy: { file: local, key: "skillOverrides.eli5" } });
    expect(stateOf(inv, eli5, app).value).toBe("on");
    expect(find(inv, "Stop", "local").location).toMatchObject({ project: home, file: local });
  });

  it("reads the switch of a plugin installed locally for the home dir from ~/.claude/settings.local.json", async () => {
    const { h, app, home, local } = homeSeed();
    const lp = h.path(".claude/plugins/cache/m/lp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "lp@m": [{ installPath: lp, scope: "local", projectPath: home }] },
    });
    h.write(".claude/settings.local.json", { enabledPlugins: { "lp@m": true } });
    const inv = await load(h, home);
    const plugin = find(inv, "lp@m");
    expect(stateOf(inv, plugin, home)).toEqual({ value: "on", setBy: { file: local, key: "enabledPlugins.lp@m" } });
    expect(stateOf(inv, plugin, app).value).toBe("off");
  });

  it("does not read the user's own config again as the home project's", async () => {
    const { h, home } = homeSeed();
    const inv = await load(h, home);
    const where = (kind: string) =>
      inv.items
        .filter((i) => i.kind === kind)
        .map((i) => `${i.location.tool}|${i.location.scope}|${i.name}|${i.summary?.command ?? ""}`)
        .sort();
    // ~/.claude/skills, ~/.claude/commands and ~/.agents/skills once each, as the user's.
    expect(where("skill")).toEqual(["claude|global|eli5|", "claude|global|hello|", "codex|global|agents-only|"]);
    // ~/.claude/settings.json and ~/.codex/hooks.json once each, as the user's; settings.local.json as the home's.
    expect(where("hook")).toEqual([
      "claude|global|Stop|user-notify",
      "claude|local|Stop|home-notify",
      "codex|global|Stop|codex-notify",
    ]);
    // ~/.codex/config.toml once, as the user's.
    expect(inv.items.filter((i) => i.name === "exa").map((i) => i.location.scope)).toEqual(["global"]);
    expect(inv.warnings).toEqual([]);
  });
});

describe("loadInventory, a .mcp.json in a parent dir", () => {
  /**
   * Claude Code 2.1.294 reads .mcp.json from the dir it starts in and from each parent dir, the
   * nearest file winning a name. ~/.mcp.json is the common case: its servers load in every
   * project under the home dir, each project approving them on its own.
   */
  function ancestorSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    const main = h.claude("default", ".claude", {
      projects: { [app]: { enabledMcpjsonServers: ["tools"] }, [web]: {} },
    });
    h.claude("work", ".claude-work", { projects: { [app]: {} } });
    h.write(".mcp.json", {
      mcpServers: {
        tools: { command: "tools-mcp" },
        notes: { command: "home-notes" },
        shared: { command: "home-shared" },
      },
    });
    h.write("repos/.mcp.json", { mcpServers: { shared: { command: "repos-shared" } } });
    h.write("repos/app/.mcp.json", { mcpServers: { notes: { command: "app-notes" } } });
    return { h, app, web, main };
  }
  const load = (h: TestHome, cwd: string) =>
    loadInventory({ homeDir: h.home, registry: h.registry, cwd, managedSettings: h.path("none.json") });
  const server = (inv: Awaited<ReturnType<typeof load>>, name: string, file: string) => {
    const found = inv.items.find((i) => i.kind === "mcp" && i.name === name && i.location.file === file);
    if (!found) throw new Error(`no ${name} in ${file}`);
    return found;
  };

  it("reads each .mcp.json once: the project's and each parent dir's up to the home dir", async () => {
    const { h, app } = ancestorSeed();
    const inv = await load(h, app);
    const files = inv.items
      .filter((i) => i.kind === "mcp")
      .map((i) => `${i.name}|${i.location.scope}|${i.location.project}|${i.location.file}`)
      .sort();
    expect(files).toEqual(
      [
        `notes|project|${app}|${h.path("repos/app/.mcp.json")}`,
        `notes|project|${h.home}|${h.path(".mcp.json")}`,
        `shared|project|${h.home}|${h.path(".mcp.json")}`,
        `shared|project|${h.path("repos")}|${h.path("repos/.mcp.json")}`,
        `tools|project|${h.home}|${h.path(".mcp.json")}`,
      ].sort(),
    );
    // A parent dir is read for its .mcp.json only: it is no project of its own.
    expect(inv.projects.map((p) => p.path)).toEqual([app, h.path("repos/web")]);
  });

  it("loads a parent dir's server in the project, approved or not by the project's own switches", async () => {
    const { h, app, web, main } = ancestorSeed();
    const inv = await load(h, app);
    const tools = server(inv, "tools", h.path(".mcp.json"));
    expect(relevantIn(tools, app)).toBe(true);
    expect(relevantIn(tools, web)).toBe(true);
    expect(stateOf(inv, tools, app, "claude:default")).toEqual({
      value: "on",
      setBy: { file: main.jsonPath, key: "enabledMcpjsonServers" },
    });
    expect(stateOf(inv, tools, app, "claude:work").value).toBe("pending-approval");
    expect(stateOf(inv, tools, web, "claude:default").value).toBe("pending-approval");
    // The project's own .mcp.json loads in that project alone.
    expect(relevantIn(server(inv, "notes", h.path("repos/app/.mcp.json")), web)).toBe(false);
  });

  it("lets the nearest .mcp.json win a name, as Claude Code merges them", async () => {
    const { h, app, web } = ancestorSeed();
    const inv = await load(h, app);
    const appNotes = server(inv, "notes", h.path("repos/app/.mcp.json"));
    const homeNotes = server(inv, "notes", h.path(".mcp.json"));
    expect(stateOf(inv, homeNotes, app).shadowedBy).toBe(appNotes.id);
    expect(stateOf(inv, appNotes, app).shadowedBy).toBeUndefined();
    expect(marksOf(inv, homeNotes, Date.now(), app)).toContain("shadowed");
    // In web, app's file is not read, so the home dir's notes is the one.
    expect(stateOf(inv, homeNotes, web).shadowedBy).toBeUndefined();
    const reposShared = server(inv, "shared", h.path("repos/.mcp.json"));
    expect(stateOf(inv, server(inv, "shared", h.path(".mcp.json")), app).shadowedBy).toBe(reposShared.id);
  });
});
