import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExitError, withJsonErrors } from "../lib/json-errors.js";
import { leakedWindows } from "../test-leaks.js";
import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import { type ExtensionsCommand, runExtensionsCommand } from "./cli.js";
import { scopeSentence } from "./describe.js";
import { loadInventory } from "./inventory.js";
import { tilde } from "./present.js";
import { pathKey } from "./read.js";
import { scopesFor } from "./scopes.js";
import { codexCanonical } from "./sources/codex-trust.js";
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

// The managed settings are the home's own, so no test reads this machine's. With --json an error
// is JSON, as commands.ts runs it.
const run = (h: TestHome, cwd: string, command: ExtensionsCommand, args: string[], columns = 120) =>
  withJsonErrors(args, () =>
    runExtensionsCommand(command, args, {
      homeDir: h.home,
      cwd,
      registry: h.registry,
      now: NOW,
      columns,
      managedSettings: h.path("managed-settings.json"),
      mcpjsonStop: h.home,
    }),
  );

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

const hasGit = spawnSync("git", ["--version"]).status === 0;

/** The test's own git run in `h`, with none of the user's git config (TestHome.gitEnv). */
function gitIn(h: TestHome, cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, ...h.gitEnv() }, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

/**
 * A `[projects]` key as Codex 0.159.3 writes one (project_trust_key): the folder's real path as
 * Codex spells it, long names and all, and on Windows in lower case.
 */
function codexTrustKey(folder: string): string {
  const real = codexCanonical(realpathSync.native(folder));
  return process.platform === "win32" ? real.replace(/[A-Z]/g, (c) => c.toLowerCase()) : real;
}

