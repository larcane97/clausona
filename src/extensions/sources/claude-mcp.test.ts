import { realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { valueHash } from "../hash.js";
import { type Collector, emptyFacts, type Project } from "../model.js";
import { TestHome } from "../test-home.js";
import { loadClaudeAccounts, loadClaudeContext } from "./claude-context.js";
import { readClaudeMcp } from "./claude-mcp.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

describe("readClaudeMcp", () => {
  it("reads user, local, project and plugin servers and the switches that turn them off", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      mcpServers: { stitch: { command: "stitch" } },
      projects: {
        [app]: {
          mcpServers: { "pg-dev": { command: "pg" } },
          disabledMcpServers: ["stitch"],
          enabledMcpjsonServers: ["docs"],
        },
        [h.path("repos/deleted")]: { mcpServers: { ghost: { command: "x" } } },
      },
    });
    h.claude("work", ".claude-work", { mcpServers: { dogear: { type: "http", url: "https://d.example/mcp" } } });
    h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs" }, extra: { command: "extra" } } });
    h.write("repos/app/.claude/settings.local.json", { disabledMcpjsonServers: ["extra"] });
    const ctx7 = h.path(".claude/plugins/cache/m/context7/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "context7@m": [{ installPath: ctx7 }] } });
    h.write(".claude/plugins/cache/m/context7/1.0.0/.mcp.json", { context7: { command: "ctx7" } });

    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const projects = [{ path: app, tools: ["claude" as const], profiles: ["claude:default"] }];
    const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
    const ctx = await loadClaudeContext({
      accounts,
      registry: h.registry,
      homeDir: h.home,
      projects,
      managedSettings: h.path("none.json"),
      mcpjsonStop: h.home,
      warnings: out.warnings,
    });
    await readClaudeMcp(ctx, projects, out);

    expect(out.items.map((i) => `${i.location.scope}|${i.location.profile ?? "-"}|${i.name}`).sort()).toEqual(
      [
        "account|claude:default|stitch",
        "account|claude:work|dogear",
        "local|claude:default|pg-dev",
        "project|-|docs",
        "project|-|extra",
        "plugin|-|plugin:context7:context7",
      ].sort(),
    );
    expect(out.items.find((i) => i.location.scope === "plugin")?.location.accounts).toEqual(["claude:default"]);
    expect(out.facts.claudeMcpDisabled).toEqual([
      { file: h.path(".claude.json"), profile: "claude:default", project: app, names: ["stitch"] },
    ]);
    expect(out.facts.claudeMcpjson.map((a) => [a.profile ?? "-", a.enabled, a.disabled])).toEqual([
      ["claude:default", ["docs"], []],
      ["-", [], ["extra"]],
    ]);
    // Each server's raw entry, hashed, so a write can tell it is still the one that was read.
    expect(out.facts.fingerprints["mcp:claude:account:claude:default:stitch"]).toBe(valueHash({ command: "stitch" }));
    const print = (name: string) => out.facts.fingerprints[out.items.find((i) => i.name === name)?.id ?? ""];
    expect(print("pg-dev")).toBe(valueHash({ command: "pg" }));
    expect(print("docs")).toBe(valueHash({ command: "docs" }));
    expect(print("plugin:context7:context7")).toBe(valueHash({ command: "ctx7" }));
    expect(Object.keys(out.facts.fingerprints).sort()).toEqual(out.items.map((i) => i.id).sort());
  });

  it("keeps the first of a plugin server defined in both its .mcp.json and its manifest", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const ctx7 = h.path(".claude/plugins/cache/m/context7/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "context7@m": [{ installPath: ctx7 }] } });
    h.write(".claude/plugins/cache/m/context7/1.0.0/.mcp.json", { context7: { command: "from-mcp-json" } });
    h.write(".claude/plugins/cache/m/context7/1.0.0/.claude-plugin/plugin.json", {
      mcpServers: { context7: { command: "from-manifest" } },
    });

    const out = await read(h, []);

    expect(out.items.map((i) => [i.name, i.summary?.command])).toEqual([["plugin:context7:context7", "from-mcp-json"]]);
  });

  it("reads the servers a plugin's manifest names by path, in a list too, with the plugin's place", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    h.claude("work", ".claude-work");
    const root = ".claude/plugins/cache/m/kit/1.0.0";
    const kit = h.path(root);
    const installs = { "kit@m": [{ installPath: kit }] };
    h.write(".claude-work/plugins/installed_plugins.json", { plugins: installs });
    h.write(`${root}/.mcp.json`, { mcpServers: { base: { command: "base-mcp" } } });
    h.write(`${root}/mcp/servers.json`, { mcpServers: { files: { command: "files-mcp" } } });
    // A file of servers may be the map itself, as a plugin's .mcp.json may.
    h.write(`${root}/mcp/more.json`, { more: { command: "more-mcp" } });
    h.write(`${root}/.claude-plugin/plugin.json`, {
      name: "kit",
      mcpServers: ["./mcp/servers.json", { inline: { command: "inline-mcp" } }, "mcp/more.json"],
    });
    // A second plugin whose manifest names one path, the string form.
    const solo = ".claude/plugins/cache/m/solo/1.0.0";
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { ...installs, "solo@m": [{ installPath: h.path(solo) }] },
    });
    h.write(`${solo}/servers.json`, { mcpServers: { only: { type: "http", url: "https://only.example/mcp" } } });
    h.write(`${solo}/.claude-plugin/plugin.json`, { mcpServers: "./servers.json" });

    const out = await read(h, []);

    const home = realpathSync.native(h.home);
    const servers = out.items.map((i) => `${i.name}|${path.relative(home, i.location.file)}`);
    expect(servers.sort()).toEqual(
      [
        `plugin:kit:base|${path.join(root, ".mcp.json")}`,
        `plugin:kit:files|${path.join(root, "mcp", "servers.json")}`,
        `plugin:kit:inline|${path.join(root, ".claude-plugin", "plugin.json")}`,
        `plugin:kit:more|${path.join(root, "mcp", "more.json")}`,
        `plugin:solo:only|${path.join(solo, "servers.json")}`,
      ].sort(),
    );
    // Each read as the plugin's .mcp.json server is: the plugin, its accounts, its install, its owner.
    const files = out.items.find((i) => i.name === "plugin:kit:files");
    const base = out.items.find((i) => i.name === "plugin:kit:base");
    expect(files?.location).toEqual({ ...base?.location, file: files?.location.file });
    expect(files?.location.accounts).toEqual(["claude:default", "claude:work"]);
    expect(files?.id).toBe(base?.id.replace(/:base$/, ":files"));
    expect(out.facts.fingerprints[files?.id ?? ""]).toBe(valueHash({ command: "files-mcp" }));
    expect(out.items.find((i) => i.name === "plugin:solo:only")?.summary?.url).toBe("https://only.example/mcp");
    expect(out.warnings).toEqual([]);
  });

  it("reads no server file a plugin's manifest names outside the plugin, or that is no .json file", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const root = ".claude/plugins/cache/m/kit/1.0.0";
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: h.path(root) }] } });
    const outside = h.write("elsewhere/servers.json", { mcpServers: { away: { command: "away-mcp" } } });
    h.write(".claude/plugins/cache/m/kit/servers.json", { mcpServers: { up: { command: "up-mcp" } } });
    h.write(`${root}/bundle.mcpb`, { mcpServers: { bundled: { command: "bundled-mcp" } } });
    // A link inside the plugin that leads out of it.
    h.link("elsewhere", `${root}/linked`);
    h.write(`${root}/.claude-plugin/plugin.json`, {
      mcpServers: ["../servers.json", outside, "./linked/servers.json", "./missing.json", "./bundle.mcpb"],
    });

    const out = await read(h, []);

    expect(out.items).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it("reads a project once when two of an account's keys resolve to it", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const entry = { mcpServers: { "pg-dev": { command: "pg" } }, disabledMcpServers: ["stitch"] };
    h.claude("default", ".claude", { projects: { [app]: entry, [`${app}/`]: entry } });

    const out = await read(h, [{ path: app, tools: ["claude"], profiles: ["claude:default"] }]);

    expect(out.items.map((i) => `${i.location.scope}|${i.name}`)).toEqual(["local|pg-dev"]);
    expect(out.facts.claudeMcpDisabled).toHaveLength(1);
  });

  it("keeps .mcp.json approvals from the user settings, for every project", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const settings = h.write(".claude/settings.json", { enableAllProjectMcpServers: true });

    const out = await read(h, []);

    expect(out.facts.claudeMcpjson).toEqual([{ file: settings, enabled: [], disabled: [], enableAll: true }]);
  });
});

async function read(h: TestHome, projects: Project[]): Promise<Collector> {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
  const ctx = await loadClaudeContext({
    accounts,
    registry: h.registry,
    homeDir: h.home,
    projects,
    managedSettings: h.path("none.json"),
    mcpjsonStop: h.home,
    warnings: out.warnings,
  });
  await readClaudeMcp(ctx, projects, out);
  return out;
}
