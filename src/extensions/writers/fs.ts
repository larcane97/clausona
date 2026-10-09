import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { acquireDirLock, type DirLockOptions } from "../../core/dir-lock.js";
import { isWithin, samePath } from "../read.js";

/**
 * Every file-system write the extension writes make, and the one lock they take: the only module
 * that changes the disk. apply.ts alone imports it (pinned by boundary.test.ts). A file is written
 * through its link, to a temp file next to the real one renamed over it; a link is removed as a
 * link, never followed; nothing here removes a tree but an operation's own backup folder.
 */

/**
 * The lock Claude Code saves `.claude.json` under: proper-lockfile at `<that path>.lock`, with
 * its default stale and update times. Waited on for 15 s at most, a try every 100 ms.
 */
export const CLAUDE_JSON_LOCK = { staleMs: 10_000, updateMs: 5_000, waitMs: 15_000, retryMs: 100 } as const;

export type FileRead = { text: string; bytes: Uint8Array; mode: number; real: string };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The file's text, bytes, mode and real path; undefined when it is not there. */
export async function readMaybe(file: string): Promise<FileRead | undefined> {
  try {
    const real = await realpath(file);
    const [buffer, info] = await Promise.all([readFile(real), stat(real)]);
    return {
      // A BOM stays in the text, as writers/json.ts expects it.
      text: buffer.toString("utf8"),
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      mode: info.mode,
      real,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * The real path through links, or the path itself when it does not exist yet. A link whose target
 * is not there yet names that target, so a file made through it leaves the link a link.
 */
export async function realOrSelf(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const target = await readlink(file).catch(() => undefined);
  if (target === undefined) return file;
  const dir = await realpath(path.dirname(file)).catch(() => path.dirname(file));
  return realOrSelf(path.resolve(dir, target));
}

/** A name next to `p` that nothing else uses: `${p}.clausona-${pid}-${random}.${tag}`. */
function besideName(p: string, tag: string): string {
  return `${p}.clausona-${process.pid}-${randomBytes(6).toString("hex")}.${tag}`;
}

const RENAME_TRIES = 5;
const RENAME_PAUSE_MS = 50;
const BUSY: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/** rename; on Windows, where a file another program has open cannot be replaced for a moment, tried again. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || attempt >= RENAME_TRIES || !BUSY.has(code)) throw error;
      await sleep(RENAME_PAUSE_MS);
    }
  }
}

/**
 * Writes `${real}.clausona-${pid}-${random}.tmp` next to `real`, chmods it, fsyncs, renames over
 * (win32: retry EPERM/EBUSY/EACCES 5×50 ms). `real` must already be the real path. A reader sees
 * the old file or the new one, never half of one.
 */
export async function writeAtomic(real: string, text: string | Uint8Array, mode: number): Promise<void> {
  const temp = besideName(real, "tmp");
  // "wx": a file already at the temp name, or a link there, is never written through.
  const handle = await open(temp, "wx", mode);
  try {
    try {
      await handle.writeFile(text);
      // open's mode is cut by the umask; this one is not.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameOver(temp, real);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** The folders at and above `dir` that are not there, outermost first. */
async function missingDirs(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let at = path.resolve(dir); (await entryKind(at)) === "missing"; at = path.dirname(at)) {
    missing.unshift(at);
    if (path.dirname(at) === at) break;
  }
  return missing;
}

/** mkdir -p; returns the dirs it created, outermost first. */
export async function ensureDir(dir: string): Promise<string[]> {
  const missing = await missingDirs(dir);
  if (missing.length > 0) await mkdir(dir, { recursive: true });
  return missing;
}

/** mkdir -p with 0700 on every level it creates, and chmod 0700 on `dir`. */
export async function privateDir(dir: string): Promise<void> {
  const missing = await missingDirs(dir);
  if (missing.length > 0) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const made of missing) await chmod(made, 0o700);
  await chmod(dir, 0o700);
}

/** writeAtomic with mode 0600, after privateDir(dirname). */
export async function writePrivate(file: string, text: string | Uint8Array): Promise<void> {
  await privateDir(path.dirname(file));
  await writeAtomic(file, text, 0o600);
}

/** What is at `p` itself: a link (a symlink or a junction) is a link, whatever it leads to. */
export async function entryKind(p: string): Promise<"dir" | "file" | "link" | "missing" | "other"> {
  try {
    const info = await lstat(p);
    if (info.isSymbolicLink()) return "link";
    return info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

/**
 * rename; on EXDEV, across file systems: `from` is renamed aside in its own folder first, then
 * cp(aside, temp next to `to`, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
 * and the temp renamed to `to`, then rm(aside, { recursive: true }). Neither follows a link inside.
 * So `from` is empty from before a copy can exist, and `to` holds the whole copy or nothing: a
 * move cut short is never taken for one made. A copy that fails is removed and `from` put back.
 */
export async function moveTo(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  const aside = besideName(from, "moving");
  const copy = besideName(to, "copying");
  await rename(from, aside);
  try {
    await cp(aside, copy, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    });
    await rename(copy, to);
  } catch (error) {
    await rm(copy, { recursive: true, force: true }).catch(() => {});
    await rename(aside, from).catch(() => {});
    throw error;
  }
  await rm(aside, { recursive: true });
}

/**
 * A link's target, resolved from the link's folder as read.ts's entryInfo resolves it, and the
 * kind of link to make it again: on Windows a junction for a folder, which needs no privilege.
 */
export async function readLinkInfo(p: string): Promise<{ target: string; type: "dir" | "file" | "junction" }> {
  const target = path.resolve(path.dirname(p), await readlink(p));
  const followed = await stat(p).catch(() => null);
  if (process.platform === "win32") return { target, type: followed && !followed.isDirectory() ? "file" : "junction" };
  return { target, type: followed?.isDirectory() ? "dir" : "file" };
}

/** unlink; on win32 when that fails with EPERM or EISDIR, rmdir. Never recursive: the target is not touched. */
export async function removeLink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR")) throw error;
    await rmdir(p);
  }
}

export async function makeLink(target: string, p: string, type: "dir" | "file" | "junction"): Promise<void> {
  await symlink(target, p, type);
}

export async function removeFile(p: string): Promise<void> {
  await unlink(p);
}

/** Each dir, innermost first, when it is empty: the first that is not keeps every one above it. */
export async function removeEmptyDirs(dirs: readonly string[]): Promise<void> {
  for (const dir of [...dirs].reverse()) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
  }
}

/** A folder's entries; none when it is not there. */
export async function listEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * rm -r of `dir` only when it is a real dir inside `within` (isWithin, lstat): not a link, not
 * `within` itself, and inside it by its real path too, so a linked folder on the way cannot lead
 * the remove out. rm -r unlinks the links it meets inside, never what they lead to.
 */
export async function removeTree(dir: string, within: string): Promise<void> {
  const info = await lstat(dir);
  const [real, root] = await Promise.all([realpath(dir), realpath(within)]);
  const inside = (p: string, outer: string) => isWithin(p, outer) && !samePath(p, outer);
  if (!info.isDirectory() || !inside(dir, within) || !inside(real, root)) {
    throw new Error(`${dir} is not a folder inside ${within}`);
  }
  await rm(dir, { recursive: true });
}

/** fn under acquireDirLock(lockPath, options); "locked" when it was not won in time. */
export async function withLock<T>(
  lockPath: string,
  options: DirLockOptions,
  fn: () => Promise<T>,
): Promise<T | "locked"> {
  const release = await acquireDirLock(lockPath, options);
  if (!release) return "locked";
  try {
    return await fn();
  } finally {
    await release();
  }
}
