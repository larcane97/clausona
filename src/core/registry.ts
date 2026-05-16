import type { Registry, RegistryV1 } from "../types.js";

export function migrateRegistryV1toV2(input: Registry | RegistryV1): Registry {
  if ("version" in input && input.version === 2) {
    return input;
  }
  const v1 = input as RegistryV1;
  const profiles: Registry["profiles"] = {};
  let activeKey = "";
  for (const [oldName, profile] of Object.entries(v1.profiles)) {
    const newKey = `claude:${oldName}`;
    profiles[newKey] = { tool: "claude", ...profile };
    if (oldName === v1.activeProfile) activeKey = newKey;
  }
  // If activeProfile wasn't found in profiles, fall back to first profile or empty
  if (!activeKey) {
    const firstKey = Object.keys(profiles)[0];
    activeKey = firstKey ?? "";
  }
  return {
    version: 2,
    primarySources: { claude: v1.primarySource },
    activeProfiles: activeKey ? { claude: activeKey } : {},
    profiles,
  };
}

export function setActiveProfile(registry: Registry, profileId: string): Registry {
  const profile = registry.profiles[profileId];
  if (!profile) throw new Error(`Profile '${profileId}' not found.`);
  return {
    ...registry,
    activeProfiles: { ...registry.activeProfiles, [profile.tool]: profileId },
    profiles: { ...registry.profiles },
  };
}

export function isV1Registry(input: unknown): input is RegistryV1 {
  return Boolean(input && typeof input === "object" && "primarySource" in input && !("version" in input));
}
