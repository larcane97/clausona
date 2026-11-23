import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireDirLock, removeHeldDirLocks } from "./dir-lock.js";

// The real calls, which a test can make refuse once the way Windows does.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), stat: vi.fn(actual.stat) };
});

const LOCK = { staleMs: 60_000, updateMs: 5_000 };

const temps: string[] = [];
const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function refusal(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted`), { code });
}

/** Runs `fn` as if on `platform`. */
async function on<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const actual = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    if (actual) Object.defineProperty(process, "platform", actual);
  }
}

afterEach(() => {
  vi.mocked(mkdir).mockReset().mockImplementation(real.mkdir);
  vi.mocked(stat).mockReset().mockImplementation(real.stat);
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

  // Windows refuses to create the directory, or to stat it, while the holder's release is
  // still deleting it. That is the holder going, not a reason to give up.
  it("waits on Windows while the holder's lock is still being deleted", async () => {
    const lock = lockPath();
    mkdirSync(lock);
    vi.mocked(mkdir).mockRejectedValueOnce(refusal("EPERM"));
    // The second look finds it on its way out, and it is gone by the next try.
    vi.mocked(stat)
      .mockImplementationOnce(real.stat)
      .mockImplementationOnce(async () => {
        rmSync(lock, { recursive: true, force: true });
        throw refusal("EPERM");
      });

    const release = await on("win32", () => acquireDirLock(lock, { ...LOCK, waitMs: 2_000, retryMs: 20 }));

    expect(release).not.toBeNull();
    expect(statSync(lock).isDirectory()).toBe(true);
    await release?.();
  });

  it("throws a refusal on Windows when no lock is there to wait for", async () => {
    const lock = lockPath();
    vi.mocked(mkdir).mockRejectedValue(refusal("EACCES"));

    await expect(on("win32", () => acquireDirLock(lock, { ...LOCK, waitMs: 2_000 }))).rejects.toMatchObject({
      code: "EACCES",
    });
    // Tried once more, in case a delete had just finished, and no more.
    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(2);
  });

  it("tries once more on Windows when the refused lock is already gone, and takes it", async () => {
    const lock = lockPath();
    vi.mocked(mkdir).mockRejectedValueOnce(refusal("EPERM"));

    const release = await on("win32", () => acquireDirLock(lock, LOCK));

    expect(release).not.toBeNull();
    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(2);
    await release?.();
  });

  it("throws EPERM elsewhere, where it never means a lock being deleted", async () => {
    const lock = lockPath();
    mkdirSync(lock);
    vi.mocked(mkdir).mockRejectedValueOnce(refusal("EPERM"));

    await expect(on("linux", () => acquireDirLock(lock, { ...LOCK, waitMs: 2_000 }))).rejects.toMatchObject({
      code: "EPERM",
    });
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
