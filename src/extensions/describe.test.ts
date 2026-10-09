import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agoWords,
  detailsOf,
  fromLabel,
  hookWhen,
  jsonItem,
  scopeSentence,
  statesByAccount,
  tagsOf,
} from "./describe.js";
import { loadInventory } from "./inventory.js";
import type { Extension, Inventory } from "./model.js";
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
});

describe("tagsOf", () => {
  it("tags the project's eli5 as hidden by the global one, which wins as Claude Code resolves a name", async () => {
    const { inv, app } = await seed();
    // Claude Code: personal over project.
    expect(tagsOf(inv, claudeSkill(inv, "eli5", app), app, NOW)).toEqual(["hidden by Global copy"]);
    expect(tagsOf(inv, claudeSkill(inv, "eli5"), app, NOW)).toEqual([]);
  });

  it("says off here for a setting of this project's, and off for one of the user's", async () => {
    const local = await seed({
      more: (h) => h.write("repos/app/.claude/settings.local.json", { skillOverrides: { "old-one": "off" } }),
    });
    expect(tagsOf(local.inv, claudeSkill(local.inv, "old-one"), local.app, NOW)).toEqual(["off here", "unused"]);
    const user = await seed({
      more: (h) => h.write(".claude/settings.json", { skillOverrides: { "old-one": "off" } }),
    });
    expect(tagsOf(user.inv, claudeSkill(user.inv, "old-one"), user.app, NOW)).toEqual(["off", "unused"]);
  });

  it("says off in 1 of 2 accounts for a server one account turned off here", async () => {
    const { inv, app } = await seed({
      defaultJson: () => ({ mcpServers: { github: { command: "gh-mcp" } } }),
      workJson: (app) => ({
        projects: { [app]: { disabledMcpServers: ["github"] } },
        mcpServers: { github: { command: "gh-mcp" } },
      }),
    });
    const copies = inv.items.filter((i) => i.kind === "mcp" && i.name === "github");
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(tagsOf(inv, copy, app, NOW)).toEqual(["off in 1 of 2 accounts"]);
    expect(statesByAccount(inv, copies[0] as Extension, app)?.map((a) => [a.profile, a.state.value])).toEqual([
      ["claude:default", "on"],
      ["claude:work", "off"],
    ]);
  });

  it("puts broken link first and leaves unused out after it; a .mcp.json server waits for approval", async () => {
    const { inv, app } = await seed({ more: (h) => h.link(path.join(h.home, "gone"), ".claude/skills/dangling") });
    expect(tagsOf(inv, claudeSkill(inv, "dangling"), app, NOW)).toEqual(["broken link"]);
    expect(
      tagsOf(
        inv,
        find(inv, (i) => i.name === "tools", "tools"),
        app,
        NOW,
      ),
    ).toEqual(["pending approval"]);
  });
});

describe("fromLabel and scopeSentence", () => {
  it("says where a loaded row comes from", async () => {
    const { inv, app, h } = await seed();
    expect(fromLabel(claudeSkill(inv, "eli5"), inv, app)).toBe("Global");
    expect(fromLabel(claudeSkill(inv, "deploy-check", app), inv, app)).toBe("Project");
    // A parent folder goes by its path: here the home dir's .mcp.json.
    expect(
      fromLabel(
        find(inv, (i) => i.name === "tools", "tools"),
        inv,
        app,
      ),
    ).toBe("~");
    expect(
      fromLabel(
        find(inv, (i) => i.name === "tools", "tools"),
        inv,
        h.home,
      ),
    ).toBe("Project");
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
    expect(scopeSentence("other", "claude", "skill", inv, app, web)).toMatch(
      /^OTHER PROJECTS › web — ~[\\/]repos[\\/]web/,
    );
    expect(scopeSentence("parents", "claude", "mcp", inv, app)).toBe(
      "PARENT FOLDERS — .mcp.json in ~ · loads here too",
    );
  });
});

