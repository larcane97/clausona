import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredAccount, Profile, Registry, ToolName } from "../types.js";
import {
  defaultProfileName,
  foldProfileName,
  initProfileNames,
  parseProfileRef,
  profileId,
  validateProfileName,
} from "./profile-ref.js";

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

  /**
   * A key is letters, digits and dashes, so it passes the allowlist above. Without this it
   * becomes a profile id in profiles.json, a directory name under the home directory, and
   * a line of stdout. The check lives here rather than in the CLI so that the TUI, init
   * and every service entry point inherit it.
   */
  describe("a name that is really an API key", () => {
    const PROBE = "sk-ant-api03-FAKE-0123456789abcdef";

    it("refuses the key prefixes, whatever their case", () => {
      for (const name of [PROBE, "sk-ant-api02-FAKE", "sk-ant-admin-FAKE", "sk-proj-FAKE", "SK-ANT-FAKE", "sk-"]) {
        expect(validateProfileName(name), name).toMatchObject({ ok: false });
      }
    });

    it("refuses a name too long to be one", () => {
      expect(validateProfileName("a".repeat(65))).toMatchObject({ ok: false });
      expect(validateProfileName("a".repeat(64))).toEqual({ ok: true });
    });

    it("never repeats the key back", () => {
      const result = validateProfileName(PROBE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(PROBE);
        expect(result.error).not.toContain("0123456789abcdef");
        // And says how a key is actually supplied, or the next try is the same.
        expect(result.error).toContain("--key-from env:NAME");
      }
    });

    it("leaves ordinary names alone, including ones that merely start with s or k", () => {
      for (const name of ["sk", "skywalker", "s-k", "keys", "sk_ant", "work"]) {
        expect(validateProfileName(name), name).toEqual({ ok: true });
      }
    });

    it("refuses one where a profile ref is expected, without echoing it", () => {
      expect(() => parseProfileRef(PROBE, REG)).toThrow(/looks like an API key/);
      try {
        parseProfileRef(PROBE, REG);
      } catch (error) {
        expect((error as Error).message).not.toContain(PROBE);
      }
    });

    // `claude:<key>` starts with 'claude:', and for a shorter key it stays under the
    // ceiling too - so the ref as a whole looks fine while the name part does not.
    it("refuses one behind a tool prefix, whatever its length", () => {
      for (const key of ["sk-or-v1-FAKE-0123", PROBE, `sk-${"a".repeat(80)}`]) {
        for (const ref of [`claude:${key}`, `codex:${key}`, `nosuch:${key}`]) {
          expect(() => parseProfileRef(ref, REG), ref).toThrow(/looks like an API key/);
          try {
            parseProfileRef(ref, REG);
          } catch (error) {
            expect((error as Error).message, ref).not.toContain(key);
          }
        }
      }
    });

    // The ceiling is a creation-time rule. A profile registered before it - or by hand -
    // still has to resolve, or it could never be removed.
    it("still resolves a registered name the ceiling would refuse", () => {
      const long = "a".repeat(80);
      const registry: Registry = {
        ...REG,
        profiles: { ...REG.profiles, [`claude:${long}`]: REG.profiles["claude:default"] },
      };

      expect(parseProfileRef(`claude:${long}`, registry).name).toBe(long);
    });
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
      // Nothing to fit in either of these - one is already spelled legally and the other
      // cannot be shortened - so the fallback is what keeps `init` working.
      [".claude-sk-foo", "profile"],
      [`.claude-${"a".repeat(70)}`, "profile"],
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

describe("initProfileNames", () => {
  const home = path.join(path.parse(process.cwd()).root, "home", "u");
  const account = (tool: ToolName, dirName: string, isPrimary = false): DiscoveredAccount => ({
    tool,
    configDir: path.join(home, dirName),
    jsonPath: "",
    email: `${dirName}@example.com`,
    keychainService: "",
    isPrimary,
  });
  const registry = (profiles: Record<string, Pick<Profile, "tool" | "configDir"> & Partial<Profile>>): Registry => ({
    version: 2,
    primarySources: {},
    activeProfiles: {},
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([id, p]) => [
        id,
        { email: "x@example.com", ...p, configDir: path.join(home, p.configDir) },
      ]),
    ),
  });
  const byDir = (names: Record<string, string>) =>
    Object.fromEntries(Object.entries(names).map(([dir, name]) => [path.basename(dir), name]));

  it("names each primary 'default' and every other account after its directory", () => {
    const found = [
      account("claude", ".claude", true),
      account("claude", ".claude-work"),
      account("codex", ".codex", true),
      account("codex", ".codex-work"),
    ];

    expect(byDir(initProfileNames(found, null))).toEqual({
      ".claude": "default",
      ".claude-work": "work",
      ".codex": "default",
      ".codex-work": "work",
    });
  });

  it("keeps the name an account is already registered under, even one from before the name rule", () => {
    const found = [account("claude", ".claude", true), account("codex", ".codex-work")];
    const existing = registry({
      "claude:main": { tool: "claude", configDir: ".claude", isPrimary: true },
      "codex:.codex-work": { tool: "codex", configDir: ".codex-work" },
    });

    expect(byDir(initProfileNames(found, existing))).toEqual({ ".claude": "main", ".codex-work": ".codex-work" });
  });

  it("does not take a name from the same directory registered under the other tool", () => {
    const found = [account("codex", ".claude-work")];
    const existing = registry({ "claude:office": { tool: "claude", configDir: ".claude-work" } });

    expect(byDir(initProfileNames(found, existing))).toEqual({ ".claude-work": "work" });
  });

  it("keeps a name the caller chose over the registered one", () => {
    const found = [account("claude", ".claude-work")];
    const existing = registry({ "claude:work": { tool: "claude", configDir: ".claude-work" } });

    expect(byDir(initProfileNames(found, existing, { [found[0].configDir]: "office" }))).toEqual({
      ".claude-work": "office",
    });
  });

  it("numbers a derived name another account already has, and lets the directory that spells it keep it", () => {
    // Sorted as discovery sorts them, the fitted one comes first; it still gets the suffix.
    const found = [
      account("claude", ".claude-my work"),
      account("claude", ".claude-my-work"),
      account("claude", ".claude-my_work"),
    ];

    expect(byDir(initProfileNames(found, null))).toEqual({
      ".claude-my work": "my-work-2",
      ".claude-my-work": "my-work",
      ".claude-my_work": "my_work",
    });
  });

  it("numbers a derived name that differs from a taken one only by case", () => {
    const found = [account("claude", ".claude-Work"), account("claude", ".claude-work")];

    expect(byDir(initProfileNames(found, null))).toEqual({ ".claude-Work": "Work", ".claude-work": "work-2" });
  });

  it("does not derive the name of a registered profile at another directory", () => {
    // Init drops that profile, but its backup directory - and the name it is under - remain.
    const found = [
      account("claude", ".claude", true),
      account("claude", ".claude-work"),
      account("claude", ".claude-glm"),
    ];
    const existing = registry({
      "claude:default": { tool: "claude", configDir: ".claude", isPrimary: true },
      "claude:work": { tool: "claude", configDir: "imported/work" },
      "claude:GLM": { tool: "claude", configDir: ".claude-api-glm", kind: "api" },
    });

    expect(byDir(initProfileNames(found, existing))).toEqual({
      ".claude": "default",
      ".claude-work": "work-2",
      ".claude-glm": "glm-2",
    });
  });

  it("gives the primary 'default' even when a profile elsewhere is registered under it", () => {
    // The primary has no backup directory, so there is nothing of that profile's to inherit.
    const found = [account("claude", ".claude", true)];
    const existing = registry({ "claude:default": { tool: "claude", configDir: "old-home/.claude", isPrimary: true } });

    expect(byDir(initProfileNames(found, existing))).toEqual({ ".claude": "default" });
  });

  it("numbers the primary's 'default' when an API profile holds it", () => {
    // Init keeps API profiles as they are, so their names are not free to take.
    const found = [account("claude", ".claude", true)];
    const existing = registry({ "claude:default": { tool: "claude", configDir: ".claude-default", kind: "api" } });

    expect(byDir(initProfileNames(found, existing))).toEqual({ ".claude": "default-2" });
  });

  it("numbers a derived name whose backup directory already holds something", () => {
    // The primary has no backup directory, so an occupied `default` does not move it.
    const found = [
      account("claude", ".claude", true),
      account("claude", ".claude-work"),
      account("codex", ".codex-work"),
    ];
    const occupied = new Set(["claude:default", "claude:work"]);

    expect(byDir(initProfileNames(found, null, {}, occupied))).toEqual({
      ".claude": "default",
      ".claude-work": "work-2",
      ".codex-work": "work",
    });
  });

  it("only derives names the rule accepts", () => {
    const found = [
      account("claude", ".claude-a b"),
      account("claude", ".claude-a:b"),
      account("claude", ".claude-日本"),
    ];
    for (const name of Object.values(initProfileNames(found, null))) {
      expect(validateProfileName(name), name).toEqual({ ok: true });
    }
  });
});

