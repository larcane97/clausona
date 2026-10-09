import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { leakedWindows } from "../test-leaks.js";
import { type ExtensionsCommand, runExtensionsCommand } from "./cli.js";
import { ExitError } from "./exit-error.js";
import { TestHome } from "./test-home.js";

const DAY = 86_400_000;
/** 200 days after the fixture's files were made (see scopes.test.ts): every skill but eli5 is unused. */
const NOW = Date.now() + 200 * DAY;

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

/**
 * One Claude account and a Codex one; projects app and web. A global eli5 (used yesterday) and
 * old-one; app's own eli5 and deploy-check; web-only in web; a Codex eli5. github is a user server
 * and pg-dev app's local one, both with a secret; Codex has exa.
 */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg", env: { PGPASSWORD: KEY } } } }, [web]: {} },
    mcpServers: { github: { command: "npx", args: ["gh-mcp", "--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
    skillUsage: { eli5: { usageCount: 4, lastUsedAt: NOW - DAY } },
  });
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "eli5");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.codex("personal", ".codex", '[mcp_servers.exa]\ncommand = "npx"\n');
  h.skill(".agents/skills", "eli5");
  return { h, app, web };
}

const run = (h: TestHome, cwd: string, command: ExtensionsCommand, args: string[], columns = 120) =>
  runExtensionsCommand(command, args, { homeDir: h.home, cwd, registry: h.registry, now: NOW, columns });

/** What a rejected run threw, for a look at its code, message and stdout. */
async function failure(promise: Promise<string>): Promise<ExitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ExitError)) throw new Error(`expected an ExitError, got ${String(error)}`);
  return error;
}

const firstLine = (text: string) => text.split("\n")[0] ?? "";

describe("skills ls", () => {
  it("lists what loads here by default, titled with the scope and the project", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls"]);
    expect(firstLine(text)).toMatch(/^4 skills · Loaded here · project ~[\\/]repos[\\/]app$/);
    expect(text).toMatch(/^NAME\s+TOOL\s+WHERE\s+USES\s+LAST USED\s+NOTE$/m);
    // The Global eli5 wins over app's, so it is the one listed.
    expect(text).toMatch(/^eli5\s+claude\s+Global\s+4\s+1d ago$/m);
    expect(text).toMatch(/^eli5\s+codex\s+Global\s+—\s+—$/m);
    expect(text).toMatch(/^deploy-check\s+claude\s+Project\s+0\s+never\s+unused$/m);
    expect(text).not.toContain("web-only");
  });

  it("has no TOOL column when one tool is asked for", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls", "--tool", "claude"]);
    expect(firstLine(text)).toMatch(/^3 skills · Loaded here · project ~/);
    expect(text).toMatch(/^NAME\s+WHERE\s+USES\s+LAST USED\s+NOTE$/m);
    expect(text).not.toMatch(/codex/);
  });

  it("is ls when no subcommand is given", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "skills", [])).toBe(await run(h, app, "skills", ["ls"]));
  });

  it("lists this project's own skills with --scope project, the hidden copy tagged", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls", "--scope", "project"]);
    expect(firstLine(text)).toMatch(/^2 skills · Project · project ~/);
    expect(text).toMatch(/^deploy-check\s+claude\s+Project\s+0\s+never\s+unused$/m);
    expect(text).toMatch(/^eli5\s+claude\s+Project\s+4\s+1d ago\s+hidden by Global copy$/m);
    expect(text).not.toContain("old-one");
  });

  it("lists the Claude skills not used in 90 days with --scope unused", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls", "--scope", "unused", "--tool", "claude"]);
    expect(firstLine(text)).toMatch(/^3 skills · Not used in 90 days · project ~/);
    expect(text).toMatch(/^deploy-check\s+Project\s+0\s+never\s+unused$/m);
    expect(text).toMatch(/^old-one\s+Global\s+0\s+never\s+unused$/m);
    expect(text).toMatch(/^web-only\s+web\s+0\s+never\s+unused$/m);
    expect(text).not.toContain("eli5");
  });

  it("lists every other project's own with --scope other, and another project's with --project", async () => {
    const { h, app, web } = seed();
    const other = await run(h, app, "skills", ["ls", "--scope", "other"]);
    expect(firstLine(other)).toMatch(/^1 skill · Other projects · project ~/);
    expect(other).toMatch(/^web-only\s+claude\s+web\s+0\s+never\s+unused$/m);
    const fromWeb = await run(h, app, "skills", ["ls", "--project", web]);
    expect(firstLine(fromWeb)).toMatch(/project ~[\\/]repos[\\/]web$/);
    expect(fromWeb).toContain("web-only");
    expect(fromWeb).not.toContain("deploy-check");
  });

  it("lists every place but Loaded here once with --scope all", async () => {
    const { h, app } = seed();
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--scope", "all", "--json"]));
    const names = json.items.map(
      (i: { tool: string; scope: string; name: string }) => `${i.tool}:${i.scope}:${i.name}`,
    );
    expect(names.sort()).toEqual([
      "claude:global:eli5",
      "claude:global:old-one",
      "claude:other:web-only",
      "claude:project:deploy-check",
      "claude:project:eli5",
      "codex:global:eli5",
    ]);
  });

  it("says why there is nothing to list", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "hooks", ["ls"])).toMatch(
      /^0 hooks · Loaded here · project .+\n\nNothing is loaded here\.$/,
    );
    expect(await run(h, app, "hooks", ["ls", "--scope", "project"])).toMatch(
      /^0 hooks · Project · project .+\n\nNothing in this project's own files\.$/,
    );
    expect(await run(h, app, "hooks", ["ls", "--scope", "global"])).toMatch(
      /^0 hooks · Global · project .+\n\nNo Global hooks\.$/,
    );
  });
});

