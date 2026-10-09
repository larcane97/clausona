import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  accountsWord,
  agoWords,
  detailsOf,
  fromLabel,
  hiddenHere,
  hookWhen,
  jsonItem,
  rowAccounts,
  scopeSentence,
  statesByAccount,
  tagsOf,
  usageCells,
  whereLabel,
} from "./describe.js";
import { loadInventory } from "./inventory.js";
import type { Extension, Inventory } from "./model.js";
import { stateHere, viewFrom } from "./present.js";
import { isAccountCopy, rowsIn, type ScopeRow } from "./scopes.js";
import { TestHome } from "./test-home.js";

const DAY = 86_400_000;
/** 200 days after the fixture's files were made (see scopes.test.ts). */
const NOW = Date.now() + 200 * DAY;
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

type Seeded = { h: TestHome; inv: Inventory; app: string; web: string };
type Extra = {
  /** More of the default account's `.claude.json`. */
  defaultJson?: (app: string) => Record<string, unknown>;
  /** More of the work account's `.claude.json`. */
  workJson?: (app: string) => Record<string, unknown>;
  more?: (h: TestHome, app: string, web: string) => void;
};

/** scopes.test.ts's fixture, copied: two Claude accounts, a Codex one, projects app and web. */
async function seed(extra: Extra = {}): Promise<Seeded> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    projects: { [app]: {}, [web]: {} },
    skillUsage: { eli5: { usageCount: 4, lastUsedAt: NOW - DAY } },
    ...extra.defaultJson?.(app),
  });
  h.claude("work", ".claude-work", { projects: { [app]: {} }, ...extra.workJson?.(app) });
  h.codex("personal", ".codex");
  h.skill(".claude/skills", "eli5", "Explain things simply");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "eli5");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".agents/skills", "eli5");
  h.write(".mcp.json", { mcpServers: { tools: { command: "tools-mcp" } } });
  h.write(".claude/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
  extra.more?.(h, app, web);
  const inv = await loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd: app,
    managedSettings: h.path("none.json"),
  });
  return { h, inv, app, web };
}

function find(inv: Inventory, test: (item: Extension) => boolean, what: string): Extension {
  const item = inv.items.find(test);
  if (!item) throw new Error(`no ${what}`);
  return item;
}

const claudeSkill = (inv: Inventory, name: string, project?: string) =>
  find(
    inv,
    (i) =>
      i.kind === "skill" &&
      i.location.tool === "claude" &&
      i.name === name &&
      (project === undefined ? i.location.project === undefined : i.location.project === project),
    name,
  );

/** The row of one item, as rowsIn gives every item but a Claude MCP server of accounts' own. */
const single = (item: Extension): ScopeRow => ({ key: item.id, name: item.name, items: [item] });

/** The Claude MCP row named `name` in `scope`, from app. */
function serverRow(inv: Inventory, scope: "global" | "project", app: string, name: string): ScopeRow {
  const row = rowsIn(inv, "claude", "mcp", scope, app, NOW).find((r) => r.name === name);
  if (!row) throw new Error(`no ${name} row`);
  return row;
}