describe("detailsOf", () => {
  it("shows a skill: title, description, file with ~, where it loads, use, and its other copies", async () => {
    const { inv, app } = await seed();
    const lines = detailsOf(inv, claudeSkill(inv, "eli5"), app, NOW);
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
    const lines = detailsOf(inv, claudeSkill(inv, "eli5", app), app, NOW);
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
    const off = detailsOf(inv, claudeSkill(inv, "old-one"), app, NOW);
    expect(off.find((l) => l.label === "Loaded")?.text).toMatch(
      /^off here \(this project's \.claude[\\/]settings\.local\.json\)$/,
    );
    const shown = detailsOf(inv, claudeSkill(inv, "eli5"), app, NOW);
    expect(shown.find((l) => l.label === "Shows as")?.text).toMatch(
      /^name only \(~[\\/]\.claude[\\/]settings\.json\)$/,
    );
  });

  it("shows a server's command and secret names, never their values, and each account's state", async () => {
    const { inv, app } = await seed({
      defaultJson: () => ({
        mcpServers: { github: { command: "gh-mcp", args: ["--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
      }),
      workJson: (app) => ({
        projects: { [app]: { disabledMcpServers: ["github"] } },
        mcpServers: { github: { command: "gh-mcp" } },
      }),
    });
    const server = find(inv, (i) => i.name === "github" && i.location.profile === "claude:default", "github");
    const lines = detailsOf(inv, server, app, NOW);
    expect(lines[0]).toEqual({ text: "GLOBAL › github" });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(lines.find((l) => l.label === "Runs")?.text.startsWith("gh-mcp --api-key ")).toBe(true);
    expect(lines.find((l) => l.label === "Secrets")?.text).toBe("GITHUB_TOKEN (value hidden)");
    const accountsAt = lines.findIndex((l) => l.label === "Accounts");
    expect(lines[accountsAt]?.text).toBe("default  on");
    expect(lines[accountsAt + 1]?.text).toMatch(
      /^work {5}off \(this project's entry in ~[\\/]\.claude-work[\\/]\.claude\.json\)$/,
    );
    expect(lines.find((l) => l.label === "File")?.text).toBe("~/.claude.json".replace("/", path.sep));
  });

  it("shows a local server's accounts, the ones without it too, and whose entry its file is", async () => {
    const { inv, app } = await seed({
      defaultJson: (app) => ({ projects: { [app]: { mcpServers: { "pg-dev": { command: "pg" } } } } }),
    });
    const lines = detailsOf(
      inv,
      find(inv, (i) => i.name === "pg-dev", "pg-dev"),
      app,
      NOW,
    );
    expect(lines[0]).toEqual({ text: "PROJECT › pg-dev" });
    const accountsAt = lines.findIndex((l) => l.label === "Accounts");
    expect(lines.slice(accountsAt, accountsAt + 2).map((l) => l.text)).toEqual(["default  on", "others   not added"]);
    expect(lines.find((l) => l.label === "File")?.text).toMatch(/\(this project's entry\)$/);
  });

  it("shows a hook in plain words", async () => {
    const { inv, app } = await seed();
    const lines = detailsOf(
      inv,
      find(inv, (i) => i.kind === "hook", "hook"),
      app,
      NOW,
    );
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
    const lines = detailsOf(
      inv,
      find(inv, (i) => i.kind === "plugin", "kit@m"),
      app,
      NOW,
    );
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

describe("jsonItem", () => {
  it("gives a skill's fields in the documented order", async () => {
    const { inv, app } = await seed();
    const item = jsonItem(inv, claudeSkill(inv, "eli5"), app, NOW);
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

  it("gives a server's accounts and each account's state, and never a secret value", async () => {
    const { inv, app } = await seed({
      defaultJson: () => ({
        mcpServers: { github: { command: "gh-mcp", args: ["--api-key", KEY], env: { GITHUB_TOKEN: KEY } } },
      }),
      workJson: (app) => ({
        projects: { [app]: { disabledMcpServers: ["github"] } },
        mcpServers: { github: { command: "gh-mcp" } },
      }),
    });
    const server = find(inv, (i) => i.name === "github" && i.location.profile === "claude:default", "github");
    const item = jsonItem(inv, server, app, NOW);
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
      "description",
      "alsoIn",
      "summary",
    ]);
    expect(item).toMatchObject({
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
