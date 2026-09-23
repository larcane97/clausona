import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireFileLock } from "./file-lock.js";

const STALE_MS = 60_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A lock path whose parent does not exist yet, so taking the lock has to create it. */
function freshLockPath() {
  const root = mkdtempSync(path.join(tmpdir(), "clausona-lock-"));
  temps.push(root);
  return path.join(root, "locks", "test.lock");
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

  it("takes over a lock older than the stale threshold", async () => {
    const lockPath = freshLockPath();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "99999");
    const then = new Date(Date.now() - 2 * STALE_MS);
    utimesSync(lockPath, then, then);

    const release = await acquireFileLock(lockPath, { staleMs: STALE_MS });

    expect(release).not.toBeNull();
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    await release?.();
  });
});
