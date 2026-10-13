import { describe, expect, it } from "vitest";

import { type Extension, emptyFacts, type Inventory, type StateFacts } from "./model.js";
import {
  claudeMcpTaken,
  claudeSkillOverride,
  codexTrusted,
  isManagedSetting,
  pluginState,
  relevantIn,
  stateOf,
} from "./state.js";

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
    places: { claudeJson: {}, stashDir: "/home/u/.clausona/extensions/stash" },
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

  it("reads what is left below the layers a change is about to skip", () => {
    const i = inv([eli5], { claudeSkillOverrides: overrides });
    expect(claudeSkillOverride(i, "eli5", P)?.value).toBe("name-only");
    expect(claudeSkillOverride(i, "eli5", P, ["local"])).toEqual({
      value: "user-invocable-only",
      setBy: { file: `${P}/.claude/settings.json`, key: "skillOverrides.eli5" },
    });
    expect(claudeSkillOverride(i, "eli5", P, ["local", "project"])?.setBy?.file).toBe("/u/settings.json");
    expect(claudeSkillOverride(i, "eli5", P, ["local", "project", "user"])).toBeUndefined();
    expect(claudeSkillOverride(i, "eli5", undefined, ["user"])).toBeUndefined();
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

  it("turns the built-in skills off under disableBundledSkills, over skillOverrides, and no other", () => {
    const api = skill("claude-api", "builtin");
    const local = `${P}/.claude/settings.local.json`;
    const i = inv([api, eli5], {
      claudeSkillOverrides: [{ file: "/u/settings.json", layer: "user", map: { "claude-api": "name-only" } }],
      claudeFlags: [
        { file: "/u/settings.json", layer: "user", key: "disableBundledSkills", value: true },
        { file: local, layer: "local", project: P, key: "disableBundledSkills", value: false },
      ],
    });
    const off = { value: "off", setBy: { file: "/u/settings.json", key: "disableBundledSkills" } };
    expect(stateOf(i, api, Q)).toEqual(off);
    expect(stateOf(i, api, undefined)).toEqual(off);
    // P's local settings turn them back on there, where the override applies again.
    expect(stateOf(i, api, P).value).toBe("name-only");
    expect(stateOf(i, eli5, Q)).toEqual({ value: "on" });
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

describe("Claude MCP under managed-mcp.json, allowedMcpServers and deniedMcpServers", () => {
  const userServer = (name: string, profile = "claude:a") =>
    ext("mcp", `${name}@${profile}`, { tool: "claude", scope: "account", profile, file: `/u/${profile}.json` });
  const named = (item: Extension, name: string): Extension => ({ ...item, id: `${item.id}:${name}`, name });
  const gh = named(userServer("gh"), "github");
  const ghB = named(userServer("gh", "claude:b"), "github");
  const fs = named(userServer("fs"), "files");
  const remote = named(userServer("remote"), "remote");
  const company = ext("mcp", "company", { tool: "claude", scope: "managed", file: "/m/managed-mcp.json" });
  const items = [gh, ghB, fs, remote, company];
  const targets: StateFacts["mcpTargets"] = {
    [gh.id]: { command: "hash-gh", vars: false },
    [ghB.id]: { command: "hash-gh", vars: false },
    [fs.id]: { command: "hash-fs", vars: false },
    [remote.id]: { url: "https://mcp.example.com/api", vars: false },
    [company.id]: { url: "https://company.example.com/mcp", vars: false },
  };
  const off = (file: string, key: string) => ({ value: "off", setBy: { file, key } });

  it("starts only managed-mcp.json's servers while it is there", () => {
    const i = inv(items, { mcpTargets: targets, claudeManagedMcp: "/m/managed-mcp.json" });
    for (const project of [P, undefined]) {
      expect(stateOf(i, gh, project, "claude:a")).toEqual(off("/m/managed-mcp.json", "managed-mcp.json"));
      expect(stateOf(i, company, project, "claude:a")).toEqual({ value: "on" });
    }
    expect(claudeMcpTaken(i, "github", P, "claude:a")).toBeUndefined();
  });

  it("turns off in every account what a denylist entry matches, by name, command or URL", () => {
    const i = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [
        { file: "/m/managed.json", layer: "managed", denied: [{ serverName: "files" }] },
        { file: "/u/settings.json", layer: "user", denied: [{ serverCommand: "hash-gh" }] },
        {
          file: `${P}/.claude/settings.json`,
          layer: "project",
          project: P,
          denied: [{ serverUrl: "https://*.example.com/*" }],
        },
      ],
    });
    expect(stateOf(i, fs, Q, "claude:a")).toEqual(off("/m/managed.json", "deniedMcpServers"));
    for (const copy of [gh, ghB]) {
      expect(stateOf(i, copy, Q, copy.location.profile)).toEqual(off("/u/settings.json", "deniedMcpServers"));
    }
    // A project's list holds in that project; the denylist reaches managed servers too.
    expect(stateOf(i, remote, P, "claude:a")).toEqual(off(`${P}/.claude/settings.json`, "deniedMcpServers"));
    expect(stateOf(i, remote, Q, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(i, company, P, "claude:a")).toEqual(off(`${P}/.claude/settings.json`, "deniedMcpServers"));
  });

  it("with an allowlist, keeps on only what an entry admits, a stdio server by command once there is one", () => {
    const names = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [
        { file: "/m/managed.json", layer: "managed", allowed: [{ serverName: "github" }, { serverName: "remote" }] },
      ],
    });
    expect(stateOf(names, gh, P, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(names, remote, P, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(names, fs, P, "claude:a")).toEqual(off("/m/managed.json", "allowedMcpServers"));
    // managed-mcp.json's own servers need no entry.
    expect(stateOf(names, company, P, "claude:a")).toEqual({ value: "on" });

    // With a serverCommand entry, a name no longer admits a stdio server; a remote one still by name.
    const commands = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [
        {
          file: "/m/managed.json",
          layer: "managed",
          allowed: [{ serverName: "github" }, { serverCommand: "hash-fs" }],
        },
        { file: "/u/settings.json", layer: "user", allowed: [{ serverName: "remote" }] },
      ],
    });
    expect(stateOf(commands, gh, P, "claude:a")).toEqual(off("/m/managed.json", "allowedMcpServers"));
    expect(stateOf(commands, fs, P, "claude:a")).toEqual({ value: "on" });
    // Lists of every file merge: the user's admits remote.
    expect(stateOf(commands, remote, P, "claude:a")).toEqual({ value: "on" });

    const urls = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [
        {
          file: "/m/managed.json",
          layer: "managed",
          allowed: [{ serverName: "remote" }, { serverUrl: "https://other.example/*" }],
        },
      ],
    });
    expect(stateOf(urls, remote, P, "claude:a")).toEqual(off("/m/managed.json", "allowedMcpServers"));
  });

  it("blocks every server but managed-mcp.json's with an empty allowlist, and keeps the managed lists alone under the lock", () => {
    const empty = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [{ file: `${P}/.claude/settings.local.json`, layer: "local", project: P, allowed: [] }],
    });
    expect(stateOf(empty, gh, P, "claude:a")).toEqual(off(`${P}/.claude/settings.local.json`, "allowedMcpServers"));
    expect(stateOf(empty, gh, Q, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(empty, company, P, "claude:a")).toEqual({ value: "on" });
    // A managed-mcp.json server whose config reads the user's environment is checked like any other.
    const fromEnv = inv(items, {
      mcpTargets: { ...targets, [company.id]: { url: "https://company.example.com/mcp", vars: true } },
      claudeMcpPolicy: [{ file: "/u/settings.json", layer: "user", allowed: [] }],
    });
    expect(stateOf(fromEnv, company, P, "claude:a")).toEqual(off("/u/settings.json", "allowedMcpServers"));

    const locked = inv(items, {
      mcpTargets: targets,
      claudeMcpPolicy: [
        { file: "/m/managed.json", layer: "managed", allowed: [{ serverName: "github" }], managedOnly: true },
        { file: "/u/settings.json", layer: "user", allowed: [{ serverName: "files" }] },
      ],
    });
    expect(stateOf(locked, gh, P, "claude:a")).toEqual({ value: "on" });
    expect(stateOf(locked, fs, P, "claude:a")).toEqual(off("/m/managed.json", "allowedMcpServers"));
  });

  it("lets a copy the lists block hide no other copy", () => {
    const local = {
      ...named(
        ext("mcp", "gh-local", {
          tool: "claude",
          scope: "local",
          profile: "claude:a",
          project: P,
          file: "/u/claude:a.json",
        }),
        "github",
      ),
    };
    const i = inv([...items, local], {
      mcpTargets: { ...targets, [local.id]: { command: "hash-local", vars: false } },
      claudeMcpPolicy: [{ file: "/u/settings.json", layer: "user", denied: [{ serverCommand: "hash-local" }] }],
    });
    expect(stateOf(i, local, P, "claude:a")).toEqual(off("/u/settings.json", "deniedMcpServers"));
    expect(stateOf(i, gh, P, "claude:a")).toEqual({ value: "on" });
    expect(claudeMcpTaken(i, "github", P, "claude:a")?.id).toBe(gh.id);
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

describe("Claude hooks under disableAllHooks", () => {
  const accounts = ["claude:a", "claude:b"];
  const userHook = ext("hook", "Stop", { tool: "claude", scope: "global", file: "/u/settings.json" });
  const projectHook = ext("hook", "SessionStart", {
    tool: "claude",
    scope: "project",
    project: P,
    file: `${P}/.claude/settings.json`,
  });
  const managedHook = ext("hook", "PreToolUse", { tool: "claude", scope: "managed", file: "/m/managed.json" });
  const pluginHook = (plugin: string) =>
    ext("hook", `PostToolUse ${plugin}`, {
      tool: "claude",
      scope: "plugin",
      plugin,
      file: `/p/${plugin}/hooks/hooks.json`,
      accounts,
    });
  const [kit, forced] = [pluginHook("kit@m"), pluginHook("forced@m")];
  const codexHook = ext("hook", "Stop", { tool: "codex", scope: "global", file: "/c/hooks.json" });
  const enabled: StateFacts["claudeEnabledPlugins"] = [
    { file: "/m/managed.json", layer: "managed", map: { "forced@m": true } },
    { file: "/u/settings.json", layer: "user", map: { "kit@m": true } },
  ];
  const all = [userHook, projectHook, managedHook, kit, forced, codexHook];
  const off = (file: string) => ({ value: "off", setBy: { file, key: "disableAllHooks" } });

  it("turns off every hook but the managed ones, and a plugin's that managed settings turn on", () => {
    const i = inv(all, {
      claudeEnabledPlugins: enabled,
      claudeFlags: [{ file: "/u/settings.json", layer: "user", key: "disableAllHooks", value: true }],
    });
    for (const project of [P, Q, undefined]) {
      expect(stateOf(i, userHook, project)).toEqual(off("/u/settings.json"));
      expect(stateOf(i, kit, project)).toEqual(off("/u/settings.json"));
      expect(stateOf(i, managedHook, project)).toEqual({ value: "on" });
      expect(stateOf(i, forced, project).value).toBe("on");
      expect(stateOf(i, codexHook, project)).toEqual({ value: "on" });
    }
    expect(stateOf(i, projectHook, P)).toEqual(off("/u/settings.json"));
  });

  it("turns off the managed hooks too when managed settings set it", () => {
    const i = inv(all, {
      claudeEnabledPlugins: enabled,
      claudeFlags: [{ file: "/m/managed.json", layer: "managed", key: "disableAllHooks", value: true }],
    });
    for (const hook of [userHook, managedHook, kit, forced])
      expect(stateOf(i, hook, P)).toEqual(off("/m/managed.json"));
  });

  it("reads it as Claude Code does: the first layer that sets it wins, a project's in that project only", () => {
    const local = `${P}/.claude/settings.local.json`;
    const i = inv(all, {
      claudeFlags: [
        { file: "/u/settings.json", layer: "user", key: "disableAllHooks", value: true },
        { file: local, layer: "local", project: P, key: "disableAllHooks", value: false },
        { file: `${Q}/.claude/settings.json`, layer: "project", project: Q, key: "disableAllHooks", value: true },
      ],
    });
    // P's local settings turn hooks back on there; elsewhere the user's setting holds.
    expect(stateOf(i, userHook, P)).toEqual({ value: "on" });
    expect(stateOf(i, userHook, Q)).toEqual(off(`${Q}/.claude/settings.json`));
    expect(stateOf(i, userHook, undefined)).toEqual(off("/u/settings.json"));
    // A managed false wins over the user's true.
    const managedOn = inv(all, {
      claudeFlags: [
        { file: "/m/managed.json", layer: "managed", key: "disableAllHooks", value: false },
        { file: "/u/settings.json", layer: "user", key: "disableAllHooks", value: true },
      ],
    });
    expect(stateOf(managedOn, userHook, P)).toEqual({ value: "on" });
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
      // Codex reads a project's .codex folder only once it trusts the project.
      codexTrust: [{ project: P, trusted: true }],
    });
    expect(stateOf(i, exa, P).value).toBe("off");
    expect(stateOf(i, exa, Q).value).toBe("on");
  });

  it("ignores the switch of a project Codex does not trust, or has not recorded, and keeps the user's", () => {
    const i = inv([exa], {
      codexMcpEnabled: [
        { file: "/c", name: "exa", enabled: false },
        { file: `${P}/.codex/config.toml`, project: P, name: "exa", enabled: true },
        { file: `${Q}/.codex/config.toml`, project: Q, name: "exa", enabled: true },
      ],
      codexTrust: [{ project: P, trusted: false }],
    });
    expect(stateOf(i, exa, P)).toEqual({ value: "off", setBy: { file: "/c", key: "mcp_servers.exa.enabled" } });
    expect(stateOf(i, exa, Q).value).toBe("off");
  });

  it("trusts a project whose recorded key is the same path and says trusted", () => {
    const i = inv([], {
      codexTrust: [
        { project: `${P}/`, trusted: true },
        { project: Q, trusted: false },
      ],
    });
    expect(codexTrusted(i, P)).toBe(true);
    expect(codexTrusted(i, Q)).toBe(false);
    expect(codexTrusted(i, "/repos/elsewhere")).toBe(false);
    expect(codexTrusted(i, undefined)).toBe(false);
  });
});

