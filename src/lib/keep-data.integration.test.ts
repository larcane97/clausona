import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Registry } from "../types.js";

/**
 * #73: a profile registered on its tool's primary directory made every shared-link step a
 * link of that directory to itself, which deleted the primary's data; doctor deleted dangling
 * links; and repair kept only the first backup of each name and then deleted the rest.
 *
 * ~/.clausona is resolved from homedir() at module load, so the whole module graph has to see
 * a temporary home. Nothing here reaches the real ~/.codex, ~/.claude or ~/.clausona.
 */
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A backup made at some moment: `<name>.<ISO timestamp, with - for : and .>`, maybe with a counter. */
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;

function backupsNamed(backupDir: string, name: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((entry) => entry.startsWith(`${name}.`) && STAMPED.test(entry.slice(name.length + 1)))
    .sort();
}

/** Every entry under `dir`, without following links: a directory, a link and where it leads, or a file and what it holds. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) out[rel] = `link:${readlinkSync(full)}`;
      else if (stats.isDirectory()) {
        out[rel] = "dir";
        walk(full);
      } else out[rel] = `file:${readFileSync(full, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

/** An auth.json the codex adapter reads an account from. Built from pieces: it is token-shaped. */
function codexAuth(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return JSON.stringify({ tokens: { id_token: ["h", payload, "s"].join(".") } });
}

/** A primary ~/.codex holding what the issue saw destroyed: shared directories and skip-set state. */
function seedCodexPrimary(dir: string) {
  mkdirSync(path.join(dir, "skills", "review"), { recursive: true });
  writeFileSync(path.join(dir, "skills", "review", "SKILL.md"), "the primary's skill");
  mkdirSync(path.join(dir, "memories"), { recursive: true });
  writeFileSync(path.join(dir, "memories", "note.md"), "the primary's memory");
  writeFileSync(path.join(dir, "config.toml"), 'model = "primary"\n');
  writeFileSync(path.join(dir, "auth.json"), codexAuth("primary@example.com"));
  writeFileSync(path.join(dir, "installation_id"), "primary-install");
  writeFileSync(path.join(dir, "state_5.sqlite"), "primary state");
  writeFileSync(path.join(dir, "history.jsonl"), '{"primary":true}\n');
}

type Dirs = { codex: string; codexWork: string; claude: string; claudeWork: string };

async function harness(
  profiles: (dirs: Dirs) => Registry["profiles"],
  primarySources: (dirs: Dirs) => Registry["primarySources"] = (dirs) => ({ codex: dirs.codex, claude: dirs.claude }),
) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-keep-"));
  temps.push(currentHome);
  const dirs: Dirs = {
    codex: path.join(currentHome, ".codex"),
    codexWork: path.join(currentHome, ".codex-work"),
    claude: path.join(currentHome, ".claude"),
    claudeWork: path.join(currentHome, ".claude-work"),
  };
  seedCodexPrimary(dirs.codex);
  mkdirSync(dirs.codexWork, { recursive: true });
  writeFileSync(path.join(dirs.codexWork, "auth.json"), codexAuth("work@example.com"));
  mkdirSync(dirs.claude, { recursive: true });
  mkdirSync(dirs.claudeWork, { recursive: true });

  const clausona = path.join(currentHome, ".clausona");
  mkdirSync(clausona, { recursive: true });
  const registry: Registry = {
    version: 2,
    primarySources: primarySources(dirs),
    activeProfiles: { codex: Object.keys(profiles(dirs))[0] },
    profiles: profiles(dirs),
  };
  const registryPath = path.join(clausona, "profiles.json");
  writeFileSync(registryPath, JSON.stringify(registry));

  vi.resetModules();
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const service = await import("./service.js");
  const commands = await import("../commands.js");
  return {
    home: currentHome,
    dirs,
    service,
    commands,
    clausona,
    backups: (name: string, tool = "codex") => path.join(clausona, "backups", tool, name),
    registry: (): Registry => JSON.parse(readFileSync(registryPath, "utf8")),
    stderr: () => stderr.join(""),
  };
}

