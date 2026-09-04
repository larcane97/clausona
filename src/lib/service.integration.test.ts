import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectSharedLink } from "../core/shared-links.js";
import { claudeAdapter } from "../tools/claude.js";
import { setupSharedLinks } from "./service.js";

describe("setupSharedLinks (real fs integration)", () => {
  it("symlinks non-skipped items from primary into profile dir (claude)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "clausona-link-claude-"));
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    const backup = path.join(tmp, "backup");
    mkdirSync(primary, { recursive: true });
    mkdirSync(profile, { recursive: true });

    // Seed primary with mix of items
    writeFileSync(path.join(primary, "settings.json"), "{}");
    writeFileSync(path.join(primary, ".claude.json"), "{}"); // in skip set
    mkdirSync(path.join(primary, "mcp-servers"));
    mkdirSync(path.join(primary, "projects")); // skipped when not merging sessions

    await setupSharedLinks(claudeAdapter, profile, primary, false, backup);

    // settings.json → shared link to primary (hard link fallback on Windows)
    expect(
      await inspectSharedLink(path.join(profile, "settings.json"), path.join(primary, "settings.json")),
    ).toMatchObject({ isSharedLink: true, pointsToSource: true });
    // mcp-servers → directory symlink/junction
    const mcpStat = lstatSync(path.join(profile, "mcp-servers"));
    expect(mcpStat.isSymbolicLink()).toBe(true);
    // .claude.json → NOT in profile (skipped)
    expect(existsSync(path.join(profile, ".claude.json"))).toBe(false);
    // projects → NOT in profile (separate sessions)
    expect(existsSync(path.join(profile, "projects"))).toBe(false);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT perform full-dir copy — regression for T21", async () => {
    // If setupSharedLinks ever re-introduces the full cp, the profile dir
    // would contain real files (not symlinks) for SKIP items.
    // Specifically: a large file in the primary's SKIP set should NOT
    // appear in the profile dir at all.
    const tmp = mkdtempSync(path.join(tmpdir(), "clausona-no-cp-"));
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(primary, { recursive: true });
    mkdirSync(profile, { recursive: true });

    // Place a marker file ONLY in the SKIP set
    writeFileSync(path.join(primary, ".claude.json"), "x".repeat(1024));

    await setupSharedLinks(claudeAdapter, profile, primary, false, undefined);

    // .claude.json must NOT have been copied to profile dir
    expect(existsSync(path.join(profile, ".claude.json"))).toBe(false);

    rmSync(tmp, { recursive: true, force: true });
  });

  it("backs up existing local data before replacing with symlink", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "clausona-backup-"));
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    const backup = path.join(tmp, "backup");
    mkdirSync(primary, { recursive: true });
    mkdirSync(profile, { recursive: true });
    mkdirSync(backup, { recursive: true });

    writeFileSync(path.join(primary, "settings.json"), "{}");
    writeFileSync(path.join(profile, "settings.json"), '{"localData": "preserve me"}');

    await setupSharedLinks(claudeAdapter, profile, primary, false, backup);

    // Original local file backed up
    const backupContent = readFileSync(path.join(backup, "settings.json"), "utf8");
    expect(backupContent).toContain("localData");
    // Now a shared link to primary
    expect(
      await inspectSharedLink(path.join(profile, "settings.json"), path.join(primary, "settings.json")),
    ).toMatchObject({ isSharedLink: true, pointsToSource: true });

    rmSync(tmp, { recursive: true, force: true });
  });
});
