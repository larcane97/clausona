import { realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts, type Project } from "../model.js";
import { TestHome } from "../test-home.js";
import { loadClaudeAccounts, loadClaudeContext } from "./claude-context.js";
import { readClaudeHooks, readClaudePlugins } from "./claude-hooks.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

async function inventoryOf(h: TestHome, projects: Project[]) {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
  const ctx = await loadClaudeContext({
    accounts,
    registry: h.registry,
    homeDir: h.home,
    projects,
    managedSettings: h.path("none.json"),
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
    h.write("repos/app/.claude/settings.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "setup" }] }] },
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
    const realSp = realpathSync(sp);
    expect(hooks.find((i) => i.location.scope === "plugin")?.location).toEqual({
      tool: "claude",
      scope: "plugin",
      plugin: "sp@m",
      file: path.join(realSp, "hooks", "hooks.json"),
      accounts: ["claude:default"],
    });
    expect(out.items.filter((i) => i.kind === "plugin")).toEqual([
      {
        id: `plugin:claude:plugin:sp@m|user|-|${realSp}:sp@m`,
        kind: "plugin",
        name: "sp@m",
        description: "Skills pack",
        location: { tool: "claude", scope: "plugin", plugin: "sp@m", file: realSp, accounts: ["claude:default"] },
      },
    ]);
    expect(out.warnings).toEqual([]);
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
});
