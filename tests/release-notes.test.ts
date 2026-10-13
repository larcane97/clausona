import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// release.yml opens each GitHub release with docs/releases/<tag>.md, so the PR that bumps the
// version has to bring that file. This fails until it does.
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("release notes", () => {
  it("exist for the version in package.json", () => {
    const notes = path.join("docs", "releases", `v${version}.md`);
    expect(existsSync(notes), `${notes} is missing; see docs/releases/README.md`).toBe(true);
    expect(readFileSync(notes, "utf8").trim()).not.toBe("");
  });
});