describe("skills ls", () => {
  it("lists what loads here by default, titled with the scope and the project", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls"]);
    expect(firstLine(text)).toMatch(/^4 skills · Loaded · project ~[\\/]repos[\\/]app$/);
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
    expect(firstLine(text)).toMatch(/^3 skills · Loaded · project ~/);
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
    expect(text).toMatch(/^eli5\s+claude\s+Project\s+—\s+—\s+hidden by Global copy$/m);
    expect(text).not.toContain("old-one");
  });

  it("gives a hidden copy no use of its own: Claude counts it under the copy that wins", async () => {
    const { h, app } = seed();
    const text = await run(h, app, "skills", ["ls", "--scope", "all", "--tool", "claude"]);
    expect(text).toMatch(/^eli5\s+Global\s+4\s+1d ago$/m);
    expect(text).toMatch(/^eli5\s+Project\s+—\s+—\s+hidden by Global copy$/m);
    // --json keeps the data as read: usage is not a cell.
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--scope", "project", "--tool", "claude", "--json"]));
    const hidden = json.items.find((i: { name: string }) => i.name === "eli5");
    expect(hidden.tags).toEqual(["hidden by Global copy"]);
    expect(hidden.usage.total).toBe(4);
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

  it("tells two other projects of one folder name apart in WHERE, by the folder above", async () => {
    const { h, app, web } = seed();
    const [work, mine] = ["work/site", "personal/site"].map((dir) => h.project(dir));
    h.claude("default", ".claude", { projects: { [app]: {}, [web]: {}, [work as string]: {}, [mine as string]: {} } });
    h.skill("work/site/.claude/skills", "ship");
    h.skill("personal/site/.claude/skills", "ship");
    const other = await run(h, app, "skills", ["ls", "--scope", "other"]);
    const where = (text: string) => text.match(/^ship\s+claude\s+(\S+)\s/gm)?.map((line) => line.split(/\s+/)[2]);
    expect(where(other)).toEqual([path.join("personal", "site"), path.join("work", "site")]);
    // A name no other project has stays short.
    expect(other).toMatch(/^web-only\s+claude\s+web\s/m);
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--scope", "other", "--json"]));
    expect(json.items.filter((i: { name: string }) => i.name === "ship").map((i: { from: string }) => i.from)).toEqual([
      path.join("personal", "site"),
      path.join("work", "site"),
    ]);
  });

  it("lists every place but Loaded once with --scope all", async () => {
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

  it("counts plugins under --scope plugins", async () => {
    const { h, app } = seed();
    const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "kit@m": [{ installPath: kit }], "sp@m": [{ installPath: sp }] },
    });
    h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true, "sp@m": true } });
    h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-a");
    h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-b");
    h.skill(".claude/plugins/cache/m/sp/1.0.0/skills", "sp-skill");
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }] },
    });
    const skills = await run(h, app, "skills", ["ls", "--scope", "plugins"]);
    expect(firstLine(skills)).toMatch(/^2 plugins · Plugins · project ~/);
    // As the screen's Plugins table: what each brings, every kind, whichever command lists it.
    expect(skills).toMatch(/^NAME\s+TOOL\s+CONTAINS\s+NOTE$/m);
    expect(skills).toMatch(/^kit@m\s+claude\s+2 skills$/m);
    expect(skills).toMatch(/^sp@m\s+claude\s+1 skill · 1 hook$/m);
    const hooks = await run(h, app, "hooks", ["ls", "--scope", "plugins", "--tool", "claude"]);
    expect(firstLine(hooks)).toMatch(/^1 plugin · Plugins · /);
    expect(hooks).toMatch(/^NAME\s+CONTAINS\s+NOTE$/m);
    expect(hooks).toMatch(/^sp@m\s+1 skill · 1 hook$/m);
    expect(await run(h, app, "mcp", ["ls", "--scope", "plugins"])).toMatch(
      /^0 plugins · Plugins · .+\n\nNo plugin brings MCP servers\.$/,
    );
    // Each plugin row says what it brings, by row name, sorted; no other row has `contains`.
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--scope", "plugins", "--json"]));
    expect(json.items.map((i: { name: string; contains: unknown }) => [i.name, i.contains])).toEqual([
      ["kit@m", { skill: ["kit:kit-a", "kit:kit-b"], mcp: [], hook: [] }],
      ["sp@m", { skill: ["sp:sp-skill"], mcp: [], hook: ["SessionStart"] }],
    ]);
    const loaded = JSON.parse(await run(h, app, "skills", ["ls", "--json"]));
    expect(loaded.items.filter((i: object) => "contains" in i)).toEqual([]);
  });

  it("cuts a narrow Plugins table in CONTAINS before NAME, whatever the command", async () => {
    const { h, app } = seed();
    const sp = h.path(".claude/plugins/cache/m/long-plugin-name/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "long-plugin-name@m": [{ installPath: sp }] } });
    h.write(".claude/settings.json", { enabledPlugins: { "long-plugin-name@m": true } });
    h.skill(".claude/plugins/cache/m/long-plugin-name/1.0.0/skills", "one");
    h.write(".claude/plugins/cache/m/long-plugin-name/1.0.0/hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "start" }] }] },
    });
    for (const command of ["skills", "hooks"] as const) {
      const wide = await run(h, app, command, ["ls", "--scope", "plugins", "--tool", "claude"]);
      expect(wide).toMatch(/^long-plugin-name@m {2}1 skill · 1 hook$/m);
      const narrow = await run(h, app, command, ["ls", "--scope", "plugins", "--tool", "claude"], 36);
      expect(narrow).toMatch(/^long-plugin-nam… {2}1 skill · 1…$/m);
      // The table's lines, after the title and the blank line.
      for (const line of narrow.split("\n").slice(2)) expect(line.length).toBeLessThanOrEqual(36);
    }
  });

  it("lists what plugins bring with --scope all, in place of the plugins", async () => {
    const { h, app } = seed();
    const sp = h.path(".claude/plugins/cache/m/sp/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "sp@m": [{ installPath: sp }] } });
    h.write(".claude/settings.json", {
      enabledPlugins: { "sp@m": true },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
    });
    h.skill(".claude/plugins/cache/m/sp/1.0.0/skills", "sp-skill");
    h.write(".claude/plugins/cache/m/sp/1.0.0/hooks/hooks.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sp-start" }] }] },
    });
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--scope", "all", "--json"]));
    expect(json.items.map((i: { kind: string; name: string; scope: string }) => [i.kind, i.name, i.scope])).toEqual([
      ["hook", "SessionStart", "plugins"],
      ["hook", "Stop", "global"],
    ]);
    // The key is the row's, as in Loaded, so the hook is one row there and here.
    const loaded = JSON.parse(await run(h, app, "hooks", ["ls", "--json"]));
    expect(json.items[0].id).toBe(loaded.items.find((i: { name: string }) => i.name === "SessionStart").id);
    expect(firstLine(await run(h, app, "hooks", ["ls", "--scope", "all"]))).toMatch(/^2 hooks · All scopes · /);
    const skills = JSON.parse(await run(h, app, "skills", ["ls", "--scope", "all", "--tool", "claude", "--json"]));
    expect(skills.items.map((i: { name: string }) => i.name)).toContain("sp:sp-skill");
    expect(skills.items.filter((i: { kind: string }) => i.kind === "plugin")).toEqual([]);
    // The plugins stay in --scope plugins, and show still finds one by name.
    expect(firstLine(await run(h, app, "hooks", ["ls", "--scope", "plugins"]))).toMatch(/^1 plugin · Plugins · /);
    expect(firstLine(await run(h, app, "hooks", ["show", "sp@m"]))).toBe("PLUGINS › sp");
  });

  it("reads the managed settings it is pointed at", async () => {
    const { h, app } = seed();
    h.write("managed-settings.json", { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "audit" }] }] } });
    const text = await run(h, app, "hooks", ["ls", "--scope", "managed"]);
    expect(firstLine(text)).toMatch(/^1 hook · Managed · /);
    expect(text).toMatch(/^SessionEnd\s+claude\s+Managed\s+When a session ends\s+audit$/m);
  });

  it("lists Built-in: a Claude Code skill your settings name that is on no disk", async () => {
    const { h, app } = seed();
    h.write(".claude/settings.json", { skillOverrides: { "claude-api": "off" } });
    const text = await run(h, app, "skills", ["ls", "--scope", "builtin", "--tool", "claude"]);
    expect(firstLine(text)).toMatch(/^1 skill · Built-in · project ~/);
    expect(text).toMatch(/^claude-api\s+Built-in\s+0\s+never\s+off$/m);
    const inv = await loadInventory(h.inventoryOptions(app));
    // In the screen's scope list, after Plugins' place and before Not used in 90 days.
    expect(scopesFor(inv, "claude", "skill", app, NOW).map((s) => s.id)).toEqual([
      "loaded",
      "project",
      "global",
      "builtin",
      "unused",
    ]);
    expect(scopeSentence("builtin", "claude", "skill", inv, app)).toBe(
      "BUILT-IN — skills that come with Claude Code · only the ones your settings name",
    );
  });

  it("says why there is nothing to list", async () => {
    const { h, app } = seed();
    expect(await run(h, app, "hooks", ["ls"])).toMatch(/^0 hooks · Loaded · project .+\n\nNothing is loaded here\.$/);
    expect(await run(h, app, "hooks", ["ls", "--scope", "project"])).toMatch(
      /^0 hooks · Project · project .+\n\nNothing in this project's own files\.$/,
    );
    expect(await run(h, app, "hooks", ["ls", "--scope", "global"])).toMatch(
      /^0 hooks · Global · project .+\n\nNo Global hooks\.$/,
    );
    // Parent folders: .mcp.json for Claude Code, a parent's .codex for Codex.
    const parents = async (command: ExtensionsCommand, ...tool: string[]) =>
      (await run(h, app, command, ["ls", "--scope", "parents", ...tool])).split("\n\n")[1];
    expect(await parents("mcp", "--tool", "claude")).toBe("No .mcp.json in the folders above this project.");
    expect(await parents("mcp")).toBe(
      "No .mcp.json in the folders above this project, and no .codex folder there has MCP servers.",
    );
    expect(await parents("hooks")).toBe("No .codex folder above this project has hooks.");
    expect(await parents("hooks", "--tool", "claude")).toBe("Only Codex has hooks in Parent folders.");
    expect(await parents("skills", "--tool", "codex")).toBe(
      "No .agents/skills or .codex/skills in a folder above this project.",
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
    // work finds its Cloud skills in the primary's folder through the link clausona makes.
    h.link(".claude/skills", ".claude-work/skills");
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
    expect(firstLine(text)).toMatch(/^2 skills · Loaded · no project$/);
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
    expect(await failure(run(h, app, "skills", ["ls", "--scope", "managed"]))).toMatchObject({
      code: 2,
      message: "--scope managed does not apply to skills.",
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
    expect(await failure(run(h, app, "skills", ["of", "eli5"]))).toMatchObject({
      code: 2,
      kind: "usage",
      message:
        "Unknown subcommand 'of'. clausona skills takes ls, show, off, on, visibility, rm or undo. Run clausona skills --help.",
    });
    expect(await failure(run(h, app, "hooks", ["visibility"]))).toMatchObject({
      code: 2,
      message:
        "Unknown subcommand 'visibility'. clausona hooks takes ls, show, off, on, rm or undo. Run clausona hooks --help.",
    });
  });

  it("says bad usage and not found as one JSON object on stdout with --json (#103)", async () => {
    const { h, app } = seed();
    const scope = await failure(run(h, app, "skills", ["ls", "--scope", "nope", "--json"]));
    expect(scope.code).toBe(2);
    expect(JSON.parse(scope.stdout ?? "")).toEqual({
      version: 1,
      error: "usage",
      message: "--scope takes loaded, project, parents, global, cloud, plugins, builtin, other, unused or all.",
    });
    const missing = await failure(run(h, app, "skills", ["show", "nope", "--json"]));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout ?? "")).toEqual({
      version: 1,
      error: "not-found",
      message: "No skill named 'nope'.",
    });
    const project = await failure(run(h, app, "skills", ["ls", "--project", h.path("no-such-dir"), "--json"]));
    expect(JSON.parse(project.stdout ?? "")).toEqual({
      version: 1,
      error: "usage",
      message: "--project: no such directory.",
    });
    // An option's value is never quoted back, a key given by mistake included.
    const secret = await failure(run(h, app, "skills", ["ls", "--scope", KEY, "--json"]));
    expect(secret.message).not.toContain(KEY);
    expect(leakedWindows([secret.message, secret.stdout ?? ""], KEY)).toEqual([]);
    // Without --json, an error is the message alone, for stderr.
    expect((await failure(run(h, app, "skills", ["show", "nope"]))).stdout).toBeUndefined();
  });

  it("takes every scope each command has", async () => {
    const { h, app } = seed();
    const scopes: Record<ExtensionsCommand, string[]> = {
      skills: ["loaded", "project", "parents", "global", "cloud", "plugins", "builtin", "other", "unused", "all"],
      mcp: ["loaded", "project", "parents", "global", "plugins", "managed", "other", "all"],
      hooks: ["loaded", "project", "parents", "global", "plugins", "managed", "other", "all"],
    };
    for (const [command, list] of Object.entries(scopes) as [ExtensionsCommand, string[]][]) {
      for (const scope of list) {
        const json = JSON.parse(await run(h, app, command, ["ls", "--scope", scope, "--json"]));
        expect(json).toMatchObject({ version: 1, command, scope });
        await expect(run(h, app, command, ["ls", `--scope=${scope}`])).resolves.toMatch(/^\d+ /);
      }
    }
  });

  it("says on the ls and show pages what state and stateByAccount hold", async () => {
    const { h, app } = seed();
    for (const command of ["skills", "mcp", "hooks"] as const) {
      for (const sub of ["ls", "show"]) {
        const help = await run(h, app, command, [sub, "--help"]);
        expect(help, `${command} ${sub}`).toContain("state: the row's one state, or mixed when its accounts differ");
        expect(help, `${command} ${sub}`).toContain("stateByAccount: each account's, for a row read per account");
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
    expect(text).toContain(`\n\nCould not read every file, so this list may miss what they hold:\n  ${bad}: `);
    const shown = await run(h, app, "skills", ["show", "deploy-check"]);
    expect(shown).toContain(`\n\nCould not read every file, so this may miss what they hold:\n  ${bad}: `);
    expect(leakedWindows([text, shown], KEY)).toEqual([]);
  });

  it("reads a leading ~ in --project as the home dir, as a shell would", async () => {
    const { h, app, web } = seed();
    const fromWeb = await run(h, app, "skills", ["ls", "--project", "~/repos/web"]);
    expect(fromWeb).toBe(await run(h, app, "skills", ["ls", "--project", web]));
    expect(JSON.parse(await run(h, app, "skills", ["ls", "--project=~", "--json"])).project).toBe(h.home);
  });

  it("stands in a project recorded inside a repository when --project names it by that path", async () => {
    const { h } = seed();
    // A repository (h.project makes its .git), and two folders in it.
    const mono = h.project("repos/mono");
    const [sub, other] = [h.path("repos", "mono", "sub"), h.path("repos", "mono", "other")];
    for (const dir of [sub, other]) mkdirSync(dir, { recursive: true });
    // Codex recorded sub (a table with no trust_level records it and decides nothing); other no one did.
    h.write(".codex/config.toml", `[projects.${JSON.stringify(sub)}]\n`);
    const projectOf = async (at: string, cwd = h.home) =>
      JSON.parse(await run(h, cwd, "skills", ["ls", "--project", at, "--json"])).project;
    expect(await projectOf(sub)).toBe(sub);
    expect(await projectOf("~/repos/mono/sub")).toBe(sub);
    expect(await projectOf("sub", mono)).toBe(sub);
    // Any other folder in the repository is the repository, as the current directory is.
    expect(await projectOf(other)).toBe(mono);
    expect(JSON.parse(await run(h, sub, "skills", ["ls", "--json"])).project).toBe(mono);
    // On Windows a path matches in any case, as there a folder does.
    if (process.platform === "win32") expect(await projectOf(sub.toUpperCase())).toBe(sub);
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

describe("what an agent tripped on", () => {
  it("finds a plugin by its name before the @, and calls two such plugins ambiguous", async () => {
    const { h, app } = seed();
    const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
    h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
    h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "kit-a");
    const short = await run(h, app, "skills", ["show", "kit"]);
    expect(firstLine(short)).toBe("PLUGINS › kit");
    expect(await run(h, app, "skills", ["show", "kit@m"])).toBe(short);
    const other = h.path(".claude/plugins/cache/x/kit/2.0.0");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "kit@m": [{ installPath: kit }], "kit@x": [{ installPath: other }] },
    });
    h.skill(".claude/plugins/cache/x/kit/2.0.0/skills", "kit-b");
    const both = await failure(run(h, app, "skills", ["show", "kit", "--json"]));
    expect(both.code).toBe(2);
    expect(JSON.parse(both.stdout ?? "").candidates.map((c: { id: string }) => c.id)).toEqual([
      expect.stringMatching(/kit@m$/),
      expect.stringMatching(/kit@x$/),
    ]);
  });

  it("says a Codex row's state without accounts, Codex having none here", async () => {
    const { h, app } = seed();
    const skill = await run(h, app, "skills", ["show", "eli5", "--tool", "codex"]);
    expect(skill).toMatch(/^Loaded {4}on in every project$/m);
    const server = await run(h, app, "mcp", ["show", "exa"]);
    expect(server).toMatch(/^Loaded {4}on in every project$/m);
    h.write(".codex/config.toml", '[mcp_servers.exa]\ncommand = "npx"\nenabled = false\n');
    const off = await run(h, app, "mcp", ["show", "exa", "--scope", "global"]);
    expect(off).toMatch(/^Loaded {4}off everywhere \(~[\\/]\.codex[\\/]config\.toml\)$/m);
    for (const text of [skill, server, off]) expect(text).not.toMatch(/account/);
  });

  it("says how long ago a never-used skill was added, as the not-used rule reads it", async () => {
    const { h, app } = seed();
    // 200 days on, by NOW: past the 14 days' grace, so it is unused.
    expect(await run(h, app, "skills", ["show", "deploy-check"])).toMatch(
      /^Used {6}never, in any account · added 6mo ago$/m,
    );
    const fresh = await runExtensionsCommand("skills", ["show", "deploy-check"], {
      homeDir: h.home,
      cwd: app,
      registry: h.registry,
      now: Date.now() + 3 * DAY,
      managedSettings: h.path("managed-settings.json"),
      mcpjsonStop: h.home,
    });
    expect(fresh).toMatch(/^Used {6}never, in any account · added 3d ago$/m);
  });

  it("leaves a broken link out of Loaded, tagged where it is listed", async () => {
    const { h, app } = seed();
    h.link(h.path("gone", "lost"), ".claude/skills/lost");
    expect(await run(h, app, "skills", ["ls", "--tool", "claude"])).not.toMatch(/^lost\s/m);
    expect(await run(h, app, "skills", ["ls", "--scope", "global", "--tool", "claude"])).toMatch(
      /^lost\s+Global\s+0\s+never\s+broken link$/m,
    );
    expect(await run(h, app, "skills", ["ls", "--scope", "unused", "--tool", "claude"])).toMatch(
      /^lost\s+Global\s+0\s+never\s+broken link$/m,
    );
    expect(await run(h, app, "skills", ["show", "lost"])).toMatch(/^Loaded {4}no, its link leads nowhere$/m);
  });
});

describe("show", () => {
  it("refuses a name several loaded items have, listing them, with exit code 2", async () => {
    const { h, app } = seed();
    // Claude's Global eli5 and Codex's both load here; app's own is hidden, so it is not asked about.
    const error = await failure(run(h, app, "skills", ["show", "eli5"]));
    expect(error.code).toBe(2);
    // Text output: the candidates are in the message, for stderr, and nothing goes to stdout.
    expect(error.stdout).toBeUndefined();
    const lines = error.message.split("\n");
    expect(lines[0]).toBe("2 skills are named 'eli5':");
    expect(lines.filter((line) => line.includes("--id 'skill:"))).toHaveLength(2);
    expect(lines.at(-1)?.trim()).toBe("Pick one with --tool, --scope or --id <id>.");
    const json = await failure(run(h, app, "skills", ["show", "eli5", "--json"]));
    expect(json.code).toBe(2);
    const parsed = JSON.parse(json.stdout ?? "");
    // Every error object has a message; this one adds the name it was given, and the candidates.
    expect(Object.keys(parsed)).toEqual(["version", "error", "message", "name", "candidates"]);
    expect(parsed.version).toBe(1);
    expect(parsed.error).toBe("ambiguous");
    expect(parsed.message).toBe(error.message);
    expect(parsed.name).toBe("eli5");
    expect(parsed.candidates).toEqual([
      { id: "skill:claude:global:-:eli5", tool: "claude", scope: "global", project: null, account: null },
      { id: "skill:codex:global:agents:eli5", tool: "codex", scope: "global", project: null, account: null },
    ]);
  });

  it("looks in what loads here first, then this project and global, then other projects", async () => {
    const { h, app } = seed();
    h.skill("repos/web/.claude/skills", "eli5");
    // Global, app and web each have one: the Global one is what loads here.
    expect(firstLine(await run(h, app, "skills", ["show", "eli5", "--tool", "claude"]))).toBe("GLOBAL › eli5");
    // Nothing here has web-only: it is found in the other projects.
    const webOnly = await run(h, app, "skills", ["show", "web-only"]);
    expect(firstLine(webOnly)).toBe("OTHER PROJECTS › web-only");
    // Not loaded, but this project's own: found before web's.
    h.write("repos/app/.claude/settings.local.json", { skillOverrides: { "deploy-check": "off" } });
    h.skill("repos/web/.claude/skills", "deploy-check");
    expect(firstLine(await run(h, app, "skills", ["show", "deploy-check"]))).toBe("PROJECT › deploy-check");
    // The first tier with the name decides: Codex's web-only loads here, so web's is not asked about.
    h.skill(".agents/skills", "web-only");
    const codexFirst = await run(h, app, "skills", ["show", "web-only", "--json"]);
    expect(JSON.parse(codexFirst)).toMatchObject({ tool: "codex", scope: "global", name: "web-only" });
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
    expect(json).toMatchObject({ version: 1, kind: "skill", tool: "claude", name: "eli5", scope: "project" });
    expect(Object.keys(json)[0]).toBe("version");
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

  it("keeps with --account what loads for that account, and in another scope what it has", async () => {
    const { h, app } = accountsSeed();
    // github is off in work, so it does not load for work; jira does.
    const loaded = await run(h, app, "mcp", ["ls", "--account", "work"]);
    expect(firstLine(loaded)).toMatch(/^1 MCP server · Loaded · /);
    expect(loaded).toMatch(/^jira\s+Global\s+work$/m);
    expect(loaded).not.toMatch(/^github\s/m);
    const names = async (args: string[]) =>
      JSON.parse(await run(h, app, "mcp", [...args, "--json"])).items.map((i: { name: string }) => i.name);
    expect(await names(["ls", "--account", "work", "--scope", "loaded"])).toEqual(["jira"]);
    expect(await names(["ls", "--account", "default"])).toEqual(["github"]);
    // Every other scope keeps the rows the account has, on or off.
    expect(await names(["ls", "--account", "work", "--scope", "global"])).toEqual(["github", "jira"]);
    expect(await names(["ls", "--account", "work", "--scope", "all"])).toEqual(["github", "jira"]);
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

describe("mcp, one server per name, as Claude Code picks it", () => {
  /** personal and work, each with a user github; app's .mcp.json has a github too, and `entry` is each account's entry for app. */
  function precedenceSeed(entry: Record<string, unknown>, work: Record<string, unknown> = entry) {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const user = { github: { command: "gh-user" } };
    h.claude("personal", ".claude", { projects: { [app]: entry }, mcpServers: user });
    h.claude("work", ".claude-work", { projects: { [app]: work }, mcpServers: user });
    h.write("repos/app/.mcp.json", { mcpServers: { github: { command: "gh-team" } } });
    h.codex("personal", ".codex", '[mcp_servers.github]\ncommand = "gh-codex"\n');
    return { h, app };
  }

  it("takes an approved .mcp.json copy over the user one, and shows it without asking which", async () => {
    const { h, app } = precedenceSeed({ enabledMcpjsonServers: ["github"] });
    const loaded = await run(h, app, "mcp", ["ls", "--tool", "claude"]);
    expect(firstLine(loaded)).toMatch(/^1 MCP server · Loaded · /);
    expect(loaded).toMatch(/^github\s+Project\s+all$/m);
    expect(await run(h, app, "mcp", ["ls", "--scope", "global", "--tool", "claude"])).toMatch(
      /^github\s+Global\s+all\s+hidden by Project copy$/m,
    );
    const shown = await run(h, app, "mcp", ["show", "github", "--tool", "claude"]);
    expect(firstLine(shown)).toBe("PROJECT › github");
    expect(shown).toMatch(/^Runs {6}gh-team$/m);
  });

  it("takes the user copy over a .mcp.json one still pending approval", async () => {
    const { h, app } = precedenceSeed({});
    const loaded = await run(h, app, "mcp", ["ls", "--tool", "claude"]);
    expect(firstLine(loaded)).toMatch(/^1 MCP server · Loaded · /);
    expect(loaded).toMatch(/^github\s+Global\s+all$/m);
    expect(await run(h, app, "mcp", ["ls", "--scope", "project", "--tool", "claude"])).toMatch(
      /^github\s+Project\s+all\s+pending approval$/m,
    );
    expect(firstLine(await run(h, app, "mcp", ["show", "github", "--tool", "claude"]))).toBe("GLOBAL › github");
  });

  it("takes an account's local copy over the others in that account, and says so per account", async () => {
    const local = { mcpServers: { github: { command: "gh-local" } } };
    const { h, app } = precedenceSeed(local, { enabledMcpjsonServers: ["github"] });
    const json = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "claude", "--json"]));
    // personal's local one and the .mcp.json one, which work approved; both user ones lose.
    expect(json.items.map((i: { scope: string; accounts?: string[] }) => [i.scope, i.accounts])).toEqual([
      ["project", ["claude:personal"]],
      ["project", ["claude:personal", "claude:work"]],
    ]);
    const team = await run(h, app, "mcp", ["show", "--id", json.items[1].id]);
    expect(team).toMatch(/^Accounts {2}personal {2}hidden by the Project copy$/m);
    expect(team).toMatch(/^ {10}work {6}on$/m);
    // In Loaded, --account keeps what loads for the account: one github each, no ambiguity.
    for (const [account, from] of [
      ["personal", "gh-local"],
      ["work", "gh-team"],
    ] as const) {
      const shown = await run(h, app, "mcp", ["show", "github", "--tool", "claude", "--account", account]);
      expect(shown).toMatch(new RegExp(`^Runs {6}${from}$`, "m"));
      expect(await run(h, app, "mcp", ["ls", "--account", account])).toMatch(/^1 MCP server · /);
    }
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

describe("mcp ls --scope other, a .mcp.json server seen from outside its folder", () => {
  /**
   * site is the project looked from. app, under repos, has docs in its .mcp.json, approved there
   * by default; repos is no project, and its .mcp.json has wiki, which loads in app.
   */
  function outside() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const site = h.project("site");
    h.write("repos/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
    h.write("repos/.mcp.json", { mcpServers: { wiki: { command: "wiki-mcp" } } });
    h.claude("default", ".claude", {
      projects: { [app]: { enabledMcpjsonServers: ["docs", "wiki"] }, [site]: {} },
    });
    h.claude("work", ".claude-work", { projects: { [app]: {}, [site]: {} } });
    return { h, app, site };
  }

  it("reads each row's state in its own project, where WHERE says it is", async () => {
    const { h, app, site } = outside();
    const parsed = JSON.parse(await run(h, site, "mcp", ["ls", "--scope", "other", "--json"]));
    const docs = parsed.items.find((i: { name: string }) => i.name === "docs");
    // In app, where it is: approved by default, pending for work. site has no say in it.
    expect(docs).toMatchObject({ project: app, from: "app", state: "mixed" });
    expect(docs.stateByAccount).toEqual({ "claude:default": "on", "claude:work": "pending-approval" });
    expect(docs.tags).toEqual([]);
    expect(await run(h, site, "mcp", ["ls", "--scope", "other"])).toMatch(/^docs\s+claude\s+app\s+all\s*$/m);
  });

  it("says not here for one of a folder that is no project, which has no state of its own", async () => {
    const { h, app, site } = outside();
    const text = await run(h, site, "mcp", ["ls", "--scope", "other"]);
    expect(text).toMatch(/^wiki\s+claude\s+~[\\/]repos\s+all\s+not here$/m);
    const wiki = JSON.parse(await run(h, site, "mcp", ["ls", "--scope", "other", "--json"])).items.find(
      (i: { name: string }) => i.name === "wiki",
    );
    expect(wiki).toMatchObject({ project: h.path("repos"), state: "not-here", tags: ["not here"] });
    expect(wiki).not.toHaveProperty("stateByAccount");
    expect(await run(h, site, "mcp", ["show", "wiki"])).toMatch(
      /^Accounts {2}not here: it loads in the projects in ~[\\/]repos, each with its own approvals$/m,
    );
    // Seen from app, below it, it has app's approvals.
    const fromApp = JSON.parse(await run(h, app, "mcp", ["ls", "--json"])).items.find(
      (i: { name: string }) => i.name === "wiki",
    );
    expect(fromApp.stateByAccount).toEqual({ "claude:default": "on", "claude:work": "pending-approval" });
  });
});

describe("skills, a project skill an account's own copy hides", () => {
  it("loads it in the other accounts, untagged, and says per account where it is hidden", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("personal", ".claude", { projects: { [app]: {} } });
    h.claude("work", ".claude-work", { projects: { [app]: {} } });
    h.skill("repos/app/.claude/skills", "deploy");
    h.skill(".claude-work/skills", "deploy");
    const project = await run(h, app, "skills", ["ls", "--scope", "project"]);
    expect(project).toMatch(/^deploy\s+claude\s+Project\s+0\s+never\s+unused$/m);
    const loaded = await run(h, app, "skills", ["ls"]);
    expect(loaded).toMatch(/^deploy\s+claude\s+Project\s/m);
    expect(loaded).toMatch(/^deploy\s+claude\s+Global · work\s/m);
    const shown = await run(h, app, "skills", ["show", "deploy", "--scope", "project"]);
    expect(shown).toMatch(/^Loaded {4}on in personal · hidden by the Global copy in work$/m);
    const json = JSON.parse(await run(h, app, "skills", ["show", "deploy", "--scope", "project", "--json"]));
    expect(json.stateByAccount).toEqual({ "claude:personal": "on", "claude:work": "on" });
    expect(json.tags).toEqual(["unused"]);
  });
});

describe("ls, a skill turned off", () => {
  it("leaves it out of Loaded and tags it where it is", async () => {
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
    expect(firstLine(wide)).toMatch(/^2 hooks · Loaded · /);
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

describe("Codex hooks and Codex's trust", () => {
  it("refuses on for a Codex hook a config.toml Codex cannot read keeps off, naming that file", async () => {
    const { h, app } = seed();
    const stop = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo z" }] }] } };
    h.write(".codex/hooks.json", stop);
    const user = tilde(h.path(".codex", "config.toml"), h.home);
    // Codex 0.159.3 loads no config with a user config.toml it refuses, so runs no hook at all.
    h.write(".codex/config.toml", "[mcp_servers.x]\ncommand = 5\n");
    const reasons = async (cwd: string) =>
      JSON.parse(await run(h, cwd, "hooks", ["on", "Stop", "--tool", "codex", "--dry-run", "--json"])).refused.map(
        (r: { code: string; reason: string }) => [r.code, r.reason],
      );
    expect(await reasons(app)).toEqual([
      ["codex-skips-hook", `Codex cannot read ${user}, so it loads no config anywhere. Change it in ${user}.`],
    ]);
    // A trusted project's that Codex refuses: none in that project, the user's hooks.json too.
    h.write(".codex/config.toml", `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`);
    h.write("repos/app/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    const own = tilde(path.join(app, ".codex", "config.toml"), h.home);
    expect(await reasons(app)).toEqual([
      ["codex-skips-hook", `Codex cannot read ${own}, so it loads no config here. Change it in ${own}.`],
    ]);
  });

  it("refuses on for a Codex hook Codex skips, with the reason it does not run", async () => {
    const { h, app } = seed();
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "prompt", prompt: "p" },
              { type: "command", command: "  " },
              { type: "mcp_tool", server: "s", tool: "" },
            ],
          },
        ],
        PreToolUse: [{ matcher: "(?=Bash)", hooks: [{ type: "command", command: "ahead" }] }],
        Unknown: [{ hooks: [{ type: "command", command: "who" }] }],
      },
    });
    // A trusted project's hooks.json with more than hooks at its top, which Codex skips whole.
    h.write(".codex/config.toml", `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`);
    h.write("repos/app/.codex/hooks.json", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "app" }] }] },
      extra: 1,
    });
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "all", "--json"]));
    const ids = json.items.map((i: { id: string }) => i.id);
    expect(ids).toHaveLength(6);
    const plan = JSON.parse(
      await run(h, app, "hooks", ["on", ...ids.flatMap((id: string) => ["--id", id]), "--dry-run", "--json"]),
    );
    const why = (reason: string, at = ".codex/hooks.json") => [
      "codex-skips-hook",
      `${reason} Change it in ${tilde(h.path(...at.split("/")), h.home)}.`,
    ];
    expect(plan.refused.map((r: { code: string; reason: string }) => [r.code, r.reason]).sort()).toEqual(
      [
        why("Codex does not run prompt hooks yet."),
        why("Codex skips a hook whose command is empty."),
        why("Codex skips the hooks of a matcher that is not a regex it can compile."),
        why("Codex knows no event of that name, and runs no hook on it."),
        why("Codex skips an MCP tool hook whose server or tool is empty."),
        why(
          "Codex skips its hooks file: it holds more than hooks and a description at its top, or a hook Codex cannot read.",
          "repos/app/.codex/hooks.json",
        ),
      ].sort(),
    );
    expect(plan.unchanged).toEqual([]);
  });

  it("lists a hook Codex has not trusted as pending approval, out of Loaded, and one it trusts as on", async () => {
    const { h, app } = seed();
    const file = h.path(".codex", "hooks.json");
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "echo a" },
              { type: "command", command: "echo b" },
            ],
          },
        ],
      },
    });
    // Trusted at the hash Codex 0.159.3 gives `echo a` on Stop; `echo b` never reviewed.
    h.write(
      ".codex/config.toml",
      `[mcp_servers.exa]\ncommand = "npx"\n\n[hooks.state.${JSON.stringify(`${file}:stop:0:0`)}]\ntrusted_hash = "sha256:f9b7a328de9c5845f5eed806f12f8f5adeba50ba82617690fd3f8ededeb12f90"\n`,
    );
    const loaded = await run(h, app, "hooks", ["ls", "--tool", "codex"]);
    expect(loaded).toContain("echo a");
    expect(loaded).not.toContain("echo b");
    const global = await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global"], 160);
    expect(global).toMatch(/^Stop\s+Global\s+When Codex finishes replying\s+echo b\s+pending approval$/m);
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    const b = json.items.find((i: { summary: { command: string } }) => i.summary.command === "echo b");
    expect(b).toMatchObject({ state: "pending-approval", tags: ["pending approval"] });
    const shown = await run(h, app, "hooks", ["show", "--id", b.id]);
    expect(shown).toMatch(/^Loaded\s+not yet: you have not trusted it yet - review it with \/hooks in Codex$/m);
    const on = await run(h, app, "hooks", ["on", "--id", b.id, "--yes"]);
    expect(on).toContain("already in its file: Codex runs it once you trust it with /hooks");
  });

  it("lists the servers a project Codex does not trust defines as off there, out of Loaded", async () => {
    const { h, app, web } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(web)}]\ntrust_level = "untrusted"\n\n[mcp_servers.shared]\ncommand = "user-shared"\n`,
    );
    const servers = (d: string) =>
      `[mcp_servers.${d}-srv]\ncommand = "${d}-srv"\n\n[mcp_servers.shared]\ncommand = "${d}-shared"\n`;
    h.write("repos/app/.codex/config.toml", servers("app"));
    h.write("repos/web/.codex/config.toml", servers("web"));
    // What Codex 0.159.3's config/read gave in web: the user's shared alone.
    const project = JSON.parse(await run(h, web, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(
      project.items.map((i: { name: string; state: string; tags: string[] }) => [i.name, i.state, i.tags]),
    ).toEqual([
      ["shared", "off", ["off"]],
      ["web-srv", "off", ["off"]],
    ]);
    const loaded = JSON.parse(await run(h, web, "mcp", ["ls", "--tool", "codex", "--json"]));
    expect(loaded.items.map((i: { name: string; scope: string }) => [i.name, i.scope])).toEqual([["shared", "global"]]);
    const shown = await run(h, web, "mcp", ["show", "web-srv"]);
    expect(shown).toMatch(/^Loaded\s+off: Codex starts a project's servers only once it trusts the project$/m);
    expect(shown).toMatch(/^Trust\s+Codex does not trust this project, so it ignores its \.codex folder\.$/m);
    // In app, which Codex trusts, app's own load.
    const own = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(own.items.map((i: { state: string }) => i.state)).toEqual(["on", "on"]);
  });

  it("hides the user's server under a same-name one a trusted project defines, as Codex takes the project's", async () => {
    const { h, app, web } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[mcp_servers.shared]\ncommand = "user-shared"\n`,
    );
    h.write("repos/app/.codex/config.toml", '[mcp_servers.shared]\ncommand = "app-shared"\n');
    h.write("repos/web/.codex/config.toml", '[mcp_servers.shared]\ncommand = "web-shared"\n');
    // Codex 0.159.3's config/read in app: shared runs app-shared.
    const loaded = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--json"]));
    expect(loaded.items.map((i: { name: string; scope: string }) => [i.name, i.scope])).toEqual([
      ["shared", "project"],
    ]);
    const global = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(global.items.map((i: { name: string; tags: string[] }) => [i.name, i.tags])).toEqual([
      ["shared", ["hidden by Project copy"]],
    ]);
    const shown = await run(h, app, "mcp", ["show", "--id", global.items[0].id]);
    expect(shown).toMatch(/^Loaded\s+no, the Project copy wins \(~[\\/]repos[\\/]app[\\/]\.codex[\\/]config\.toml\)$/m);
    // In web, which Codex does not trust, the user's runs.
    const there = JSON.parse(await run(h, web, "mcp", ["ls", "--tool", "codex", "--json"]));
    expect(there.items.map((i: { name: string; scope: string }) => [i.name, i.scope])).toEqual([["shared", "global"]]);
  });

  it("shows a user server a trusted project's table changes without a command as Codex runs it there", async () => {
    const { h, app, web } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\nargs = ["-y", "exa"]\nenv = { A = "1" }\n`,
    );
    // Codex 0.159.3's config/read in app: exa runs npx --p, env A; in web, untrusted, npx -y exa.
    h.write("repos/app/.codex/config.toml", '[mcp_servers.exa]\nargs = ["--p"]\n');
    h.write("repos/web/.codex/config.toml", '[mcp_servers.exa]\nargs = ["--p"]\n');
    type Row = { name: string; scope: string; summary: Record<string, string>; tags: string[] };
    const rows = async (cwd: string) =>
      (JSON.parse(await run(h, cwd, "mcp", ["ls", "--tool", "codex", "--scope", "all", "--json"])).items as Row[]).map(
        (i) => [i.scope, i.summary.command, i.tags],
      );
    expect(await rows(app)).toEqual([
      ["project", "npx --p", []],
      ["global", "npx -y exa", ["hidden by Project copy"]],
    ]);
    // From web app's copy is another project's.
    expect(await rows(web)).toEqual([
      ["global", "npx -y exa", []],
      ["other", "npx --p", []],
    ]);
    // A change goes to app's own table, as for any project copy.
    const off = JSON.parse(await run(h, app, "mcp", ["off", "exa", "--tool", "codex", "--dry-run", "--json"]));
    expect(off.changes.map((c: { file: string; what: string }) => [c.file, c.what])).toEqual([
      [path.join(app, ".codex", "config.toml"), "mcp_servers.exa.enabled → false"],
    ]);
    // A table that only switches it is that switch, and no copy.
    h.write("repos/app/.codex/config.toml", "[mcp_servers.exa]\nenabled = false\n");
    expect(await rows(app)).toEqual([["global", "npx -y exa", ["off here"]]]);
  });

  it("shows a trusted project's server merged over the user's, as Codex runs it, and an untrusted one's as written", async () => {
    const { h, app, web } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[mcp_servers.shared]\ncommand = "npx"\nargs = ["-y", "shared"]\nenv = { A = "1" }\n`,
    );
    h.write("repos/app/.codex/config.toml", '[mcp_servers.shared]\ncommand = "app-shared"\nenv = { B = "2" }\n');
    h.write("repos/web/.codex/config.toml", '[mcp_servers.shared]\ncommand = "web-shared"\nenv = { B = "2" }\n');
    // Codex 0.159.3's config/read in app: command app-shared, args -y shared, env A and B. In
    // web, untrusted, it reads none of web's file.
    const project = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(project.items.map((i: { summary: Record<string, string> }) => i.summary)).toEqual([
      { transport: "stdio", command: "app-shared -y shared", env: "A, B" },
    ]);
    expect(await run(h, app, "mcp", ["show", "--id", project.items[0].id])).toMatch(/^Runs\s+app-shared -y shared$/m);
    const there = JSON.parse(await run(h, web, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(there.items.map((i: { summary: Record<string, string> }) => i.summary)).toEqual([
      { transport: "stdio", command: "web-shared", env: "B" },
    ]);
  });

  /**
   * A home whose project root, for Codex, is ~/repos (a `.hg` marker there), above app and web:
   * Codex reads ~/repos/.codex for both, by ~/repos's own trust - and ~/repos, whose entry that
   * is, is a project too. `user` goes after the markers.
   */
  const parentHome = (user: (projects: { app: string; web: string }) => string) => {
    const seeded = seed();
    const { h } = seeded;
    const repos = h.path("repos");
    h.write("repos/.hg/requires", "");
    h.write(
      ".codex/config.toml",
      `project_root_markers = [".hg"]\n\n[projects.${JSON.stringify(repos)}]\ntrust_level = "trusted"\n\n${user(seeded)}`,
    );
    return { ...seeded, repos, parentFile: path.join(repos, ".codex", "config.toml") };
  };

  it("lists what a parent folder's .codex holds under Parent folders with its file, merged as Codex merges it", async () => {
    const { h, app, web, parentFile } = parentHome(
      ({ web }) =>
        `[projects.${JSON.stringify(web)}]\ntrust_level = "untrusted"\n\n[mcp_servers.shared]\ncommand = "user-shared"\n`,
    );
    h.write(
      "repos/.codex/config.toml",
      '[mcp_servers.rootsrv]\ncommand = "root"\n\n[mcp_servers.shared]\ncommand = "root-shared"\nargs = ["--root"]\n',
    );
    h.write("repos/.codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "root-hook" }] }] } });
    h.write(
      "repos/app/.codex/config.toml",
      '[mcp_servers.subsrv]\ncommand = "sub"\n\n[mcp_servers.shared]\nenv = { S = "1" }\n',
    );
    h.write("repos/app/.codex/hooks.json", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "sub-hook" }] }] },
    });
    h.write("repos/web/.codex/config.toml", '[mcp_servers.websrv]\ncommand = "web"\n');
    type Row = { name: string; file: string; state: string; tags: string[]; summary: Record<string, string> };
    const rows = async (cwd: string, scope: string, command: ExtensionsCommand = "mcp") =>
      (
        JSON.parse(await run(h, cwd, command, ["ls", "--tool", "codex", "--scope", scope, "--json"])).items as Row[]
      ).map((i) => [i.name, i.file, i.state, i.tags, i.summary.command]);
    const appFile = path.join(app, ".codex", "config.toml");
    // What Codex 0.159.3's config/read gave started in a folder below a trusted root: the root's
    // rootsrv, the folder's subsrv, and shared as root-shared --root with the folder's env S.
    expect(await rows(app, "parents")).toEqual([
      ["rootsrv", parentFile, "on", [], "root"],
      ["shared", parentFile, "on", ["hidden by Project copy"], "root-shared --root"],
    ]);
    expect(await rows(app, "project")).toEqual([
      ["shared", appFile, "on", [], "root-shared --root"],
      ["subsrv", appFile, "on", [], "sub"],
    ]);
    const shared = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(shared.items[0].summary).toMatchObject({ env: "S" });
    const table = await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "parents"], 160);
    expect(table).toMatch(/^rootsrv\s+~[\\/]repos[\\/]\.codex[\\/]config\.toml\s/m);
    expect(firstLine(table)).toMatch(/^2 MCP servers · Parent folders · /);
    // The screen lists them in a scope of their own, after Project and before Global.
    const inv = await loadInventory(h.inventoryOptions(app));
    expect(scopesFor(inv, "codex", "mcp", app, NOW).map((s) => s.id)).toEqual([
      "loaded",
      "project",
      "parents",
      "global",
    ]);
    expect(scopeSentence("parents", "codex", "hook", inv, app)).toBe(
      `PARENT FOLDERS — .codex in ${tilde(h.path("repos"), h.home)} · runs here too`,
    );
    // Codex lists both folders' hooks.
    expect((await rows(app, "parents", "hooks")).map((r) => r[1])).toEqual([
      path.join(h.path("repos"), ".codex", "hooks.json"),
    ]);
    expect((await rows(app, "project", "hooks")).map((r) => r[1])).toEqual([path.join(app, ".codex", "hooks.json")]);
    // Where Codex does not trust the folder but trusts the root, it reads the root's alone.
    expect(await rows(web, "parents")).toEqual([
      ["rootsrv", parentFile, "on", [], "root"],
      ["shared", parentFile, "on", [], "root-shared --root"],
    ]);
    expect(await rows(web, "project")).toEqual([
      ["websrv", path.join(web, ".codex", "config.toml"), "off", ["off"], "web"],
    ]);
    expect(await run(h, web, "mcp", ["show", "rootsrv"])).not.toMatch(/^Trust/m);
    // Your shared gives way to the nearest copy Codex reads: app's own in app, the root's in web.
    const userFile = h.path(".codex", "config.toml");
    expect(await rows(app, "global")).toEqual([["shared", userFile, "on", ["hidden by Project copy"], "user-shared"]]);
    expect(await rows(web, "global")).toEqual([
      ["shared", userFile, "on", ["hidden by Parent folders copy"], "user-shared"],
    ]);
  });

  it("reads no parent folder's .codex Codex does not trust, nor any where no marker is above", async () => {
    // The root's own entry says untrusted, app's trusted: Codex reads app's alone.
    const { h, app, repos } = parentHome(({ app }) => `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`);
    h.write(
      ".codex/config.toml",
      `project_root_markers = [".hg"]\n\n[projects.${JSON.stringify(repos)}]\ntrust_level = "untrusted"\n\n[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`,
    );
    h.write("repos/.codex/config.toml", '[mcp_servers.rootsrv]\ncommand = "root"\n');
    h.write("repos/app/.codex/config.toml", '[mcp_servers.subsrv]\ncommand = "sub"\n');
    const names = async (scope: string) =>
      JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", scope, "--json"])).items.map(
        (i: { name: string }) => i.name,
      );
    expect(await names("parents")).toEqual([]);
    expect(await names("project")).toEqual(["subsrv"]);
    // With no marker, Codex's project root is the folder it starts in: no parent is read, and the
    // root's entry is no longer app's.
    h.write(
      ".codex/config.toml",
      `project_root_markers = []\n\n[projects.${JSON.stringify(repos)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n`,
    );
    expect(await names("parents")).toEqual([]);
    expect(await names("loaded")).toEqual(["subsrv"]);
  });

  it("refuses with Codex a parent's config.toml that does not parse, and a project's it makes unreadable", async () => {
    const { h, app, web, repos, parentFile } = parentHome(() => "");
    const warnings = async () =>
      JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--json"])).warnings.map(
        (w: { file: string; message: string }) => [w.file, w.message],
      );
    // Codex 0.159.3 refused the root's file for every folder below it, as for the root itself.
    h.write("repos/.codex/config.toml", "[mcp_servers.bad\n");
    const said = await warnings();
    expect(said).toHaveLength(1);
    expect(said[0][0]).toBe(parentFile);
    expect(said[0][1]).toMatch(/^is not valid TOML at line \d+, column \d+, so Codex loads no config in /);
    const all = `${tilde(repos, h.home)}, ${tilde(app, h.home)} and ${tilde(web, h.home)}`;
    expect(said[0][1].endsWith(all)).toBe(true);
    // Merged, as Codex checks it: the root's server with app's args of the wrong type is app's to fix.
    h.write("repos/.codex/config.toml", '[mcp_servers.shared]\ncommand = "root-shared"\n');
    h.write("repos/app/.codex/config.toml", '[mcp_servers.shared]\nargs = "x"\n');
    const appFile = path.join(app, ".codex", "config.toml");
    expect(await warnings()).toEqual([
      [appFile, `has an MCP server Codex cannot read, so Codex loads no config in ${tilde(app, h.home)}`],
    ]);
    // And the root's table with no command, which app's command completes, is no problem in app.
    // In the root and in web nothing completes it: Codex refuses it there, as the root's.
    h.write("repos/.codex/config.toml", '[mcp_servers.shared]\nenv = { A = "1" }\n');
    h.write("repos/app/.codex/config.toml", '[mcp_servers.shared]\ncommand = "sub-shared"\n');
    expect(await warnings()).toEqual([
      [
        parentFile,
        `has an MCP server Codex cannot read, so Codex loads no config in ${tilde(repos, h.home)} and ${tilde(web, h.home)}`,
      ],
    ]);
    const project = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(project.items.map((i: { summary: Record<string, string> }) => i.summary)).toEqual([
      { transport: "stdio", command: "sub-shared", env: "A" },
    ]);
  });

  it("reads the primary's Codex home as a parent folder's .codex for the other profiles alone", async () => {
    const { h, app } = seed();
    // The home is the project root (a .hg marker), so its .codex is above app: the primary's own
    // home, which a second profile, linking its config.toml, hooks.json and skills, reads too.
    h.write(".hg/requires", "");
    h.write(
      ".codex/config.toml",
      `project_root_markers = [".hg"]\n\n[projects.${JSON.stringify(h.home)}]\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\n`,
    );
    const hooksFile = h.path(".codex", "hooks.json");
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "home-hook" }] }] } });
    h.skill(".codex/skills", "askill");
    type Row = { name: string; file: string; accounts?: string[]; summary: Record<string, string> };
    const rows = async (command: ExtensionsCommand) =>
      (
        JSON.parse(await run(h, app, command, ["ls", "--tool", "codex", "--scope", "parents", "--json"])).items as Row[]
      ).map((i) => [i.summary.command ?? i.name, i.file, i.accounts]);
    // The primary leaves its own home out, as Codex 0.159.3 does with CODEX_HOME.
    expect(await rows("hooks")).toEqual([]);
    h.codex("work", ".codex-work");
    h.link(".codex/skills", ".codex-work/skills");
    // A file link; on Windows, where a test may not make one, a hard link, which is the same file.
    for (const name of ["config.toml", "hooks.json"]) {
      const [target, link] = [h.path(".codex", name), h.path(".codex-work", name)];
      if (process.platform === "win32") linkSync(target, link);
      else symlinkSync(target, link);
    }
    // Codex run as work listed the hook a second time, under ~/.codex's key; the servers and
    // skills it merged in or listed once, the files being its own.
    expect(await rows("hooks")).toEqual([["home-hook", hooksFile, ["codex:work"]]]);
    expect(await rows("mcp")).toEqual([]);
    expect(await rows("skills")).toEqual([]);
    const shown = await run(h, app, "hooks", ["show", "Stop", "--scope", "parents"]);
    expect(shown).toMatch(/^File\s+~[\\/]\.codex[\\/]hooks\.json$/m);
    expect(shown).toMatch(/^Profiles\s+work, not the profile whose own Codex folder this is$/m);
    // A profile whose config.toml is its own takes the primary's servers from there too, and the
    // primary's reading, which the states are, is as it was.
    rmSync(h.path(".codex-work", "config.toml"));
    h.write(".codex-work/config.toml", 'project_root_markers = [".hg"]\n');
    expect(await rows("mcp")).toEqual([["npx", h.path(".codex", "config.toml"), ["codex:work"]]]);
    const global = JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(global.items.map((i: { name: string; tags: string[] }) => [i.name, i.tags])).toEqual([["exa", []]]);
  });

  it("lists the skills folders Codex reads from the project root down, whatever the trust", async () => {
    const { h, app, repos } = parentHome(() => "");
    // The root's own entry says untrusted, and app has none: skills/list still listed them all.
    h.write(
      ".codex/config.toml",
      `project_root_markers = [".hg"]\n\n[projects.${JSON.stringify(repos)}]\ntrust_level = "untrusted"\n`,
    );
    const root = h.skill("repos/.agents/skills", "rootskill");
    const rootCodex = h.skill("repos/.codex/skills", "rcskill");
    const own = h.skill("repos/app/.agents/skills", "subskill");
    const ownCodex = h.skill("repos/app/.codex/skills", "scskill");
    h.skill("repos/app/deep/.agents/skills", "deepskill");
    type Row = { name: string; file: string; state: string };
    const rows = async (scope: string) =>
      (
        JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--scope", scope, "--json"])).items as Row[]
      ).map((i) => [i.name, i.file, i.state]);
    // What Codex 0.159.3's skills/list gave started in a folder below the root, the root untrusted.
    expect(await rows("parents")).toEqual([
      ["rcskill", rootCodex, "on"],
      ["rootskill", root, "on"],
    ]);
    expect(await rows("project")).toEqual([
      ["scskill", ownCodex, "on"],
      ["subskill", own, "on"],
    ]);
    const loaded = JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--json"])).items;
    expect(loaded.map((i: { name: string }) => i.name)).toEqual([
      "eli5",
      "rcskill",
      "rootskill",
      "scskill",
      "subskill",
    ]);
    // With no marker, Codex reads the project's own alone.
    h.write(".codex/config.toml", "project_root_markers = []\n");
    expect(await rows("parents")).toEqual([]);
  });

  it("deletes a skill a project below also lists under Parent folders, as the one folder it is", async () => {
    const { h, app, repos } = parentHome(() => "");
    // ~/repos, recorded by its trust entry, is a project with the skill as its own; app sees it from below.
    const folder = h.skill("repos/.agents/skills", "rootskill");
    for (const [cwd, scope] of [
      [repos, "project"],
      [app, "parents"],
    ] as const) {
      const plan = JSON.parse(
        await run(h, cwd, "skills", ["rm", "rootskill", "--tool", "codex", "--scope", scope, "--dry-run", "--json"]),
      );
      expect(plan.refused).toEqual([]);
      expect(plan.changes.map((c: { file: string }) => c.file)).toEqual([folder]);
    }
  });

  it("switches a parent folder's server in the project's own config.toml, and deletes it in the parent's", async () => {
    const { h, app, parentFile } = parentHome(() => '[mcp_servers.u]\ncommand = "u"\n');
    h.write(
      "repos/.codex/config.toml",
      '[mcp_servers.rootsrv]\ncommand = "root"\n\n[mcp_servers.u]\nenabled = false\n',
    );
    const appFile = path.join(app, ".codex", "config.toml");
    const plan = async (args: string[]) =>
      JSON.parse(await run(h, app, "mcp", [...args, "--tool", "codex", "--dry-run", "--json"])).changes.map(
        (c: { file: string; what: string }) => [c.file, c.what],
      );
    // Codex 0.159.3 left u off below the root that turns it off, and on where the folder turns it on.
    const state = async () =>
      JSON.parse(await run(h, app, "mcp", ["ls", "--tool", "codex", "--scope", "global", "--json"])).items.map(
        (i: { name: string; state: string; tags: string[] }) => [i.name, i.state, i.tags],
      );
    expect(await state()).toEqual([["u", "off", ["off here"]]]);
    expect(await run(h, app, "mcp", ["show", "u"])).toMatch(/~[\\/]repos[\\/]\.codex[\\/]config\.toml/);
    expect(await plan(["on", "u"])).toEqual([[appFile, "mcp_servers.u.enabled → true"]]);
    expect(await plan(["off", "rootsrv"])).toEqual([[appFile, "mcp_servers.rootsrv.enabled → false"]]);
    expect(await plan(["rm", "rootsrv"])).toEqual([[parentFile, "[mcp_servers.rootsrv] deleted"]]);
    h.write("repos/app/.codex/config.toml", "[mcp_servers.u]\nenabled = true\n");
    expect(await state()).toEqual([["u", "on", []]]);
  });

  it.skipIf(!hasGit)(
    "trusts a linked worktree of a trusted repo, and a folder inside one, by the repo's entry, as Codex does",
    async () => {
      const { h } = seed();
      // main is trusted and commits its .codex folder; main-wt is a worktree of it, and so is
      // main-own, which its own entry marks untrusted; pkg is a folder inside main.
      const main = h.path("repos", "main");
      mkdirSync(main, { recursive: true });
      gitIn(h, main, "init", "-q");
      h.write("repos/main/.codex/config.toml", '[mcp_servers.projsrv]\ncommand = "projsrv"\n');
      h.write("repos/main/.codex/hooks.json", {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "main-stop" }] }] },
      });
      h.write("repos/main/pkg/.codex/config.toml", '[mcp_servers.pkgsrv]\ncommand = "pkgsrv"\n');
      gitIn(h, main, "add", ".");
      gitIn(h, main, "commit", "-q", "-m", "init");
      const [wt, own] = [h.path("repos", "main-wt"), h.path("repos", "main-own")];
      gitIn(h, main, "worktree", "add", "-q", wt);
      gitIn(h, main, "worktree", "add", "-q", own);
      const pkg = h.path("repos", "main", "pkg");
      // By its real path, as Codex records a trust: git names the main checkout by it too. A
      // table with no trust_level, as main-wt's, decides nothing.
      h.write(
        ".codex/config.toml",
        [
          `[projects.${JSON.stringify(codexTrustKey(main))}]`,
          'trust_level = "trusted"',
          `[projects.${JSON.stringify(wt)}]`,
          `[projects.${JSON.stringify(own)}]`,
          'trust_level = "untrusted"',
          "",
        ].join("\n"),
      );
      h.claude("default", ".claude", { projects: { [wt]: {}, [own]: {}, [pkg]: {} } });
      const states = async (cwd: string, command: ExtensionsCommand, scope = "project") =>
        JSON.parse(await run(h, cwd, command, ["ls", "--tool", "codex", "--scope", scope, "--json"])).items.map(
          (i: { name: string; state: string; tags: string[] }) => [i.name, i.state, i.tags],
        );
      // What Codex 0.159.3 gave from main-wt: its .codex layer enabled, projsrv among the servers.
      expect(await states(wt, "mcp")).toEqual([["projsrv", "on", []]]);
      // Its own Stop is not what Codex runs there: main's is, waiting for its review.
      expect(await states(wt, "hooks")).toEqual([
        ["Stop", "on", ["main checkout's runs"]],
        ["Stop", "pending-approval", ["pending approval"]],
      ]);
      expect(await run(h, wt, "mcp", ["show", "projsrv"])).not.toMatch(/^Trust/m);
      const off = JSON.parse(
        await run(h, wt, "mcp", ["off", "projsrv", "--tool", "codex", "--tracked", "--dry-run", "--json"]),
      );
      expect(off.refused).toEqual([]);
      expect(off.changes.map((c: { file: string }) => c.file)).toEqual([path.join(wt, ".codex", "config.toml")]);
      // pkg is in main's repo, so main is here there; its server is among the other projects'.
      expect(await states(main, "mcp", "other")).toContainEqual(["pkgsrv", "on", []]);
      // An entry of the worktree's own comes first.
      expect(await states(own, "mcp")).toEqual([["projsrv", "off", ["off"]]]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "lists a worktree's main checkout's hooks as the ones that run there, and changes the worktree's own nowhere",
    async () => {
      const { h } = seed();
      const stop = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
      const main = h.path("repos", "main");
      mkdirSync(main, { recursive: true });
      gitIn(h, main, "init", "-q");
      h.write("repos/main/.codex/hooks.json", stop("echo a"));
      h.write(
        "repos/main/.codex/config.toml",
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "main-toml"\n',
      );
      gitIn(h, main, "add", ".");
      gitIn(h, main, "commit", "-q", "-m", "init");
      const wt = h.path("repos", "main-wt");
      gitIn(h, main, "worktree", "add", "-q", wt);
      // The worktree's own copy, changed since, and a hook of its own config.toml: Codex reads neither there.
      h.write("repos/main-wt/.codex/hooks.json", stop("echo wt"));
      h.write(
        "repos/main-wt/.codex/config.toml",
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "wt-toml"\n',
      );
      // git names the main checkout by its real path, and Codex keys the hooks it runs there by it.
      const real = realpathSync.native(main);
      const mainHooks = path.join(real, ".codex", "hooks.json");
      // `echo a` on Stop trusted at the hash Codex 0.159.3 gives it, under the main checkout's key.
      h.write(
        ".codex/config.toml",
        [
          `[projects.${JSON.stringify(codexTrustKey(main))}]`,
          'trust_level = "trusted"',
          `[hooks.state.${JSON.stringify(`${mainHooks}:stop:0:0`)}]`,
          'trusted_hash = "sha256:f9b7a328de9c5845f5eed806f12f8f5adeba50ba82617690fd3f8ededeb12f90"',
          "",
        ].join("\n"),
      );
      h.claude("default", ".claude", { projects: { [wt]: {} } });
      type Row = { id: string; state: string; tags: string[]; file: string; summary: { command: string } };
      const listed: Row[] = JSON.parse(
        await run(h, wt, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]),
      ).items;
      const rows = listed.map((i) => [i.summary.command, i.state, i.tags, i.file]);
      expect(rows).toEqual([
        ["echo wt", "on", ["main checkout's runs"], path.join(wt, ".codex", "hooks.json")],
        ["wt-toml", "on", ["main checkout's runs"], path.join(wt, ".codex", "config.toml")],
        ["echo a", "on", [], mainHooks],
        ["main-toml", "pending-approval", ["pending approval"], path.join(real, ".codex", "config.toml")],
      ]);
      const loaded = JSON.parse(await run(h, wt, "hooks", ["ls", "--tool", "codex", "--json"])).items;
      expect(loaded.map((i: Row) => i.summary.command)).toEqual(["echo a"]);
      const byCommand = (command: string) => listed.find((i) => i.summary.command === command)?.id ?? "";
      const shownAt = tilde(mainHooks, h.home);
      const shown = await run(h, wt, "hooks", ["show", "--id", byCommand("echo wt")]);
      const loadedLine = shown.split("\n").find((line) => line.startsWith("Loaded"));
      expect(loadedLine?.replace(/^Loaded\s+/, "")).toBe(`no, Codex runs the hooks in ${shownAt} in this worktree`);
      // The worktree's own: refused, naming the main checkout's file; what clausona kept aside it may delete.
      for (const verb of ["off", "rm"]) {
        const own = JSON.parse(await run(h, wt, "hooks", [verb, "--id", byCommand("echo wt"), "--dry-run", "--json"]));
        expect(own.changes).toEqual([]);
        expect(own.refused.map((r: { code: string; reason: string }) => [r.code, r.reason])).toEqual([
          ["codex-worktree-hook", `Codex runs the hooks in ${shownAt} in this worktree. Change them there.`],
        ]);
      }
      // The main checkout's, from the worktree: its file, which git tracks there, with consent.
      const mainOff = (more: string[]) =>
        run(h, wt, "hooks", ["off", "--id", byCommand("echo a"), "--dry-run", "--json", ...more]).then(JSON.parse);
      const unconsented = (await mainOff([])).refused;
      expect(unconsented.map((r: { code: string }) => r.code)).toEqual(["tracked"]);
      expect(unconsented[0].reason).toMatch(/^Git tracks it in main, so this changes the repo\. /);
      const consented = await mainOff(["--tracked"]);
      expect(consented.refused).toEqual([]);
      expect(consented.changes.map((c: { file: string; what: string }) => [c.file, c.what])).toEqual([
        [mainHooks, "Stop hook taken out, kept by clausona"],
      ]);
      // Turned off, the copy clausona keeps is the worktree's row, off, and no hook Codex skips.
      await run(h, wt, "hooks", ["off", "--id", byCommand("echo a"), "--tracked", "--yes"]);
      const after: Row[] = JSON.parse(
        await run(h, wt, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]),
      ).items;
      const keptCopy = after.find((i) => i.summary.command === "echo a");
      expect(keptCopy && [keptCopy.state, keptCopy.tags, keptCopy.file]).toEqual(["off", ["off"], mainHooks]);
      expect(await run(h, wt, "hooks", ["show", "--id", keptCopy?.id ?? ""])).toMatch(
        /^Loaded\s+off everywhere — clausona keeps its settings so you can turn it back on$/m,
      );
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  /**
   * A git repo at repos/main with a linked worktree at repos/main-wt, each with an untracked
   * .codex folder, and the user config.toml `user`, which trusts main.
   */
  function worktreeHome(h: TestHome, user: string): { main: string; wt: string } {
    const main = h.path("repos", "main");
    mkdirSync(main, { recursive: true });
    gitIn(h, main, "init", "-q");
    h.write("repos/main/a", "x\n");
    gitIn(h, main, "add", "a");
    gitIn(h, main, "commit", "-q", "-m", "init");
    const wt = h.path("repos", "main-wt");
    gitIn(h, main, "worktree", "add", "-q", wt);
    mkdirSync(path.join(main, ".codex"), { recursive: true });
    mkdirSync(path.join(wt, ".codex"), { recursive: true });
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(codexTrustKey(main))}]\ntrust_level = "trusted"\n\n${user}`,
    );
    return { main, wt };
  }

  const mainHook =
    '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "echo main-hook"\n';

  it.skipIf(!hasGit)(
    "checks only the main checkout's [hooks] from a worktree, so its own switch there neither warns nor blocks a write",
    async () => {
      const { h } = seed();
      const { main, wt } = worktreeHome(h, '[mcp_servers.github]\ncommand = "gh-mcp"\n');
      h.write("repos/main/.codex/config.toml", mainHook);
      // clausona's own switch in the main checkout: a table with `enabled` alone.
      await run(h, main, "mcp", ["off", "github", "--tool", "codex", "--yes"]);
      const mainFile = path.join(main, ".codex", "config.toml");
      expect(readFileSync(mainFile, "utf8")).toContain("[mcp_servers.github]\nenabled = false");
      // Codex 0.159.3's hooks/list from main-wt lists the main checkout's hook, under its key there.
      const listed = JSON.parse(await run(h, wt, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
      const rows = listed.items.map((i: { summary: { command: string }; state: string; file: string }) => [
        i.summary.command,
        i.state,
        i.file,
      ]);
      expect(rows).toEqual([["echo main-hook", "pending-approval", realpathSync.native(mainFile)]]);
      expect(listed.warnings).toEqual([]);
      // With the worktree recorded, every run reads it; clausona can still turn its switch back on.
      const user = readFileSync(h.path(".codex", "config.toml"), "utf8");
      h.write(".codex/config.toml", `${user}\n[projects.${JSON.stringify(codexTrustKey(wt))}]\n`);
      const plan = JSON.parse(await run(h, main, "mcp", ["on", "github", "--tool", "codex", "--dry-run", "--json"]));
      expect(plan.refused).toEqual([]);
      expect(plan.changes.map((c: { what: string }) => c.what)).toEqual(["mcp_servers.github.enabled removed"]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "leaves a worktree's own [hooks] out of its check, as Codex runs the main checkout's in their place",
    async () => {
      const { h } = seed();
      const { wt } = worktreeHome(h, '[mcp_servers.github]\ncommand = "gh-mcp"\n');
      h.write("repos/main/.codex/config.toml", mainHook);
      h.write(
        "repos/main-wt/.codex/config.toml",
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo wt-own"\ntimeout = 30.0\n',
      );
      // Codex 0.159.3 from main-wt: skills/list gives eli5, config/read github, hooks/list the main checkout's hook.
      const skills = JSON.parse(await run(h, wt, "skills", ["ls", "--tool", "codex", "--json"]));
      expect(skills.items.map((i: { name: string }) => i.name)).toContain("eli5");
      expect(skills.warnings).toEqual([]);
      const servers = JSON.parse(await run(h, wt, "mcp", ["ls", "--tool", "codex", "--json"]));
      expect(servers.items.map((i: { name: string }) => i.name)).toEqual(["github"]);
      const hooks = JSON.parse(await run(h, wt, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
      expect(
        hooks.items.map((i: { summary: { command: string }; tags: string[] }) => [i.summary.command, i.tags]),
      ).toEqual([
        ["echo main-hook", ["pending approval"]],
        ["echo wt-own", ["main checkout's runs"]],
      ]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "loads nothing of Codex in a trusted worktree whose main checkout's [hooks] Codex cannot read, and says which file",
    async () => {
      const { h } = seed();
      const { main, wt } = worktreeHome(h, "");
      // A wrong type outside [hooks] too, which Codex does not read from the worktree.
      h.write(
        "repos/main/.codex/config.toml",
        '[mcp_servers.x]\ncommand = 5\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo main"\ntimeout = 30.0\n',
      );
      // Codex 0.159.3's config/read from main-wt: "invalid type: floating point `30.0`, expected u64 in `hooks`".
      const listed = JSON.parse(await run(h, wt, "skills", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
      expect(listed.items.map((i: { name: string; tags: string[] }) => [i.name, i.tags])).toContainEqual([
        "eli5",
        ["off here"],
      ]);
      // git names the main checkout by its real path, and Codex reads its hooks there.
      const mainFile = realpathSync.native(path.join(main, ".codex", "config.toml"));
      // One line per cause: the worktree's, and the main checkout's own, a recorded project too,
      // which on Windows spells the file by Codex's lower-cased key: one file all the same.
      const place = (p: string) => tilde(p, h.home);
      expect(listed.warnings.map((w: { file: string; message: string }) => [pathKey(w.file), w.message])).toEqual([
        [pathKey(mainFile), `has a hook Codex cannot read, so Codex loads no config in ${place(wt)}`],
        [
          pathKey(mainFile),
          `has an MCP server Codex cannot read, so Codex loads no config in ${place(codexTrustKey(main))}`,
        ],
      ]);
      const id = listed.items.find((i: { name: string }) => i.name === "eli5").id;
      expect(await run(h, wt, "skills", ["show", "--id", id])).toContain(
        `off here (Codex cannot read ${tilde(mainFile, h.home)})`,
      );
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "warns once of a main checkout's config.toml Codex refuses, naming the main checkout and its worktree",
    async () => {
      const { h } = seed();
      const { main, wt } = worktreeHome(h, "");
      const mainFile = path.join(realpathSync.native(path.join(main, ".codex")), "config.toml");
      const places = `${tilde(codexTrustKey(main), h.home)} and ${tilde(wt, h.home)}`;
      // The main checkout reads its file by Codex's key, on Windows lower-cased, and the worktree as
      // git spells it: one file, one line.
      const warnings = async () =>
        JSON.parse(await run(h, wt, "skills", ["ls", "--tool", "codex", "--json"])).warnings.map(
          (w: { file: string; message: string }) => [pathKey(w.file), w.message],
        );
      // A hook Codex cannot read refuses both, the main checkout as its own project and its worktree.
      h.write(
        "repos/main/.codex/config.toml",
        '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo main"\ntimeout = 30.0\n',
      );
      expect(await warnings()).toEqual([
        [pathKey(mainFile), `has a hook Codex cannot read, so Codex loads no config in ${places}`],
      ]);
      // And one that does not parse: one parse warning.
      h.write("repos/main/.codex/config.toml", "[x\n");
      const said = await warnings();
      expect(said).toHaveLength(1);
      expect(said[0][1]).toMatch(/^is not valid TOML at line \d+, column \d+, so Codex loads no config in /);
      expect(said[0][1].endsWith(places)).toBe(true);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "runs a worktree's main checkout's hooks for a folder above the project too, and none of the worktree's own there",
    async () => {
      const { h } = seed();
      const { main, wt } = worktreeHome(h, "");
      const sub = path.join(wt, "sub");
      const stop = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
      const toml = (command: string) =>
        `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "${command}"\n`;
      h.write("repos/main/.codex/hooks.json", stop("main-root"));
      h.write("repos/main/.codex/config.toml", `[mcp_servers.mainsrv]\ncommand = "main"\n\n${toml("main-root-toml")}`);
      h.write("repos/main/sub/.codex/hooks.json", stop("main-sub"));
      h.write("repos/main-wt/.codex/hooks.json", stop("wt-root"));
      h.write("repos/main-wt/.codex/config.toml", `[mcp_servers.wtsrv]\ncommand = "wt"\n\n${toml("wt-root-toml")}`);
      h.write("repos/main-wt/sub/.codex/hooks.json", stop("wt-sub"));
      // Codex recorded sub, a folder of the worktree, which --project then stands in.
      h.write(
        ".codex/config.toml",
        `[projects.${JSON.stringify(codexTrustKey(main))}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(sub)}]\n`,
      );
      type Row = { id: string; state: string; tags: string[]; summary: { command: string } };
      const rows = async (command: ExtensionsCommand, scope: string) =>
        (
          JSON.parse(await run(h, wt, command, ["ls", "--tool", "codex", "--scope", scope, "--project", sub, "--json"]))
            .items as Row[]
        ).map((i) => [i.summary.command, i.tags]);
      // What Codex 0.159.3's hooks/list gave started in the worktree's sub: the main checkout's
      // at the worktree's root and at sub, and the worktree's own servers.
      expect(await rows("hooks", "parents")).toEqual([
        ["wt-root", ["main checkout's runs"]],
        ["wt-root-toml", ["main checkout's runs"]],
        ["main-root", ["pending approval"]],
        ["main-root-toml", ["pending approval"]],
      ]);
      expect(await rows("hooks", "project")).toEqual([
        ["wt-sub", ["main checkout's runs"]],
        ["main-sub", ["pending approval"]],
      ]);
      expect((await rows("mcp", "parents")).map((r) => r[0])).toEqual(["wt"]);
      // The worktree's own, above the project too: refused, naming the main checkout's file.
      const listed: Row[] = JSON.parse(
        await run(h, wt, "hooks", ["ls", "--tool", "codex", "--scope", "parents", "--project", sub, "--json"]),
      ).items;
      const own = listed.find((i) => i.summary.command === "wt-root")?.id ?? "";
      const shownAt = tilde(path.join(realpathSync.native(path.join(main, ".codex")), "hooks.json"), h.home);
      const off = JSON.parse(await run(h, wt, "hooks", ["off", "--id", own, "--project", sub, "--dry-run", "--json"]));
      expect(off.refused.map((r: { code: string; reason: string }) => [r.code, r.reason])).toEqual([
        ["codex-worktree-hook", `Codex runs the hooks in ${shownAt} in this worktree. Change them there.`],
      ]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasGit)(
    "says first that Codex does not trust a worktree, where it runs neither its own hooks nor its main checkout's",
    async () => {
      const { h } = seed();
      const main = h.path("repos", "main");
      mkdirSync(main, { recursive: true });
      gitIn(h, main, "init", "-q");
      h.write("repos/main/.codex/hooks.json", {
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo a" }] }] },
      });
      gitIn(h, main, "add", ".");
      gitIn(h, main, "commit", "-q", "-m", "init");
      const own = h.path("repos", "main-own");
      gitIn(h, main, "worktree", "add", "-q", own);
      // main is trusted, and the worktree's own entry says untrusted: Codex lists no hooks there.
      h.write(
        ".codex/config.toml",
        `[projects.${JSON.stringify(codexTrustKey(main))}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(own)}]\ntrust_level = "untrusted"\n`,
      );
      h.claude("default", ".claude", { projects: { [own]: {} } });
      type Row = { id: string; state: string; tags: string[]; file: string };
      const rows: Row[] = JSON.parse(
        await run(h, own, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]),
      ).items;
      const ownRow = rows.find((i) => i.file === path.join(own, ".codex", "hooks.json"));
      expect(ownRow && [ownRow.state, ownRow.tags]).toEqual(["off", ["off", "main checkout's runs"]]);
      const shown = await run(h, own, "hooks", ["show", "--id", ownRow?.id ?? ""]);
      expect(shown).toMatch(/^Loaded\s+off: Codex runs a project's hooks only once it trusts the project$/m);
      expect(shown).toMatch(/^Trust\s+Codex does not trust this project, so it ignores its \.codex folder\.$/m);
      const off = JSON.parse(await run(h, own, "hooks", ["off", "--id", ownRow?.id ?? "", "--dry-run", "--json"]));
      expect(off.refused.map((r: { code: string }) => r.code)).toEqual(["codex-untrusted"]);
    },
    SPAWNING_TEST_TIMEOUT_MS,
  );

  it("lists a Codex hook clausona keeps aside as off, not as one Codex skips", async () => {
    const { h, app } = seed();
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo kept" }] }] } });
    const global = async () =>
      JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"])).items;
    await run(h, app, "hooks", ["off", "--id", (await global())[0].id, "--yes"]);
    const kept = await global();
    expect(
      kept.map((i: { summary: { command: string }; state: string; tags: string[] }) => [
        i.summary.command,
        i.state,
        i.tags,
      ]),
    ).toEqual([["echo kept", "off", ["off"]]]);
    expect(await run(h, app, "hooks", ["show", "--id", kept[0].id])).toMatch(
      /^Loaded\s+off everywhere — clausona keeps its settings so you can turn it back on$/m,
    );
  });

  it("lists the hooks of a project Codex does not trust as off there, and says it is the trust", async () => {
    const { h, app, web } = seed();
    const stop = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(web)}]\ntrust_level = "untrusted"\n`,
    );
    h.write("repos/app/.codex/hooks.json", stop("app-stop"));
    h.write("repos/web/.codex/hooks.json", stop("web-stop"));
    const json = JSON.parse(await run(h, web, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(json.items.map((i: { state: string; tags: string[] }) => [i.state, i.tags])).toEqual([["off", ["off"]]]);
    expect(await run(h, web, "hooks", ["ls", "--tool", "codex"])).not.toContain("web-stop");
    const shown = await run(h, web, "hooks", ["show", "--id", json.items[0].id]);
    expect(shown).toMatch(/^Loaded\s+off: Codex runs a project's hooks only once it trusts the project$/m);
    expect(shown).toMatch(/^Trust\s+Codex does not trust this project, so it ignores its \.codex folder\.$/m);
    // A trusted project's hook waits for its own review, as before.
    const own = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "project", "--json"]));
    expect(own.items.map((i: { state: string }) => i.state)).toEqual(["pending-approval"]);
  });

  it("lists a command hook with an empty command as such, out of Loaded, and says Codex skips it", async () => {
    const { h, app } = seed();
    h.write(".codex/hooks.json", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: " " }] }] },
    });
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(json.items.map((i: { tags: string[] }) => i.tags)).toEqual([["empty command"]]);
    expect(JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--json"])).items).toEqual([]);
    expect(await run(h, app, "hooks", ["show", "--id", json.items[0].id])).toMatch(
      /^Loaded\s+no, Codex skips a hook whose command is empty$/m,
    );
  });

  it("plans a skill switch in a project whose config.toml Codex refuses, noting it stays off there", async () => {
    const { h, app } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[[skills.config]]\nname = "eli5"\nenabled = false\n`,
    );
    h.write("repos/app/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    h.skill("repos/app/.agents/skills", "proj");
    const own = tilde(path.join(app, ".codex", "config.toml"), h.home);
    const user = h.path(".codex", "config.toml");
    const noted = `stays off in this project until Codex can read ${own}`;
    const lines = async (args: string[]) =>
      JSON.parse(await run(h, app, "skills", [...args, "--tool", "codex", "--dry-run", "--json"])).changes.map(
        (c: { file: string; what: string; note: string | null }) => [c.file, c.what, c.note],
      );
    // The user config.toml, as anywhere: the name entry goes, and the path entry is made.
    expect(await lines(["on", "eli5", "--everywhere"])).toEqual([[user, "skills.config eli5 removed", noted]]);
    const skillFile = tilde(path.join(app, ".agents", "skills", "proj", "SKILL.md"), h.home);
    expect(await lines(["off", "proj"])).toEqual([[user, `skills.config ${skillFile} → off`, noted]]);
  });

  it("plans a server switch in a project whose config.toml Codex refuses but clausona reads, noting it stays off", async () => {
    const { h, app } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\n`,
    );
    const file = path.join(app, ".codex", "config.toml");
    const plan = (verb: string) =>
      run(h, app, "mcp", [verb, "exa", "--tool", "codex", "--dry-run", "--json"]).then(JSON.parse);
    // A wrong type, which Codex refuses: the file reads, so the switch is planned in it.
    h.write("repos/app/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    const off = await plan("off");
    expect(off.refused).toEqual([]);
    expect(
      off.changes.map((c: { file: string; what: string; note: string | null }) => [c.file, c.what, c.note]),
    ).toEqual([
      [
        file,
        "mcp_servers.exa.enabled → false",
        `stays off in this project until Codex can read ${tilde(file, h.home)}`,
      ],
    ]);
    // Not valid TOML: clausona cannot edit it either.
    h.write("repos/app/.codex/config.toml", "[mcp_servers.p\n");
    expect((await plan("off")).refused.map((r: { code: string }) => r.code)).toEqual(["unreadable"]);
  });

  it("loads nothing of Codex in a trusted project whose config.toml Codex refuses, and says so", async () => {
    const { h, app, web } = seed();
    h.write(
      ".codex/config.toml",
      `[projects.${JSON.stringify(app)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(web)}]\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\n`,
    );
    // Codex 0.159.3 from app: config/read and skills/list fail ("invalid configuration"), and
    // hooks/list too; from web, all reads.
    h.write("repos/app/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    const ls = await run(h, app, "skills", ["ls", "--tool", "codex"]);
    expect(ls).not.toMatch(/^eli5\s/m);
    expect(ls).toContain(
      `${tilde(path.join(app, ".codex", "config.toml"), h.home)}: has an MCP server Codex cannot read`,
    );
    const global = JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(global.items.map((i: { name: string; state: string; tags: string[] }) => [i.name, i.state, i.tags])).toEqual(
      [["eli5", "off", ["off here"]]],
    );
    expect(await run(h, app, "mcp", ["show", "exa", "--tool", "codex"])).toMatch(
      /^Loaded\s+off here \(Codex cannot read this project's \.codex[\\/]config\.toml\)$/m,
    );
    expect(await run(h, web, "skills", ["ls", "--tool", "codex"])).toMatch(/^eli5\s/m);
  });

  it("lists a hook on an event Codex does not know as such, out of Loaded, whatever it holds", async () => {
    const { h, app } = seed();
    // Codex 0.159.3's hooks/list: Stop's listed; `Unknown` and `stop` not, and no warning - one
    // with a command that is no string under them leaves the file read.
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "known" }] }],
        Unknown: [
          {
            hooks: [
              { type: "command", command: "unknown" },
              { type: "command", command: 5 },
            ],
          },
        ],
        stop: [{ hooks: [{ type: "prompt", prompt: "lower" }] }],
      },
    });
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    const rows = json.items.map((i: { name: string; tags: string[] }) => [i.name, i.tags]);
    // The known one waits for its review, as any untrusted hook does.
    expect(rows.sort()).toEqual([
      ["Stop", ["pending approval"]],
      ["Unknown", ["unknown event"]],
      ["Unknown", ["unknown event"]],
      ["stop", ["unknown event"]],
    ]);
    const unknown = json.items.find((i: { name: string }) => i.name === "Unknown");
    expect(await run(h, app, "hooks", ["show", "--id", unknown.id])).toMatch(
      /^Loaded\s+no, Codex knows no event of that name, and runs no hook on it$/m,
    );
  });

  it("lists an MCP tool hook with an empty server or tool as such, out of Loaded, and says why", async () => {
    const { h, app } = seed();
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "" }] }] } });
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(json.items.map((i: { tags: string[] }) => i.tags)).toEqual([["empty tool"]]);
    expect(JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--json"])).items).toEqual([]);
    expect(await run(h, app, "hooks", ["show", "--id", json.items[0].id])).toMatch(
      /^Loaded\s+no, Codex skips an MCP tool hook whose server or tool is empty$/m,
    );
  });

  it("lists a prompt or agent hook as not supported, out of Loaded, and says Codex does not run it", async () => {
    const { h, app } = seed();
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "prompt", prompt: "summarize the turn" },
              { type: "agent", prompt: "check the diff" },
            ],
          },
        ],
      },
    });
    expect(await run(h, app, "hooks", ["ls", "--tool", "codex"])).not.toContain("summarize");
    const json = JSON.parse(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    const prompt = json.items.find((i: { summary: { type: string } }) => i.summary.type === "prompt");
    const agent = json.items.find((i: { summary: { type: string } }) => i.summary.type === "agent");
    expect([prompt.tags, agent.tags]).toEqual([["not supported"], ["not supported"]]);
    expect(await run(h, app, "hooks", ["show", "--id", prompt.id])).toMatch(
      /^Loaded\s+no, Codex does not run prompt hooks yet$/m,
    );
    expect(await run(h, app, "hooks", ["show", "--id", agent.id])).toMatch(
      /^Loaded\s+no, Codex does not run agent hooks yet$/m,
    );
  });
});

