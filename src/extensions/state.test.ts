import { describe, expect, it } from "vitest";

import { type Extension, emptyFacts, type Inventory, type StateFacts } from "./model.js";
import { pluginState, relevantIn, stateOf } from "./state.js";

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

describe("Claude skills", () => {
  const eli5 = skill("eli5", "global");
  const overrides: StateFacts["claudeSkillOverrides"] = [
    { file: "/u/settings.json", layer: "user", map: { eli5: "off" } },
    { file: `${P}/.claude/settings.local.json`, layer: "local", project: P, map: { eli5: "name-only" } },
  ];

  it("takes local over project over user, and user alone with no project", () => {
    const i = inv([eli5], { claudeSkillOverrides: overrides });
    expect(stateOf(i, eli5, P)).toEqual({
      value: "name-only",
      setBy: { file: `${P}/.claude/settings.local.json`, key: "skillOverrides.eli5" },
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
  const user = {
    id: "m1",
    kind: "mcp",
    name: "stitch",
    location: { tool: "claude", scope: "account", profile: "claude:a", file: "/a.json" },
  } as Extension;
  const shared = {
    id: "m2",
    kind: "mcp",
    name: "docs",
    location: { tool: "claude", scope: "project", project: P, file: `${P}/.mcp.json` },
  } as Extension;

  it("is off for the account and project that disabled it, on elsewhere and with no project", () => {
    const i = inv([user], {
      claudeMcpDisabled: [{ file: "/a.json", profile: "claude:a", project: P, names: ["stitch"] }],
    });
    expect(stateOf(i, user, P).value).toBe("off");
    expect(stateOf(i, user, Q).value).toBe("on");
    expect(stateOf(i, user).value).toBe("on");
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
});

describe("Codex", () => {
  const repoSkill = {
    id: "c1",
    kind: "skill",
    name: "lint",
    location: { tool: "codex", scope: "project", project: P, file: `${P}/.agents/skills/lint` },
  } as Extension;
  const exa = {
    id: "c2",
    kind: "mcp",
    name: "exa",
    location: { tool: "codex", scope: "global", file: "/c/config.toml" },
  } as Extension;

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
