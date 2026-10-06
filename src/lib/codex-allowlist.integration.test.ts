import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorIssue, DoctorProfileResult, Registry } from "../types.js";

/**
 * #74: a Codex profile shares only the entries codex.ts allows, never the per-home state
 * Codex 0.148-0.159 added - the app-server daemon's directories, the memories and other
 * databases - and repair takes back what an older clausona linked.
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
afterEach(async () => {
  vi.restoreAllMocks();
  // The graph's dir-lock exit listener goes with it, as in add-leftover.integration.test.ts.
  process.off("exit", (await import("../core/dir-lock.js")).removeHeldDirLocks);
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An auth.json the codex adapter reads an account from. */
function codexAuth(account: string): string {
  return JSON.stringify({ tokens: { account_id: account } });
}

/** What a primary ~/.codex on codex-cli 0.159 holds: configuration, and state of its own account's. */
function seedPrimary(dir: string) {
  mkdirSync(path.join(dir, "skills", "review"), { recursive: true });
  writeFileSync(path.join(dir, "skills", "review", "SKILL.md"), "the primary's skill");
  writeFileSync(path.join(dir, "config.toml"), 'model = "primary"\n');
  writeFileSync(path.join(dir, "hooks.json"), "{}");
  writeFileSync(path.join(dir, "auth.json"), codexAuth("primary"));
  mkdirSync(path.join(dir, "app-server-control"));
  writeFileSync(path.join(dir, "app-server-control", "control.json"), "the primary's daemon");
  mkdirSync(path.join(dir, "app-server-daemon"));
  writeFileSync(path.join(dir, "app-server-daemon", "daemon.lock"), "primary");
  mkdirSync(path.join(dir, "memories"));
  writeFileSync(path.join(dir, "memories", "summary.md"), "the primary's memory");
  writeFileSync(path.join(dir, "memories_1.sqlite"), "the primary's memories");
  writeFileSync(path.join(dir, "memories_1.sqlite-wal"), "the primary's memories wal");
  writeFileSync(path.join(dir, "goals_1.sqlite"), "the primary's goals");
  for (const name of ["archived_sessions", "attachments", "sessions"]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "primary.jsonl"), `the primary's ${name}`);
  }
}

async function harness(profiles: (dirs: { codex: string; work: string }) => Registry["profiles"] = () => ({})) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-allow-"));
  temps.push(currentHome);
  const dirs = { codex: path.join(currentHome, ".codex"), work: path.join(currentHome, ".codex-work") };
  seedPrimary(dirs.codex);
  const clausona = path.join(currentHome, ".clausona");
  mkdirSync(clausona, { recursive: true });
  const registryPath = path.join(clausona, "profiles.json");
  const registry: Registry = {
    version: 2,
    primarySources: { codex: dirs.codex },
    activeProfiles: { codex: "codex:default" },
    profiles: {
      "codex:default": { tool: "codex", configDir: dirs.codex, email: "primary", isPrimary: true },
      ...profiles(dirs),
    },
  };
  writeFileSync(registryPath, JSON.stringify(registry));

  vi.resetModules();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const { getAdapter } = await import("../tools/registry.js");
  // The login is Codex's own browser sign-in; its stand-in leaves what it would.
  vi.spyOn(getAdapter("codex"), "runLogin").mockImplementation(async (configDir) => {
    writeFileSync(path.join(configDir, "auth.json"), codexAuth(path.basename(configDir)));
    return true;
  });
  const service = await import("./service.js");
  const { offersRepair } = await import("./format.js");
  return {
    dirs,
    service,
    offersRepair,
    backups: (name: string) => path.join(clausona, "backups", "codex", name),
    primaryBefore: snapshot(dirs.codex),
  };
}

/**
 * A profile's doctor findings, but for the warning that a temporary home's long path draws:
 * the daemon's socket would not fit under it, which says nothing about links.
 */
function findings(results: DoctorProfileResult[], name = "codex:work"): DoctorIssue[] {
  return (results.find((result) => result.name === name)?.issues ?? []).filter(
    (issue) => issue.kind !== "socket_path_too_long",
  );
}

/** A registered codex:work whose directory exists, with an account of its own. */
const work = (dirs: { work: string }): Registry["profiles"] => {
  mkdirSync(dirs.work, { recursive: true });
  writeFileSync(path.join(dirs.work, "auth.json"), codexAuth("work"));
  return { "codex:work": { tool: "codex", configDir: dirs.work, email: "work", mergeSessions: false } };
};

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