describe("Codex skills Codex skips", () => {
  it("lists one with no front matter under its folder, tagged, out of Loaded, and says why", async () => {
    const { h, app } = seed();
    h.write(".agents/skills/plain/SKILL.md", "just text\n");
    expect(await run(h, app, "skills", ["ls", "--tool", "codex"])).not.toMatch(/^plain\s/m);
    expect(await run(h, app, "skills", ["ls", "--tool", "codex", "--scope", "global"])).toMatch(
      /^plain\s+Global\s+—\s+—\s+no front matter$/m,
    );
    const shown = await run(h, app, "skills", ["show", "plain"]);
    expect(shown).toMatch(/^Loaded\s+no, Codex skips its SKILL\.md: it has no front matter$/m);
    const json = JSON.parse(await run(h, app, "skills", ["ls", "--tool", "codex", "--scope", "global", "--json"]));
    expect(json.items.find((i: { name: string }) => i.name === "plain")).toMatchObject({
      state: "on",
      tags: ["no front matter"],
    });
  });
});

describe("Codex plugins", () => {
  /** The seed, with Codex's plugin kit@m on, bringing a skill, a server and a hook. */
  function withKit() {
    const { h, app } = seed();
    h.write(".codex/config.toml", '[mcp_servers.exa]\ncommand = "npx"\n\n[plugins."kit@m"]\nenabled = true\n');
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, { name: "kit", description: "Kit tools" });
    h.skill(`${kit}/skills`, "plan");
    h.write(`${kit}/.mcp.json`, { mcpServers: { kitdb: { command: "kitdb-mcp", args: ["--token", KEY] } } });
    h.write(`${kit}/hooks/hooks.json`, { hooks: { Stop: [{ hooks: [{ type: "command", command: "kit-notify" }] }] } });
    return { h, app };
  }

  it("lists them under --scope plugins, and what they bring in Loaded", async () => {
    const { h, app } = withKit();
    const plugins = await run(h, app, "skills", ["ls", "--tool", "codex", "--scope", "plugins"]);
    expect(firstLine(plugins)).toMatch(/^1 plugin · Plugins · /);
    expect(plugins).toMatch(/^kit@m\s+1 skill · 1 MCP server · 1 hook$/m);
    const loaded = await run(h, app, "skills", ["ls", "--tool", "codex"]);
    expect(loaded).toMatch(/^kit:plan\s+kit\s+—\s+—$/m);
    const mcp = await run(h, app, "mcp", ["ls", "--tool", "codex"]);
    expect(mcp).toMatch(/^kitdb\s+kit\s+—$/m);
    const server = await run(h, app, "mcp", ["show", "kitdb"]);
    expect(firstLine(server)).toBe("PLUGINS › kitdb");
    expect(server).toMatch(/^Runs\s+kitdb-mcp --token <hidden>$/m);
    expect(await run(h, app, "hooks", ["ls", "--tool", "codex", "--scope", "plugins"])).toMatch(/^kit@m\s/m);
    const shown = await run(h, app, "skills", ["show", "kit@m", "--tool", "codex"]);
    expect(firstLine(shown)).toBe("PLUGINS › kit");
    expect(shown).toContain("Kit tools");
    expect(leakedWindows([plugins, loaded, mcp, server, shown], KEY)).toEqual([]);
  });

  it("refuses to change one, and points to Codex's /plugins", async () => {
    const { h, app } = withKit();
    const error = await failure(
      run(h, app, "skills", ["off", "kit@m", "--tool", "codex", "--scope", "plugins", "--yes"]),
    );
    expect(error.code).toBe(1);
    expect(error.message).toContain("Use /plugins in Codex to turn a plugin on or off, or to uninstall it.");
    const skill = await failure(run(h, app, "skills", ["off", "kit:plan", "--tool", "codex", "--everywhere", "--yes"]));
    expect(skill.message).toContain(
      "It comes with the plugin kit@m. Turn the plugin on or off with /plugins in Codex.",
    );
  });

  it("shows a server named as its plugin is, and the plugin by its full name", async () => {
    const { h, app } = withKit();
    // Shipped off, so it is not in Loaded: the lookup goes on to the places, the plugin's among them.
    h.write(".codex/plugins/cache/m/kit/1.0.0/.mcp.json", {
      mcpServers: { kit: { command: "kit-mcp", enabled: false } },
    });
    expect(firstLine(await run(h, app, "mcp", ["show", "kit"]))).toBe("PLUGINS › kit");
    expect(await run(h, app, "mcp", ["show", "kit"])).toMatch(/^Runs\s+kit-mcp$/m);
    expect(await run(h, app, "mcp", ["show", "kit@m"])).toMatch(/^Contains\s+1 skill · 1 MCP server · 1 hook$/m);
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
    expect(firstLine(text)).toBe("2 MCP servers · Loaded · project ~");
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
    // WHERE names the .mcp.json the server is in.
    expect(parents).toMatch(/^tools\s+claude\s+~[\\/]\.mcp\.json\s+all$/m);
    expect(parents).toMatch(/^shared\s+claude\s+~[\\/]repos[\\/]\.mcp\.json\s+all\s+pending approval$/m);
    expect(parents).toMatch(/^notes\s+claude\s+~[\\/]\.mcp\.json\s+all\s+pending approval$/m);
    // Only tools is approved here, in one account: it is all that loads.
    const loaded = await run(h, app, "mcp", ["ls"]);
    expect(firstLine(loaded)).toMatch(/^1 MCP server · Loaded · /);
    expect(loaded).toMatch(/^tools\s+claude\s+~[\\/]\.mcp\.json\s+all$/m);
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
