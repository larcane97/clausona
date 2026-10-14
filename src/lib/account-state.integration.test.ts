import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, Registry } from "../types.js";

// doctorProfiles and repairProfile resolve ~/.clausona at module load, so the whole module graph
// has to see a temporary home. The mock is read through `currentHome`, which each case sets
// before re-importing the module.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const realPlatform = process.platform;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.resetModules();
});

/**
 * What Claude Code 2.1.299 keeps for one account or one org in its config directory: the org's
 * policy limits and remote managed settings with every sibling it names for them, the MCP servers
 * that need this account's sign-in, its `state/` and the Claude in Chrome host it writes for the
 * directory; then copies of the account file, the background daemon with its sign-in state, the
 * telemetry it has yet to send, the tokens of hosted sessions, and the caches and ledgers of the
 * account it runs as. Directories are the ones it keeps as directories.
 */
const ACCOUNT_FILES = [
  "policy-limits.json",
  "policy-limits.json.signature.json",
  "policy-limits.json.signature-iat.json",
  "policy-limits.json.stamp.json",
  "remote-settings.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.signature-iat.json",
  "remote-settings.json.synced-at",
  "remote-settings-helper-consent",
  "remote-settings-consent.json",
  "mcp-needs-auth-cache.json",
  ".claude.json.backup",
  ".claude-custom-oauth.json",
  ".config.json",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  ".session_ingress_token",
  "hfi-auth.json",
  "stats-cache.json",
  "active-time.json",
];
const ACCOUNT_DIRS = ["state", "chrome", "backups", "daemon", "telemetry", "cache", "mcp-discovery-cache", "feedback"];
const ACCOUNT_STATE = [...ACCOUNT_FILES, ...ACCOUNT_DIRS];

/** Those through which Claude Code in the profile acts as the primary's account: doctor's wrong_account_link. */
const WRONG_ACCOUNT = new Set([
  ".claude-custom-oauth.json",
  ".config.json",
  "daemon",
  ".session_ingress_token",
  "hfi-auth.json",
]);

/** The one file inside each directory above, holding whose it is. */
const OWNER_FILE: Record<string, string> = {
  state: "mcp-discover-verdicts.json",
  chrome: "chrome-native-host",
  backups: ".claude.json.backup.1760000000000",
  daemon: "roster.json",
  telemetry: "1p_failed_events.session.run.json",
  cache: "model-access.json",
  "mcp-discovery-cache": "discovery.json",
  feedback: "draft.json",
};

/**
 * Writes `owner` into entry `name` under `dir`, as `as` (a backup's name, say): the file, or the
 * one file inside the directory.
 */
function writeOwned(dir: string, name: string, owner: string, as = name) {
  const file = OWNER_FILE[name];
  if (file) {
    mkdirSync(path.join(dir, as), { recursive: true });
    writeFileSync(path.join(dir, as, file), JSON.stringify({ owner }));
  } else {
    writeFileSync(path.join(dir, as), JSON.stringify({ owner }));
  }
}

/** Whose `name` under `dir` is. */
function ownerOf(dir: string, name: string): string {
  const file = OWNER_FILE[name];
  return JSON.parse(readFileSync(file ? path.join(dir, name, file) : path.join(dir, name), "utf8")).owner;
}

/**
 * What the look for the profile's background daemon finds: none (every case not about it), a
 * stand-in listening on its control socket under the case's own folder in place of /tmp, or no
 * answer.
 */
type DaemonLook = "none" | "stand-in" | "no-answer";

/**
 * A primary and one secondary Claude profile under a throwaway home, the primary holding its own
 * copy of each entry. Both profiles have an account and a credential file, and the platform is
 * pinned to Linux so doctor reads that file instead of probing the Keychain: the only findings
 * left are about links.
 */
async function seedHome({ daemon = "none" }: { daemon?: DaemonLook } = {}) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-accountstate-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });
  mkdirSync(primary, { recursive: true });
  mkdirSync(work, { recursive: true });

  const account = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });
  writeFileSync(path.join(currentHome, ".claude.json"), account("primary@example.com"));
  writeFileSync(path.join(work, ".claude.json"), account("work@example.com"));
  const credential = JSON.stringify({ claudeAiOauth: { accessToken: "T" } });
  writeFileSync(path.join(primary, ".credentials.json"), credential);
  writeFileSync(path.join(work, ".credentials.json"), credential);
  for (const name of ACCOUNT_STATE) writeOwned(primary, name, "primary");

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "work@example.com" },
    },
  };
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.resetModules();
  // In place of /tmp, for the daemon's control socket: short enough for sun_path.
  const daemonRoot = mkdtempSync(path.join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "cd-"));
  temps.push(daemonRoot);
  vi.doMock("../core/claude-daemon.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../core/claude-daemon.js")>();
    const running = async (configDir: string) =>
      daemon === "stand-in"
        ? real.claudeDaemonRunning(configDir, { tmpRoot: daemonRoot })
        : daemon === "none"
          ? false
          : null;
    return { ...real, claudeDaemonRunning: running };
  });
  const service = await import("./service.js");
  const { claudeAdapter } = await import("../tools/claude.js");
  const backupDir = path.join(currentHome, ".clausona", "backups", "claude", "work");
  return { primary, work, backupDir, daemonRoot, service, claudeAdapter };
}