describe("repair over the profile's own data", () => {
  async function workHarness() {
    return harness((dirs) => ({
      "codex:default": { tool: "codex", configDir: dirs.codex, email: "primary@example.com", isPrimary: true },
      "codex:work": { tool: "codex", configDir: dirs.codexWork, email: "work@example.com", mergeSessions: false },
    }));
  }

  /** Puts a real skills/ directory where the profile's shared link is, as a tool writing locally would. */
  function replaceLinkWithOwnDir(configDir: string, file: string, content: string) {
    rmSync(path.join(configDir, "skills"), { recursive: true, force: true });
    mkdirSync(path.join(configDir, "skills"));
    writeFileSync(path.join(configDir, "skills", file), content);
  }

  it("keeps a timestamped backup each time it replaces a real directory, and loses nothing", async () => {
    const h = await workHarness();
    replaceLinkWithOwnDir(h.dirs.codexWork, "first.md", "first");

    await h.service.repairProfile("codex:work");
    replaceLinkWithOwnDir(h.dirs.codexWork, "second.md", "second");
    await h.service.repairProfile("codex:work");

    const backups = backupsNamed(h.backups("work"), "skills");
    expect(backups).toHaveLength(2);
    const contents = backups.map((name) => snapshot(path.join(h.backups("work"), name)));
    expect(contents).toEqual([{ "first.md": "file:first" }, { "second.md": "file:second" }]);
    expect(lstatSync(path.join(h.dirs.codexWork, "skills")).isSymbolicLink()).toBe(true);
    // The primary's own copy is untouched.
    expect(readFileSync(path.join(h.dirs.codex, "skills", "review", "SKILL.md"), "utf8")).toBe("the primary's skill");
  });

  it("remove puts the newest backup back and keeps the older ones", async () => {
    const h = await workHarness();
    replaceLinkWithOwnDir(h.dirs.codexWork, "first.md", "first");
    await h.service.repairProfile("codex:work");
    replaceLinkWithOwnDir(h.dirs.codexWork, "second.md", "second");
    await h.service.repairProfile("codex:work");

    await h.service.removeProfile("codex:work");

    expect(snapshot(path.join(h.dirs.codexWork, "skills"))).toEqual({ "second.md": "file:second" });
    const kept = backupsNamed(h.backups("work"), "skills");
    expect(kept).toHaveLength(1);
    expect(snapshot(path.join(h.backups("work"), kept[0]))).toEqual({ "first.md": "file:first" });
    expect(h.stderr()).toContain("still in");
  });

  it("the session-mode toggle brings a private directory back from its newest backup", async () => {
    const h = await workHarness();
    mkdirSync(path.join(h.dirs.codex, "sessions"));
    writeFileSync(path.join(h.dirs.codex, "sessions", "primary.jsonl"), "primary");
    mkdirSync(path.join(h.dirs.codexWork, "sessions"));
    writeFileSync(path.join(h.dirs.codexWork, "sessions", "mine.jsonl"), "mine");

    await h.service.updateProfileConfig("codex:work", { mergeSessions: true });
    expect(lstatSync(path.join(h.dirs.codexWork, "sessions")).isSymbolicLink()).toBe(true);
    expect(backupsNamed(h.backups("work"), "sessions")).toHaveLength(1);

    await h.service.updateProfileConfig("codex:work", { mergeSessions: false });

    expect(snapshot(path.join(h.dirs.codexWork, "sessions"))).toEqual({ "mine.jsonl": "file:mine" });
    expect(readFileSync(path.join(h.dirs.codex, "sessions", "primary.jsonl"), "utf8")).toBe("primary");
  });

  it("remove puts no backup over what the profile has written since, and keeps that backup", async () => {
    const h = await workHarness();
    mkdirSync(path.join(h.dirs.codex, "sessions"));
    mkdirSync(path.join(h.dirs.codexWork, "sessions"));
    writeFileSync(path.join(h.dirs.codexWork, "sessions", "mine.jsonl"), "old");
    writeFileSync(path.join(h.dirs.codexWork, "history.jsonl"), "old history");
    // Merged sets both aside; separated copies them back from their backups.
    await h.service.updateProfileConfig("codex:work", { mergeSessions: true });
    await h.service.updateProfileConfig("codex:work", { mergeSessions: false });
    // The profile goes on writing.
    writeFileSync(path.join(h.dirs.codexWork, "sessions", "mine.jsonl"), "newer");
    writeFileSync(path.join(h.dirs.codexWork, "history.jsonl"), "newer history");

    await h.service.removeProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.codexWork, "sessions", "mine.jsonl"), "utf8")).toBe("newer");
    expect(readFileSync(path.join(h.dirs.codexWork, "history.jsonl"), "utf8")).toBe("newer history");
    const kept = [...backupsNamed(h.backups("work"), "sessions"), ...backupsNamed(h.backups("work"), "history.jsonl")];
    expect(kept).toHaveLength(2);
    expect(h.stderr()).toContain("history.jsonl, sessions");
  });

  it("puts a relative link back exactly as it was written", async () => {
    const h = await workHarness();
    mkdirSync(path.join(h.home, "dotfiles"));
    writeFileSync(path.join(h.home, "dotfiles", "foo.md"), "from dotfiles");
    mkdirSync(path.join(h.dirs.codex, "sessions"));
    mkdirSync(path.join(h.dirs.codexWork, "sessions"));
    const relative = path.join("..", "..", "dotfiles", "foo.md");
    symlinkSync(relative, path.join(h.dirs.codexWork, "sessions", "foo.md"));

    // Set aside by merging, then copied back by separating.
    await h.service.updateProfileConfig("codex:work", { mergeSessions: true });
    await h.service.updateProfileConfig("codex:work", { mergeSessions: false });

    const restored = path.join(h.dirs.codexWork, "sessions", "foo.md");
    expect(readlinkSync(restored)).toBe(relative);
    expect(readFileSync(restored, "utf8")).toBe("from dotfiles");

    // And when removing the profile puts a backup back.
    replaceLinkWithOwnDir(h.dirs.codexWork, "own.md", "own");
    symlinkSync(relative, path.join(h.dirs.codexWork, "skills", "foo.md"));
    await h.service.repairProfile("codex:work");
    await h.service.removeProfile("codex:work");

    expect(readlinkSync(path.join(h.dirs.codexWork, "skills", "foo.md"))).toBe(relative);
  });
});

