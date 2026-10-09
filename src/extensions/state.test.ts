import { describe, expect, it } from "vitest";

import { type Extension, emptyFacts, type Inventory, type StateFacts } from "./model.js";
import { claudeMcpTaken, pluginState, relevantIn, stateOf } from "./state.js";

const P = "/repos/app";
const Q = "/repos/web";

function inv(items: Extension[], facts: Partial<StateFacts> = {}): Inventory {
  return {
    items,
    projects: [{ path: P, tools: ["claude"], profiles: ["claude:a", "claude:b"] }],
    homeDir: "/home/u",
    claudeProfiles: ["claude:a", "claude:b"],
    facts: { ...emptyFacts(), ...facts },
    usage: {},
    hashes: {},
    warnings: [],
  };
}
function skill(
  name: string,
  scope: Extension["location"]["scope"],
  extra: Partial<Extension["location"]> = {},
): Extension {
  return {
    id: `skill:claude:${scope}:${name}`,
    kind: "skill",
    name,
    location: { tool: "claude", scope, file: `/f/${name}`, ...extra },
  };
}
/** A typed item of any kind; the id only has to be unique within a test. */
function ext(kind: Extension["kind"], name: string, location: Extension["location"]): Extension {
  return { id: `${kind}:${location.tool}:${location.scope}:${name}`, kind, name, location };
}

describe("Claude skills", () => {
  const eli5 = skill("eli5", "global");
  // Listed out of precedence order, so neither the first nor the last entry winning passes.
  const overrides: StateFacts["claudeSkillOverrides"] = [
    { file: "/u/settings.json", layer: "user", map: { eli5: "off" } },
    { file: `${P}/.claude/settings.local.json`, layer: "local", project: P, map: { eli5: "name-only" } },
    { file: `${P}/.claude/settings.json`, layer: "project", project: P, map: { eli5: "user-invocable-only" } },
  ];

  it("takes local over project over user, and user alone with no project", () => {
    const i = inv([eli5], { claudeSkillOverrides: overrides });
    expect(stateOf(i, eli5, P)).toEqual({
      value: "name-only",
      setBy: { file: `${P}/.claude/settings.local.json`, key: "skillOverrides.eli5" },
    });
    const noLocal = inv([eli5], { claudeSkillOverrides: overrides.filter((o) => o.layer !== "local") });
    expect(stateOf(noLocal, eli5, P)).toEqual({
      value: "user-invocable-only",
      setBy: { file: `${P}/.claude/settings.json`, key: "skillOverrides.eli5" },
    });
    expect(stateOf(i, eli5, Q).value).toBe("off");
    expect(stateOf(i, eli5).value).toBe("off");
  });

  it("lets managed settings win, ignores an unknown value, and defaults to on", () => {
    const i = inv([eli5], {
      claudeSkillOverrides: [
        { file: "/m.json", layer: "managed", map: { eli5: "off" } },
        { file: `${P}/.claude/settings.local.json`, layer: "local", project: P, map: { eli5: "on" } },
        { file: "/u/settings.json", layer: "user", map: { other: "sideways" } },
      ],
    });
    expect(stateOf(i, eli5, P).value).toBe("off");
    expect(
      stateOf(
        inv([skill("other", "global")], {
          claudeSkillOverrides: [{ file: "/u", layer: "user", map: { other: "sideways" } }],
        }),
        skill("other", "global"),
      ).value,
    ).toBe("on");
  });

  it("follows the plugin for a plugin skill and marks a project skill a global one shadows", () => {
    const fromPlugin = skill("sp:brainstorming", "plugin", { plugin: "sp@m" });
    const local = skill("eli5", "project", { project: P });
    const i = inv([eli5, local, fromPlugin], {
      claudeEnabledPlugins: [{ file: "/u", layer: "user", map: { "sp@m": false } }],
    });
    expect(stateOf(i, fromPlugin, P).value).toBe("off");
    expect(stateOf(i, local, P).shadowedBy).toBe(eli5.id);
    expect(pluginState(i, "missing@m").value).toBe("off");
  });
});

