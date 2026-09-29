import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageStore } from "../types.js";

/**
 * track-usage.ts derives its ~/.clausona paths from homedir() at import time, so HOME is
 * stubbed and the module re-imported, as in src/commands.shell-env.test.ts.
 */

const temps: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A registry of `count` claude profiles, each with its own config dir whose .claude.json
 * holds one session that ended with a cost - what Claude Code leaves behind when it exits.
 */
async function harness(count: number) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-track-usage-"));
  temps.push(home);
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  const profiles: Record<string, { tool: "claude"; configDir: string; email: string }> = {};
  for (let i = 0; i < count; i += 1) {
    const configDir = path.join(home, `.claude-p${i}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({
        projects: {
          [path.join(home, "project")]: {
            lastSessionId: `session-${i}`,
            lastCost: 0.25 + i,
            lastTotalInputTokens: 100 + i,
            lastTotalOutputTokens: 10 + i,
            lastDuration: 1000,
          },
        },
      }),
    );
    profiles[`claude:p${i}`] = { tool: "claude", configDir, email: `p${i}@example.com` };
  }
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { claude: path.join(home, ".claude") },
      activeProfiles: { claude: "claude:p0" },
      profiles,
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  const { seedSeenSessions, trackUsage } = await import("./track-usage.js");

  return {
    profiles,
    seedSeenSessions,
    trackUsage,
    usage: () => JSON.parse(readFileSync(path.join(home, ".clausona", "usage.json"), "utf8")) as UsageStore,
  };
}

describe("usage.json writers", () => {
  /**
   * The shell hook records usage in the background, so two sessions that end together - in
   * two terminals, on two profiles - run `_track-usage` at the same moment, and an `add` can
   * seed a new profile in between. Each of them reads usage.json, changes its own entry and
   * writes the whole file back; without a lock the last write wins, and the others' records
   * are gone.
   */
  it("keeps every writer's change when several run at once", async () => {
    const h = await harness(4);
    const [seeded, ...tracked] = Object.keys(h.profiles) as [string, ...string[]];

    await Promise.all([
      ...tracked.map((id) => h.trackUsage(id)),
      h.seedSeenSessions(seeded, h.profiles[seeded]?.configDir as string),
    ]);

    const usage = h.usage();
    for (const id of tracked) {
      expect(usage[id]?.records, id).toHaveLength(1);
    }
    // Seeded, not recorded: the session that was there before tracking began is marked seen.
    expect(usage[seeded]?.records).toEqual([]);
    expect(Object.values(usage[seeded]?.seenSessions ?? {})).toHaveLength(1);
  });
});