describe("ls, rows that differ only in whose they are", () => {
  it("lists a Cloud skill once, with how many accounts have it, and names a legacy command as one", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      projects: { [app]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
    });
    h.claude("work", ".claude-work", { oauthAccount: { organizationUuid: "org1", accountUuid: "acc2" } });
    h.skill(".claude/skills/synced/org1_acc1", "pdf");
    h.skill(".claude/skills/synced/org1_acc2", "pdf");
    h.skill(".claude/skills", "eli5");
    h.write(".claude/commands/eli5.md", "Explain it simply\n");
    const cloud = await run(h, app, "skills", ["ls", "--scope", "cloud"]);
    expect(cloud).toMatch(/^pdf\s+claude\s+Cloud · 2 accounts\s/m);
    expect(cloud.match(/^pdf\s/gm)).toHaveLength(1);
    const global = await run(h, app, "skills", ["ls", "--scope", "global"]);
    expect(global).toMatch(/^eli5\s+claude\s+Global\s+0\s+never\s+unused$/m);
    expect(global).toMatch(/^eli5\s+claude\s+Global · command\s+0\s+never\s+unused$/m);
  });
});

describe("ls with no project (Review Focus 3)", () => {
  it("says no project in the title, and lists only what no project owns", async () => {
    const { h } = seed();
    // At the filesystem root there is no project: no git root, and the root is never one.
    const root = path.parse(h.home).root;
    const text = await run(h, root, "skills", ["ls", "--tool", "claude"]);
    expect(firstLine(text)).toMatch(/^2 skills · Loaded here · no project$/);
    expect(text).toMatch(/^eli5\s+Global\s/m);
    expect(text).toMatch(/^old-one\s+Global\s/m);
    expect(await run(h, root, "skills", ["ls", "--scope", "project"])).toMatch(
      /^0 skills · Project · no project\n\nNo project — pick one with --project <path>\.$/,
    );
    expect(JSON.parse(await run(h, root, "skills", ["ls", "--json"])).project).toBeNull();
  });
});

