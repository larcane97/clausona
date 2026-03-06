import { describe, expect, it } from "vitest";

import { setActiveProfile } from "./registry.js";

describe("registry", () => {
  it("updates the active profile without mutating other profile metadata", () => {
    const next = setActiveProfile(
      {
        primarySource: "/Users/test/.claude",
        activeProfile: "default",
        profiles: {
          default: {
            configDir: "/Users/test/.claude",
            email: "default@example.com",
            isPrimary: true,
          },
          work: {
            configDir: "/Users/test/.claude-work",
            email: "work@example.com",
          },
        },
      },
      "work",
    );

    expect(next.activeProfile).toBe("work");
    expect(next.profiles.default.email).toBe("default@example.com");
    expect(next.profiles.work.configDir).toBe("/Users/test/.claude-work");
  });
});
