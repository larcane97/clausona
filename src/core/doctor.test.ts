import { describe, expect, it } from "vitest";
import { evaluateSymlinkHealth } from "./doctor.js";

describe("evaluateSymlinkHealth", () => {
  it("reports a local override where primary has the item", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      items: [{ name: "jobs", isSharedLink: false, pointsToPrimary: false, targetExists: true, existsInPrimary: true }],
    });
    expect(issues).toEqual([{ kind: "local_override", message: "jobs replaced an expected shared link" }]);
  });

  it("reports a directory the primary has but the profile is missing", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      items: [],
      missingSharedDirs: ["jobs", "teams"],
    });
    expect(issues.map((i) => i.kind)).toEqual(["missing_shared_link", "missing_shared_link"]);
    expect(issues[0].message).toContain("jobs/");
    expect(issues[0].message).toContain("clausona repair");
  });

  it("stays silent for the primary profile even when directories are reported missing", () => {
    expect(evaluateSymlinkHealth({ isPrimary: true, items: [], missingSharedDirs: ["jobs"] })).toEqual([]);
  });

  it("treats an absent missingSharedDirs as no missing directories", () => {
    expect(evaluateSymlinkHealth({ isPrimary: false, items: [] })).toEqual([]);
  });
});