describe("ls options", () => {
  it("refuses a value or a scope that does not apply, as bad usage", async () => {
    const { h, app } = seed();
    expect(await failure(run(h, app, "skills", ["ls", "--scope", "parents"]))).toMatchObject({
      code: 2,
      message: "--scope parents does not apply to skills.",
    });
    expect(await failure(run(h, app, "hooks", ["ls", "--scope", "cloud"]))).toMatchObject({ code: 2 });
    expect(await failure(run(h, app, "mcp", ["ls", "--scope", "unused"]))).toMatchObject({ code: 2 });
    expect(await failure(run(h, app, "hooks", ["ls", "--scope", "unused"]))).toMatchObject({ code: 2 });
    const bad = await failure(run(h, app, "skills", ["ls", "--scope", "everywhere"]));
    expect(bad.code).toBe(2);
    expect(bad.message).toMatch(/^--scope takes loaded, project, /);
    expect(bad.message).not.toContain("everywhere");
    expect(await failure(run(h, app, "skills", ["ls", "--tool", "cursor"]))).toMatchObject({
      code: 2,
      message: "--tool takes claude or codex.",
    });
    expect(await failure(run(h, app, "skills", ["ls", "--scope"]))).toMatchObject({ code: 2 });
    expect(await failure(run(h, app, "skills", ["ls", "--account", "default"]))).toMatchObject({ code: 2 });
    expect(await failure(run(h, app, "skills", ["ls", "eli5"]))).toMatchObject({ code: 2 });
  });

  it("refuses an unknown subcommand as bad usage", async () => {
    const { h, app } = seed();
    expect(await failure(run(h, app, "skills", ["off", "eli5"]))).toMatchObject({
      code: 2,
      message: "Unknown subcommand 'off'. Run clausona skills --help.",
    });
  });

  it("takes every scope each command has", async () => {
    const { h, app } = seed();
    const scopes: Record<ExtensionsCommand, string[]> = {
      skills: ["loaded", "project", "global", "cloud", "plugins", "builtin", "other", "unused", "all"],
      mcp: ["loaded", "project", "parents", "global", "plugins", "managed", "other", "all"],
      hooks: ["loaded", "project", "global", "plugins", "managed", "other", "all"],
    };
    for (const [command, list] of Object.entries(scopes) as [ExtensionsCommand, string[]][]) {
      for (const scope of list) {
        const json = JSON.parse(await run(h, app, command, ["ls", "--scope", scope, "--json"]));
        expect(json).toMatchObject({ version: 1, command, scope });
        await expect(run(h, app, command, ["ls", `--scope=${scope}`])).resolves.toMatch(/^\d+ /);
      }
    }
  });

  it("answers --help with the page of the subcommand", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "skills", ["--help"])).toContain("SUBCOMMANDS");
    expect(await run(h, app, "skills", ["ls", "--help"])).toContain("List skills");
    expect(await run(h, app, "mcp", ["show", "-h"])).toContain("Everything about one MCP server");
  });

  it("refuses a --project that is no directory, without echoing it", async () => {
    const { h, app } = seed();
    const error = await failure(run(h, app, "skills", ["ls", "--project", h.path("no-such-dir")]));
    expect(error.code).toBe(2);
    expect(error.message).toBe("--project: no such directory.");
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

describe("ls --json", () => {
  it("is version 1, with the scope, the tools and each item's fields in order", async () => {
    const { h, app } = seed();
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--json"]));
    expect(json).toMatchObject({
      version: 1,
      command: "skills",
      project: app,
      scope: "loaded",
      tools: ["claude", "codex"],
      warnings: [],
    });
    expect(Object.keys(json)).toEqual(["version", "command", "project", "scope", "tools", "items", "warnings"]);
    expect(json.items).toHaveLength(4);
    for (const item of json.items) {
      expect(Object.keys(item).slice(0, 6)).toEqual(["id", "kind", "tool", "name", "scope", "from"]);
    }
    const codexOnly = JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--json"]));
    expect(codexOnly.tools).toEqual(["codex"]);
    expect(codexOnly.items.map((i: { name: string; tool: string }) => `${i.tool}:${i.name}`)).toEqual(["codex:eli5"]);
  });

  it("carries state and where for servers, and never a secret", async () => {
    const { h, app } = seed();
    const out = await run(h, app, "mcp", ["ls", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.project).toBe(app);
    expect(parsed.items.map((i: { name: string }) => i.name).sort()).toEqual(["exa", "github", "pg-dev"]);
    expect(parsed.items.find((i: { name: string }) => i.name === "github").summary).toEqual({
      transport: "stdio",
      command: "npx gh-mcp --api-key <hidden>",
      env: "GITHUB_TOKEN",
    });
    const text = await run(h, app, "mcp", ["ls"]);
    expect(text).toMatch(/^NAME\s+TOOL\s+WHERE\s+ACCOUNTS\s+NOTE$/m);
    expect(text).toMatch(/^github\s+claude\s+Global\s+all$/m);
    expect(text).toMatch(/^exa\s+codex\s+Global\s+—$/m);
    expect(leakedWindows([out, text], KEY)).toEqual([]);
  });
});

describe("show", () => {
  it("refuses a name several items have, listing them, with exit code 2", async () => {
    const { h, app } = seed();
    const error = await failure(run(h, app, "skills", ["show", "eli5"]));
    expect(error.code).toBe(2);
    // Text output: the candidates are in the message, for stderr, and nothing goes to stdout.
    expect(error.stdout).toBeUndefined();
    const lines = error.message.split("\n");
    expect(lines[0]).toBe("3 skills are named 'eli5':");
    expect(lines.filter((line) => line.includes("--id 'skill:"))).toHaveLength(3);
    expect(lines.at(-1)?.trim()).toBe("Pick one with --tool, --scope or --id <id>.");
    const json = await failure(run(h, app, "skills", ["show", "eli5", "--json"]));
    expect(json.code).toBe(2);
    const parsed = JSON.parse(json.stdout ?? "");
    expect(parsed.error).toBe("ambiguous");
    expect(parsed.candidates).toHaveLength(3);
    expect(parsed.candidates).toContainEqual({
      id: expect.stringMatching(/^skill:claude:project:/),
      tool: "claude",
      scope: "project",
      project: app,
      account: null,
    });
    for (const candidate of parsed.candidates) {
      expect(Object.keys(candidate)).toEqual(["id", "tool", "scope", "project", "account"]);
    }
  });

  it("shows one copy picked with --tool and --scope, or with --id", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["show", "eli5", "--tool", "claude", "--scope", "project"]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("PROJECT › eli5");
    expect(text).toMatch(/^Loaded {4}no, the Global copy wins \(~[\\/]\.claude[\\/]skills[\\/]eli5\)$/m);
    const json = JSON.parse(
      await run(h, app, "skills", ["show", "eli5", "--tool", "claude", "--scope", "project", "--json"]),
    );
    expect(json).toMatchObject({ kind: "skill", tool: "claude", name: "eli5", scope: "project" });
    expect(json.details[0]).toEqual({ text: "PROJECT › eli5" });
    expect(await run(h, app, "skills", ["show", "--id", json.id])).toBe(text);
    // An id is a name too, so one listed by ls --json can be given as it is.
    expect(await run(h, app, "skills", ["show", json.id])).toBe(text);
  });

  it("refuses a name nothing has with exit code 1", async () => {
    const { h, app } = seed();
    expect(await failure(run(h, app, "skills", ["show", "nope"]))).toMatchObject({
      code: 1,
      message: "No skill named 'nope'.",
    });
    expect(await failure(run(h, app, "skills", ["show", "--id", "skill:claude:global:-:nope"]))).toMatchObject({
      code: 1,
    });
    expect(await failure(run(h, app, "skills", ["show"]))).toMatchObject({ code: 2 });
  });

  it("shows a server's command and secret names, never a secret value", async () => {
    const { h, app } = seed();
    const texts = [
      await run(h, app, "mcp", ["show", "github"]),
      await run(h, app, "mcp", ["show", "github", "--json"]),
      await run(h, app, "mcp", ["show", "pg-dev"]),
      await run(h, app, "mcp", ["show", "pg-dev", "--json"]),
    ];
    expect(texts[0]).toMatch(/^Runs {6}npx gh-mcp --api-key <hidden>$/m);
    expect(texts[0]).toMatch(/^Secrets {3}GITHUB_TOKEN \(value hidden\)$/m);
    expect(texts[2]).toMatch(/^Secrets {3}PGPASSWORD \(value hidden\)$/m);
    expect(leakedWindows(texts, KEY)).toEqual([]);
  });
});

describe("mcp, a server in several accounts", () => {
  function accountsSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: {} }, mcpServers: { github: { command: "gh-mcp" } } });
    h.claude("work", ".claude-work", {
      projects: { [app]: { disabledMcpServers: ["github"] } },
      mcpServers: { github: { command: "gh-mcp" }, jira: { command: "jira-mcp" } },
    });
    h.claude("solo", ".claude-solo", { projects: { [app]: {} } });
    return { h, app };
  }

  it("is one row, whose ACCOUNTS say how many have it", async () => {
    const { h, app } = accountsSeed();
    const text = await run(h, app, "mcp", ["ls", "--tool", "claude"]);
    expect(firstLine(text)).toMatch(/^2 MCP servers · /);
    expect(text).toMatch(/^github\s+Global\s+2 of 3\s+off in 1 of 2 accounts$/m);
    expect(text).toMatch(/^jira\s+Global\s+work$/m);
    expect(await run(h, app, "mcp", ["ls", "--tool", "claude", "--account", "default"])).not.toContain("jira");
  });

  it("shows it by its name, its row key or any account's copy's id", async () => {
    const { h, app } = accountsSeed();
    const text = await run(h, app, "mcp", ["show", "github"]);
    expect(firstLine(text)).toBe("GLOBAL › github");
    const json = JSON.parse(await run(h, app, "mcp", ["show", "github", "--json"]));
    expect(json.id).toBe("mcp:claude:account:-:github");
    expect(json.copies).toHaveLength(2);
    expect(await run(h, app, "mcp", ["show", "--id", json.id])).toBe(text);
    expect(await run(h, app, "mcp", ["show", "--id", json.copies[1].id])).toBe(text);
    expect(await run(h, app, "mcp", ["show", "github", "--account", "work"])).toBe(text);
    expect(await failure(run(h, app, "mcp", ["show", "github", "--account", "solo"]))).toMatchObject({ code: 1 });
    expect(await failure(run(h, app, "mcp", ["show", "github", "--account", "nobody"]))).toMatchObject({ code: 2 });
  });
});

