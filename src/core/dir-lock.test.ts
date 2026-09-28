import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { acquireDirLock, removeHeldDirLocks } from "./dir-lock.js";

const LOCK = { staleMs: 60_000, updateMs: 5_000 };

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockPath() {
  const root = mkdtempSync(path.join(tmpdir(), "clausona-dir-lock-"));
  temps.push(root);
  return path.join(root, "test.lock");
}

describe("acquireDirLock", () => {
  it("takes the lock by creating the directory, and gives it up by removing it", async () => {
    const lock = lockPath();

    const release = await acquireDirLock(lock, LOCK);

    expect(release).not.toBeNull();
    expect(statSync(lock).isDirectory()).toBe(true);
    await release?.();
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves a lock another holder has refreshed within the stale threshold to it", async () => {
    const lock = lockPath();
    mkdirSync(lock);

    expect(await acquireDirLock(lock, LOCK)).toBeNull();
    expect(existsSync(lock)).toBe(true);
  });

  it("takes over a lock whose holder stopped refreshing it", async () => {
    const lock = lockPath();
    mkdirSync(lock);
    const then = new Date(Date.now() - 2 * LOCK.staleMs);
    utimesSync(lock, then, then);

    const release = await acquireDirLock(lock, LOCK);

    expect(release).not.toBeNull();
    // Created again, so it no longer looks abandoned to anyone else.
    expect(statSync(lock).mtimeMs).toBeGreaterThan(Date.now() - LOCK.staleMs);
    await release?.();
    expect(existsSync(lock)).toBe(false);
  });

  it("refreshes the mtime while it holds the lock, so the lock never looks abandoned", async () => {
    const lock = lockPath();
    const options = { staleMs: 600, updateMs: 50 };
    const release = await acquireDirLock(lock, options);
    const taken = statSync(lock).mtimeMs;

    await sleep(1_000);

    expect(statSync(lock).mtimeMs).toBeGreaterThan(taken);
    expect(await acquireDirLock(lock, options)).toBeNull();
    await release?.();
    expect(existsSync(lock)).toBe(false);
  });

  it("removes a lock still held when the process exits, from one exit listener however many it takes", async () => {
    const first = lockPath();
    const second = lockPath();
    const releaseFirst = await acquireDirLock(first, LOCK);
    const releaseSecond = await acquireDirLock(second, LOCK);

    const listeners = process.listeners("exit").filter((listener) => listener === removeHeldDirLocks);
    expect(listeners).toHaveLength(1);
    // What process.exit, or the end of the event loop, runs.
    listeners[0]?.(0);

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    // Releasing afterwards finds nothing of its own to remove.
    await releaseFirst?.();
    await releaseSecond?.();
  });
});