describe("Claude MCP", () => {
  const user = ext("mcp", "stitch", { tool: "claude", scope: "account", profile: "claude:a", file: "/a.json" });
  const shared = ext("mcp", "docs", { tool: "claude", scope: "project", project: P, file: `${P}/.mcp.json` });
  const fromPlugin = ext("mcp", "plugin:sp:search", {
    tool: "claude",
    scope: "plugin",
    plugin: "sp@m",
    file: "/p/.mcp.json",
    accounts: ["claude:a", "claude:b"],
  });

  it("is off for the account and project that disabled it, on elsewhere and with no project", () => {
    const i = inv([user], {
      claudeMcpDisabled: [{ file: "/a.json", profile: "claude:a", project: P, names: ["stitch"] }],
    });
    expect(stateOf(i, user, P).value).toBe("off");
    expect(stateOf(i, user, Q).value).toBe("on");
    expect(stateOf(i, user).value).toBe("on");
    // The disable sits in claude:a's .claude.json, so it says nothing about claude:b.
    expect(stateOf(i, user, P, "claude:a").value).toBe("off");
    expect(stateOf(i, user, P, "claude:b").value).toBe("on");
  });

  it("reads .mcp.json approvals: denied, approved, or pending", () => {
    const pending = inv([shared]);
    expect(stateOf(pending, shared, P).value).toBe("pending-approval");
    const approved = inv([shared], {
      claudeMcpjson: [{ file: "/l.json", project: P, enabled: ["docs"], disabled: [], enableAll: false }],
    });
    expect(stateOf(approved, shared, P).value).toBe("on");
    // User settings carry no project: their approvals apply in every project.
    const fromUser = inv([shared], {
      claudeMcpjson: [{ file: "/u/settings.json", enabled: ["docs"], disabled: [], enableAll: false }],
    });
    expect(stateOf(fromUser, shared, P).value).toBe("on");
    expect(stateOf(fromUser, shared, P).setBy?.file).toBe("/u/settings.json");
    const denied = inv([shared], {
      claudeMcpjson: [
        { file: "/l.json", project: P, enabled: [], disabled: ["docs"], enableAll: false },
        { file: "/a.json", project: P, profile: "claude:a", enabled: [], disabled: [], enableAll: true },
      ],
    });
    expect(stateOf(denied, shared, P, "claude:a").value).toBe("off");
  });

  it("keeps an account's .mcp.json approval to that account", () => {
    const deniedByB = inv([shared], {
      claudeMcpjson: [
        { file: "/b.json", project: P, profile: "claude:b", enabled: [], disabled: ["docs"], enableAll: false },
      ],
    });
    expect(stateOf(deniedByB, shared, P, "claude:a").value).toBe("pending-approval");
    expect(stateOf(deniedByB, shared, P, "claude:b")).toEqual({
      value: "off",
      setBy: { file: "/b.json", key: "disabledMcpjsonServers" },
    });
    // With no account named, every account's approvals count.
    expect(stateOf(deniedByB, shared, P).value).toBe("off");
    const allByA = inv([shared], {
      claudeMcpjson: [{ file: "/a.json", project: P, profile: "claude:a", enabled: [], disabled: [], enableAll: true }],
    });
    expect(stateOf(allByA, shared, P, "claude:a")).toEqual({
      value: "on",
      setBy: { file: "/a.json", key: "enableAllProjectMcpServers" },
    });
    expect(stateOf(allByA, shared, P, "claude:b").value).toBe("pending-approval");
  });

  it("turns a plugin's server off with the plugin, and for one account with disabledMcpServers", () => {
    const pluginOff = inv([fromPlugin], {
      claudeEnabledPlugins: [{ file: "/u/settings.json", layer: "user", map: { "sp@m": false } }],
    });
    expect(stateOf(pluginOff, fromPlugin, P, "claude:a")).toEqual({
      value: "off",
      setBy: { file: "/u/settings.json", key: "enabledPlugins.sp@m" },
    });
    expect(stateOf(pluginOff, fromPlugin).value).toBe("off");
    const disabledForA = inv([fromPlugin], {
      claudeEnabledPlugins: [{ file: "/u/settings.json", layer: "user", map: { "sp@m": true } }],
      claudeMcpDisabled: [{ file: "/a.json", profile: "claude:a", project: P, names: ["plugin:sp:search"] }],
    });
    expect(stateOf(disabledForA, fromPlugin, P, "claude:a")).toEqual({
      value: "off",
      setBy: { file: "/a.json", key: "disabledMcpServers" },
    });
    expect(stateOf(disabledForA, fromPlugin, P, "claude:b").value).toBe("on");
    // With no account named, no account's disabledMcpServers entry applies.
    expect(stateOf(disabledForA, fromPlugin, P).value).toBe("on");
  });
});