function issuesFor(results: DoctorProfileResult[], name: string) {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues;
}

const lstatOrNull = (p: string) => lstatSync(p, { throwIfNoEntry: false }) ?? null;

describe("Claude Code state for one account or org", () => {
  it("is never linked into a profile, in either session mode", async () => {
    const { primary, work, backupDir, service, claudeAdapter } = await seedHome();

    for (const mergeSessions of [false, true]) {
      await service.setupSharedLinks(claudeAdapter, work, primary, mergeSessions, backupDir);
      for (const name of ACCOUNT_STATE) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
    }
  });

  it("loses a link to the primary's on repair, and the primary's copy is untouched", async () => {
    const { primary, work, service } = await seedHome();
    // A profile linked before these entries were kept apart, whose Claude Code has not yet
    // saved its own copy over the link.
    for (const name of ACCOUNT_STATE) symlinkSync(path.join(primary, name), path.join(work, name));

    // Said as Codex's are: what the profile reads of the primary account's, and the repair.
    const before = issuesFor(await service.doctorProfiles(), "claude:work");
    expect(before).toHaveLength(ACCOUNT_STATE.length);
    for (const name of ACCOUNT_STATE) {
      const issue = before.find((found) => found.message.startsWith(`${name} links to the primary's, `));
      expect(issue?.kind, name).toBe(WRONG_ACCOUNT.has(name) ? "wrong_account_link" : "shared_account_state");
      expect(issue?.message, name).toMatch(/, so .*primary.*\. `clausona repair claude:work` removes the link\.$/);
    }

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name)), name).toBeNull();
      expect(ownerOf(primary, name), name).toBe("primary");
    }
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("stays the profile's own where it has a copy, and doctor does not report it", async () => {
    const { primary, work, service } = await seedHome();
    // What Claude Code leaves where the link was: its own copy, written by a rename over it.
    for (const name of ACCOUNT_STATE) writeOwned(work, name, "work");

    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name))?.isSymbolicLink(), name).toBe(false);
      expect(ownerOf(work, name), name).toBe("work");
      expect(ownerOf(primary, name), name).toBe("primary");
    }
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("comes back on repair from the profile's own backup, never from one that is a link to the primary's", async () => {
    const { primary, work, backupDir, service } = await seedHome();
    // An earlier repair set aside the profile's own copy to put the link back, and a later one
    // set aside a link to the primary's: the newer backup holds nothing of the profile's.
    mkdirSync(backupDir, { recursive: true });
    for (const name of ACCOUNT_STATE) {
      writeOwned(backupDir, name, "work", `${name}.2026-01-01T00-00-00-000Z`);
      symlinkSync(path.join(primary, name), path.join(backupDir, `${name}.2026-02-01T00-00-00-000Z`));
      symlinkSync(path.join(primary, name), path.join(work, name));
    }

    await service.repairProfile("claude:work");

    for (const name of ACCOUNT_STATE) {
      expect(lstatOrNull(path.join(work, name))?.isSymbolicLink(), name).toBe(false);
      expect(ownerOf(work, name), name).toBe("work");
    }
    // Copied, so the backups stay.
    expect(readdirSync(backupDir)).toHaveLength(ACCOUNT_STATE.length * 2);
    expect(existsSync(path.join(primary, "policy-limits.json"))).toBe(true);
  });
});

