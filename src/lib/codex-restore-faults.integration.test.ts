import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Registry } from "../types.js";

/**
 * #74 review: a database put back from a backup must never be left beside half of what came
 * with it, nor a copy cut short taken for the file itself. The faults are made by failing
 * fs.rename and fs.cp for the paths each case names.
 *
 * ~/.clausona is resolved from homedir() at module load, so the whole module graph has to see
 * a temporary home. Nothing here reaches the real ~/.codex, ~/.claude or ~/.clausona.
 */
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

type Faults = {
  /** A rename from this path fails as a failing disk would. */
  renameFails?: string;
  /** A rename from this path fails as one across filesystems does. */
  acrossDevices?: string;
  /** A copy to a path under this one writes half and fails. */
  copyFailsInto?: string;
};
const faults: Faults = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (String(from) === faults.renameFails) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    if (String(from) === faults.acrossDevices) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return actual.rename(from, to);
  };
  const cp: typeof actual.cp = async (from, to, options) => {
    if (faults.copyFailsInto && String(to).startsWith(faults.copyFailsInto)) {
      await actual.writeFile(String(to), "half a copy");
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return actual.cp(from, to, options);
  };
  return { ...actual, default: { ...actual, rename, cp }, rename, cp };
});

const temps: string[] = [];
afterEach(async () => {
  for (const key of Object.keys(faults) as Array<keyof Faults>) delete faults[key];
  vi.restoreAllMocks();
  process.off("exit", (await import("../core/dir-lock.js")).removeHeldDirLocks);
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stamped = (name: string, iso: string) => `${name}.${iso.replace(/[:.]/g, "-")}`;
const SET_ASIDE = "2026-09-01T10:00:00.000Z";

/** codex:work with the primary's memories_1.sqlite linked in, and its own copy and -wal in its backups. */
async function harness() {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-faults-"));
  temps.push(currentHome);
  const codex = path.join(currentHome, ".codex");
  const work = path.join(currentHome, ".codex-work");
  mkdirSync(codex, { recursive: true });
  writeFileSync(path.join(codex, "memories_1.sqlite"), "the primary's memories");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "auth.json"), JSON.stringify({ tokens: { account_id: "work" } }));
  symlinkSync(path.join(codex, "memories_1.sqlite"), path.join(work, "memories_1.sqlite"), "file");
  const clausona = path.join(currentHome, ".clausona");
  const backups = path.join(clausona, "backups", "codex", "work");
  mkdirSync(backups, { recursive: true });
  const db = path.join(backups, stamped("memories_1.sqlite", SET_ASIDE));
  const wal = path.join(backups, stamped("memories_1.sqlite-wal", SET_ASIDE));
  writeFileSync(db, "work's own memories");
  writeFileSync(wal, "work's own memories wal");
  const registry: Registry = {
    version: 2,
    primarySources: { codex },
    activeProfiles: { codex: "codex:default" },
    profiles: {
      "codex:default": { tool: "codex", configDir: codex, email: "primary", isPrimary: true },
      "codex:work": { tool: "codex", configDir: work, email: "work", mergeSessions: false },
    },
  };
  writeFileSync(path.join(clausona, "profiles.json"), JSON.stringify(registry));

  vi.resetModules();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const service = await import("./service.js");
  return { work, backups, db, wal, service };
}

describe("putting a database back", () => {
  it("returns it to its backup when its -wal cannot follow, so the next repair puts back both", async () => {
    const h = await harness();
    faults.renameFails = h.wal;

    await expect(h.service.repairProfile("codex:work")).rejects.toThrow("EIO");

    expect(existsSync(path.join(h.work, "memories_1.sqlite"))).toBe(false);
    expect(readFileSync(h.db, "utf8")).toBe("work's own memories");
    expect(readFileSync(h.wal, "utf8")).toBe("work's own memories wal");

    delete faults.renameFails;
    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readFileSync(path.join(h.work, "memories_1.sqlite-wal"), "utf8")).toBe("work's own memories wal");
    expect(readdirSync(h.backups)).toEqual([]);
  });

  it("across filesystems, never leaves a copy cut short where the database goes", async () => {
    const h = await harness();
    faults.acrossDevices = h.db;
    faults.copyFailsInto = path.join(h.work, "memories_1.sqlite");

    await expect(h.service.repairProfile("codex:work")).rejects.toThrow("ENOSPC");

    expect(readdirSync(h.work).filter((name) => name.startsWith("memories_1.sqlite"))).toEqual([]);
    expect(readFileSync(h.db, "utf8")).toBe("work's own memories");

    delete faults.copyFailsInto;
    await h.service.repairProfile("codex:work");

    expect(readFileSync(path.join(h.work, "memories_1.sqlite"), "utf8")).toBe("work's own memories");
    expect(readdirSync(h.work).filter((name) => name.includes("clausona-move"))).toEqual([]);
    expect(existsSync(h.db)).toBe(false);
  });
});
