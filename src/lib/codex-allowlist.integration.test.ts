import { type ChildProcess, spawn } from "node:child_process";
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
  utimesSync,
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
  writeFileSync(path.join(dir, ".env"), "SOME_MCP_TOKEN=the primary's\n");
  mkdirSync(path.join(dir, "app-server-control"));
  writeFileSync(path.join(dir, "app-server-control", "control.json"), "the primary's daemon");
  mkdirSync(path.join(dir, "app-server-daemon"));
  writeFileSync(path.join(dir, "app-server-daemon", "daemon.lock"), "primary");
  mkdirSync(path.join(dir, "memories"));
  writeFileSync(path.join(dir, "memories", "summary.md"), "the primary's memory");
  writeFileSync(path.join(dir, "memories_1.sqlite"), "the primary's memories");
  writeFileSync(path.join(dir, "memories_1.sqlite-wal"), "the primary's memories wal");
  writeFileSync(path.join(dir, "goals_1.sqlite"), "the primary's goals");
  for (const db of ["state_5.sqlite", "thread_history_1.sqlite"]) {
    writeFileSync(path.join(dir, db), `the primary's ${db}`);
  }
  for (const companion of ["state_5.sqlite-wal", "state_5.sqlite-shm", "goals_1.sqlite-wal"]) {
    writeFileSync(path.join(dir, companion), `the primary's ${companion}`);
  }
  for (const name of ["archived_sessions", "attachments", "sessions", "rollout-migrations"]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "primary.jsonl"), `the primary's ${name}`);
  }
}

/**
 * `realProcessCheck` keeps the look for a running Codex, which the cases about it need. Every
 * other case goes without it: on a loaded machine its pgrep and ps take seconds, and nothing
 * else here is about them.
 */