describe("Claude MCP, one server per name", () => {
  // Claude Code: "local-scoped servers first, followed by project-scoped servers, and finally user-scoped servers".
  const user = (profile: string) =>
    ({
      ...ext("mcp", "github", { tool: "claude", scope: "account", profile, file: `/${profile}.json` }),
      id: `mcp:claude:account:${profile}:github`,
    }) satisfies Extension;
  const [userA, userB] = [user("claude:a"), user("claude:b")];
  const localA: Extension = {
    ...ext("mcp", "github", {
      tool: "claude",
      scope: "local",
      profile: "claude:a",
      project: P,
      file: "/claude:a.json",
    }),
    id: "mcp:claude:local:claude:a@app:github",
  };
  const shared = ext("mcp", "github", { tool: "claude", scope: "project", project: P, file: `${P}/.mcp.json` });
  const parent: Extension = {
    ...ext("mcp", "github", { tool: "claude", scope: "project", project: "/repos", file: "/repos/.mcp.json" }),
    id: "mcp:claude:project:/repos:github",
  };
  const approvedFor = (profile: string): Partial<StateFacts> => ({
    claudeMcpjson: [
      { file: `/${profile}.json`, project: P, profile, enabled: ["github"], disabled: [], enableAll: false },
    ],
  });

  it("hides a user server behind the same account's local one, in that account only", () => {
    const i = inv([userA, userB, localA]);
    expect(stateOf(i, userA, P)).toEqual({ value: "on", shadowedBy: localA.id });
    expect(stateOf(i, userB, P)).toEqual({ value: "on" });
    expect(stateOf(i, localA, P)).toEqual({ value: "on" });
    // The local server is the project's: elsewhere, and with no project, the user one loads.
    expect(stateOf(i, userA, Q).shadowedBy).toBeUndefined();
    expect(stateOf(i, userA).shadowedBy).toBeUndefined();
  });

  it("hides a user server behind a .mcp.json one approved for its account, here or in a parent dir", () => {
    const i = inv([userA, userB, shared], approvedFor("claude:a"));
    expect(stateOf(i, userA, P)).toEqual({ value: "on", shadowedBy: shared.id });
    // Not approved for b: Claude Code leaves the .mcp.json copy out, and b's user server loads.
    expect(stateOf(i, userB, P)).toEqual({ value: "on" });
    const fromParent = inv([userA, parent], approvedFor("claude:a"));
    expect(stateOf(fromParent, userA, P).shadowedBy).toBe(parent.id);
  });

  it("keeps a user server loading beside a pending or denied .mcp.json one, which waits or is off", () => {
    const pending = inv([userA, shared]);
    expect(stateOf(pending, userA, P)).toEqual({ value: "on" });
    expect(stateOf(pending, shared, P, "claude:a")).toEqual({ value: "pending-approval" });
    const denied = inv([userA, shared], {
      claudeMcpjson: [
        {
          file: "/claude:a.json",
          project: P,
          profile: "claude:a",
          enabled: [],
          disabled: ["github"],
          enableAll: false,
        },
      ],
    });
    expect(stateOf(denied, userA, P)).toEqual({ value: "on" });
    expect(stateOf(denied, shared, P, "claude:a").value).toBe("off");
  });

  it("hides a .mcp.json server behind an account's local one, in that account only", () => {
    const i = inv([localA, shared, parent], approvedFor("claude:a"));
    expect(stateOf(i, shared, P, "claude:a")).toMatchObject({ value: "on", shadowedBy: localA.id });
    expect(stateOf(i, shared, P, "claude:b")).toEqual({ value: "pending-approval" });
    // The local copy outranks every .mcp.json copy; without it, the nearer file still wins.
    expect(stateOf(i, parent, P, "claude:a").shadowedBy).toBe(localA.id);
    expect(stateOf(i, parent, P, "claude:b").shadowedBy).toBe(shared.id);
    // With no account named, no account's own server applies.
    expect(stateOf(i, shared, P).shadowedBy).toBeUndefined();
  });

  it("takes, per account, the copy Claude Code starts", () => {
    const i = inv([userA, userB, localA, shared], approvedFor("claude:b"));
    expect(claudeMcpTaken(i, "github", P, "claude:a")).toBe(localA);
    expect(claudeMcpTaken(i, "github", P, "claude:b")).toBe(shared);
    const pending = inv([userA, shared]);
    expect(claudeMcpTaken(pending, "github", P, "claude:a")).toBe(userA);
    // Nothing but a pending .mcp.json copy: it is the one, waiting for approval.
    expect(claudeMcpTaken(pending, "github", P, "claude:b")).toBe(shared);
  });
});

