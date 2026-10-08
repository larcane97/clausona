import { describe, expect, it } from "vitest";

import type { ToolName } from "../types.js";
import { expandPatterns, globToRegExp, type Member, matchesMember } from "./route-patterns.js";

function member(id: string, extra: Partial<Member> = {}): Member {
  const [tool, name] = id.split(":") as [ToolName, string];
  return {
    id,
    tool,
    name,
    email: `${name.toLowerCase()}@example.com`,
    kind: "subscription",
    sharesSessions: true,
    configDir: `/home/u/.${tool}-${name}`,
    ...extra,
  };
}

const work = member("claude:work", { email: "work@corp.example.com" });
const teamA = member("claude:team-a", { email: "a@corp.example.com" });
const teamB = member("claude:team-b");
const personal = member("claude:Personal");
const glm = member("claude:glm", { kind: "api", email: "" });
const all = [work, teamA, teamB, personal, glm];
const ids = (list: Member[]) => list.map((m) => m.id);

describe("globToRegExp", () => {
  it("anchors and turns * and ? into wildcards", () => {
    expect(globToRegExp("team-*").test("team-a")).toBe(true);
    expect(globToRegExp("team-*").test("my-team-a")).toBe(false);
    expect(globToRegExp("w?rk").test("work")).toBe(true);
  });

  it("treats regex characters as plain text", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a+b").test("a+b")).toBe(true);
  });
});

describe("matchesMember", () => {
  it("matches every subscription profile with *", () => {
    expect(ids(all.filter((m) => matchesMember("*", m)))).toEqual([
      "claude:work",
      "claude:team-a",
      "claude:team-b",
      "claude:Personal",
    ]);
  });

  it("matches names without regard to case", () => {
    expect(matchesMember("personal", personal)).toBe(true);
    expect(matchesMember("TEAM-*", teamA)).toBe(true);
  });

  it("reads a tool prefix", () => {
    expect(matchesMember("claude:team-?", teamA)).toBe(true);
  });

  it("matches the email when the pattern has an @", () => {
    expect(ids(all.filter((m) => matchesMember("*@corp.example.com", m)))).toEqual(["claude:work", "claude:team-a"]);
  });

  it("matches an API profile only by its exact name", () => {
    expect(matchesMember("glm", glm)).toBe(true);
    expect(matchesMember("claude:glm", glm)).toBe(true);
    expect(matchesMember("g*", glm)).toBe(false);
    expect(matchesMember("*", glm)).toBe(false);
    expect(matchesMember("*@*", glm)).toBe(false);
  });
});

describe("expandPatterns", () => {
  it("lists in pattern order, by id within a pattern, each member once", () => {
    const out = expandPatterns(["team-*", "*"], all);
    expect(out.members.map((entry) => [entry.member.id, entry.pattern])).toEqual([
      ["claude:team-a", "team-*"],
      ["claude:team-b", "team-*"],
      ["claude:Personal", "*"],
      ["claude:work", "*"],
    ]);
  });

  it("reports exact names nobody has, and patterns that match nobody", () => {
    const out = expandPatterns(["gone", "x-*", "*@nowhere.example.com"], all);
    expect(out.members).toEqual([]);
    expect(out.unknownNames).toEqual(["gone"]);
    expect(out.emptyPatterns).toEqual(["x-*", "*@nowhere.example.com"]);
  });
});
