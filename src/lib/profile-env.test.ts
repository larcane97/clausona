import { describe, expect, it } from "vitest";

import type { Profile } from "../types.js";
import { buildProfileEnv, displayName, RESERVED_ENV_KEYS } from "./profile-env.js";

const identityRealpath = async (p: string) => p;
const fakeSecret = async () => "sk-test";

function apiProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    tool: "claude",
    kind: "api",
    configDir: "/home/u/.claude-glm",
    email: "",
    label: "gpu-box",
    api: { baseUrl: "http://gpu-box:30000", authScheme: "bearer", secret: { source: "keychain" } },
    ...overrides,
  };
}

describe("displayName", () => {
  it("prefers the label when present", () => {
    expect(displayName({ email: "", label: "gpu-box" })).toBe("gpu-box");
  });

  it("falls back to the email", () => {
    expect(displayName({ email: "you@example.com" })).toBe("you@example.com");
  });
});

describe("buildProfileEnv", () => {
  const deps = { resolveSecret: fakeSecret, realpath: identityRealpath };

  it("emits only CLAUDE_CONFIG_DIR for a subscription profile", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude-work", email: "you@example.com" };
    const { env } = await buildProfileEnv("claude:work", profile, deps);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-work" });
  });

  it("emits nothing for a primary profile", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude", email: "a@b.c", isPrimary: true };
    const { env } = await buildProfileEnv("claude:main", profile, deps);
    expect(env).toEqual({});
  });

  it("uses ANTHROPIC_AUTH_TOKEN for the bearer scheme", async () => {
    const { env } = await buildProfileEnv("claude:glm", apiProfile(), deps);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gpu-box:30000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses ANTHROPIC_API_KEY for the api-key scheme", async () => {
    const profile = apiProfile({
      api: { baseUrl: "https://api.anthropic.com", authScheme: "api-key", secret: { source: "keychain" } },
    });
    const { env } = await buildProfileEnv("claude:api", profile, deps);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("lets the env map override the API block but never CLAUDE_CONFIG_DIR", async () => {
    const profile = apiProfile({
      env: { ANTHROPIC_BASE_URL: "http://override:8080", ANTHROPIC_MODEL: "glm-5.3", CLAUDE_CONFIG_DIR: "/evil" },
    });
    const { env, warnings } = await buildProfileEnv("claude:glm", profile, deps);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://override:8080");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-glm");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("claude:glm");
    expect(warnings[0]).toContain("CLAUDE_CONFIG_DIR");
  });

  it("omits the config variable when a non-primary profile points at the tool default", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude", email: "you@example.com" };
    const { env, warnings } = await buildProfileEnv("claude:default", profile, {
      ...deps,
      homedir: () => "/home/u",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("warns and omits the credential when the secret cannot be resolved", async () => {
    const failing = async () => {
      throw new Error("no stored secret");
    };
    const { env, warnings } = await buildProfileEnv("claude:glm", apiProfile(), {
      resolveSecret: failing,
      realpath: identityRealpath,
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gpu-box:30000");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no stored secret/);
  });

  it("reserves the tool config variables", () => {
    expect(RESERVED_ENV_KEYS.has("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(RESERVED_ENV_KEYS.has("CODEX_HOME")).toBe(true);
  });
});