describe("doctor and a shared link whose target is gone", () => {
  it("reports it and leaves it in place; repair moves it into a backup", async () => {
    const h = await harness((dirs) => ({
      "codex:default": { tool: "codex", configDir: dirs.codex, email: "primary@example.com", isPrimary: true },
      "codex:work": { tool: "codex", configDir: dirs.codexWork, email: "work@example.com", mergeSessions: false },
    }));
    await h.service.repairProfile("codex:work");
    // The primary loses a directory the profile links to.
    mkdirSync(path.join(h.dirs.codex, "rules"));
    symlinkSync(path.join(h.dirs.codex, "rules"), path.join(h.dirs.codexWork, "rules"), "junction");
    rmSync(path.join(h.dirs.codex, "rules"), { recursive: true });
    const dangling = path.join(h.dirs.codexWork, "rules");

    const results = await h.service.doctorProfiles();

    const work = results.find((result) => result.name === "codex:work");
    expect(work?.issues).toContainEqual({
      kind: "broken_symlink",
      message: "rules shared link points to a missing target",
    });
    expect(lstatSync(dangling).isSymbolicLink(), "doctor deleted the dangling link").toBe(true);

    await h.service.repairProfile("codex:work");

    expect(lstatSync(dangling, { throwIfNoEntry: false })).toBeUndefined();
    expect(backupsNamed(h.backups("work"), "rules")).toHaveLength(1);
    const after = await h.service.doctorProfiles();
    expect(after.find((result) => result.name === "codex:work")?.issues).toEqual([]);
  });
});

/** A primary ~/.claude with a shared directory, a shared file and skip-set state. */
function seedClaudePrimary(dir: string) {
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "helper.md"), "the primary's agent");
  writeFileSync(path.join(dir, "settings.json"), '{"primary":true}');
  writeFileSync(path.join(dir, ".credentials.json"), '{"primary":true}');
  mkdirSync(path.join(dir, "projects", "-repo"), { recursive: true });
  writeFileSync(path.join(dir, "projects", "-repo", "s.jsonl"), "{}\n");
}

/** The issue's registry: `codex:personal` is a non-primary profile on ~/.codex itself. */
const selfLinked = (dirs: { codex: string; codexWork: string }): Registry["profiles"] => ({
  "codex:personal": { tool: "codex", configDir: dirs.codex, email: "primary@example.com", mergeSessions: false },
  "codex:work": { tool: "codex", configDir: dirs.codexWork, email: "work@example.com", mergeSessions: false },
});

