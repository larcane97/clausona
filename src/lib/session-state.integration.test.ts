import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../tools/claude.js";
import { mergeSessionState, setupSharedLinks } from "./service.js";

const temps: string[] = [];
function scratch(label: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `clausona-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedJob(configDir: string, id: string, sessionId: string) {
  const jobDir = path.join(configDir, "jobs", id);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(
    path.join(jobDir, "state.json"),
    JSON.stringify({
      state: "stopped",
      sessionId,
      resumeSessionId: sessionId,
      daemonShort: id,
      linkScanPath: path.join(configDir, "projects", "-repo", `${sessionId}.jsonl`),
    }),
  );
  writeFileSync(path.join(jobDir, "timeline.jsonl"), '{"state":"stopped"}\n');
  return jobDir;
}

function readState(configDir: string, id: string) {
  return JSON.parse(readFileSync(path.join(configDir, "jobs", id, "state.json"), "utf8"));
}

describe("session-scoped skip set", () => {
  it("keeps jobs/ and teams/ private when sessions are separated", () => {
    const skip = claudeAdapter.sharedSkipSet(false);
    expect(skip.has("projects")).toBe(true);
    expect(skip.has("jobs")).toBe(true);
    expect(skip.has("teams")).toBe(true);
  });

  it("shares jobs/ and teams/ when sessions are merged", () => {
    const skip = claudeAdapter.sharedSkipSet(true);
    expect(skip.has("projects")).toBe(false);
    expect(skip.has("jobs")).toBe(false);
    expect(skip.has("teams")).toBe(false);
  });

  it("links jobs/ and teams/ only for a session-merging profile", async () => {
    const tmp = scratch("skip");
    const primary = path.join(tmp, "primary");
    const merged = path.join(tmp, "merged");
    const separated = path.join(tmp, "separated");
    for (const dir of [primary, merged, separated]) mkdirSync(dir, { recursive: true });
    for (const name of ["projects", "jobs", "teams"]) mkdirSync(path.join(primary, name));

    await setupSharedLinks(claudeAdapter, merged, primary, true, path.join(tmp, "b1"));
    await setupSharedLinks(claudeAdapter, separated, primary, false, path.join(tmp, "b2"));

    for (const name of ["projects", "jobs", "teams"]) {
      expect(lstatSync(path.join(merged, name)).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(separated, name))).toBe(false);
    }
  });
});

describe("mergeSessionState", () => {
  it("moves background-session and team records into the primary", async () => {
    const tmp = scratch("merge");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    mkdirSync(path.join(primary, "teams"), { recursive: true });
    mkdirSync(path.join(profile, "teams", "session-abcd1234"), { recursive: true });
    writeFileSync(path.join(profile, "teams", "session-abcd1234", "config.json"), "{}");
    seedJob(profile, "deadbeef", "deadbeef-1111-2222-3333-444455556666");

    await mergeSessionState(profile, primary);

    expect(existsSync(path.join(primary, "jobs", "deadbeef", "state.json"))).toBe(true);
    expect(existsSync(path.join(primary, "jobs", "deadbeef", "timeline.jsonl"))).toBe(true);
    expect(existsSync(path.join(primary, "teams", "session-abcd1234", "config.json"))).toBe(true);
  });

  it("rebases a merged job's transcript path onto the primary", async () => {
    const tmp = scratch("rebase");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    const sessionId = "deadbeef-1111-2222-3333-444455556666";
    seedJob(profile, "deadbeef", sessionId);

    await mergeSessionState(profile, primary);

    expect(readState(primary, "deadbeef").linkScanPath).toBe(
      path.join(primary, "projects", "-repo", `${sessionId}.jsonl`),
    );
  });

  it("leaves a transcript path that does not belong to the profile untouched", async () => {
    const tmp = scratch("foreign");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    const jobDir = seedJob(profile, "deadbeef", "deadbeef-1111-2222-3333-444455556666");
    const foreign = path.join(tmp, "elsewhere", "transcript.jsonl");
    writeFileSync(path.join(jobDir, "state.json"), JSON.stringify({ linkScanPath: foreign }));

    await mergeSessionState(profile, primary);

    expect(readState(primary, "deadbeef").linkScanPath).toBe(foreign);
  });

  it("keeps the primary's record when both accounts hold the same id", async () => {
    const tmp = scratch("collide");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    seedJob(primary, "deadbeef", "primary-session");
    seedJob(profile, "deadbeef", "profile-session");

    await mergeSessionState(profile, primary);

    expect(readState(primary, "deadbeef").sessionId).toBe("primary-session");
  });

  it("does not copy whole-store files such as jobs/pins.json", async () => {
    const tmp = scratch("pins");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    mkdirSync(path.join(profile, "jobs"), { recursive: true });
    writeFileSync(path.join(primary, "jobs", "pins.json"), "[]");
    writeFileSync(path.join(profile, "jobs", "pins.json"), '["profile"]');

    await mergeSessionState(profile, primary);

    expect(readFileSync(path.join(primary, "jobs", "pins.json"), "utf8")).toBe("[]");
  });

  it("is a no-op once the profile's records are already shared", async () => {
    const tmp = scratch("shared");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    mkdirSync(profile, { recursive: true });
    seedJob(primary, "deadbeef", "primary-session");
    symlinkSync(path.join(primary, "jobs"), path.join(profile, "jobs"));

    await mergeSessionState(profile, primary);

    expect(readState(primary, "deadbeef").sessionId).toBe("primary-session");
    expect(lstatSync(path.join(profile, "jobs")).isSymbolicLink()).toBe(true);
  });

  it("leaves records alone when the primary has no store to merge into", async () => {
    const tmp = scratch("nostore");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(primary, { recursive: true });
    seedJob(profile, "deadbeef", "deadbeef-1111-2222-3333-444455556666");

    await mergeSessionState(profile, primary);

    expect(existsSync(path.join(primary, "jobs"))).toBe(false);
    expect(existsSync(path.join(profile, "jobs", "deadbeef", "state.json"))).toBe(true);
  });
});

describe("repair ordering", () => {
  it("preserves records that setupSharedLinks would otherwise delete", async () => {
    const tmp = scratch("order");
    const primary = path.join(tmp, "primary");
    const profile = path.join(tmp, "profile");
    mkdirSync(path.join(primary, "jobs"), { recursive: true });
    mkdirSync(path.join(primary, "projects"), { recursive: true });
    seedJob(profile, "deadbeef", "deadbeef-1111-2222-3333-444455556666");

    // The order repairProfile uses: fold session state in, then replace with links.
    await mergeSessionState(profile, primary);
    await setupSharedLinks(claudeAdapter, profile, primary, true, path.join(tmp, "backup"));

    expect(lstatSync(path.join(profile, "jobs")).isSymbolicLink()).toBe(true);
    // Reachable through the profile again, because it now lives in the primary.
    expect(existsSync(path.join(profile, "jobs", "deadbeef", "state.json"))).toBe(true);
  });
});
