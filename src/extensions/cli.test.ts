import path from "node:path";

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
    const main = h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["docs"] } } });
    const work = h.claude("work", ".claude-work", { projects: { [app]: { disabledMcpjsonServers: ["docs"] } } });
    // Codex records the project too, but never loads a .mcp.json, so it is not one of the two.
    h.codex("personal", ".codex", `[projects."${app.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    const text = await run(h, app, "mcp", ["ls"]);
    expect(text).toMatch(/^1 MCP server · /);
    expect(text).toMatch(/^docs\s+claude\s+project app\s+1\/2 on$/m);
    const docs = JSON.parse(await run(h, app, "mcp", ["ls", "--json"])).items[0];
    expect(docs.stateByAccount).toEqual([
      { profile: "claude:default", value: "on", setBy: { file: main.jsonPath, key: "enabledMcpjsonServers" } },
      { profile: "claude:work", value: "off", setBy: { file: work.jsonPath, key: "disabledMcpjsonServers" } },
    ]);
    // Off in one account is off enough to list, as the dashboard's Off filter does.
    expect(await run(h, app, "mcp", ["ls", "--filter", "off"])).toMatch(/^docs\s/m);
  });

  it("counts only the accounts that have the plugin, for a plugin's server", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: {} } });
    const work = h.claude("work", ".claude-work", {
      projects: { [app]: { disabledMcpServers: ["plugin:sp:search"] } },
    });
    h.claude("solo", ".claude-solo", { projects: { [app]: {} } });
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude-work/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude/plugins/cache/m/sp/1.0.0/.mcp.json", { mcpServers: { search: { command: "search-mcp" } } });
    h.write(".claude/settings.json", { enabledPlugins: { "sp@m": true } });
    expect(await run(h, app, "mcp", ["ls"])).toMatch(/^plugin:sp:search\s+claude\s+plugin sp\s+1\/2 on$/m);
    const parsed = JSON.parse(await run(h, app, "mcp", ["ls", "--json"]));
    const search = parsed.items.find((i: { name: string }) => i.name === "plugin:sp:search");
    expect(search.accounts).toEqual(["claude:default", "claude:work"]);
    expect(search.state).toEqual({ value: "on" });
    expect(search.stateByAccount).toEqual([
      { profile: "claude:default", value: "on" },
      { profile: "claude:work", value: "off", setBy: { file: work.jsonPath, key: "disabledMcpServers" } },
    ]);
    expect(await run(h, app, "mcp", ["ls", "--filter", "off"])).toMatch(/^plugin:sp:search\s/m);
  });
});

describe("ls --all-projects", () => {
  it("reads another project's item in that project's own settings", async () => {
    const { h, app } = seed();
    h.write("repos/web/.claude/settings.local.json", { skillOverrides: { "web-only": "off" } });
    expect(await run(h, app, "skills", ["ls", "--all-projects"])).toMatch(/^web-only\s+claude\s+project web\s+off\s/m);
    expect(await run(h, app, "skills", ["ls", "--all-projects", "--filter", "off"])).toMatch(/^web-only\s/m);
  });
});

describe("ls with nothing to list", () => {
  it("says so instead of printing a bare header", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "hooks", ["ls"])).toMatch(
      /^0 hooks · .+\n\nNothing loads here\. Add --all-projects to include every project's own\.$/,
    );
    expect(await run(h, app, "hooks", ["ls", "--tool", "codex"])).toMatch(/^0 hooks · .+\n\nNo codex hooks here\.$/);
    expect(await run(h, app, "hooks", ["ls", "--all-projects"])).toMatch(
      /^0 hooks · all projects\n\nNothing found in any project\.$/,
    );
    expect(await run(h, app, "skills", ["ls", "--filter", "cleanup"])).toMatch(
      /^0 skills · .+\n\nNothing matches --filter cleanup here\.$/,
    );
  });
});

describe("hooks ls", () => {
  it("shows each hook's command, cut to fit and never a secret", async () => {
    const { h, app } = seed();
    const long = `${"/opt/hooks/".repeat(6)}guard.sh`;
    h.write(".claude/settings.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              // Short enough to show whole at 120 columns, so a redaction that failed would show.
              { type: "command", command: `audit-bash --api-key ${KEY}` },
              { type: "command", command: long },
            ],
          },
        ],
      },
    });
    const wide = await run(h, app, "hooks", ["ls"]);
    expect(wide).toMatch(/^2 hooks · /);
    expect(wide).toMatch(/^NAME\s+TOOL\s+WHERE\s+COMMAND\s+STATE\s+NOTES$/m);
    expect(wide).toMatch(/^PreToolUse Bash\s+claude\s+global\s+audit-bash --api-key <hidden>\s+on$/m);
    const narrow = await runExtensionsCommand("hooks", ["ls"], {
      homeDir: h.home,
      cwd: app,
      registry: h.registry,
      columns: 60,
    });
    const rows = narrow.split("\n").filter((line) => line.startsWith("PreToolUse"));
    expect(rows).toHaveLength(2);
    // The command gives way first: a hook's name is short, and its matcher is what tells it apart.
    expect(rows[1]).toMatch(/^PreToolUse Bash\s+claude\s+global\s+\/opt\/hooks\/\S*…\s+on$/);
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    expect(leakedWindows([wide, narrow], KEY)).toEqual([]);
  });

  it("shows the home dir as ~ in the table's command, and in full in --json", async () => {
    const { h, app } = seed();
    const command = `${path.join(h.home, "bin", "guard.sh")} --log ${h.home}`;
    h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    const row = (await run(h, app, "hooks", ["ls"])).split("\n").find((line) => line.startsWith("Stop")) ?? "";
    expect(row).toContain(`${path.join("~", "bin", "guard.sh")} --log ~`);
    expect(row).not.toContain(h.home);
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--json"]));
    expect(json.items[0].summary.command).toBe(command);
  });
});

describe("ls options and warnings", () => {
  it("refuses a --project that is no directory, without echoing it", async () => {
    const { h, app } = seed();
    const error = await run(h, app, "skills", ["ls", "--project", h.path("no-such-dir")]).catch((e: Error) => e);
    expect(String(error)).toMatch(/--project: no such directory\./);
    expect(String(error)).not.toContain("no-such-dir");
  });

  it("names each file it could not read, by its message and never its contents", async () => {
    const { h, app } = seed();
    h.write("repos/app/.claude/settings.local.json", `{ "token": "${KEY}", nope`);
    const text = await run(h, app, "skills", ["ls"]);
    const bad = path.join("~", "repos", "app", ".claude", "settings.local.json");
    expect(text).toContain(`\n\nCould not read every file:\n  ${bad}: `);
    expect(leakedWindows([text], KEY)).toEqual([]);
  });
});

describe("ls from the home dir", () => {
  function homeSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      mcpServers: { github: { command: "gh-mcp" } },
      projects: {
        [h.home]: { mcpServers: { "home-db": { command: "db-mcp" } }, disabledMcpServers: ["github"] },
        [app]: {},
      },
    });
    h.claude("work", ".claude-work", { projects: { [h.home]: { enabledMcpjsonServers: ["notes"] } } });
    h.write(".mcp.json", { mcpServers: { notes: { command: "notes-mcp" } } });
    return { h, app };
  }

  it("lists what Claude Code started there reads: the account's home servers, ~/.mcp.json and the switches", async () => {
    const { h } = homeSeed();
    const text = await run(h, h.home, "mcp", ["ls"]);
    expect(text).toMatch(/^3 MCP servers · project ~$/m);
    expect(text).toMatch(/^github\s+claude\s+account default\s+off$/m);
    expect(text).toMatch(/^home-db\s+claude\s+local default · ~\s+on$/m);
    expect(text).toMatch(/^notes\s+claude\s+project ~\s+1\/2 on$/m);
  });

  it("reads --project ~ as the home project, from anywhere", async () => {
    const { h, app } = homeSeed();
    expect(await run(h, app, "mcp", ["ls", "--project", h.home])).toBe(await run(h, h.home, "mcp", ["ls"]));
    // From app, the home dir's own servers do not load.
    const fromApp = await run(h, app, "mcp", ["ls"]);
    expect(fromApp).not.toContain("home-db");
    expect(fromApp).toMatch(/^github\s+claude\s+account default\s+on$/m);
  });

  it("lists the home servers once with --all-projects", async () => {
    const { h, app } = homeSeed();
    const rows = (await run(h, app, "mcp", ["ls", "--all-projects"])).split("\n");
    expect(rows.filter((line) => line.startsWith("home-db "))).toHaveLength(1);
    expect(rows.filter((line) => line.startsWith("notes "))).toHaveLength(1);
  });
});