describe("temp files left from a save", () => {
  // One left in the primary on a real machine, linked into every profile from there.
  const LEFTOVER = ".session-stats.json.tmp.56475.1780981766229.1qip4a37kvx";
  const CLAUDE_CODE_LEFTOVER = "settings.json.tmp.12345.0a1b2c3d4e5f";

  it("are never linked into a profile", async () => {
    const { primary, work, backupDir, service, claudeAdapter } = await seedHome();
    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) writeFileSync(path.join(primary, name), "{}");

    await service.setupSharedLinks(claudeAdapter, work, primary, true, backupDir);

    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
  });

  it("lose a link left from before on repair, even once the primary's is gone", async () => {
    const { primary, work, service } = await seedHome();
    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) {
      writeFileSync(path.join(primary, name), "{}");
      symlinkSync(path.join(primary, name), path.join(work, name));
    }
    // Its writer, or Claude Code's cleanup, takes the primary's out in time.
    rmSync(path.join(primary, CLAUDE_CODE_LEFTOVER));

    await service.repairProfile("claude:work");

    for (const name of [LEFTOVER, CLAUDE_CODE_LEFTOVER]) expect(lstatOrNull(path.join(work, name)), name).toBeNull();
    expect(readFileSync(path.join(primary, LEFTOVER), "utf8")).toBe("{}");
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });

  it("of the profile's own are left alone, and doctor does not report them", async () => {
    const { work, service } = await seedHome();
    const own = ".claude.json.tmp.78985.429da2c70baf";
    writeFileSync(path.join(work, own), "{}");

    await service.repairProfile("claude:work");

    expect(readFileSync(path.join(work, own), "utf8")).toBe("{}");
    expect(issuesFor(await service.doctorProfiles(), "claude:work")).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("repair while the profile's background daemon runs", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  /** A stand-in for the profile's daemon: something listening on its control socket. */
  async function daemonRunsIn(configDir: string, daemonRoot: string) {
    const { claudeDaemonControlPath } = await import("../core/claude-daemon.js");
    const socketPath = (await claudeDaemonControlPath(configDir, { tmpRoot: daemonRoot })) ?? "";
    mkdirSync(path.dirname(socketPath), { recursive: true });
    const server = createServer((connection) => connection.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  }

  it("is refused while it would take out the profile's daemon/ link, and goes ahead with --force", async () => {
    const { primary, work, daemonRoot, service } = await seedHome({ daemon: "stand-in" });
    symlinkSync(path.join(primary, "daemon"), path.join(work, "daemon"));
    symlinkSync(path.join(primary, "policy-limits.json"), path.join(work, "policy-limits.json"));
    await daemonRunsIn(work, daemonRoot);

    await expect(service.repairProfile("claude:work")).rejects.toThrow(
      "Claude Code's background daemon is running in ~/.claude-work, and this would take out the link to the primary's daemon/ it keeps its control key, roster and session tokens in. Stop it with 'CLAUDE_CONFIG_DIR=~/.claude-work claude daemon stop', then run this again. Nothing was changed. To go ahead while it runs: clausona repair claude:work --force",
    );
    // Nothing was changed: the other link is still there too.
    expect(lstatOrNull(path.join(work, "daemon"))?.isSymbolicLink()).toBe(true);
    expect(lstatOrNull(path.join(work, "policy-limits.json"))?.isSymbolicLink()).toBe(true);

    await service.repairProfile("claude:work", { force: true });

    expect(lstatOrNull(path.join(work, "daemon"))).toBeNull();
    expect(lstatOrNull(path.join(work, "policy-limits.json"))).toBeNull();
  });

  it("goes ahead while the daemon runs on the profile's own daemon/", async () => {
    const { primary, work, daemonRoot, service } = await seedHome({ daemon: "stand-in" });
    writeOwned(work, "daemon", "work");
    symlinkSync(path.join(primary, "policy-limits.json"), path.join(work, "policy-limits.json"));
    await daemonRunsIn(work, daemonRoot);

    await service.repairProfile("claude:work");

    expect(ownerOf(work, "daemon")).toBe("work");
    expect(lstatOrNull(path.join(work, "policy-limits.json"))).toBeNull();
  });

  it("goes ahead when the daemon running is another config dir's", async () => {
    const { primary, work, daemonRoot, service } = await seedHome({ daemon: "stand-in" });
    symlinkSync(path.join(primary, "daemon"), path.join(work, "daemon"));
    await daemonRunsIn(primary, daemonRoot);

    await service.repairProfile("claude:work");

    expect(lstatOrNull(path.join(work, "daemon"))).toBeNull();
  });

  it("is refused for the session-mode toggle too, with its own --force", async () => {
    const { primary, work, daemonRoot, service } = await seedHome({ daemon: "stand-in" });
    symlinkSync(path.join(primary, "daemon"), path.join(work, "daemon"));
    await daemonRunsIn(work, daemonRoot);

    await expect(service.updateProfileConfig("claude:work", { mergeSessions: true })).rejects.toThrow(
      "To go ahead while it runs: clausona config claude:work --merge-sessions --force",
    );
    expect(lstatOrNull(path.join(work, "daemon"))?.isSymbolicLink()).toBe(true);
  });

  it("is refused when the look gets no answer", async () => {
    const { primary, work, service } = await seedHome({ daemon: "no-answer" });
    symlinkSync(path.join(primary, "daemon"), path.join(work, "daemon"));

    await expect(service.repairProfile("claude:work")).rejects.toThrow(
      "The look for Claude Code's background daemon in ~/.claude-work got no answer: its control socket neither took the connection nor refused it. This would take out the link to the primary's daemon/ a running daemon keeps its control key, roster and session tokens in. Nothing was changed. Run this again, or, with the daemon stopped in this profile, go ahead without the look: clausona repair claude:work --force",
    );
    expect(lstatOrNull(path.join(work, "daemon"))?.isSymbolicLink()).toBe(true);
  });
});