describe("foldProfileName", () => {
  it("folds case and the characters APFS treats as the same letter", () => {
    expect(foldProfileName("Work")).toBe(foldProfileName("work"));
    // U+017F LATIN SMALL LETTER LONG S and U+212A KELVIN SIGN
    expect(foldProfileName("\u017Fwork")).toBe(foldProfileName("swork"));
    expect(foldProfileName("\u212Aey")).toBe(foldProfileName("key"));
    expect(foldProfileName("work")).not.toBe(foldProfileName("worker"));
  });
});

describe("addProfile name validation (F3)", () => {
  // service.ts takes its ~/.clausona from HOME at import time. It is imported under a temp
  // HOME with every spawn refused, so a regression in the validator reaches neither the
  // real registry nor a real `claude auth login`.
  const temps: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("../core/process.js");
    vi.resetModules();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function isolatedAddProfile() {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-profile-ref-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    vi.doMock("../core/process.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../core/process.js")>();
      const refuse = (command: string): never => {
        throw new Error(`test attempted to spawn '${command}'`);
      };
      return { ...actual, spawnCommand: refuse, spawnCommandSync: refuse };
    });
    return (await import("./service.js")).addProfile;
  }

  it("rejects a name containing ':'", async () => {
    const addProfile = await isolatedAddProfile();
    await expect(addProfile({ tool: "claude", name: "foo:bar" })).rejects.toThrow(/invalid profile name/i);
  });

  it("rejects an empty name", async () => {
    const addProfile = await isolatedAddProfile();
    await expect(addProfile({ tool: "claude", name: "" })).rejects.toThrow(/invalid profile name.*non-empty/i);
  });
});
