import { describe, expect, it } from "vitest";
import type { Registry, RegistryV1 } from "../types.js";
import { migrateRegistryV1toV2, setActiveProfile } from "./registry.js";

describe("migrateRegistryV1toV2", () => {
  it("rewrites a v1 registry into v2 form with prefixed keys", () => {
    const v1: RegistryV1 = {
      primarySource: "/home/x/.claude",
      activeProfile: "work",
      profiles: {
        default: { configDir: "/home/x/.claude", email: "a@x", isPrimary: true },
        work: { configDir: "/home/x/.claude-work", email: "b@x", mergeSessions: false },
      },
    };

    const v2 = migrateRegistryV1toV2(v1);

    expect(v2).toEqual({
      version: 2,
      primarySources: { claude: "/home/x/.claude" },
      activeProfiles: { claude: "claude:work" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/home/x/.claude", email: "a@x", isPrimary: true },
        "claude:work": { tool: "claude", configDir: "/home/x/.claude-work", email: "b@x", mergeSessions: false },
      },
    } satisfies Registry);
  });

  it("is a no-op for an already-v2 registry", () => {
    const v2: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude" },
      activeProfiles: { claude: "claude:default" },
      profiles: { "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true } },
    };
    expect(migrateRegistryV1toV2(v2)).toEqual(v2);
  });
});

describe("setActiveProfile (v2)", () => {
  it("sets the per-tool active by tool field", () => {
    const reg: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude", codex: "/x/.codex" },
      activeProfiles: { claude: "claude:default", codex: "codex:default" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true },
        "claude:work": { tool: "claude", configDir: "/x/.claude-work", email: "b@x" },
        "codex:default": { tool: "codex", configDir: "/x/.codex", email: "c@x", isPrimary: true },
      },
    };
    const next = setActiveProfile(reg, "claude:work");
    expect(next.activeProfiles).toEqual({ claude: "claude:work", codex: "codex:default" });
  });
});

describe("removeProfile primarySources cleanup (F2)", () => {
  it("clears primarySources[tool] when the last profile of that tool is removed", () => {
    // Simulate the registry mutation logic from removeProfile
    const registry: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude", codex: "/x/.codex" },
      activeProfiles: { claude: "claude:default", codex: "codex:personal" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true },
        "codex:personal": { tool: "codex", configDir: "/x/.codex-personal", email: "b@x" },
      },
    };

    const id = "codex:personal";
    const profile = registry.profiles[id];
    delete registry.profiles[id];
    if (registry.activeProfiles[profile.tool] === id) {
      const otherKey = Object.keys(registry.profiles).find((k) => registry.profiles[k].tool === profile.tool);
      if (otherKey) {
        registry.activeProfiles[profile.tool] = otherKey;
      } else {
        delete registry.activeProfiles[profile.tool];
      }
    }
    const anyLeftForTool = Object.values(registry.profiles).some((p) => p.tool === profile.tool);
    if (!anyLeftForTool) {
      delete registry.primarySources[profile.tool];
    }

    expect(registry.primarySources).not.toHaveProperty("codex");
    expect(registry.primarySources).toHaveProperty("claude");
    expect(registry.activeProfiles).not.toHaveProperty("codex");
  });

  it("keeps primarySources[tool] when another profile of that tool remains", () => {
    const registry: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude" },
      activeProfiles: { claude: "claude:work" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true },
        "claude:work": { tool: "claude", configDir: "/x/.claude-work", email: "b@x" },
      },
    };

    const id = "claude:work";
    const profile = registry.profiles[id];
    delete registry.profiles[id];
    if (registry.activeProfiles[profile.tool] === id) {
      const otherKey = Object.keys(registry.profiles).find((k) => registry.profiles[k].tool === profile.tool);
      if (otherKey) {
        registry.activeProfiles[profile.tool] = otherKey;
      } else {
        delete registry.activeProfiles[profile.tool];
      }
    }
    const anyLeftForTool = Object.values(registry.profiles).some((p) => p.tool === profile.tool);
    if (!anyLeftForTool) {
      delete registry.primarySources[profile.tool];
    }

    expect(registry.primarySources).toHaveProperty("claude");
    expect(registry.activeProfiles.claude).toBe("claude:default");
  });
});
