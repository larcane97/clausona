import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Registry } from "../types.js";
import { defaultProfileName, parseProfileRef, profileId, validateProfileName } from "./profile-ref.js";
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

describe("validateProfileName", () => {
  it("accepts names built from letters, digits, '.', '_' and '-'", () => {
    for (const name of ["work", "Work2", "glm-5.3", "a_b", "7"]) {
      expect(validateProfileName(name), name).toEqual({ ok: true });
    }
  });

  it("rejects dot segments, separators, ':', whitespace and a leading punctuation mark", () => {
    for (const name of ["", ".", "..", ".hidden", "a/b", "a\\b", "../x", "a:b", "a b", " a", "-a", "_a", "a\n"]) {
      expect(validateProfileName(name), JSON.stringify(name)).toMatchObject({ ok: false });
    }
  });

  it("rejects a missing name from an untyped caller", () => {
    expect(validateProfileName(undefined as unknown as string)).toMatchObject({ ok: false });
  });

  it("states the rule so the name can be corrected", () => {
    const result = validateProfileName("..");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/start with a letter or digit.*letters, digits, '\.', '_' and '-'/);
  });
});

describe("defaultProfileName", () => {
  const home = path.join(path.parse(process.cwd()).root, "home", "u");

  it("strips the tool prefix from either tool's directory", () => {
    // The codex case used to keep its prefix, and `.codex-work` breaks the name rule.
    expect(defaultProfileName(path.join(home, ".claude-work"))).toBe("work");
    expect(defaultProfileName(path.join(home, ".codex-work"))).toBe("work");
    expect(validateProfileName(defaultProfileName(path.join(home, ".codex-work")))).toEqual({ ok: true });
  });

  it("falls back to 'profile' for a tool's bare default directory", () => {
    expect(defaultProfileName(path.join(home, ".claude"))).toBe("profile");
    expect(defaultProfileName(path.join(home, ".codex"))).toBe("profile");
  });

  it("uses the directory name as-is for an imported directory without a prefix", () => {
    expect(defaultProfileName(path.join(home, "backups", "old-claude"))).toBe("old-claude");
  });

  // A derived name is clausona's choice, not the user's, so it has to follow the rule:
  // `init --auto` has nobody to ask for another one.
  it("turns a directory name the rule rejects into one it accepts", () => {
    const cases: Array<[string, string]> = [
      [".claude-my work", "my-work"],
      [".claude-a  b\tc", "a-b-c"],
      [".claude-.x", "x"],
      [".codex--x", "x"],
      [".claude-work:2", "work-2"],
      [".claude-work!", "work"],
      [".claude-日本", "profile"],
      [".claude-...", "profile"],
    ];
    for (const [dir, expected] of cases) {
      const name = defaultProfileName(path.join(home, dir));
      expect(name, dir).toBe(expected);
      expect(validateProfileName(name), dir).toEqual({ ok: true });
    }
  });

  it("leaves a name the rule already accepts exactly as it is", () => {
    for (const name of ["work", "glm-5.3", "a_b", "work-", "x."]) {
      expect(defaultProfileName(path.join(home, `.claude-${name}`))).toBe(name);
    }
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
