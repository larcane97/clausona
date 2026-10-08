import { afterEach, describe, expect, it } from "vitest";

import { leakedWindows } from "../test-leaks.js";
import { runExtensionsCommand } from "./cli.js";
import { TestHome } from "./test-home.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg", env: { PGPASSWORD: KEY } } } }, [web]: {} },
    mcpServers: { github: { command: "npx", args: ["gh-mcp", "--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
  });
  h.skill(".claude/skills", "eli5");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.codex("personal", ".codex", '[mcp_servers.exa]\ncommand = "npx"\n');
  h.skill(".agents/skills", "eli5");
  return { h, app, web };
}

const run = (h: TestHome, cwd: string, command: "skills" | "mcp" | "hooks", args: string[]) =>
  runExtensionsCommand(command, args, { homeDir: h.home, cwd, registry: h.registry, columns: 120 });

describe("skills ls", () => {
  it("lists what loads here: global and this project's, not another project's", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls"]);
    expect(text).toContain("eli5");
    expect(text).toContain("deploy-check");
    expect(text).not.toContain("web-only");
    expect(text).toMatch(/project app/);
  });

  it("lists every project with --all-projects and another with --project", async () => {
    const { h, app, web } = seed();
    expect(await run(h, app, "skills", ["ls", "--all-projects"])).toContain("web-only");
    const other = await run(h, app, "skills", ["ls", "--project", web]);
    expect(other).toContain("web-only");
    expect(other).not.toContain("deploy-check");
  });

  it("filters by tool and refuses bad options", async () => {
    const { h, app } = seed();
    const codexOnly = JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--json"]));
    expect(codexOnly.items.map((i: { name: string; tool: string }) => `${i.tool}:${i.name}`)).toEqual(["codex:eli5"]);
    await expect(run(h, app, "skills", ["ls", "--tool", "cursor"])).rejects.toThrow(/--tool takes claude or codex/);
    await expect(run(h, app, "skills", ["ls", "--all-projects", "--project", app])).rejects.toThrow(
      /either --project or --all-projects/,
    );
    await expect(run(h, app, "skills", ["off", "eli5"])).rejects.toThrow(/clausona skills ls/);
  });

  it("is ls when no subcommand is given", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "skills", [])).toContain("eli5");
  });
});

describe("mcp ls --json", () => {
  it("carries state and where, and never a secret", async () => {
    const { h, app } = seed();
    const out = await run(h, app, "mcp", ["ls", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.currentProject).toBe(app);
    expect(parsed.items.map((i: { name: string }) => i.name).sort()).toEqual(["exa", "github", "pg-dev"]);
    expect(parsed.items.find((i: { name: string }) => i.name === "github").summary).toEqual({
      transport: "stdio",
      command: "npx gh-mcp --api-key <hidden>",
      env: "GITHUB_TOKEN",
    });
    expect(leakedWindows([out], KEY, (s) => s)).toEqual([]);
  });
});

describe("mcp ls, a server more than one account sees", () => {
  it("counts the Claude accounts that recorded the project, for a .mcp.json server", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
    h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["docs"] } } });
    h.claude("work", ".claude-work", { projects: { [app]: { disabledMcpjsonServers: ["docs"] } } });
    // Codex records the project too, but never loads a .mcp.json, so it is not one of the two.
    h.codex("personal", ".codex", `[projects."${app.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    expect(await run(h, app, "mcp", ["ls"])).toMatch(/^docs\s+claude\s+project app\s+1\/2 on$/m);
  });

  it("counts only the accounts that have the plugin, for a plugin's server", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: {} } });
    h.claude("work", ".claude-work", { projects: { [app]: { disabledMcpServers: ["plugin:sp:search"] } } });
    h.claude("solo", ".claude-solo", { projects: { [app]: {} } });
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude-work/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude/plugins/cache/m/sp/1.0.0/.mcp.json", { mcpServers: { search: { command: "search-mcp" } } });
    h.write(".claude/settings.json", { enabledPlugins: { "sp@m": true } });
    expect(await run(h, app, "mcp", ["ls"])).toMatch(/^plugin:sp:search\s+claude\s+plugin sp\s+1\/2 on$/m);
    const parsed = JSON.parse(await run(h, app, "mcp", ["ls", "--json"]));
    expect(parsed.items.find((i: { name: string }) => i.name === "plugin:sp:search").accounts).toEqual([
      "claude:default",
      "claude:work",
    ]);
  });
});