describe("Claude skills, one per name", () => {
  const deploy = skill("deploy", "project", { project: P });
  const workOwn: Extension = {
    ...skill("deploy", "account", { profile: "claude:b" }),
    id: "skill:claude:account:b:deploy",
  };

  it("hides a project skill behind an account's own copy in that account only, and a Global one in every account", () => {
    const i = inv([deploy, workOwn]);
    expect(stateOf(i, deploy, P, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(i, deploy, P, "claude:b")).toEqual({ value: "on", shadowedBy: workOwn.id });
    // With no account named, no account's own copy applies.
    expect(stateOf(i, deploy, P).shadowedBy).toBeUndefined();
    const global = skill("deploy", "global");
    const both = inv([deploy, workOwn, global]);
    expect(stateOf(both, deploy, P, "claude:a").shadowedBy).toBe(global.id);
    expect(stateOf(both, deploy, P).shadowedBy).toBe(global.id);
  });
});

describe("Claude plugins and hooks", () => {
  const accounts = ["claude:a", "claude:b"];
  const plugin = ext("plugin", "sp@m", { tool: "claude", scope: "plugin", plugin: "sp@m", file: "/p", accounts });
  const pluginHook = ext("hook", "PreToolUse", {
    tool: "claude",
    scope: "plugin",
    plugin: "sp@m",
    file: "/p/hooks/hooks.json",
    accounts,
  });
  const settingsHook = ext("hook", "Stop", { tool: "claude", scope: "global", file: "/u/settings.json" });
  // Off for the user, on in P's shared settings.
  const facts: Partial<StateFacts> = {
    claudeEnabledPlugins: [
      { file: "/u/settings.json", layer: "user", map: { "sp@m": false } },
      { file: `${P}/.claude/settings.json`, layer: "project", project: P, map: { "sp@m": true } },
    ],
  };

  it("gives a plugin and a plugin's hook the plugin's state", () => {
    const i = inv([plugin, pluginHook, settingsHook], facts);
    for (const project of [P, Q, undefined]) {
      expect(stateOf(i, plugin, project)).toEqual(pluginState(i, "sp@m", project));
      expect(stateOf(i, pluginHook, project)).toEqual(pluginState(i, "sp@m", project));
    }
    expect(stateOf(i, plugin, P)).toEqual({
      value: "on",
      setBy: { file: `${P}/.claude/settings.json`, key: "enabledPlugins.sp@m" },
    });
    expect(stateOf(i, plugin, Q).value).toBe("off");
    expect(stateOf(i, pluginHook, Q).value).toBe("off");
  });

  it("has no switch for a settings hook", () => {
    expect(stateOf(inv([settingsHook], facts), settingsHook, Q)).toEqual({ value: "on" });
  });
});

describe("Codex", () => {
  const repoSkill = ext("skill", "lint", {
    tool: "codex",
    scope: "project",
    project: P,
    file: `${P}/.agents/skills/lint`,
  });
  const exa = ext("mcp", "exa", { tool: "codex", scope: "global", file: "/c/config.toml" });

  it("turns a skill off by path over name", () => {
    const i = inv([repoSkill], {
      codexSkillConfig: [
        { file: "/c", name: "lint", enabled: true },
        { file: "/c", path: `${P}/.agents/skills/lint/SKILL.md`, enabled: false },
      ],
    });
    expect(stateOf(i, repoSkill, P).value).toBe("off");
  });

  it("takes a project's mcp_servers.enabled over the user's", () => {
    const i = inv([exa], {
      codexMcpEnabled: [
        { file: "/c", name: "exa", enabled: true },
        { file: `${P}/.codex/config.toml`, project: P, name: "exa", enabled: false },
      ],
    });
    expect(stateOf(i, exa, P).value).toBe("off");
    expect(stateOf(i, exa, Q).value).toBe("on");
  });
});

describe("relevantIn", () => {
  it("is true for what no project owns and for the project's own", () => {
    expect(relevantIn(skill("a", "global"), undefined)).toBe(true);
    expect(relevantIn(skill("b", "project", { project: P }), P)).toBe(true);
    expect(relevantIn(skill("b", "project", { project: P }), Q)).toBe(false);
    expect(relevantIn(skill("b", "project", { project: P }), undefined)).toBe(false);
  });
});
