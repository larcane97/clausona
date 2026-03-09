import { describe, expect, it } from "vitest";

import { evaluateSymlinkHealth } from "./doctor.js";

describe("evaluateSymlinkHealth", () => {
  it("reports broken links and local overrides for non-primary profiles", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      items: [
        { name: "cache", isSymlink: true, pointsToPrimary: true, targetExists: false, existsInPrimary: true },
        { name: "statsig", isSymlink: false, pointsToPrimary: false, targetExists: true, existsInPrimary: true },
      ],
    });

    expect(issues).toHaveLength(2);
    expect(issues[0]?.kind).toBe("broken_symlink");
    expect(issues[1]?.kind).toBe("local_override");
  });
});