/** github in both accounts - default's with a secret in its args and env - and off for app in work. */
const github = {
  defaultJson: () => ({
    mcpServers: { github: { command: "gh-mcp", args: ["--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
  }),
  workJson: (app: string) => ({
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: { github: { command: "gh-mcp" } },
  }),
};

/** A hook item named as the sources name one: "<Event> <matcher>" or "<Event>". */
function hook(name: string): Extension {
  return {
    id: `hook:${name}`,
    kind: "hook",
    name,
    location: { tool: "claude", scope: "global", file: "/settings.json" },
  };
}

describe("agoWords", () => {
  it("says how long ago in one short word, or never", () => {
    const now = 1_000 * DAY;
    expect(agoWords(now - 38 * 60_000, now)).toBe("38m ago");
    expect(agoWords(now - 5 * 3_600_000, now)).toBe("5h ago");
    expect(agoWords(now - 13 * DAY, now)).toBe("13d ago");
    expect(agoWords(now - 90 * DAY, now)).toBe("3mo ago");
    expect(agoWords(now - 800 * DAY, now)).toBe("2y ago");
    expect(agoWords(undefined, now)).toBe("never");
  });
});

describe("hookWhen", () => {
  it("puts a hook's event in plain words, with its matcher", () => {
    expect(hookWhen(hook("PreToolUse Bash"))).toBe("Before Bash runs");
    expect(hookWhen(hook("PreToolUse"))).toBe("Before any tool runs");
    expect(hookWhen(hook("PreToolUse *"))).toBe("Before any tool runs");
    expect(hookWhen(hook("PostToolUse Edit|Write"))).toBe("After Edit|Write runs");
    expect(hookWhen(hook("Stop"))).toBe("When Claude finishes replying");
    expect(hookWhen(hook("SessionStart"))).toBe("When a session starts");
    expect(hookWhen(hook("SessionStart startup"))).toBe("When a session starts (startup)");
    expect(hookWhen(hook("Mystery"))).toBe("Mystery");
    // An event named like an object's own property is an event like any other.
    expect(hookWhen(hook("constructor"))).toBe("constructor");
  });

  it("names the hook's own tool where the words name one", () => {
    const codex = (name: string): Extension => ({
      ...hook(name),
      location: { tool: "codex", scope: "global", file: "/hooks.json" },
    });
    expect(hookWhen(codex("Stop"))).toBe("When Codex finishes replying");
    expect(hookWhen(codex("Notification"))).toBe("When Codex sends a notification");
    expect(hookWhen(codex("PermissionRequest"))).toBe("When Codex asks for permission");
    expect(hookWhen(codex("PreToolUse Bash"))).toBe("Before Bash runs");
    expect(hookWhen(hook("Notification"))).toBe("When Claude sends a notification");
    expect(hookWhen(hook("PermissionRequest"))).toBe("When Claude asks for permission");
  });
});

describe("tagsOf", () => {
  it("tags the project's eli5 as hidden by the global one, which wins as Claude Code resolves a name", async () => {
    const { inv, app } = await seed();
    // Claude Code: personal over project.
    expect(tagsOf(inv, single(claudeSkill(inv, "eli5", app)), app, NOW)).toEqual(["hidden by Global copy"]);
    expect(tagsOf(inv, single(claudeSkill(inv, "eli5")), app, NOW)).toEqual([]);
  });

  it("says off here for a setting of this project's, and off for one of the user's", async () => {
    const local = await seed({
      more: (h) => h.write("repos/app/.claude/settings.local.json", { skillOverrides: { "old-one": "off" } }),
    });
    expect(tagsOf(local.inv, single(claudeSkill(local.inv, "old-one")), local.app, NOW)).toEqual([
      "off here",
      "unused",
    ]);
    const user = await seed({
      more: (h) => h.write(".claude/settings.json", { skillOverrides: { "old-one": "off" } }),
    });
    expect(tagsOf(user.inv, single(claudeSkill(user.inv, "old-one")), user.app, NOW)).toEqual(["off", "unused"]);
  });

  it("in the home dir, says off for the user's settings and off here for its local settings", async () => {
    const at = async (file: string) => {
      const h = new TestHome();
      homes.push(h);
      h.claude("default", ".claude");
      h.skill(".claude/skills", "x");
      h.write(file, { skillOverrides: { x: "off" } });
      // Started in the home dir, which is then the project: every file is under it.
      const inv = await loadInventory({
        homeDir: h.home,
        registry: h.registry,
        cwd: h.home,
        managedSettings: h.path("none.json"),
      });
      expect(inv.currentProject).toBe(h.home);
      return tagsOf(inv, single(claudeSkill(inv, "x")), h.home, NOW);
    };
    expect((await at(".claude/settings.json"))[0]).toBe("off");
    expect((await at(".claude/settings.local.json"))[0]).toBe("off here");
  });

  it("says off in 1 of 2 accounts for a server one account turned off here", async () => {
    const { inv, app } = await seed(github);
    const row = serverRow(inv, "global", app, "github");
    expect(row.items).toHaveLength(2);
    expect(tagsOf(inv, row, app, NOW)).toEqual(["off in 1 of 2 accounts"]);
    expect(statesByAccount(inv, row, app)?.map((a) => [a.profile, a.state.value])).toEqual([
      ["claude:default", "on"],
      ["claude:work", "off"],
    ]);
    // One account's copy alone is that account's server: off where it is off, and nothing else.
    const work = row.items.find((i) => i.location.profile === "claude:work") as Extension;
    expect(tagsOf(inv, { key: row.key, name: "github", items: [work] }, app, NOW)).toEqual(["off here"]);
  });

  it("puts broken link first and leaves unused out after it; a .mcp.json server waits for approval", async () => {
    const { inv, app } = await seed({ more: (h) => h.link(path.join(h.home, "gone"), ".claude/skills/dangling") });
    expect(tagsOf(inv, single(claudeSkill(inv, "dangling")), app, NOW)).toEqual(["broken link"]);
    expect(tagsOf(inv, single(find(inv, (i) => i.name === "tools", "tools")), app, NOW)).toEqual(["pending approval"]);
  });
});

describe("hiddenHere and usageCells", () => {
  it("judges another project's copy in its own project, wherever it is seen from", async () => {
    const { inv, app, web } = await seed({ more: (h) => h.skill("repos/web/.claude/skills", "eli5") });
    const global = claudeSkill(inv, "eli5");
    const webEli5 = claudeSkill(inv, "eli5", web);
    // Read in web, its own project, not in app, the project the list is seen from.
    expect(viewFrom(webEli5, app)).toBe(web);
    expect(stateHere(inv, webEli5, app).shadowedBy).toBe(global.id);
    // The Global copy wins in web as anywhere: hidden seen from app, from web and from no project.
    for (const from of [app, web, undefined]) expect(hiddenHere(inv, single(webEli5), from), String(from)).toBe(true);
    expect(hiddenHere(inv, single(claudeSkill(inv, "web-only", web)), app)).toBe(false);
    expect(hiddenHere(inv, single(global), app)).toBe(false);
    expect(usageCells(inv, single(webEli5), app, NOW)).toEqual(["—", "—"]);
  });

  it("gives the total and how long ago or never, a dash where there is nothing to count", async () => {
    const { inv, app } = await seed();
    expect(usageCells(inv, single(claudeSkill(inv, "eli5")), app, NOW)).toEqual(["4", "1d ago"]);
    expect(usageCells(inv, single(claudeSkill(inv, "old-one")), app, NOW)).toEqual(["0", "never"]);
    // A hidden copy's use is the winner's.
    expect(usageCells(inv, single(claudeSkill(inv, "eli5", app)), app, NOW)).toEqual(["—", "—"]);
    // Codex keeps no record.
    const codex = find(inv, (i) => i.kind === "skill" && i.location.tool === "codex", "codex eli5");
    expect(usageCells(inv, single(codex), app, NOW)).toEqual(["—", "—"]);
  });
});

describe("fromLabel and scopeSentence", () => {
  it("says where a loaded row comes from", async () => {
    const { inv, app, h } = await seed();
    expect(fromLabel(claudeSkill(inv, "eli5"), inv, app)).toBe("Global");
    expect(fromLabel(claudeSkill(inv, "deploy-check", app), inv, app)).toBe("Project");
    // A parent folder's server goes by its file: here the home dir's .mcp.json.
    expect(
      fromLabel(
        find(inv, (i) => i.name === "tools", "tools"),
        inv,
        app,
      ),
    ).toBe(path.join("~", ".mcp.json"));
    expect(
      fromLabel(
        find(inv, (i) => i.name === "tools", "tools"),
        inv,
        h.home,
      ),
    ).toBe("Project");
  });

  it("says where a row is as WHERE does: Project here, Global, or another project's name", async () => {
    const { inv, app, web } = await seed();
    expect(whereLabel(claudeSkill(inv, "deploy-check", app), inv, app)).toBe("Project");
    expect(whereLabel(claudeSkill(inv, "eli5"), inv, app)).toBe("Global");
    expect(whereLabel(claudeSkill(inv, "web-only", web), inv, app)).toBe("web");
    // In FROM's words where it has them.
    expect(whereLabel(claudeSkill(inv, "deploy-check", app), inv, app)).toBe(
      fromLabel(claudeSkill(inv, "deploy-check", app), inv, app),
    );
  });

  it("heads a table with the scope's name and one plain sentence", async () => {
    const { inv, app, web } = await seed();
    expect(scopeSentence("global", "claude", "skill", inv, app)).toMatch(
      /^GLOBAL — ~[\\/]\.claude[\\/]skills · loads in every project$/,
    );
    expect(scopeSentence("cloud", "claude", "skill", inv, app)).toBe(
      "CLOUD — skills on your claude.ai accounts, different per account",
    );
    expect(scopeSentence("project", "claude", "skill", inv, undefined)).toBe("PROJECT — no project · pick one with p");
    expect(scopeSentence("loaded", "claude", "skill", inv, web)).toMatch(
      /^LOADED — what Claude Code loads in ~[\\/]repos[\\/]web, in at least one account$/,
    );
    expect(scopeSentence("parents", "claude", "mcp", inv, app)).toBe(
      "PARENT FOLDERS — .mcp.json in ~ · loads here too",
    );
  });
});

describe("detailsOf", () => {
  it("shows a skill: title, description, file with ~, where it loads, use, and its other copies", async () => {
    const { inv, app } = await seed();
    const lines = detailsOf(inv, single(claudeSkill(inv, "eli5")), app, NOW);
    expect(lines[0]).toEqual({ text: "GLOBAL › eli5" });
    expect(lines[1]).toEqual({ text: "Explain things simply" });
    const file = lines.find((l) => l.label === "File");
    expect(file?.text).toMatch(/^~[\\/]\.claude[\\/]skills[\\/]eli5[\\/]SKILL\.md$/);
    expect(lines.find((l) => l.label === "Loaded")?.text).toBe("on in every account, every project");
    expect(lines.find((l) => l.label === "Used")?.text).toBe("4 times · last 1d ago");
    const usedAt = lines.findIndex((l) => l.label === "Used");
    expect(lines[usedAt + 1]).toEqual({ label: "", text: "default 4" });
    const alsoAt = lines.findIndex((l) => l.label === "Also in");
    expect(alsoAt).toBeGreaterThan(0);
    // The project copy says less than the global one; the Codex copy is the project's twin.
    expect(lines.slice(alsoAt, alsoAt + 2).map((l) => l.text)).toEqual([
      "Claude › Project (different content)",
      "Codex › Global (different content)",
    ]);
    expect(lines.some((l) => l.label === "Shows as")).toBe(false);
  });

  it("says why a hidden copy does not load, and that its use is counted under the winner", async () => {
    const { inv, app } = await seed();
    const lines = detailsOf(inv, single(claudeSkill(inv, "eli5", app)), app, NOW);
    expect(lines[0]).toEqual({ text: "PROJECT › eli5" });
    expect(lines.find((l) => l.label === "Loaded")?.text).toMatch(/^no, the Global copy wins \(~[\\/]\.claude[\\/]/);
    expect(lines.find((l) => l.label === "Used")?.text).toBe("counted under the copy that wins");
  });

  it("says where an off skill is turned off, and how a skill shows when not in full", async () => {
    const { inv, app } = await seed({
      more: (h) => {
        h.write("repos/app/.claude/settings.local.json", { skillOverrides: { "old-one": "off" } });
        h.write(".claude/settings.json", { skillOverrides: { eli5: "name-only" } });
      },
    });
    const off = detailsOf(inv, single(claudeSkill(inv, "old-one")), app, NOW);
    expect(off.find((l) => l.label === "Loaded")?.text).toMatch(
      /^off here \(this project's \.claude[\\/]settings\.local\.json\)$/,
    );
    const shown = detailsOf(inv, single(claudeSkill(inv, "eli5")), app, NOW);
    expect(shown.find((l) => l.label === "Shows as")?.text).toMatch(
      /^name only \(~[\\/]\.claude[\\/]settings\.json\)$/,
    );
  });

  it("shows a server's commands and secret names, never their values, and each account's state", async () => {
    const { inv, app } = await seed(github);
    const lines = detailsOf(inv, serverRow(inv, "global", app, "github"), app, NOW);
    expect(lines[0]).toEqual({ text: "GLOBAL › github" });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    // The two accounts' copies run different commands, so each says whose it is.
    const runsAt = lines.findIndex((l) => l.label === "Runs");
    expect(lines[runsAt]?.text).toMatch(/^gh-mcp --api-key \S+ \(in default\)$/);
    expect(lines[runsAt + 1]).toEqual({ label: "", text: "gh-mcp (in work)" });
    expect(lines.find((l) => l.label === "Secrets")?.text).toBe("GITHUB_TOKEN (value hidden)");
    const accountsAt = lines.findIndex((l) => l.label === "Accounts");
    expect(lines[accountsAt]?.text).toBe("default  on");
    expect(lines[accountsAt + 1]?.text).toMatch(
      /^work {5}off \(this project's entry in ~[\\/]\.claude-work[\\/]\.claude\.json\)$/,
    );
    const fileAt = lines.findIndex((l) => l.label === "File");
    expect(lines.slice(fileAt, fileAt + 2).map((l) => l.text)).toEqual([
      `~${path.sep}.claude.json`,
      `~${path.sep}${path.join(".claude-work", ".claude.json")}`,
    ]);
  });

  it("shows a local server's accounts, the ones without it too, and whose entry its file is", async () => {
    const { inv, app } = await seed({
      defaultJson: (app) => ({ projects: { [app]: { mcpServers: { "pg-dev": { command: "pg" } } } } }),
    });
    const lines = detailsOf(inv, serverRow(inv, "project", app, "pg-dev"), app, NOW);
    expect(lines[0]).toEqual({ text: "PROJECT › pg-dev" });
    const accountsAt = lines.findIndex((l) => l.label === "Accounts");
    expect(lines.slice(accountsAt, accountsAt + 2).map((l) => l.text)).toEqual(["default  on", "others   not added"]);
    expect(lines.find((l) => l.label === "File")?.text).toMatch(/\(this project's entry\)$/);
  });

  it("shows a hook in plain words", async () => {
    const { inv, app } = await seed();
    const lines = detailsOf(inv, single(find(inv, (i) => i.kind === "hook", "hook")), app, NOW);
    expect(lines).toEqual([
      { text: "GLOBAL › Stop" },
      { label: "When", text: "Claude finishes replying" },
      { label: "Runs", text: "notify-me" },
      { label: "File", text: `~${path.sep}${path.join(".claude", "settings.json")}` },
    ]);
  });

  it("shows a plugin: who it is installed for, whether it is on, and what it brings", async () => {
    const { inv, app } = await seed({
      more: (h) => {
        const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
        h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
        h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
        h.write(".claude/plugins/cache/m/kit/1.0.0/.claude-plugin/plugin.json", { name: "kit", description: "A kit" });
        h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
        h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "review");
        h.write(".claude/plugins/cache/m/kit/1.0.0/hooks/hooks.json", {
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "kit-start" }] }] },
        });
      },
    });
    const lines = detailsOf(inv, single(find(inv, (i) => i.kind === "plugin", "kit@m")), app, NOW);
    expect(lines).toEqual([
      { text: "PLUGINS › kit" },
      { text: "A kit" },
      { label: "Installed", text: "for you (every project)" },
      { label: "Loaded", text: "on in default, every project" },
      { label: "Contains", text: "2 skills · 0 MCP servers · 1 hook" },
      { label: "", text: "plan, review, SessionStart" },
    ]);
  });
});

describe("rowAccounts and accountsWord", () => {
  /** One install's copy of a plugin's server, as the sources read one: `accounts` only when given. */
  const install = (dir: string, accounts?: string[]): Extension => ({
    id: `mcp:claude:plugin:sp@m|user|-|/${dir}:plugin:sp:search`,
    kind: "mcp",
    name: "plugin:sp:search",
    location: {
      tool: "claude",
      scope: "plugin",
      plugin: "sp@m",
      file: `/${dir}/.mcp.json`,
      ...(accounts ? { accounts } : {}),
    },
  });
  const row = (...items: Extension[]): ScopeRow => ({ key: "row", name: "plugin:sp:search", items });

  it("is every account for a row of copies that name none, never 0 of N", async () => {
    const { inv } = await seed();
    const bare = row(install("a"), install("b"));
    expect(bare.items.every(isAccountCopy)).toBe(true);
    expect(rowAccounts(inv, bare)).toBeUndefined();
    expect(accountsWord(inv, bare)).toBe("all");
    expect(accountsWord(inv, row(install("a", [])))).toBe("all");
  });

  it("names the one account, counts several of all, and says all when every account has it", async () => {
    const { inv } = await seed();
    const three = { ...inv, claudeProfiles: [...inv.claudeProfiles, "claude:solo"] };
    const work = row(install("a", ["claude:work"]));
    expect(rowAccounts(three, work)).toEqual(["claude:work"]);
    expect(accountsWord(three, work)).toBe("work");
    const two = row(install("a", ["claude:work"]), install("b", ["claude:default"]));
    expect(rowAccounts(three, two)).toEqual(["claude:default", "claude:work"]);
    expect(accountsWord(three, two)).toBe("2 of 3");
    expect(accountsWord(inv, two)).toBe("all");
    // A server in each account's own .claude.json: the accounts whose file has it.
    const both = await seed(github);
    const server = serverRow(both.inv, "global", both.app, "github");
    expect(accountsWord(both.inv, server)).toBe("all");
    expect(accountsWord({ ...both.inv, claudeProfiles: [...both.inv.claudeProfiles, "claude:solo"] }, server)).toBe(
      "2 of 3",
    );
  });

  it("is a dash for a Codex row", async () => {
    const { inv } = await seed();
    const codex = find(inv, (i) => i.location.tool === "codex" && i.kind === "skill", "a Codex skill");
    expect(accountsWord(inv, row(codex))).toBe("—");
  });
});

describe("jsonItem", () => {
  it("gives a skill's fields in the documented order", async () => {
    const { inv, app } = await seed();
    const item = jsonItem(inv, single(claudeSkill(inv, "eli5")), app, NOW);
    expect(Object.keys(item)).toEqual([
      "id",
      "kind",
      "tool",
      "name",
      "scope",
      "from",
      "project",
      "state",
      "usage",
      "tags",
      "file",
      "description",
      "alsoIn",
    ]);
    expect(item).toMatchObject({
      kind: "skill",
      tool: "claude",
      name: "eli5",
      scope: "global",
      from: "Global",
      project: null,
      state: "on",
      usage: { total: 4, lastUsedAt: new Date(NOW - DAY).toISOString(), byAccount: { "claude:default": 4 } },
      tags: [],
      description: "Explain things simply",
    });
    expect(item.alsoIn).toEqual([
      { tool: "claude", scope: "project", project: app, sameContent: false },
      { tool: "codex", scope: "global", project: null, sameContent: false },
    ]);
  });

  it("gives a server row its key, every account's copy and state, and never a secret value", async () => {
    const { inv, app } = await seed(github);
    const row = serverRow(inv, "global", app, "github");
    const item = jsonItem(inv, row, app, NOW);
    expect(Object.keys(item)).toEqual([
      "id",
      "kind",
      "tool",
      "name",
      "scope",
      "from",
      "project",
      "accounts",
      "state",
      "stateByAccount",
      "usage",
      "tags",
      "file",
      "copies",
      "description",
      "alsoIn",
      "summary",
    ]);
    const [mine, theirs] = row.items as [Extension, Extension];
    expect(item).toMatchObject({
      id: "mcp:claude:account:-:github",
      file: mine.location.file,
      copies: [
        { id: mine.id, account: "claude:default", file: mine.location.file },
        { id: theirs.id, account: "claude:work", file: theirs.location.file },
      ],
      accounts: ["claude:default", "claude:work"],
      state: "mixed",
      stateByAccount: { "claude:default": "on", "claude:work": "off" },
      usage: null,
      tags: ["off in 1 of 2 accounts"],
      description: null,
      alsoIn: [],
    });
    expect(JSON.stringify(item)).not.toContain(KEY);
    expect(item.summary).toMatchObject({ env: "GITHUB_TOKEN" });
  });
});

describe("rows across accounts", () => {
  /** Three accounts: default and work have Cloud's pdf, and kit installed for everyone, each from its own folder. */
  async function shared() {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.claude("default", ".claude", {
      projects: { [app]: {} },
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
    });
    h.claude("work", ".claude-work", { oauthAccount: { organizationUuid: "org1", accountUuid: "acc2" } });
    h.claude("solo", ".claude-solo");
    h.skill(".claude/skills/synced/org1_acc1", "pdf", "Read PDFs");
    h.skill(".claude/skills/synced/org1_acc2", "pdf", "Read PDFs");
    h.skill(".claude/skills", "pdf", "My own pdf");
    const kitA = h.path(".claude/plugins/cache/m/kit/1.0.0");
    const kitB = h.path(".claude-work/plugins/cache/m/kit/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kitA }] } });
    h.write(".claude-work/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kitB }] } });
    h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
    h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
    h.skill(".claude-work/plugins/cache/m/kit/1.0.0/skills", "plan");
    const inv = await loadInventory({
      homeDir: h.home,
      registry: h.registry,
      cwd: app,
      managedSettings: h.path("none.json"),
    });
    const row = (scope: "cloud" | "plugins" | "loaded", name: string): ScopeRow => {
      const found = rowsIn(inv, "claude", "skill", scope, app, NOW).find((r) => r.name === name);
      if (!found) throw new Error(`no ${name} row`);
      return found;
    };
    return { h, inv, app, row };
  }

  it("reads a Cloud skill's row per account, and says which accounts have it", async () => {
    const { inv, app, row } = await shared();
    const pdf = row("cloud", "pdf");
    expect(statesByAccount(inv, pdf, app)?.map((a) => [a.profile, a.state.value])).toEqual([
      ["claude:default", "on"],
      ["claude:work", "on"],
    ]);
    expect(tagsOf(inv, pdf, app, NOW)).toEqual([]);
    const lines = detailsOf(inv, pdf, app, NOW);
    expect(lines[0]).toEqual({ text: "CLOUD › pdf" });
    const loadedAt = lines.findIndex((l) => l.label === "Loaded");
    expect(lines.slice(loadedAt, loadedAt + 2)).toEqual([
      { label: "Loaded", text: "on in 2 accounts, every project" },
      { label: "", text: "default, work" },
    ]);
    const fileAt = lines.findIndex((l) => l.label === "File");
    expect(lines[fileAt + 1]).toEqual({ label: "", text: "and 1 more copy", tone: "muted" });
    // The row's own copies are not "also" anywhere: only the global pdf is.
    // A Cloud copy is never hashed, so whether the two say the same is not known.
    expect(lines.filter((l) => l.label === "Also in").map((l) => l.text)).toEqual(["Claude › Global"]);
  });

  it("gives a Cloud skill's row its key and every account's copy in JSON", async () => {
    const { inv, app, row } = await shared();
    const pdf = row("cloud", "pdf");
    const item = jsonItem(inv, pdf, app, NOW);
    expect(Object.keys(item)).toEqual([
      "id",
      "kind",
      "tool",
      "name",
      "scope",
      "from",
      "project",
      "accounts",
      "state",
      "stateByAccount",
      "usage",
      "tags",
      "file",
      "copies",
      "description",
      "alsoIn",
    ]);
    expect(item).toMatchObject({
      id: "skill:claude:synced:-:pdf",
      scope: "cloud",
      accounts: ["claude:default", "claude:work"],
      stateByAccount: { "claude:default": "on", "claude:work": "on" },
      copies: pdf.items.map((i) => ({ id: i.id, account: i.location.profile, file: i.location.file })),
      file: pdf.items[0]?.location.file,
    });
    expect(item.alsoIn).toEqual([{ tool: "claude", scope: "global", project: null, sameContent: null }]);
  });

  it("shows a plugin installed in two accounts as one, with what its installs bring merged", async () => {
    const { inv, app, row } = await shared();
    const kit = row("plugins", "kit@m");
    expect(kit.items).toHaveLength(2);
    expect(detailsOf(inv, kit, app, NOW)).toEqual([
      { text: "PLUGINS › kit" },
      { label: "Installed", text: "for you (every project)" },
      { label: "Loaded", text: "on in 2 accounts, every project" },
      { label: "", text: "default, work" },
      { label: "Contains", text: "1 skill · 0 MCP servers · 0 hooks" },
      { label: "", text: "plan" },
    ]);
    const item = jsonItem(inv, kit, app, NOW);
    expect(item).toMatchObject({
      id: "plugin:claude:user:-:kit@m",
      plugin: "kit@m",
      accounts: ["claude:default", "claude:work"],
      copies: kit.items.map((i) => ({ id: i.id, accounts: i.location.accounts, file: i.location.file })),
    });
    // What it brings is one row too, in both accounts.
    const plan = row("loaded", "kit:plan");
    expect(plan.items).toHaveLength(2);
    expect(statesByAccount(inv, plan, app)?.map((a) => a.profile)).toEqual(["claude:default", "claude:work"]);
    expect(detailsOf(inv, plan, app, NOW).some((l) => l.label === "Also in")).toBe(false);
  });
});
