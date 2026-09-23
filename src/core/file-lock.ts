import { mkdir, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Takes an exclusive lock by creating `lockPath`, resolving to the function that
 * releases it, or to null if the lock stayed with another holder for all of `waitMs`.
 *
 * A process that dies holding the lock never removes it, so a lock older than
 * `staleMs` is presumed abandoned and taken over. That makes `staleMs` a promise every
 * holder has to keep: finish well within it, or a waiter will act as if it had died.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions): Promise<ReleaseFileLock | null> {
  await mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
  const deadline = Date.now() + (options.waitMs ?? 0);

  const create = async () => {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  while (!(await create())) {
    const info = await stat(lockPath).catch((error: NodeJS.ErrnoException) => error);
    if (info instanceof Error) {
      // Released between the two calls, so try again at once. A lock that exists but
      // cannot be inspected — on Windows, one that is being deleted — is waited out
      // rather than removed, since the path may already belong to a new holder.
      if (info.code === "ENOENT" && (await create())) break;
    } else if (Date.now() - info.mtimeMs >= options.staleMs) {
      // Only reclaim a lock old enough that its owner cannot still be working under it.
      await rm(lockPath, { force: true }).catch(() => {});
      if (await create()) break;
    }
    if (Date.now() >= deadline) return null;
    await sleep(options.retryMs ?? DEFAULT_RETRY_MS);
  }

  return async () => {
    await rm(lockPath, { force: true }).catch(() => {});
  };
}
