import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireFileLock, type ReleaseFileLock } from "./file-lock.js";

const STALE_MS = 60_000;

// Runs `run` once, just after the `nth` stat of `path` from now returns: when a waiter has
// looked at the lock but not yet acted on what it saw, which is the gap another waiter can
// get into.
let afterStat: { path: string; nth: number; run: () => Promise<void> } | null = null;
// Every file the lock writes, so a case can tell whether the steal lock was used at all.
const written: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = async (filePath: string) => {
    const info = await actual.stat(filePath);
    const hook = afterStat;
    if (hook?.path === filePath && --hook.nth === 0) {
      afterStat = null;
      await hook.run();
    }
    return info;
  };
  const writeFile = (async (filePath: string, ...rest: unknown[]) => {
    written.push(String(filePath));
    return (actual.writeFile as (...args: unknown[]) => Promise<void>)(filePath, ...rest);
  }) as typeof actual.writeFile;
  return { ...actual, stat, writeFile };
});

const temps: string[] = [];
afterEach(() => {
  afterStat = null;
  written.length = 0;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A lock path whose parent does not exist yet, so taking the lock has to create it. */
function freshLockPath() {
  const root = mkdtempSync(path.join(tmpdir(), "clausona-lock-"));
  temps.push(root);
  return path.join(root, "locks", "test.lock");
}

/** Writes `content` to `filePath` as a process that took a lock `ageMs` ago would have left it. */
function writeAged(filePath: string, content: string, ageMs: number) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  age(filePath, ageMs);
}

function age(filePath: string, ageMs: number) {
  const then = new Date(Date.now() - ageMs);
  utimesSync(filePath, then, then);
}

describe("acquireFileLock", () => {
  it("hands the lock to one holder at a time", async () => {
    const lockPath = freshLockPath();

    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });
    expect(release).not.toBeNull();
    expect(await acquireFileLock(lockPath, { staleMs: STALE_MS })).toBeNull();

    await release?.();
    expect(existsSync(lockPath)).toBe(false);

    const next = await acquireFileLock(lockPath, { staleMs: STALE_MS });
    expect(next).not.toBeNull();
    await next?.();
  });

  it("waits for the holder to release when given time to wait", async () => {
    const lockPath = freshLockPath();
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    let released = false;
    setTimeout(() => {
      released = true;
      void release?.();
    }, 200);
    const next = await acquireFileLock(lockPath, { staleMs: STALE_MS, waitMs: 10_000, retryMs: 10 });

    expect(next).not.toBeNull();
    expect(released).toBe(true);
    await next?.();
  });

  it("gives up once the wait runs out, leaving a live holder's lock in place", async () => {
    const lockPath = freshLockPath();
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    expect(await acquireFileLock(lockPath, { staleMs: STALE_MS, waitMs: 100, retryMs: 10 })).toBeNull();
    expect(existsSync(lockPath)).toBe(true);

    await release?.();
  });

  // A read-only lock directory, which root writes through and Windows does not make. The
  // second run takes the Windows branch, where EACCES can also be a lock being deleted.
  for (const platform of ["native", "win32"] as const) {
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      `throws what stops it creating the lock instead of waiting it out (${platform})`,
      async () => {
        const lockPath = freshLockPath();
        mkdirSync(path.dirname(lockPath));
        chmodSync(path.dirname(lockPath), 0o555);
        const actual = Object.getOwnPropertyDescriptor(process, "platform");
        if (platform === "win32") Object.defineProperty(process, "platform", { value: "win32" });
        try {
          await expect(acquireFileLock(lockPath, { staleMs: STALE_MS, waitMs: 2_000 })).rejects.toMatchObject({
            code: "EACCES",
          });
        } finally {
          if (actual) Object.defineProperty(process, "platform", actual);
          chmodSync(path.dirname(lockPath), 0o755);
        }
      },
    );
  }

  it("takes over a lock older than the stale threshold", async () => {
    const lockPath = freshLockPath();
    writeAged(lockPath, "99999", 2 * STALE_MS);

    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    expect(release).not.toBeNull();
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}-`));
    await release?.();
  });

  it("releases a lock held briefly without going through the steal lock", async () => {
    // On Windows every extra file created and deleted is one a scanner can hold open, and a
    // release that then could not get the steal lock left its lock to go stale.
    const lockPath = freshLockPath();
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    await release?.();

    expect(existsSync(lockPath)).toBe(false);
    expect(written.filter((file) => file.endsWith(".steal"))).toEqual([]);
  });

  it("still releases through the steal lock once the lock is past half its stale threshold", async () => {
    const lockPath = freshLockPath();
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });
    age(lockPath, STALE_MS * 0.6);

    await release?.();

    expect(existsSync(lockPath)).toBe(false);
    expect(written.filter((file) => file.endsWith(".steal"))).toHaveLength(1);
  });

  it("leaves a successor's lock alone when a holder that overran the stale threshold releases", async () => {
    const lockPath = freshLockPath();
    const late = await acquireFileLock(lockPath, { staleMs: STALE_MS });
    age(lockPath, 2 * STALE_MS);
    const successor = await acquireFileLock(lockPath, { staleMs: STALE_MS });
    expect(successor).not.toBeNull();
    const taken = readFileSync(lockPath, "utf8");

    await late?.();

    expect(readFileSync(lockPath, "utf8")).toBe(taken);
    expect(await acquireFileLock(lockPath, { staleMs: STALE_MS })).toBeNull();
    await successor?.();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("lets only one of two waiters take over the same stale lock", async () => {
    const lockPath = freshLockPath();
    writeAged(lockPath, "99999", 2 * STALE_MS);

    // A waiter looks at the lock twice: once to find it stale, then again just before it
    // removes it. Another waiter arrives between that second look and the removal, where
    // only the steal lock keeps it from taking over the same lock too.
    let other = null as ReleaseFileLock | null;
    afterStat = {
      path: lockPath,
      nth: 2,
      run: async () => {
        other = await acquireFileLock(lockPath, { staleMs: STALE_MS });
      },
    };
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    // The other waiter did get into that gap.
    expect(afterStat).toBeNull();
    expect(other).toBeNull();
    expect(release).not.toBeNull();
    expect(readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}-`));
    await release?.();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("waits for a takeover in progress, but not for one whose process died", async () => {
    const lockPath = freshLockPath();
    const stealPath = `${lockPath}.steal`;
    writeAged(lockPath, "99999", 2 * STALE_MS);
    // Another waiter is part way through taking the lock over.
    writeAged(stealPath, "88888", 0);

    expect(await acquireFileLock(lockPath, { staleMs: STALE_MS })).toBeNull();

    // A steal lock as old as the lock's own stale threshold is abandoned, whatever
    // threshold the steal lock uses.
    age(stealPath, STALE_MS);
    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    expect(release).not.toBeNull();
    expect(existsSync(stealPath)).toBe(false);
    await release?.();
    expect(existsSync(lockPath)).toBe(false);
  });
});