const lstatOrNull = (target: string) => lstatSync(target, { throwIfNoEntry: false }) ?? null;

/**
 * Whether `target` is a shared link to `source`: a symbolic link or junction that leads there,
 * or - where Windows makes no file symbolic link - a hard link to the same file.
 */
function linksTo(target: string, source: string): boolean {
  const stats = lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!stats) return false;
  if (stats.isSymbolicLink()) return realpathSync(target) === realpathSync(source);
  const sourceStats = statSync(source, { bigint: true });
  return stats.isFile() && stats.ino === sourceStats.ino && stats.dev === sourceStats.dev;
}

/** Links `target` to `source` as an older clausona did: a junction for a directory. */
function linkAs(source: string, target: string) {
  symlinkSync(source, target, statSync(source).isDirectory() ? "junction" : "file");
}

/** A backup's name, as setAside writes one at `iso`. */
const stamped = (name: string, iso: string) => `${name}.${iso.replace(/[:.]/g, "-")}`;

describe("adding a codex profile", () => {
  it("links config.toml, skills/ and hooks.json, and none of the daemon's directories or the databases", async () => {
    const h = await harness();

    await h.service.addProfile({ tool: "codex", name: "work" });

    for (const name of ["config.toml", "skills", "hooks.json"]) {
      expect(linksTo(path.join(h.dirs.work, name), path.join(h.dirs.codex, name)), `${name} is not linked`).toBe(true);
    }
    for (const name of [
      "app-server-control",
      "app-server-daemon",
      "memories",
      "memories_1.sqlite",
      "memories_1.sqlite-wal",
      "goals_1.sqlite",
    ]) {
      expect(lstatOrNull(path.join(h.dirs.work, name)), `${name} was linked`).toBeNull();
    }
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("links archived_sessions/ and attachments/ only with merged sessions", async () => {
    const h = await harness();

    await h.service.addProfile({ tool: "codex", name: "work" });
    await h.service.addProfile({ tool: "codex", name: "team", mergeSessions: true });

    const team = path.join(path.dirname(h.dirs.work), ".codex-team");
    for (const name of ["archived_sessions", "attachments", "sessions"]) {
      expect(lstatOrNull(path.join(h.dirs.work, name)), `${name} was linked into separate sessions`).toBeNull();
      expect(linksTo(path.join(team, name), path.join(h.dirs.codex, name)), `${name} not linked when merged`).toBe(
        true,
      );
    }
  });

  it("is reported healthy by doctor: nothing it keeps for itself is expected as a shared link", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      // Linked as add links a profile now: what Codex shares, and nothing else.
      for (const name of ["config.toml", "skills", "hooks.json"]) {
        linkAs(path.join(dirs.codex, name), path.join(dirs.work, name));
      }
      return profiles;
    });

    const results = await h.service.doctorProfiles();

    expect(findings(results)).toEqual([]);
  });
});

describe("the session-mode toggle", () => {
  it("unlinks archived_sessions/ and attachments/ when sessions are separated again", async () => {
    const h = await harness((dirs) => work(dirs));

    await h.service.updateProfileConfig("codex:work", { mergeSessions: true });
    expect(linksTo(path.join(h.dirs.work, "archived_sessions"), path.join(h.dirs.codex, "archived_sessions"))).toBe(
      true,
    );
    await h.service.updateProfileConfig("codex:work", { mergeSessions: false });

    for (const name of ["archived_sessions", "attachments", "sessions"]) {
      expect(lstatOrNull(path.join(h.dirs.work, name)), `${name} is still linked`).toBeNull();
    }
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("merging takes back a linked database as repair does, with the profile's own copy", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      linkAs(path.join(dirs.codex, "memories_1.sqlite"), path.join(dirs.work, "memories_1.sqlite"));
      return profiles;
    });
    mkdirSync(h.backups("work"), { recursive: true });
    writeFileSync(path.join(h.backups("work"), stamped("memories_1.sqlite", "2026-09-01T10:00:00.000Z")), "own");

    await h.service.updateProfileConfig("codex:work", { mergeSessions: true });

    const db = path.join(h.dirs.work, "memories_1.sqlite");
    expect(lstatSync(db).isSymbolicLink()).toBe(false);
    expect(readFileSync(db, "utf8")).toBe("own");
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });
});

