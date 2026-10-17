/**
 * ~/.clausona/notices.json: what clausona has told or asked the user, so that it asks once. The
 * star's question (star.ts) and the update's daily check (update.ts) both keep their record here.
 */

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { acquireFileLock } from "./file-lock.js";

export type NoticesDeps = { path: string; now: () => number; env: NodeJS.ProcessEnv };

export type Notices = Record<string, unknown>;

export function noticesPath(clausonaDir: string = path.join(homedir(), ".clausona")): string {
  return path.join(clausonaDir, "notices.json");
}

export function defaultNoticesDeps(): NoticesDeps {
  return { path: noticesPath(), now: Date.now, env: process.env };
}

/** The record, `{}` when there is none yet, or null when the file is there but cannot be read as one. */
export async function readNotices(filePath: string): Promise<Notices | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Notices) : null;
  } catch {
    return null;
  }
}

/** Written aside and renamed into place, so a reader never sees half a file. */
async function writeNotices(filePath: string, notices: Notices): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(notices, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Every write holds it for one read and one write of a small file. */
const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 2_000;

/**
 * Reads the record and writes it back with `change` applied, under a lock, so that writes made at
 * the same time all land: the dashboard claims the star while its update check records a tag, and
 * a command's question waits for its answer while the background check writes. `change` returns
 * null to leave the file as it is. A record that cannot be read as one is left alone, or with
 * `unreadable` given, `change` is applied to that instead. True when something was written; never
 * throws.
 *
 * The directory has to be there already. clausona's own is made by init and removed by uninstall,
 * and the background check can still be running after an uninstall: it must not make it again.
 */
export async function changeNotices(
  filePath: string,
  change: (notices: Notices) => Notices | null,
  options: { unreadable?: Notices; waitMs?: number } = {},
): Promise<boolean> {
  try {
    const directory = path.dirname(filePath);
    if (!(await stat(directory)).isDirectory()) return false;
    const lockPath = path.join(directory, "locks", "notices.lock");
    const release = await acquireFileLock(lockPath, {
      staleMs: LOCK_STALE_MS,
      waitMs: options.waitMs ?? LOCK_WAIT_MS,
    });
    if (!release) return false;
    try {
      const notices = (await readNotices(filePath)) ?? options.unreadable ?? null;
      const changed = notices && change(notices);
      if (!changed) return false;
      await writeNotices(filePath, changed);
      return true;
    } finally {
      await release();
    }
  } catch {
    return false;
  }
}

/** A time the record keeps, as milliseconds, or NaN when it holds none or one that does not parse. */
export function timeIn(notices: Notices, key: string): number {
  const value = notices[key];
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** CI as most runners set it; `false` and `0` are how a user says it is not. */
export function onCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}
