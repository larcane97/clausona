import crypto from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type FileLockOptions = {
  /** A lock older than this is treated as abandoned by a crashed process and taken over. */
  staleMs: number;
  /** How long to keep retrying while another holder has the lock. Zero gives up at once. */
  waitMs?: number;
  /** Pause between attempts while waiting. */
  retryMs?: number;
};

export type ReleaseFileLock = () => Promise<void>;

const DEFAULT_RETRY_MS = 50;

// The steal lock is held only while one small file is read and removed, so one this old
// was left by a process that died holding it, and is removed. Seconds rather than
// milliseconds let a holder that a loaded machine merely stalled keep it. It never exceeds
// the lock's own staleMs, so a dead taker never holds up a waiter longer than a dead holder.
const STEAL_STALE_MS = 5_000;

type HeldFile = { token: string; mtimeMs: number };

type ClaimOptions = { staleMs: number; waitMs: number; retryMs: number };

const isStale = (held: HeldFile, staleMs: number) => Date.now() - held.mtimeMs >= staleMs;

/** The token in `filePath` and when it was written. Rejects as the read or stat does. */
async function inspect(filePath: string): Promise<HeldFile> {
  const token = await readFile(filePath, "utf8");
  const { mtimeMs } = await stat(filePath);
  return { token, mtimeMs };
}

/**
 * Removes one of the lock's files. On Windows a scanner or a pending delete can refuse that
 * for a moment, with EBUSY or EPERM, and a refusal taken as final leaves the file in the
 * way until it goes stale. rm retries those only when recursive, which a file never needs.
 */
async function removeFile(filePath: string) {
  await rm(filePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
}

/** Removes `filePath` if what it holds now still passes `check`. Never rejects. */
async function removeIf(filePath: string, check: (held: HeldFile) => boolean) {
  const held = await inspect(filePath).catch(() => null);
  if (held && check(held)) await removeFile(filePath);
}

/**
 * Creates `filePath` holding `token`, resolving to false only when another holder has it.
 * A directory it may not write or a full disk is thrown as it is: waiting would not fix
 * it, and the timeout would blame a holder that does not exist.
 */
async function create(filePath: string, token: string, retry = true): Promise<boolean> {
  try {
    await writeFile(filePath, token, { flag: "wx" });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // Windows refuses, with EPERM or EACCES, to create a file while the last one at that
    // path is still being deleted, so those are another holder while the file is there.
    // With none there, one more try tells a delete that just finished from a real refusal.
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      const exists = await stat(filePath).then(
        () => true,
        (statError: NodeJS.ErrnoException) => statError.code !== "ENOENT",
      );
      if (exists) return false;
      if (retry) return create(filePath, token, false);
    }
    throw error;
  }
}

/**
 * Creates `filePath` holding `token`, retrying for `waitMs` while another holder has it,
 * and resolves to whether it did. One older than `staleMs` is handed to `reclaim`, which
 * removes it if it is still the one that was found stale.
 */
async function claim(
  filePath: string,
  token: string,
  options: ClaimOptions,
  reclaim: (held: HeldFile) => Promise<unknown>,
): Promise<boolean> {
  const deadline = Date.now() + options.waitMs;
  while (!(await create(filePath, token))) {
    const held = await inspect(filePath).catch((error: NodeJS.ErrnoException) => error);
    if (held instanceof Error) {
      // Released between the two calls, so try again at once. A lock that exists but
      // cannot be inspected — on Windows, one that is being deleted — is waited out
      // rather than removed, since the path may already belong to a new holder.
      if (held.code === "ENOENT" && (await create(filePath, token))) return true;
    } else if (isStale(held, options.staleMs)) {
      // Only reclaim a lock old enough that its owner cannot still be working under it.
      await reclaim(held);
      if (await create(filePath, token)) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(options.retryMs);
  }
  return true;
}

/**
 * Takes an exclusive lock by creating `lockPath`, resolving to the function that
 * releases it, or to null if the lock stayed with another holder for all of `waitMs`.
 * Anything else that stops it creating the lock is thrown at once.
 *
 * A process that dies holding the lock never removes it, so a lock older than
 * `staleMs` is presumed abandoned and taken over. That makes `staleMs` a promise every
 * holder has to keep: finish well within it, or a waiter will act as if it had died.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<ReleaseFileLock | null> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  // Written into the lock so that this holder only ever removes its own. The pid alone
  // repeats: the same process takes the lock again, and the system reuses pids.
  const token = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;

  // Removing the lock, to take it over or to release it, happens only under the steal
  // lock, and is decided there from what the lock holds then. Two waiters that found the
  // same lock stale would otherwise both remove it, the second removing the lock the
  // first had just taken, and a holder that overran `staleMs` would remove its
  // successor's. Creating the lock needs no steal lock: it only succeeds on an empty path.
  const stealPath = `${lockPath}.steal`;
  const stealStaleMs = Math.min(options.staleMs, STEAL_STALE_MS);
  const withStealLock = async (waitMs: number, fn: () => Promise<void>) => {
    // Nothing guards removing an abandoned steal lock the way it guards the lock, so two
    // waiters can still both remove one. That needs a process to have died mid-takeover
    // first, and checking the token again just before removing it leaves them only the
    // moment between that check and the removal.
    const taken = await claim(stealPath, token, { staleMs: stealStaleMs, waitMs, retryMs }, (held) =>
      removeIf(stealPath, (now) => now.token === held.token && isStale(now, stealStaleMs)),
    );
    if (!taken) return;
    try {
      await fn();
    } finally {
      await removeIf(stealPath, (now) => now.token === token);
    }
  };

  // A takeover in progress holds the steal lock only briefly, so rather than wait here
  // the waiter looks at the lock again after its usual pause, within its own `waitMs`.
  const takeOver = (stale: HeldFile) =>
    withStealLock(0, () => removeIf(lockPath, (now) => now.token === stale.token && isStale(now, options.staleMs)));
  if (!(await claim(lockPath, token, { staleMs: options.staleMs, waitMs: options.waitMs ?? 0, retryMs }, takeOver))) {
    return null;
  }

  return async () => {
    // A lock released well within `staleMs` cannot be taken over meanwhile: a takeover needs
    // it stale, and checks that again under the steal lock before removing it. So a holder
    // in time removes its own lock directly, and only one that ran late goes through the
    // steal lock. That keeps the steal lock off every ordinary release, where on Windows
    // each file created and deleted is one more that a scanner or a pending delete can keep
    // in the way - and a release that could not get the steal lock left its lock to go stale.
    const held = await inspect(lockPath).catch((error: NodeJS.ErrnoException) => error);
    // Gone, or another holder's since this one ran late: nothing of this holder's to remove.
    if (held instanceof Error ? held.code === "ENOENT" : held.token !== token) return;
    if (!(held instanceof Error) && Date.now() - held.mtimeMs < options.staleMs / 2) {
      await removeFile(lockPath);
      return;
    }
    // Waiting out the steal lock's own threshold is long enough for one left by a dead
    // taker to be removed. Failing that, the lock is left to go stale, as it would be had
    // this process died holding it.
    await withStealLock(stealStaleMs, () => removeIf(lockPath, (now) => now.token === token)).catch(() => {});
  };
}
