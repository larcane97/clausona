import { describe, expect, it } from "vitest";
import type { Registry } from "../types.js";
import { parseProfileRef, profileId } from "./profile-ref.js";
import { addProfile } from "./service.js";

const REG: Registry = {
  version: 2,
  primarySources: { claude: "/h/.claude", codex: "/h/.codex" },
  activeProfiles: { claude: "claude:default", codex: "codex:default" },
  profiles: {
    "claude:default": { tool: "claude", configDir: "/h/.claude", email: "a", isPrimary: true },
    "claude:work": { tool: "claude", configDir: "/h/.claude-work", email: "b" },
    "codex:default": { tool: "codex", configDir: "/h/.codex", email: "c", isPrimary: true },
    "codex:personal": { tool: "codex", configDir: "/h/.codex-personal", email: "d" },
  },
};

describe("parseProfileRef", () => {
  it("accepts explicit prefix", () => {
    expect(parseProfileRef("claude:work", REG)).toEqual({ tool: "claude", name: "work", id: "claude:work" });
    expect(parseProfileRef("codex:personal", REG)).toEqual({ tool: "codex", name: "personal", id: "codex:personal" });
  });

  it("infers tool when bare name is unique", () => {
    expect(parseProfileRef("work", REG)).toEqual({ tool: "claude", name: "work", id: "claude:work" });
    expect(parseProfileRef("personal", REG)).toEqual({ tool: "codex", name: "personal", id: "codex:personal" });
  });

  it("errors on ambiguous bare name", () => {
    const reg2: Registry = {
      ...REG,
      profiles: { ...REG.profiles, "codex:work": { tool: "codex", configDir: "/h/.codex-work", email: "e" } },
    };
    expect(() => parseProfileRef("work", reg2)).toThrow(/exists in both claude and codex/i);
  });

  it("errors when profile is not registered", () => {
    expect(() => parseProfileRef("missing", REG)).toThrow(/not found/i);
    expect(() => parseProfileRef("claude:missing", REG)).toThrow(/not found/i);
  });

  it("rejects malformed prefix forms", () => {
    expect(() => parseProfileRef("foo:bar", REG)).toThrow(/unknown tool/i);
  });
});

describe("profileId", () => {
  it("composes tool:name", () => {
    expect(profileId("codex", "work")).toBe("codex:work");
  });
});

describe("addProfile name validation (F3)", () => {
  it("rejects a name containing ':'", async () => {
    await expect(addProfile({ tool: "claude", name: "foo:bar" })).rejects.toThrow(/invalid profile name/i);
  });

  it("rejects an empty name", async () => {
    await expect(addProfile({ tool: "claude", name: "" })).rejects.toThrow(/invalid profile name.*non-empty/i);
  });
});
