import { rmdirSync, statSync } from "node:fs";
import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export type DirLockOptions = {
  /** A lock whose mtime is older than this is treated as abandoned by a dead holder and taken over. */
  staleMs: number;
  /** How often a held lock's mtime is refreshed, which has to be well within `staleMs`. */
  updateMs: number;
  /** How long to keep retrying while a live holder has the lock. Zero gives up at once. */
  waitMs?: number;
  /** Pause between attempts while waiting. */
  retryMs?: number;
};

export type ReleaseDirLock = () => Promise<void>;

const DEFAULT_RETRY_MS = 50;

/** A lock this process holds, with the mtime it last gave it. */
type HeldLock = { lockPath: string; mtimeMs: number };

const held = new Set<HeldLock>();

/**
 * Removes every lock this process still holds, as proper-lockfile does when a process
 * exits. Run from an "exit" listener, which fires on process.exit and on a normal end
 * alike, so it has to be synchronous. A lock whose mtime is no longer the one it was
 * given has been taken over, and is left to its new holder.
 *
 * A signal that kills the process by its default action runs no listener, so a lock
 * held then is left to go stale, as it is when the process crashes.
 */
export function removeHeldDirLocks(): void {
  for (const lock of held) {
    held.delete(lock);
    try {
      if (statSync(lock.lockPath).mtimeMs === lock.mtimeMs) rmdirSync(lock.lockPath);
    } catch {
      // Gone already, or not this process's to remove.
    }
  }
}

let exitListenerAdded = false;

/**
 * Creates the lock directory and resolves to its mtime, or to null while a live holder has
 * it. A lock whose mtime is older than `staleMs` is removed and one more attempt made, the
 * one takeover proper-lockfile allows: if another process takes the lock in between, it
 * wins.
 */
async function create(lockPath: string, staleMs: number, takeOver = true): Promise<number | null> {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!takeOver) return null;
    // Gone by the time it is looked at means released in between, which is worth the same
    // one more attempt as a stale lock.
    const info = await stat(lockPath).catch((statError: NodeJS.ErrnoException) => {
      if (statError.code === "ENOENT") return null;
      throw statError;
    });
    if (info && info.mtimeMs >= Date.now() - staleMs) return null;
    if (info) {
      await rmdir(lockPath).catch((rmError: NodeJS.ErrnoException) => {
        if (rmError.code !== "ENOENT") throw rmError;
      });
    }
    return create(lockPath, staleMs, false);
  }

  try {
    return (await stat(lockPath)).mtimeMs;
  } catch (error) {
    await rmdir(lockPath).catch(() => {});
    throw error;
  }
}

/**
 * Takes the lock at `lockPath` the way proper-lockfile does, so it excludes every other
 * program that locks the same path with that library - Claude Code among them, which is
 * what this is for (see src/tools/claude.ts). Resolves to the function that releases it,
 * or to null if a live holder kept it for all of `waitMs`. Anything else that stops it
 * creating the lock is thrown at once.
 *
 * The lock is a directory, as proper-lockfile's is: creating one is atomic on every platform
 * and filesystem, network ones included. A holder that dies never removes it, so a live one
 * refreshes its mtime every `updateMs`, and one whose mtime is older than `staleMs` is
 * presumed abandoned and taken over.
 */
export async function acquireDirLock(lockPath: string, options: DirLockOptions): Promise<ReleaseDirLock | null> {
  // Timed on the monotonic clock, so a wall clock that is set back cannot stretch the wait.
  const deadline = performance.now() + (options.waitMs ?? 0);
  let taken = await create(lockPath, options.staleMs);
  while (taken === null) {
    if (performance.now() >= deadline) return null;
    await sleep(options.retryMs ?? DEFAULT_RETRY_MS);
    taken = await create(lockPath, options.staleMs);
  }

  const lock: HeldLock = { lockPath, mtimeMs: taken };
  held.add(lock);
  if (!exitListenerAdded) {
    process.on("exit", removeHeldDirLocks);
    exitListenerAdded = true;
  }

  let released = false;
  let lost = false;
  let timer: NodeJS.Timeout | undefined;
  let touching: Promise<void> = Promise.resolve();

  // A holder that stalled past `staleMs` can have had the lock taken over, and the directory
  // is then someone else's, with an mtime of its own. Removing it would let a third process
  // in beside the one that holds it now.
  const stillOurs = async () => (await stat(lockPath).catch(() => null))?.mtimeMs === lock.mtimeMs;

  const touch = async () => {
    if (!(await stillOurs())) {
      lost = true;
      held.delete(lock);
      return;
    }
    const now = new Date();
    await utimes(lockPath, now, now);
    // Read back rather than taken from `now`, which a filesystem can round.
    lock.mtimeMs = (await stat(lockPath)).mtimeMs;
  };

  const schedule = () => {
    timer = setTimeout(() => {
      // A refresh that failed is tried again on the next tick; the lock only goes stale if
      // they keep failing for all of `staleMs`.
      touching = touch()
        .catch(() => {})
        .then(() => {
          if (!released && !lost) schedule();
        });
    }, options.updateMs);
    // The lock is never a reason for the process to stay alive.
    timer.unref();
  };
  schedule();

  return async () => {
    released = true;
    clearTimeout(timer);
    // A refresh already under way would otherwise move the mtime after it is compared.
    await touching;
    if (!lost && (await stillOurs())) await rmdir(lockPath).catch(() => {});
    held.delete(lock);
  };
}
