import { realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { valueHash } from "../hash.js";
import { type Collector, emptyFacts, type Project } from "../model.js";
import { pathKey } from "../read.js";
import { TestHome } from "../test-home.js";
import { loadClaudeAccounts, loadClaudeContext } from "./claude-context.js";
import { readClaudeHooks, readClaudePlugins } from "./claude-hooks.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

async function inventoryOf(h: TestHome, projects: Project[], managedSettings = h.path("none.json")) {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
  const ctx = await loadClaudeContext({
    accounts,
    registry: h.registry,
    homeDir: h.home,
    projects,
    managedSettings,
    warnings: out.warnings,
  });
  await Promise.all([readClaudeHooks(ctx, out), readClaudePlugins(ctx, out)]);
  return out;
}

describe("readClaudeHooks and readClaudePlugins", () => {
  it("lists one item per hook command and one per plugin", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const app = h.project("repos/app");
    h.write(".claude/settings.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "guard" },
              { type: "command", command: "log" },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      },
    });
    // An entry that is not an object is no hook command, so only "setup" is one.
    h.write("repos/app/.claude/settings.json", {
      hooks: { SessionStart: [{ hooks: [null, "setup", { type: "command", command: "setup" }] }] },
    });
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude/plugins/cache/m/sp/1.0.0/.claude-plugin/plugin.json", { name: "sp", description: "Skills pack" });
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }] },
    });

    const out = await inventoryOf(h, [{ path: app, tools: ["claude"], profiles: [] }]);

    const hooks = out.items.filter((i) => i.kind === "hook");
    expect(hooks.map((i) => `${i.location.scope}|${i.name}|${i.summary?.command}`).sort()).toEqual(
      [
        "global|PreToolUse Bash|guard",
        "global|PreToolUse Bash|log",
        "global|Stop|notify",
        "project|SessionStart|setup",
        "plugin|SessionStart|sp-start",
      ].sort(),
    );
    expect(new Set(hooks.map((i) => i.id)).size).toBe(hooks.length);
    // Install paths are realpaths: on macOS the temp dir sits behind the /var link.
    const realSp = realpathSync.native(sp);
    expect(hooks.find((i) => i.location.scope === "plugin")?.location).toEqual({
      tool: "claude",
      scope: "plugin",
      plugin: "sp@m",
      file: path.join(realSp, "hooks", "hooks.json"),
      accounts: ["claude:default"],
    });
    expect(out.items.filter((i) => i.kind === "plugin")).toEqual([
      {
        id: `plugin:claude:plugin:sp@m|user|-|${pathKey(realSp)}:sp@m`,
        kind: "plugin",
        name: "sp@m",
        description: "Skills pack",
        location: { tool: "claude", scope: "plugin", plugin: "sp@m", file: realSp, accounts: ["claude:default"] },
      },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("says where each hook sits in its file, and fingerprints its raw entry", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const app = h.project("repos/app");
    h.write(".claude/settings.json", {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
        PreToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] },
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "guard" },
              { type: "command", command: "log", timeout: 5 },
            ],
          },
        ],
      },
    });
    // What is no command still holds its place: "setup" is the third entry.
    h.write("repos/app/.claude/settings.json", {
      hooks: { SessionStart: [{ hooks: [null, "setup", { type: "command", command: "setup" }] }] },
    });
    // A plugin's hooks.json written without the "hooks" key: the events sit at the root.
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
      SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }],
    });

    const out = await inventoryOf(h, [{ path: app, tools: ["claude"], profiles: [] }]);

    const byCommand = (command: string) => {
      const item = out.items.find((i) => i.kind === "hook" && i.summary?.command === command);
      if (!item) throw new Error(`no hook ${command}`);
      return item;
    };
    expect(byCommand("notify").hook).toEqual({ base: "hooks", event: "Stop", group: 0, index: 0 });
    expect(out.facts.fingerprints[byCommand("notify").id]).toBe(valueHash({ type: "command", command: "notify" }));
    expect(byCommand("log").hook).toEqual({ base: "hooks", event: "PreToolUse", matcher: "Bash", group: 1, index: 1 });
    expect(out.facts.fingerprints[byCommand("log").id]).toBe(
      valueHash({ type: "command", command: "log", timeout: 5 }),
    );
    expect(byCommand("fmt").hook).toEqual({ base: "hooks", event: "PreToolUse", matcher: "Edit", group: 0, index: 0 });
    expect(byCommand("setup").hook).toEqual({ base: "hooks", event: "SessionStart", group: 0, index: 2 });
    expect(byCommand("sp-start").hook).toEqual({ base: "root", event: "SessionStart", group: 0, index: 0 });
    expect(out.facts.fingerprints[byCommand("sp-start").id]).toBe(valueHash({ type: "command", command: "sp-start" }));
    // One fingerprint per hook listed, none for what is no command.
    const hooks = out.items.filter((i) => i.kind === "hook");
    expect(Object.keys(out.facts.fingerprints).sort()).toEqual(hooks.map((i) => i.id).sort());
  });

  it("gives each install of one plugin its own items", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    const app = h.project("repos/app");
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "sp@m": [{ installPath: sp }, { scope: "local", projectPath: app, installPath: sp }] },
    });
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }] },
    });

    const out = await inventoryOf(h, [{ path: app, tools: ["claude"], profiles: [] }]);

    const plugins = out.items.filter((i) => i.kind === "plugin");
    const hooks = out.items.filter((i) => i.kind === "hook");
    expect(plugins.map((i) => i.location.project ?? "-").sort()).toEqual(["-", app].sort());
    expect(hooks.map((i) => i.location.project ?? "-").sort()).toEqual(["-", app].sort());
    expect(new Set(plugins.map((i) => i.id)).size).toBe(2);
    expect(new Set(hooks.map((i) => i.id)).size).toBe(2);
  });

  it("gives each settings file its own hook ids, and redacts their commands", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    // Built from pieces, so no key-shaped string sits in the source.
    const secretCommand = ["API_KEY=", "abc", "123", " run --token ", "xyz", "789"].join("");
    const managed = h.write("managed-settings.json", {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "policy" }] }] },
    });
    h.write("managed-settings.d/10-a.json", {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: secretCommand }] }] },
    });

    const out = await inventoryOf(h, [], managed);

    const hooks = out.items.filter((i) => i.kind === "hook");
    expect(hooks.map((i) => `${i.location.scope}|${path.basename(i.location.file)}`).sort()).toEqual([
      "managed|10-a.json",
      "managed|managed-settings.json",
    ]);
    expect(new Set(hooks.map((i) => i.id)).size).toBe(2);
    const command = hooks.find((i) => i.location.file.endsWith("10-a.json"))?.summary?.command;
    expect(command).toContain("run");
    expect(command).not.toContain("abc123");
    expect(command).not.toContain("xyz789");
    expect(out.warnings).toEqual([]);
  });
});
