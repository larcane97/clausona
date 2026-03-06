import type { Registry } from "../types.js";

export function setActiveProfile(registry: Registry, activeProfile: string): Registry {
  return {
    ...registry,
    activeProfile,
    profiles: { ...registry.profiles },
  };
}
