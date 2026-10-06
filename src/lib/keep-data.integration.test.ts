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

async function harness(profiles: (dirs: { codex: string; codexWork: string }) => Registry["profiles"]) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-keep-"));
  temps.push(currentHome);
  const dirs = { codex: path.join(currentHome, ".codex"), codexWork: path.join(currentHome, ".codex-work") };
  seedCodexPrimary(dirs.codex);
  mkdirSync(dirs.codexWork, { recursive: true });
  writeFileSync(path.join(dirs.codexWork, "auth.json"), codexAuth("work@example.com"));

  const clausona = path.join(currentHome, ".clausona");
  mkdirSync(clausona, { recursive: true });
  const registry: Registry = {
    version: 2,
    primarySources: { codex: dirs.codex },
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
    backups: (name: string) => path.join(clausona, "backups", "codex", name),
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