async function harness(
  profiles: (dirs: { codex: string; work: string }) => Registry["profiles"] = () => ({}),
  { realProcessCheck = false } = {},
) {
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
  if (realProcessCheck) vi.doUnmock("../core/running-codex.js");
  else vi.doMock("../core/running-codex.js", () => ({ codexProcessesFor: async () => [] }));
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
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
    stderr: () => stderr.join(""),
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

/** codex:work as clausona 0.5.0 left it: the primary's memories and daemon control linked in. */
function linkedByOlderClausona(dirs: { codex: string; work: string }) {
  const profiles = work(dirs);
  for (const name of ["memories_1.sqlite", "memories_1.sqlite-wal", "goals_1.sqlite", "app-server-control"]) {
    linkAs(path.join(dirs.codex, name), path.join(dirs.work, name));
  }
  return profiles;
}

/** The backups of `name` in `backupDir` set aside since the layout was timestamped, oldest first. */
function stampedBackups(backupDir: string, name: string): string[] {
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;
  return readdirSync(backupDir)
    .filter((entry) => entry.startsWith(`${name}.`) && stamp.test(entry.slice(name.length + 1)))
    .sort();
}

describe("repairing a profile an older clausona linked", () => {
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
    // No backup of goals_1.sqlite: the spot stays empty, Codex starts a new one, and repair says so.
    expect(lstatOrNull(path.join(h.dirs.work, "goals_1.sqlite"))).toBeNull();
    for (const name of ["goals_1.sqlite", "app-server-control"]) {
      expect(h.stderr()).toMatch(
        new RegExp(`${name.replace(".", "\\.")} in .* was a link to the primary's and is gone`),
      );
    }
    expect(h.stderr()).not.toMatch(/memories_1\.sqlite in .* is gone/);
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

describe("putting a database back beside a -wal already there", () => {
  const SET_ASIDE = "2026-09-01T10:00:00.000Z";
  const at = (iso: string) => new Date(iso);

  /** codex:work with memories_1.sqlite linked, a backup of its own copy, and a -wal of its own beside the link. */
  async function walBeside(walTime: string, layout: "timestamped" | "untimestamped" = "timestamped") {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      linkAs(path.join(dirs.codex, "memories_1.sqlite"), path.join(dirs.work, "memories_1.sqlite"));
      const wal = path.join(dirs.work, "memories_1.sqlite-wal");
      writeFileSync(wal, "a -wal beside the link");
      utimesSync(wal, at(walTime), at(walTime));
      return profiles;
    });
    mkdirSync(h.backups("work"), { recursive: true });
    const backup = path.join(
      h.backups("work"),
      layout === "timestamped" ? stamped("memories_1.sqlite", SET_ASIDE) : "memories_1.sqlite",
    );
    writeFileSync(backup, "work's own memories");
    // An untimestamped backup was copied when it was set aside, so its own time says when.
    utimesSync(backup, at(SET_ASIDE), at(SET_ASIDE));
    return h;
  }

  it.each([
    "timestamped",
    "untimestamped",
  ] as const)("sets aside one written after the database was set aside (%s backup)", async (layout) => {
    // As SQLite wrote the primary's frames there, through a hard link to the primary's database.
    const h = await walBeside("2026-09-20T10:00:00.000Z", layout);

    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(lstatOrNull(path.join(h.dirs.work, "memories_1.sqlite-wal"))).toBeNull();
    const [setAside] = stampedBackups(h.backups("work"), "memories_1.sqlite-wal");
    expect(readFileSync(path.join(h.backups("work"), setAside), "utf8")).toBe("a -wal beside the link");
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("keeps one untouched since the database was set aside, and says so", async () => {
    const h = await walBeside("2026-08-31T10:00:00.000Z");

    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite-wal"), "utf8")).toBe("a -wal beside the link");
    expect(h.stderr()).toContain("beside the memories_1.sqlite-wal already there");
  });
});

describe("a database whose -wal cannot be told apart", () => {
  it.each([
    ["set aside before backups were timestamped", "memories_1.sqlite-wal"],
    ["set aside in another pass", stamped("memories_1.sqlite-wal", "2026-10-01T10:05:00.000Z")],
  ])("stays in the backups with a -wal %s, and is said", async (_how, walBackup) => {
    const h = await harness(linkedByOlderClausona);
    mkdirSync(h.backups("work"), { recursive: true });
    const db = stamped("memories_1.sqlite", "2026-10-01T10:00:00.000Z");
    writeFileSync(path.join(h.backups("work"), db), "work's own memories");
    writeFileSync(path.join(h.backups("work"), walBackup), "a -wal of some copy");

    await h.service.repairProfile("codex:work");

    expect(lstatOrNull(path.join(h.dirs.work, "memories_1.sqlite"))).toBeNull();
    expect(lstatOrNull(path.join(h.dirs.work, "memories_1.sqlite-wal"))).toBeNull();
    expect(readdirSync(h.backups("work")).sort()).toEqual([db, walBackup].sort());
    expect(h.stderr()).toContain("memories_1.sqlite was not put back");
  });
});

/** A codex account as discovery finds it. */
function codexAccount(configDir: string, email: string, isPrimary: boolean) {
  return {
    tool: "codex" as const,
    configDir,
    jsonPath: path.join(configDir, "auth.json"),
    email,
    keychainService: "",
    isPrimary,
  };
}

describe("init on a codex profile it keeps", () => {
  it("unlinks a linked database and puts the profile's own copy back, as repair does", async () => {
    const h = await harness(linkedByOlderClausona);
    mkdirSync(h.backups("work"), { recursive: true });
    writeFileSync(path.join(h.backups("work"), "memories_1.sqlite"), "work's own memories");
    writeFileSync(path.join(h.backups("work"), "memories_1.sqlite-wal"), "work's own memories wal");

    await h.service.initializeRegistry({
      accounts: [codexAccount(h.dirs.codex, "primary", true), codexAccount(h.dirs.work, "work", false)],
      profileNames: { [h.dirs.codex]: "default", [h.dirs.work]: "work" },
    });

    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readFileSync(path.join(h.dirs.work, "memories_1.sqlite-wal"), "utf8")).toBe("work's own memories wal");
    expect(lstatOrNull(path.join(h.dirs.work, "app-server-control"))).toBeNull();
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("puts back nothing it did not unlink: a cache or sessions/ the profile has since deleted stays gone", async () => {
    const h = await harness((dirs) => work(dirs));
    mkdirSync(path.join(h.backups("work"), stamped("sessions", "2026-09-01T10:00:00.000Z")), { recursive: true });
    mkdirSync(path.join(h.backups("work"), "log"), { recursive: true });

    await h.service.initializeRegistry({
      accounts: [codexAccount(h.dirs.codex, "primary", true), codexAccount(h.dirs.work, "work", false)],
      profileNames: { [h.dirs.codex]: "default", [h.dirs.work]: "work" },
    });

    expect(lstatOrNull(path.join(h.dirs.work, "sessions"))).toBeNull();
    expect(lstatOrNull(path.join(h.dirs.work, "log"))).toBeNull();
    expect(readdirSync(h.backups("work")).sort()).toEqual(
      ["log", stamped("sessions", "2026-09-01T10:00:00.000Z")].sort(),
    );
  });
});

describe("a codex profile's .env", () => {
  it("is a copy of the primary's once repair takes out the link to it", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      linkAs(path.join(dirs.codex, ".env"), path.join(dirs.work, ".env"));
      return profiles;
    });

    await h.service.repairProfile("codex:work");

    const env = path.join(h.dirs.work, ".env");
    expect(lstatSync(env).isFile()).toBe(true);
    expect(readFileSync(env, "utf8")).toBe("SOME_MCP_TOKEN=the primary's\n");
    expect(h.stderr()).toContain("is now a copy of it");
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it("is the profile's own again where repair finds a backup of it", async () => {
    const h = await harness((dirs) => {
      const profiles = work(dirs);
      linkAs(path.join(dirs.codex, ".env"), path.join(dirs.work, ".env"));
      return profiles;
    });
    mkdirSync(h.backups("work"), { recursive: true });
    writeFileSync(path.join(h.backups("work"), stamped(".env", "2026-09-01T10:00:00.000Z")), "SOME_MCP_TOKEN=work's\n");

    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.dirs.work, ".env"), "utf8")).toBe("SOME_MCP_TOKEN=work's\n");
  });

  it.each([
    "a new",
    "an imported",
  ] as const)("is not copied into %s profile, which is told the primary has one", async (how) => {
    const h = await harness();
    if (how === "an imported") {
      mkdirSync(h.dirs.work);
      writeFileSync(path.join(h.dirs.work, "auth.json"), codexAuth("work"));
    }

    await h.service.addProfile({
      tool: "codex",
      name: "work",
      ...(how === "an imported" ? { fromPath: h.dirs.work } : {}),
    });

    expect(lstatOrNull(path.join(h.dirs.work, ".env"))).toBeNull();
    expect(h.stderr()).toContain("The primary's .env is not shared");
  });

  it("is not copied by repair into a profile that never linked it", async () => {
    const h = await harness((dirs) => work(dirs));

    await h.service.repairProfile("codex:work");

    expect(lstatOrNull(path.join(h.dirs.work, ".env"))).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("repair while Codex runs in the profile", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  /** Starts a process named codex - node under that name - with `codexHome` as its CODEX_HOME. */
  function startCodex(binDir: string, codexHome: string): ChildProcess {
    const codex = path.join(binDir, "codex");
    if (!existsSync(codex)) symlinkSync(process.execPath, codex);
    return spawn(codex, ["-e", "setTimeout(() => {}, 60000)"], {
      env: { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome },
      stdio: "ignore",
    });
  }

  /** Starts one codex with the profile's CODEX_HOME, spelled with a trailing separator, and one with the primary's. */
  async function codexRunning(h: Awaited<ReturnType<typeof harness>>) {
    const bin = path.join(path.dirname(h.dirs.work), "bin");
    mkdirSync(bin);
    const { codexProcessesFor } = await import("../core/running-codex.js");
    const other = startCodex(bin, h.dirs.codex);
    child = startCodex(bin, `${h.dirs.work}${path.sep}`);
    const pid = child.pid ?? -1;
    let found: number[] = [];
    for (let tries = 0; tries < 50 && !found.includes(pid); tries++) {
      found = await codexProcessesFor(h.dirs.work);
      if (!found.includes(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    other.kill();
    return { pid, found, other: other.pid };
  }

  it("is found by its CODEX_HOME however it is spelled, and repair refuses until --force", async () => {
    const h = await harness(linkedByOlderClausona, { realProcessCheck: true });
    const { pid, found, other } = await codexRunning(h);
    expect(found).toContain(pid);
    expect(found).not.toContain(other);
    const before = snapshot(h.dirs.work);

    await expect(h.service.repairProfile("codex:work")).rejects.toThrow(
      new RegExp(`Codex is running in .* \\(pid ${pid}\\).*clausona repair codex:work --force`),
    );
    expect(snapshot(h.dirs.work)).toEqual(before);

    await h.service.repairProfile("codex:work", { force: true });

    expect(lstatOrNull(path.join(h.dirs.work, "app-server-control"))).toBeNull();
  });

  it("refuses the session-mode toggle too, which leaves the mode as it was", async () => {
    const h = await harness(linkedByOlderClausona, { realProcessCheck: true });
    await codexRunning(h);
    const before = snapshot(h.dirs.work);

    await expect(h.service.updateProfileConfig("codex:work", { mergeSessions: true })).rejects.toThrow(
      /--merge-sessions --force/,
    );

    expect(snapshot(h.dirs.work)).toEqual(before);
    const registry = JSON.parse(
      readFileSync(path.join(path.dirname(h.dirs.work), ".clausona", "profiles.json"), "utf8"),
    );
    expect(registry.profiles["codex:work"].mergeSessions).toBe(false);
  });

  it("refuses init on a profile it would unlink, before writing anything", async () => {
    const h = await harness(linkedByOlderClausona, { realProcessCheck: true });
    await codexRunning(h);
    const registryPath = path.join(path.dirname(h.dirs.work), ".clausona", "profiles.json");
    const registryBefore = readFileSync(registryPath, "utf8");
    const before = snapshot(h.dirs.work);

    await expect(
      h.service.initializeRegistry({
        accounts: [codexAccount(h.dirs.codex, "primary", true), codexAccount(h.dirs.work, "work", false)],
        profileNames: { [h.dirs.codex]: "default", [h.dirs.work]: "work" },
      }),
    ).rejects.toThrow(/clausona init --auto --force/);

    expect(snapshot(h.dirs.work)).toEqual(before);
    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
  });
});

describe("codex's thread store", () => {
  const STORE = ["state_5.sqlite", "goals_1.sqlite", "thread_history_1.sqlite"];
  // Windows' SQLite would keep a second -wal beside a link: there the store stays in each profile.
  const shares = process.platform !== "win32";

  it("is linked with merged sessions - the databases alone, never a -wal or -shm - and not without", async () => {
    const h = await harness();

    await h.service.addProfile({ tool: "codex", name: "work" });
    await h.service.addProfile({ tool: "codex", name: "team", mergeSessions: true });

    const team = path.join(path.dirname(h.dirs.work), ".codex-team");
    for (const name of [...STORE, "rollout-migrations"]) {
      expect(lstatOrNull(path.join(h.dirs.work, name)), `${name} was linked into separate sessions`).toBeNull();
    }
    for (const db of STORE) {
      expect(linksTo(path.join(team, db), path.join(h.dirs.codex, db)), `${db} with merged sessions`).toBe(shares);
    }
    const migrations = path.join(team, "rollout-migrations");
    expect(linksTo(migrations, path.join(h.dirs.codex, "rollout-migrations"))).toBe(true);
    for (const companion of ["state_5.sqlite-wal", "state_5.sqlite-shm", "goals_1.sqlite-wal"]) {
      expect(lstatOrNull(path.join(team, companion)), `${companion} was linked`).toBeNull();
    }
    expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
  });

  it.skipIf(!shares)(
    "comes back as the profile's own, with its -wal and -shm, when sessions are separated again",
    async () => {
      const h = await harness((dirs) => {
        const profiles = work(dirs);
        for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
          writeFileSync(path.join(dirs.work, name), `work's own ${name}`);
        }
        return profiles;
      });

      await h.service.updateProfileConfig("codex:work", { mergeSessions: true });

      const db = path.join(h.dirs.work, "state_5.sqlite");
      expect(linksTo(db, path.join(h.dirs.codex, "state_5.sqlite"))).toBe(true);
      expect(lstatOrNull(`${db}-wal`)).toBeNull();
      expect(lstatOrNull(`${db}-shm`)).toBeNull();

      await h.service.updateProfileConfig("codex:work", { mergeSessions: false });

      for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
        const restored = path.join(h.dirs.work, name);
        expect(lstatSync(restored).isSymbolicLink(), name).toBe(false);
        expect(readFileSync(restored, "utf8")).toBe(`work's own ${name}`);
      }
      expect(snapshot(h.dirs.codex)).toEqual(h.primaryBefore);
    },
  );
});