describe("repairing a profile an older clausona linked", () => {
  /** codex:work as clausona 0.5.0 left it: the primary's memories and daemon control linked in. */
  function linkedByOlderClausona(dirs: { codex: string; work: string }) {
    const profiles = work(dirs);
    for (const name of ["memories_1.sqlite", "memories_1.sqlite-wal", "goals_1.sqlite", "app-server-control"]) {
      linkAs(path.join(dirs.codex, name), path.join(dirs.work, name));
    }
    return profiles;
  }

  it.each([
    ["timestamped", (name: string) => stamped(name, "2026-09-01T10:00:00.000Z")],
    ["untimestamped", (name: string) => name],
  ])("unlinks memories_1.sqlite and puts its own copy back with its -wal (%s backups)", async (_layout, backupName) => {
    const h = await harness(linkedByOlderClausona);
    mkdirSync(h.backups("work"), { recursive: true });
    writeFileSync(path.join(h.backups("work"), backupName("memories_1.sqlite")), "work's own memories");
    writeFileSync(path.join(h.backups("work"), backupName("memories_1.sqlite-wal")), "work's own memories wal");

    await h.service.repairProfile("codex:work");

    for (const name of ["memories_1.sqlite", "memories_1.sqlite-wal", "goals_1.sqlite", "app-server-control"]) {
      expect(lstatOrNull(path.join(h.dirs.work, name))?.isSymbolicLink(), `${name} is still linked`).not.toBe(true);
    }
    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite-wal"), "utf8")).toBe("work's own memories wal");
    // No backup of goals_1.sqlite: the spot stays empty, and Codex starts a new one.
    expect(lstatOrNull(path.join(h.dirs.work, "goals_1.sqlite"))).toBeNull();
    // Moved back, so the profile's copy is the only one.
    expect(existsSync(h.backups("work")) ? readdirSync(h.backups("work")) : []).toEqual([]);
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("leaves the profile's own database where it is", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      writeFileSync(path.join(dirs.work, "memories_1.sqlite"), "work's own memories");
      writeFileSync(path.join(dirs.work, "memories_1.sqlite-wal"), "work's own memories wal");
      return profiles;
    });

    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite-wal"), "utf8")).toBe("work's own memories wal");
    expect(existsSync(h.backups("work"))).toBe(false);
  });

  /** Backups of two copies of the database: the older one set aside with its -wal, the newer one without. */
  function twoCopies(backupDir: string) {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, stamped("memories_1.sqlite", "2026-08-01T10:00:00.000Z")), "older copy");
    writeFileSync(path.join(backupDir, stamped("memories_1.sqlite-wal", "2026-08-01T10:00:00.004Z")), "older wal");
    writeFileSync(path.join(backupDir, stamped("memories_1.sqlite", "2026-09-01T10:00:00.000Z")), "newer copy");
  }

  it("never puts a -wal back beside a copy of the database it was not written with", async () => {
    const h = await harness(linkedByOlderClausona);
    twoCopies(h.backups("work"));

    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("newer copy");
    expect(lstatOrNull(path.join(h.dirs.work, "memories_1.sqlite-wal"))).toBeNull();
    expect(readdirSync(h.backups("work")).sort()).toEqual(
      [
        stamped("memories_1.sqlite", "2026-08-01T10:00:00.000Z"),
        stamped("memories_1.sqlite-wal", "2026-08-01T10:00:00.004Z"),
      ].sort(),
    );
  });

  it("and neither does remove", async () => {
    const h = await harness(linkedByOlderClausona);
    twoCopies(h.backups("work"));

    await h.service.removeProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("newer copy");
    expect(lstatOrNull(path.join(h.dirs.work, "memories_1.sqlite-wal"))).toBeNull();
    expect(readdirSync(h.backups("work"))).toContain(stamped("memories_1.sqlite-wal", "2026-08-01T10:00:00.004Z"));
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });
});

describe("doctor on a profile an older clausona linked", () => {
  it("reports the linked app-server-control/ as a wrong account, and memories_1.sqlite as shared state", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      for (const name of ["app-server-control", "memories_1.sqlite"]) {
        linkAs(path.join(dirs.codex, name), path.join(dirs.work, name));
      }
      return profiles;
    });

    const issues = findings(await h.service.doctorProfiles());

    expect(issues).toContainEqual({
      kind: "wrong_account_link",
      message: expect.stringMatching(
        /^app-server-control links to the primary's, .*app-server daemon.*account and quota/,
      ),
    });
    expect(issues).toContainEqual({
      kind: "shared_account_state",
      message: expect.stringMatching(/^memories_1\.sqlite links to the primary's, .*conversation summaries/),
    });
    expect(h.offersRepair(issues)).toBe(true);

    await h.service.repairProfile("codex:work");

    expect(findings(await h.service.doctorProfiles())).toEqual([]);
  });
});
