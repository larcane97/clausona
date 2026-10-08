import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts } from "../model.js";
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
  });
});