describe("mcp ls, a server more than one account sees", () => {
  it("is on in some accounts and off in others, for a .mcp.json server", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
    h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["docs"] } } });
    h.claude("work", ".claude-work", { projects: { [app]: { disabledMcpjsonServers: ["docs"] } } });
    // Codex records the project too, but never loads a .mcp.json, so it is not one of the two.
    h.codex("personal", ".codex", `[projects."${app.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    const text = await run(h, app, "mcp", ["ls"]);
    expect(text).toMatch(/^1 MCP server · /);
    expect(text).toMatch(/^docs\s+claude\s+Project\s+all\s+off in 1 of 2 accounts$/m);
    const docs = JSON.parse(await run(h, app, "mcp", ["ls", "--json"])).items[0];
    expect(docs.state).toBe("mixed");
    expect(docs.stateByAccount).toEqual({ "claude:default": "on", "claude:work": "off" });
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
    expect(await run(h, app, "mcp", ["ls"])).toMatch(
      /^plugin:sp:search\s+claude\s+sp\s+2 of 3\s+off in 1 of 2 accounts$/m,
    );
    const parsed = JSON.parse(await run(h, app, "mcp", ["ls", "--json"]));
    const search = parsed.items.find((i: { name: string }) => i.name === "plugin:sp:search");
    expect(search.accounts).toEqual(["claude:default", "claude:work"]);
    expect(search.stateByAccount).toEqual({ "claude:default": "on", "claude:work": "off" });
  });
});

describe("ls, a skill turned off", () => {
  it("leaves it out of Loaded here and tags it where it is", async () => {
    const { h, app } = seed();
    h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "off" } });
    expect(await run(h, app, "skills", ["ls", "--tool", "claude"])).not.toMatch(/^eli5\s/m);
    expect(await run(h, app, "skills", ["ls", "--scope", "global", "--tool", "claude"])).toMatch(
      /^eli5\s+Global\s+4\s+1d ago\s+off here$/m,
    );
  });

  it("reads another project's item in that project's own settings", async () => {
    const { h, app } = seed();
    h.write("repos/web/.claude/settings.local.json", { skillOverrides: { "web-only": "off" } });
    expect(await run(h, app, "skills", ["ls", "--scope", "other"])).toMatch(
      /^web-only\s+claude\s+web\s+0\s+never\s+off/m,
    );
  });
});

describe("hooks ls", () => {
  it("shows when each hook runs and what, cut to fit and never a secret", async () => {
    const { h, app } = seed();
    const long = `${"/opt/hooks/".repeat(6)}guard.sh`;
    h.write(".claude/settings.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              // Short enough to show whole at 160 columns, so a redaction that failed would show.
              { type: "command", command: `audit-bash --api-key ${KEY}` },
              { type: "command", command: long },
            ],
          },
        ],
      },
    });
    const wide = await run(h, app, "hooks", ["ls"], 160);
    expect(firstLine(wide)).toMatch(/^2 hooks · Loaded here · /);
    expect(wide).toMatch(/^NAME\s+TOOL\s+WHERE\s+WHEN\s+RUNS\s+NOTE$/m);
    expect(wide).toMatch(/^PreToolUse Bash\s+claude\s+Global\s+Before Bash runs\s+audit-bash --api-key <hidden>$/m);
    const narrow = await run(h, app, "hooks", ["ls"], 70);
    const rows = narrow.split("\n").filter((line) => line.startsWith("PreToolUse"));
    expect(rows).toHaveLength(2);
    // WHEN, the NAME in plain words, gives way first, then what it runs: NAME is what show takes.
    expect(rows[1]).toMatch(/^PreToolUse Bash\s+claude\s+Global\s+Before Bash…\s+\/opt\/hooks\/\S*…$/);
    for (const line of narrow.split("\n")) expect(line.length).toBeLessThanOrEqual(70);
    expect(leakedWindows([wide, narrow], KEY)).toEqual([]);
  });

  it("shows the home dir as ~ in RUNS, and in full in --json", async () => {
    const { h, app } = seed();
    const command = `${path.join(h.home, "bin", "guard.sh")} --log ${h.home}`;
    h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    const row = (await run(h, app, "hooks", ["ls"])).split("\n").find((line) => line.startsWith("Stop")) ?? "";
    expect(row).toContain("When Claude finishes replying");
    expect(row).toContain(`${path.join("~", "bin", "guard.sh")} --log ~`);
    expect(row).not.toContain(h.home);
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--json"]));
    expect(json.items[0].summary.command).toBe(command);
    expect(firstLine(await run(h, app, "hooks", ["show", "Stop"]))).toBe("GLOBAL › Stop");
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

  it("lists what Claude Code started there loads: the account's home servers and ~/.mcp.json", async () => {
    const { h } = homeSeed();
    const text = await run(h, h.home, "mcp", ["ls"]);
    expect(firstLine(text)).toBe("2 MCP servers · Loaded here · project ~");
    expect(text).toMatch(/^home-db\s+claude\s+Project\s+default$/m);
    expect(text).toMatch(/^notes\s+claude\s+Project\s+all$/m);
    // github is off for the home dir in the one account that has it.
    expect(await run(h, h.home, "mcp", ["ls", "--scope", "global"])).toMatch(
      /^github\s+claude\s+Global\s+default\s+off here$/m,
    );
  });

  it("reads --project ~ as the home project, from anywhere", async () => {
    const { h, app } = homeSeed();
    expect(await run(h, app, "mcp", ["ls", "--project", h.home])).toBe(await run(h, h.home, "mcp", ["ls"]));
    // From app, the home dir's own servers do not load.
    const fromApp = await run(h, app, "mcp", ["ls"]);
    expect(fromApp).not.toContain("home-db");
    expect(fromApp).toMatch(/^github\s+claude\s+Global\s+default$/m);
  });

  it("lists the home servers once with --scope all", async () => {
    const { h, app } = homeSeed();
    const rows = (await run(h, app, "mcp", ["ls", "--scope", "all"])).split("\n");
    expect(rows.filter((line) => line.startsWith("home-db "))).toHaveLength(1);
    expect(rows.filter((line) => line.startsWith("notes "))).toHaveLength(1);
  });
});

describe("ls --project through a link", () => {
  it("is the project recorded at the link's real path", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.link("repos/app", "links/app");
    h.claude("default", ".claude", {
      mcpServers: { github: { command: "gh-mcp" } },
      projects: { [app]: { mcpServers: { "pg-dev": { command: "pg" } }, disabledMcpServers: ["github"] } },
    });
    const json = JSON.parse(await run(h, h.home, "mcp", ["ls", "--json", "--project", h.path("links/app")]));
    expect(json.project).toBe(app);
    const text = await run(h, h.home, "mcp", ["ls", "--project", h.path("links/app")]);
    expect(text).toMatch(/^pg-dev\s+claude\s+Project\s+all$/m);
    expect(text).not.toMatch(/^github\s/m);
  });

  it("is the project recorded at the link, for the real path, when that is the path Claude Code saw", async () => {
    const h = new TestHome();
    homes.push(h);
    h.project("repos/app");
    h.link("repos/app", "links/app");
    const linked = h.path("links/app");
    h.claude("default", ".claude", {
      mcpServers: { github: { command: "gh-mcp" } },
      projects: { [linked]: { disabledMcpServers: ["github"] } },
    });
    const args = ["ls", "--json", "--scope", "global", "--project", h.path("repos/app")];
    const json = JSON.parse(await run(h, h.home, "mcp", args));
    expect(json.project).toBe(linked);
    expect(json.items.find((i: { name: string }) => i.name === "github").state).toBe("off");
  });
});

describe("ls, a .mcp.json in a parent dir", () => {
  function ancestorSeed() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", { projects: { [app]: { enabledMcpjsonServers: ["tools"] } } });
    h.claude("work", ".claude-work", { projects: { [app]: {} } });
    h.write(".mcp.json", { mcpServers: { tools: { command: "tools-mcp" }, notes: { command: "home-notes" } } });
    h.write("repos/.mcp.json", { mcpServers: { shared: { command: "repos-shared" } } });
    h.write("repos/app/.mcp.json", { mcpServers: { notes: { command: "app-notes" } } });
    return { h, app };
  }

  it("lists its servers under Parent folders, with the project's approvals, and a name the nearer file wins as hidden", async () => {
    const { h, app } = ancestorSeed();
    const parents = await run(h, app, "mcp", ["ls", "--scope", "parents"]);
    expect(firstLine(parents)).toMatch(/^3 MCP servers · Parent folders · /);
    expect(parents).toMatch(/^tools\s+claude\s+~\s+all$/m);
    expect(parents).toMatch(/^shared\s+claude\s+~[\\/]repos\s+all\s+pending approval$/m);
    expect(parents).toMatch(/^notes\s+claude\s+~\s+all\s+pending approval$/m);
    // Only tools is approved here, in one account: it is all that loads.
    const loaded = await run(h, app, "mcp", ["ls"]);
    expect(firstLine(loaded)).toMatch(/^1 MCP server · Loaded here · /);
    expect(loaded).toMatch(/^tools\s+claude\s+~\s+all$/m);
    const json = JSON.parse(await run(h, app, "mcp", ["ls", "--json"]));
    expect(json.items[0].project).toBe(h.home);
    expect(json.items[0].stateByAccount).toEqual({ "claude:default": "on", "claude:work": "pending-approval" });
  });

  it("lists each file's servers once with --scope all", async () => {
    const { h, app } = ancestorSeed();
    const rows = (await run(h, app, "mcp", ["ls", "--scope", "all"])).split("\n");
    expect(rows.filter((line) => line.startsWith("tools "))).toHaveLength(1);
    expect(rows.filter((line) => line.startsWith("shared "))).toHaveLength(1);
    expect(rows.filter((line) => line.startsWith("notes "))).toHaveLength(2);
  });
});
