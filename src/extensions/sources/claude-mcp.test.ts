import { realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { valueHash } from "../hash.js";
import type { Env } from "../mcp-policy.js";
import { type Collector, emptyFacts, type Project } from "../model.js";
import { pathKey } from "../read.js";
import { TestHome } from "../test-home.js";
import { collectClaudeSettingsFacts, loadClaudeAccounts, loadClaudeContext } from "./claude-context.js";
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

  it("takes the last of a plugin server defined more than once, as Claude Code picks it", async () => {
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

    // Claude Code 2.1.296 reads the plugin's .mcp.json first, then what the manifest declares, in
    // its order, and a server name declared later replaces an earlier one.
    expect(out.items.map((i) => [i.name, i.summary?.command])).toEqual([["plugin:context7:context7", "from-manifest"]]);
    const [context7] = out.items;
    expect(context7?.location.file).toBe(path.join(realpathSync.native(ctx7), ".claude-plugin", "plugin.json"));
    expect(out.facts.fingerprints[context7?.id ?? ""]).toBe(valueHash({ command: "from-manifest" }));

    // In a list, the last entry that names it wins too, a file of servers as an inline one.
    h.write(".claude/plugins/cache/m/context7/1.0.0/servers.json", { context7: { command: "from-file" } });
    h.write(".claude/plugins/cache/m/context7/1.0.0/.claude-plugin/plugin.json", {
      mcpServers: ["./servers.json", { context7: { command: "from-list" } }],
    });
    expect((await read(h, [])).items.map((i) => i.summary?.command)).toEqual(["from-list"]);
    h.write(".claude/plugins/cache/m/context7/1.0.0/.claude-plugin/plugin.json", {
      mcpServers: [{ context7: { command: "from-list" } }, "./servers.json"],
    });
    expect((await read(h, [])).items.map((i) => i.summary?.command)).toEqual(["from-file"]);
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

  it("lists managed-mcp.json's servers as managed, and says the file is there even when it cannot be read", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude", { mcpServers: { mine: { command: "mine-mcp" } } });
    const managed = h.write("policy/managed-mcp.json", {
      mcpServers: { company: { type: "http", url: "https://mcp.example.com/api" } },
    });

    const out = await read(h, [], h.path("policy", "managed-settings.json"));
    expect(out.items.map((i) => `${i.location.scope}|${i.name}`).sort()).toEqual(["account|mine", "managed|company"]);
    const company = out.items.find((i) => i.name === "company");
    expect(company?.id).toBe("mcp:claude:managed:-:company");
    expect(company?.location).toEqual({ tool: "claude", scope: "managed", file: managed });
    expect(out.facts.claudeManagedMcp).toBe(managed);
    // What each server starts, for the lists to match: a remote one's URL, a stdio one's words hashed.
    expect(out.facts.mcpTargets["mcp:claude:managed:-:company"]).toEqual({
      url: "https://mcp.example.com/api",
      vars: false,
    });
    expect(out.facts.mcpTargets["mcp:claude:account:claude:default:mine"]).toEqual({
      command: valueHash(["mine-mcp"]),
      vars: false,
    });

    // A file Claude Code cannot parse still takes control of the servers, as it does there.
    h.write("policy/managed-mcp.json", "{ nope");
    const broken = await read(h, [], h.path("policy", "managed-settings.json"));
    expect(broken.items.map((i) => i.name)).toEqual(["mine"]);
    expect(broken.facts.claudeManagedMcp).toBe(managed);
    expect(broken.warnings.map((w) => w.file)).toEqual([managed]);
    // And with no file, nothing does.
    expect((await read(h, [])).facts.claudeManagedMcp).toBeUndefined();
  });

  it("lists the managedMcpServers of managed settings that Claude Code accepts, a drop-in's over the base file's", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const ref = (name: string) => ["$", "{", name, "}"].join("");
    const remote = (url: string, more: Record<string, unknown> = {}) => ({ type: "http", url, ...more });
    const base = h.write("policy/managed-settings.json", {
      managedMcpServers: {
        docs: remote("https://docs.example.com/mcp", { headers: { "X-Team": "core" } }),
        wiki: { type: "sse", url: "https://wiki.example.com/sse" },
        stream: { type: "streamable-http", url: "https://stream.example.com/mcp" },
        shared: remote("https://base.example.com/mcp"),
        // Each of these Claude Code drops: a program to run, no type, plain http, a variable,
        // a control character, a name it does not take.
        local: { type: "stdio", command: "srv" },
        runs: remote("https://runs.example.com/mcp", { command: "srv" }),
        untyped: { url: "https://untyped.example.com/mcp" },
        plain: remote("http://plain.example.com/mcp"),
        fromEnv: remote(`https://${ref("HOST")}/mcp`),
        bell: remote("https://bell.example.com/mcp", { headers: { "X-Note": "a\u0007b" } }),
        "bad name": remote("https://bad.example.com/mcp"),
        constructor: remote("https://proto.example.com/mcp"),
      },
    });
    const dropIn = h.write("policy/managed-settings.d/10-team.json", {
      managedMcpServers: { shared: remote("https://team.example.com/mcp") },
    });
    // Claude Code honors the key from managed settings alone.
    h.write(".claude/settings.json", { managedMcpServers: { mine: remote("https://mine.example.com/mcp") } });

    const out = await read(h, [], base);
    const managed = out.items.filter((i) => i.location.scope === "managed");
    expect(managed.map((i) => i.name).sort()).toEqual(["docs", "shared", "stream", "wiki"]);
    const docs = managed.find((i) => i.name === "docs");
    expect(docs?.id).toBe("mcp:claude:managed:settings:docs");
    expect(docs?.location).toEqual({ tool: "claude", scope: "managed", file: base });
    expect(docs?.summary).toMatchObject({ url: "https://docs.example.com/mcp" });
    expect(out.facts.mcpTargets[docs?.id ?? ""]).toEqual({ url: "https://docs.example.com/mcp", vars: false });
    // A name in two managed files is the higher one's, the drop-in's, whole.
    const shared = managed.find((i) => i.name === "shared");
    expect(shared?.location.file).toBe(dropIn);
    expect(out.facts.mcpTargets[shared?.id ?? ""]).toMatchObject({ url: "https://team.example.com/mcp" });
    expect(out.items.some((i) => i.name === "mine")).toBe(false);

    // Not an object of servers: none of it.
    h.write("policy/managed-settings.json", { managedMcpServers: [remote("https://docs.example.com/mcp")] });
    h.write("policy/managed-settings.d/10-team.json", {});
    expect((await read(h, [], base)).items.filter((i) => i.location.scope === "managed")).toEqual([]);
  });

  it("expands the variables of the lists and of what each server starts from the environment it is given", async () => {
    const h = new TestHome();
    homes.push(h);
    const ref = (name: string) => ["$", "{", name, "}"].join("");
    h.claude("default", ".claude", {
      mcpServers: {
        tools: { command: `${ref("TOOLS")}/srv`, args: ["--home", ref("NOPE")] },
        remote: { type: "http", url: `https://${ref("HOST")}/mcp` },
      },
    });
    const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
    h.write(".claude/plugins/cache/m/kit/1.0.0/.mcp.json", {
      kit: { command: `${ref("CLAUDE_PLUGIN_ROOT")}/kit-mcp` },
    });
    const user = h.write(".claude/settings.json", { deniedMcpServers: [{ serverCommand: [`${ref("TOOLS")}/bad`] }] });

    const env = { TOOLS: "/opt/tools", HOST: "mcp.example.com" };
    const out = await read(h, [], h.path("none.json"), env);
    expect(out.facts.claudeMcpPolicy).toEqual([
      { file: user, layer: "user", denied: [{ serverCommand: valueHash(["/opt/tools/bad"]), reads: ["TOOLS"] }] },
    ]);
    // NOPE is unset, so it stays as written.
    expect(out.facts.mcpTargets["mcp:claude:account:claude:default:tools"]).toEqual({
      command: valueHash(["/opt/tools/srv", "--home", ref("NOPE")]),
      vars: true,
      reads: ["TOOLS", "NOPE"],
    });
    expect(out.facts.mcpTargets["mcp:claude:account:claude:default:remote"]).toEqual({
      url: "https://mcp.example.com/mcp",
      vars: true,
      reads: ["HOST"],
    });
    const plugin = out.items.find((i) => i.name === "plugin:kit:kit");
    expect(out.facts.mcpTargets[plugin?.id ?? ""]).toEqual({
      // The plugin's folder by its real path, as realpath gives it: long names on Windows.
      command: valueHash([`${realpathSync.native(kit)}/kit-mcp`]),
      vars: true,
    });
  });

  it("lays the settings files' env over the shell's for a server, and managed settings' alone for a list", async () => {
    const h = new TestHome();
    homes.push(h);
    const ref = (name: string) => ["$", "{", name, "}"].join("");
    const app = h.project("repos/app");
    h.claude("default", ".claude", { mcpServers: { tools: { command: `${ref("TOOLS")}/srv`, args: [ref("MODE")] } } });
    // User settings set TOOLS and MODE, the project's local settings TOOLS again, managed settings MODE.
    const user = h.write(".claude/settings.json", {
      env: { TOOLS: "/user/tools", MODE: "user", LIST: "/user/list" },
      allowedMcpServers: [{ serverCommand: [`${ref("LIST")}/srv`] }],
      deniedMcpServers: [{ serverCommand: [`${ref("LIST")}/bad`] }, { serverCommand: [`${ref("ONLY")}/bad`] }],
    });
    h.write("repos/app/.claude/settings.local.json", { env: { TOOLS: "/local/tools" } });
    const managed = h.write("policy/managed-settings.json", { env: { MODE: "managed", ONLY: "/managed/only" } });

    const out = await read(h, [{ path: app, tools: ["claude"], profiles: [] }], managed, { TOOLS: "/shell/tools" });
    const id = "mcp:claude:account:claude:default:tools";
    // A setting's env wins over the shell's; managed settings' over the user's.
    expect(out.facts.mcpTargets[id]).toMatchObject({ command: valueHash(["/user/tools/srv", "managed"]) });
    // In the project, its local settings win TOOLS; elsewhere the user's still holds.
    expect(out.facts.mcpTargetsIn[pathKey(app)]?.[id]).toMatchObject({
      command: valueHash(["/local/tools/srv", "managed"]),
    });
    // An entry reads the shell and managed settings alone; a denylist entry falls back to the user's env.
    expect(out.facts.claudeMcpPolicy).toEqual([
      {
        file: user,
        layer: "user",
        allowed: [{ serverCommand: valueHash([`${ref("LIST")}/srv`]), reads: ["LIST"] }],
        denied: [
          { serverCommand: valueHash(["/user/list/bad"]), reads: ["LIST"] },
          { serverCommand: valueHash(["/managed/only/bad"]), reads: ["ONLY"] },
        ],
      },
    ]);
    // No project of its own env: nothing kept apart.
    expect((await read(h, [], managed)).facts.mcpTargetsIn).toEqual({});
  });

  it("reads every settings file's allowedMcpServers and deniedMcpServers, and the managed lock", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const app = h.project("repos/app");
    const managed = h.write("policy/managed-settings.json", {
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverUrl: "https://*.example.com/*" }, { serverName: "two", serverUrl: "x" }],
    });
    const user = h.write(".claude/settings.json", { deniedMcpServers: [{ serverCommand: ["npx", "bad"] }] });
    const local = h.write("repos/app/.claude/settings.local.json", {
      allowedMcpServers: [],
      // Only managed settings can turn the lock on.
      allowManagedMcpServersOnly: true,
    });

    const out = await read(h, [{ path: app, tools: ["claude"], profiles: [] }], managed);
    expect(out.facts.claudeMcpPolicy).toEqual([
      { file: managed, layer: "managed", allowed: [{ serverUrl: "https://*.example.com/*" }], managedOnly: true },
      { file: user, layer: "user", denied: [{ serverCommand: valueHash(["npx", "bad"]) }] },
      { file: local, layer: "local", project: app, allowed: [] },
    ]);
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

async function read(
  h: TestHome,
  projects: Project[],
  managedSettings = h.path("none.json"),
  env: Env = {},
): Promise<Collector> {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
  const ctx = await loadClaudeContext({
    accounts,
    registry: h.registry,
    homeDir: h.home,
    projects,
    managedSettings,
    mcpjsonStop: h.home,
    env,
    warnings: out.warnings,
  });
  collectClaudeSettingsFacts(ctx, out);
  await readClaudeMcp(ctx, projects, out);
  return out;
}