describe("isManagedSetting", () => {
  it("is true for a managed settings file the inventory read, and for no other", () => {
    const i = inv([], {
      claudeSkillOverrides: [
        { file: "/m/managed-settings.json", layer: "managed", map: {} },
        { file: "/u/settings.json", layer: "user", map: {} },
      ],
      claudeEnabledPlugins: [{ file: "/m/managed-settings.d/10-a.json", layer: "managed", map: {} }],
      claudeFlags: [{ file: "/m/managed-settings.d/20-b.json", layer: "managed", key: "disableAllHooks", value: true }],
      claudeMcpPolicy: [{ file: "/m/managed-settings.d/30-c.json", layer: "managed", denied: [] }],
      claudeManagedMcp: "/m/managed-mcp.json",
    });
    expect(isManagedSetting(i, "/m/managed-settings.d/30-c.json")).toBe(true);
    expect(isManagedSetting(i, "/m/managed-mcp.json")).toBe(true);
    expect(isManagedSetting(i, "/m/managed-settings.d/20-b.json")).toBe(true);
    expect(isManagedSetting(i, "/m/managed-settings.json")).toBe(true);
    expect(isManagedSetting(i, "/m/managed-settings.d/10-a.json")).toBe(true);
    expect(isManagedSetting(i, "/u/settings.json")).toBe(false);
    expect(isManagedSetting(i, "/m/other.json")).toBe(false);
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
