import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts } from "../model.js";
import { TestHome } from "../test-home.js";
import { loadCodexContext, readCodex } from "./codex.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

const CACHE = ".codex/plugins/cache";

/** A plugin's version folder in Codex's cache, with a manifest in `.codex-plugin` (or `.claude-plugin`). */
function plugin(h: TestHome, at: string, manifest: Record<string, unknown> | undefined, claude = false): string {
  if (manifest) h.write(`${CACHE}/${at}/${claude ? ".claude-plugin" : ".codex-plugin"}/plugin.json`, manifest);
  return h.path(CACHE, at);
}

async function read(h: TestHome, projects: string[] = []): Promise<Collector> {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
  if (!ctx) throw new Error("no codex context");
  await readCodex(
    ctx,
    projects.map((p) => ({ path: p, tools: ["codex"], profiles: [] })),
    out,
  );
  return out;
}

/** kind|scope|plugin|name for each item, sorted. */
const rows = (out: Collector) =>
  out.items.map((i) => `${i.kind}|${i.location.scope}|${i.location.plugin ?? "-"}|${i.name}`).sort();

describe("readCodex: plugins", () => {
  it("reads each plugin in Codex's cache, as plugin@marketplace, and what it brings", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex", '[plugins."kit@m"]\nenabled = true\n');
    const kit = plugin(h, "m/kit/1.0.0", { name: "kit", description: "Kit tools", mcpServers: "./.mcp.json" });
    h.skill(`${CACHE}/m/kit/1.0.0/skills`, "plan");
    h.write(`${CACHE}/m/kit/1.0.0/.mcp.json`, { mcpServers: { kitdb: { command: "kitdb-mcp" } } });
    h.write(`${CACHE}/m/kit/1.0.0/hooks/hooks.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "kit-notify" }] }] },
    });
    // A Claude manifest is a plugin's to Codex too.
    plugin(h, "m/claudy/2.0.0", { name: "claudy" }, true);
    h.skill(`${CACHE}/m/claudy/2.0.0/skills`, "draw");
    // No manifest: Codex loads nothing from it.
    h.skill(`${CACHE}/m/bare/1.0.0/skills`, "lonely");
    // Installed from ChatGPT's catalog: the account says whether it is on, not config.toml.
    plugin(h, "openai-curated-remote/sites/1.0.1", { name: "sites" });
    h.write(`${CACHE}/openai-curated-remote/sites/.codex-remote-plugin-install.json`, { schema_version: 1 });
    h.skill(`${CACHE}/openai-curated-remote/sites/1.0.1/skills`, "sites");

    const out = await read(h);
    expect(rows(out)).toEqual(
      [
        "plugin|plugin|kit@m|kit@m",
        "skill|plugin|kit@m|kit:plan",
        "mcp|plugin|kit@m|kitdb",
        "hook|plugin|kit@m|Stop",
        "plugin|plugin|claudy@m|claudy@m",
        "skill|plugin|claudy@m|claudy:draw",
      ].sort(),
    );
    const kitItem = out.items.find((i) => i.kind === "plugin" && i.name === "kit@m");
    expect(kitItem).toMatchObject({
      id: "plugin:codex:plugin:kit@m:kit@m",
      description: "Kit tools",
      location: { tool: "codex", scope: "plugin", plugin: "kit@m", file: kit },
    });
    const plan = out.items.find((i) => i.name === "kit:plan");
    expect(plan?.location.file).toBe(path.join(kit, "skills", "plan"));
    expect(plan?.usageKeys).toEqual([]);
    expect(out.items.find((i) => i.name === "kitdb")?.summary).toEqual({ transport: "stdio", command: "kitdb-mcp" });
    // A server's own enabled is its starting state; kitdb sets none.
    expect(out.facts.codexPluginServers).toEqual([]);
    expect(out.items.find((i) => i.kind === "hook")?.location.file).toBe(path.join(kit, "hooks", "hooks.json"));
    expect(out.warnings).toEqual([]);
  });

  it("reads the version folder Codex loads: local, else the highest, never a link", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex");
    const version = (at: string) => {
      const [name = "", v = ""] = at.split("/");
      plugin(h, `m/${at}`, { name });
      h.skill(`${CACHE}/m/${at}/skills`, `${name}-${v.replaceAll(".", "_")}`);
    };
    for (const at of ["semver/1.9.0", "semver/1.10.0"]) version(at);
    for (const at of ["pre/1.0.0-beta", "pre/1.0.0", "pre/0.9.0"]) version(at);
    for (const at of ["loc/99.0.0", "loc/local"]) version(at);
    // Names that are not versions go by their text, as Codex compares them.
    for (const at of ["word/1.0.0", "word/zzz", "num/2", "num/10"]) version(at);
    // A link is no version folder Codex takes, whatever it is called.
    for (const at of ["lnk/1.0.0", "lnk/2.0.0"]) version(at);
    h.link(`${CACHE}/m/lnk/1.0.0`, `${CACHE}/m/lnk/9.9.9`);

    const out = await read(h);
    expect(out.items.filter((i) => i.kind === "skill").map((i) => i.name)).toEqual(
      expect.arrayContaining([
        "semver:semver-1_10_0",
        "pre:pre-1_0_0",
        "loc:loc-local",
        "word:word-zzz",
        "num:num-2",
        "lnk:lnk-2_0_0",
      ]),
    );
    expect(out.items.filter((i) => i.kind === "skill")).toHaveLength(6);
  });

  it("takes the manifest's skills, mcpServers and hooks in each form Codex reads, inside the plugin only", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex");
    // Paths given replace the default folders and files; one that leaves the plugin is not read.
    const paths = plugin(h, "m/paths/1.0.0", {
      name: "paths",
      skills: ["./a/", "./b/", "../../other/1.0.0/skills/"],
      mcpServers: "./servers/x.json",
      hooks: "./h/custom.json",
    });
    h.skill(`${CACHE}/m/paths/1.0.0/a`, "first");
    h.skill(`${CACHE}/m/paths/1.0.0/b`, "second");
    h.skill(`${CACHE}/m/paths/1.0.0/skills`, "not-read");
    h.skill(`${CACHE}/m/other/1.0.0/skills`, "outside");
    h.write(`${CACHE}/m/paths/1.0.0/servers/x.json`, { mcpServers: { pathsdb: { command: "paths-mcp" } } });
    h.write(`${CACHE}/m/paths/1.0.0/.mcp.json`, { mcpServers: { unread: { command: "unread" } } });
    h.write(`${CACHE}/m/paths/1.0.0/h/custom.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "c" }] }] },
    });
    h.write(`${CACHE}/m/paths/1.0.0/hooks/hooks.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "unread" }] }] },
    });
    // Inline servers and hooks, a .mcp.json written without the mcpServers key, lists of hooks.
    const inline = plugin(h, "m/inline/1.0.0", {
      name: "inline",
      mcpServers: { inl: { url: "https://inline.example/mcp" } },
      hooks: [
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "inline-start" }] }] } },
        // Events at the top of an inline object are not what Codex reads.
        { PreToolUse: [{ hooks: [{ type: "command", command: "unread" }] }] },
      ],
    });
    plugin(h, "m/listed/1.0.0", { name: "listed", hooks: ["./h/one.json"] });
    h.write(`${CACHE}/m/listed/1.0.0/h/one.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "one" }] }] },
    });
    // A list of paths and inline hooks together: Codex ignores it, and reads no hooks of the plugin.
    const mixed = plugin(h, "m/mixed/1.0.0", {
      name: "mixed",
      hooks: ["./h/one.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "unread" }] }] } }],
    });
    h.write(`${CACHE}/m/mixed/1.0.0/h/one.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "unread" }] }] },
    });
    h.write(`${CACHE}/m/mixed/1.0.0/hooks/hooks.json`, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "unread" }] }] },
    });
    plugin(h, "m/flat/1.0.0", { name: "flat" });
    h.write(`${CACHE}/m/flat/1.0.0/.mcp.json`, { flatdb: { command: "flat-mcp", enabled: false } });
    // With no name, Codex names the skills after the version folder.
    plugin(h, "m/noname/1.0.0", { version: "1.0.0" });
    h.skill(`${CACHE}/m/noname/1.0.0/skills`, "nn");

    const out = await read(h);
    expect(rows(out).filter((r) => !r.startsWith("plugin|"))).toEqual(
      [
        "skill|plugin|paths@m|paths:first",
        "skill|plugin|paths@m|paths:second",
        "mcp|plugin|paths@m|pathsdb",
        "hook|plugin|paths@m|Stop",
        "mcp|plugin|inline@m|inl",
        "hook|plugin|listed@m|Stop",
        "hook|plugin|inline@m|SessionStart",
        "mcp|plugin|flat@m|flatdb",
        "skill|plugin|noname@m|1.0.0:nn",
      ].sort(),
    );
    const commands = out.items.filter((i) => i.kind === "hook").map((i) => i.summary?.command);
    expect(commands.sort()).toEqual(["c", "inline-start", "one"]);
    expect(out.warnings).toEqual([
      {
        file: path.join(mixed, ".codex-plugin", "plugin.json"),
        message: "lists hook files and hooks together under hooks, which Codex ignores",
      },
    ]);
    // A server the plugin ships off is that server's starting state.
    expect(out.facts.codexPluginServers).toEqual([
      {
        file: h.path(CACHE, "m", "flat", "1.0.0", ".mcp.json"),
        plugin: "flat@m",
        name: "flatdb",
        enabled: false,
        default: true,
      },
    ]);
    expect(out.items.find((i) => i.name === "pathsdb")?.location.file).toBe(path.join(paths, "servers", "x.json"));
    const manifest = path.join(inline, ".codex-plugin", "plugin.json");
    expect(out.items.find((i) => i.name === "inl")?.location.file).toBe(manifest);
    expect(out.items.find((i) => i.summary?.command === "inline-start")?.location.file).toBe(manifest);
    // Each hook file's hooks are their own: one Stop in each of two files is two hooks.
    const ids = out.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records each [plugins] table and plugin server switch, the user's and a project's", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex(
      "personal",
      ".codex",
      [
        '[plugins."kit@m"]',
        "enabled = true",
        "",
        '[plugins."kit@m".mcp_servers.kitdb]',
        "enabled = false",
        "",
        '[plugins."off@m"]',
        "enabled = false",
        "",
        // A table that sets no enabled leaves the plugin on.
        '[plugins."named@m"]',
        "",
      ].join("\n"),
    );
    h.write("repos/app/.codex/config.toml", '[plugins."kit@m"]\nenabled = false\n');
    const out = await read(h, [app]);
    const user = h.path(".codex", "config.toml");
    const own = path.join(app, ".codex", "config.toml");
    expect(out.facts.codexPlugins).toEqual(
      expect.arrayContaining([
        { file: user, plugin: "kit@m", enabled: true },
        { file: user, plugin: "off@m", enabled: false },
        { file: user, plugin: "named@m" },
        { file: own, project: app, plugin: "kit@m", enabled: false },
      ]),
    );
    expect(out.facts.codexPlugins).toHaveLength(4);
    expect(out.facts.codexPluginServers).toEqual([{ file: user, plugin: "kit@m", name: "kitdb", enabled: false }]);
    // A plugin's server switch is not the user server switch of that name.
    expect(out.facts.codexMcpEnabled).toEqual([]);
  });
});