describe("a profile on its tool's primary directory", () => {
  it.each([
    ["claude", seedClaudePrimary],
    ["codex", seedCodexPrimary],
  ] as const)("setupSharedLinks will not link %s's primary to itself, and deletes nothing", async (tool, seed) => {
    currentHome = mkdtempSync(path.join(tmpdir(), "clausona-keep-"));
    temps.push(currentHome);
    const { getAdapter } = await import("../tools/registry.js");
    const adapter = getAdapter(tool);
    const primary = path.join(currentHome, "primary");
    seed(primary);
    // Another spelling of the same directory, which only resolving it tells apart.
    const alias = path.join(currentHome, "alias");
    symlinkSync(primary, alias, "junction");
    const backup = path.join(currentHome, "backup");
    const before = snapshot(primary);
    const { setupSharedLinks } = await import("./service.js");

    for (const profileDir of [primary, alias]) {
      await expect(setupSharedLinks(adapter, profileDir, primary, false, backup)).rejects.toThrow(
        /is the primary config directory itself/,
      );
      await expect(setupSharedLinks(adapter, profileDir, primary, true, backup)).rejects.toThrow(
        /is the primary config directory itself/,
      );
    }

    // Skip-set files (.credentials.json, auth.json, state_5.sqlite, ...) included.
    expect(snapshot(primary)).toEqual(before);
    expect(existsSync(backup)).toBe(false);
  });

  it("repair refuses it and leaves the directory as it is", async () => {
    const h = await harness(selfLinked);
    const before = snapshot(h.dirs.codex);

    await expect(h.service.repairProfile("codex:personal")).rejects.toThrow(
      /'codex:personal' is registered on .*\.codex, codex's primary config directory itself/,
    );

    expect(snapshot(h.dirs.codex)).toEqual(before);
    expect(existsSync(h.backups("personal"))).toBe(false);
  });

  it("the session-mode toggle refuses it and changes nothing", async () => {
    const h = await harness(selfLinked);
    const before = snapshot(h.dirs.codex);

    await expect(h.service.updateProfileConfig("codex:personal", { mergeSessions: true })).rejects.toThrow(
      /codex's primary config directory itself/,
    );

    expect(snapshot(h.dirs.codex)).toEqual(before);
    expect(h.registry().profiles["codex:personal"].mergeSessions).toBe(false);
  });

  it("add --from refuses the primary directory", async () => {
    const h = await harness(selfLinked);
    const before = snapshot(h.dirs.codex);

    await expect(h.commands.runCommand("add", ["codex:again", "--from", "~/.codex"])).rejects.toThrow(
      "it is codex's primary config directory",
    );

    expect(snapshot(h.dirs.codex)).toEqual(before);
  });

  it("init refuses to set the primary directory up as a profile of its own", async () => {
    const h = await harness(selfLinked);
    const before = snapshot(h.dirs.codex);

    await expect(
      h.service.initializeRegistry({
        accounts: [
          {
            tool: "codex",
            configDir: h.dirs.codex,
            jsonPath: path.join(h.dirs.codex, "auth.json"),
            email: "primary@example.com",
            keychainService: "",
            isPrimary: false,
          },
        ],
        profileNames: { [h.dirs.codex]: "personal" },
      }),
    ).rejects.toThrow(/codex's primary config directory/);

    expect(snapshot(h.dirs.codex)).toEqual(before);
  });

  it("doctor reports it as the primary directory, says how to fix the registry, and changes nothing", async () => {
    const h = await harness(selfLinked);
    const before = snapshot(h.dirs.codex);

    const results = await h.service.doctorProfiles();

    const personal = results.find((result) => result.name === "codex:personal");
    expect(personal?.issues).toEqual([
      {
        kind: "primary_config_dir",
        message: expect.stringContaining(`set "isPrimary": true on 'codex:personal'`),
      },
    ]);
    expect(personal?.healthy).toBe(false);
    expect(snapshot(h.dirs.codex)).toEqual(before);
  });

  it("doctor points a duplicate of the primary profile at remove", async () => {
    const h = await harness((dirs) => ({
      "codex:default": { tool: "codex", configDir: dirs.codex, email: "primary@example.com", isPrimary: true },
      ...selfLinked(dirs),
    }));

    const results = await h.service.doctorProfiles();

    const personal = results.find((result) => result.name === "codex:personal");
    expect(personal?.issues.map((issue) => issue.kind)).toEqual(["primary_config_dir"]);
    expect(personal?.issues[0].message).toContain("'codex:default' already registers it as the primary");
    expect(personal?.issues[0].message).toContain("clausona remove codex:personal");
  });

  it("remove drops only the entry, and leaves the primary and its backup as they are", async () => {
    const h = await harness(selfLinked);
    // What an earlier, unguarded repair set aside from the primary.
    mkdirSync(path.join(h.backups("personal"), "skills"), { recursive: true });
    writeFileSync(path.join(h.backups("personal"), "skills", "lost.md"), "set aside");
    const before = snapshot(h.dirs.codex);
    const backupBefore = snapshot(h.backups("personal"));

    await h.service.removeProfile("codex:personal");

    expect(snapshot(h.dirs.codex)).toEqual(before);
    expect(snapshot(h.backups("personal"))).toEqual(backupBefore);
    expect(h.registry().profiles["codex:personal"]).toBeUndefined();
    expect(h.stderr()).toContain("only its entry was removed");
  });
});
