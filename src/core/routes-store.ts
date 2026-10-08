import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { acquireFileLock } from "./file-lock.js";
import { checkRoutesFile, emptyRoutesFile, type RoutesFile } from "./route-config.js";

/**
 * ~/.clausona/routes.json (the user's routes) and ~/.clausona/route-picks.json (when each
 * profile was last picked, for round-robin). Both are clausona's own files, written whole and
 * atomically under their own lock; neither is profiles.json, so editing routes never touches
 * the launch cache.
 */

export type RoutesPaths = { routesPath: string; picksPath: string; routesLock: string; picksLock: string };

/** Evaluated per call, so a test that points HOME elsewhere gets its own files. */
export function routesPaths(clausonaDir: string = path.join(homedir(), ".clausona")): RoutesPaths {
  return {
    routesPath: path.join(clausonaDir, "routes.json"),
    picksPath: path.join(clausonaDir, "route-picks.json"),
    routesLock: path.join(clausonaDir, "locks", "routes.lock"),
    picksLock: path.join(clausonaDir, "locks", "route-picks.lock"),
  };
}

/** Holders finish in milliseconds; one older than this died holding the lock. */
const LOCK_STALE_MS = 10_000;
const ROUTES_LOCK_WAIT_MS = 5_000;
/** Routing never blocks a launch on its own bookkeeping for longer than this. */
const PICKS_LOCK_WAIT_MS = 2_000;

export class RoutesFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly problems: string[],
    readonly newer = false,
  ) {
    super(
      [
        `${filePath} cannot be used:`,
        ...problems.map((problem) => `    ${problem}`),
        ...(newer ? [] : ["  Fix it with `clausona route edit`, or by hand."]),
      ].join("\n"),
    );
    this.name = "RoutesFileError";
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Written aside and renamed into place, so a reader never sees half a file. */
async function writeAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

const toText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Where JSON.parse stopped in `body`, when its message says. Its message is never passed on: it
 * quotes the text around the error, and a key pasted into a pattern list would be quoted with it
 * (as `registryProblem` keeps it out for profiles.json). Node 20 gives only the position, so the
 * line and column are counted here.
 */
function jsonProblem(error: unknown, body: string): string {
  const position = /in JSON at position (\d+)/.exec(error instanceof Error ? error.message : "");
  if (!position) return "not valid JSON";
  const before = body.slice(0, Number(position[1]));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `not valid JSON (line ${line}, column ${column})`;
}

export function parseRoutesText(text: string, filePath: string): RoutesFile {
  // Windows Notepad saves UTF-8 with a byte-order mark, which JSON.parse refuses.
  const body = text.replace(/^\uFEFF/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new RoutesFileError(filePath, [jsonProblem(error, body)]);
  }
  const check = checkRoutesFile(raw);
  if (!check.ok) throw new RoutesFileError(filePath, check.problems, check.newerVersion !== undefined);
  return check.file;
}

/** routes.json exactly as it is on disk, or null when there is none: what `route edit` starts from. */
export function readRoutesText(paths: RoutesPaths = routesPaths()): Promise<string | null> {
  return readText(paths.routesPath);
}

export async function readRoutes(paths: RoutesPaths = routesPaths()): Promise<RoutesFile> {
  const text = await readText(paths.routesPath);
  return text === null ? emptyRoutesFile() : parseRoutesText(text, paths.routesPath);
}

async function withRoutesLock<T>(paths: RoutesPaths, fn: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(paths.routesLock, { staleMs: LOCK_STALE_MS, waitMs: ROUTES_LOCK_WAIT_MS });
  if (!release) {
    throw new Error(
      `Timed out waiting for another clausona process to release ${paths.routesLock}. If none is running, delete that file and try again.`,
    );
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Changes routes.json as it stands under the lock. `update` gets a copy and returns the file to
 * write, or null to leave it alone; what it returns is checked before anything is written.
 */
export async function updateRoutes(
  update: (current: RoutesFile) => RoutesFile | null,
  paths: RoutesPaths = routesPaths(),
): Promise<RoutesFile> {
  return withRoutesLock(paths, async () => {
    const current = await readRoutes(paths);
    const next = update(structuredClone(current));
    if (next === null) return current;
    const check = checkRoutesFile(next);
    if (!check.ok) throw new Error(check.problems.join("\n"));
    await writeAtomic(paths.routesPath, toText(check.file));
    return check.file;
  });
}

/**
 * Writes an edited routes.json as the user saved it, if the file is still what the edit
 * started from (`expected`, null for no file). The caller has already checked `text`.
 */
export async function replaceRoutesText(
  expected: string | null,
  text: string,
  paths: RoutesPaths = routesPaths(),
): Promise<void> {
  await withRoutesLock(paths, async () => {
    if ((await readText(paths.routesPath)) !== expected) {
      throw new Error(
        `${paths.routesPath} changed while you were editing, so your edit was not saved. Run \`clausona route edit\` again.`,
      );
    }
    await writeAtomic(paths.routesPath, text.endsWith("\n") ? text : `${text}\n`);
  });
}

export async function readPicks(paths: RoutesPaths = routesPaths()): Promise<Record<string, string>> {
  const text = await readText(paths.picksPath).catch(() => null);
  if (text === null) return {};
  try {
    const raw = JSON.parse(text) as { version?: unknown; lastPicked?: unknown };
    if (raw.version !== 1 || typeof raw.lastPicked !== "object" || raw.lastPicked === null) return {};
    return Object.fromEntries(
      Object.entries(raw.lastPicked as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    // A broken record costs one round-robin turn, never a launch.
    return {};
  }
}

/**
 * Picks under the pick-record lock and records the choice, so picks made at the same moment
 * see each other. A lock that cannot be had within 2 s picks from the record as it is and
 * records nothing.
 */
export async function pickWithRecord<T>(
  choose: (lastPicked: Record<string, string>) => { result: T; picked?: string },
  clock: () => number,
  paths: RoutesPaths = routesPaths(),
): Promise<T> {
  const release = await acquireFileLock(paths.picksLock, { staleMs: LOCK_STALE_MS, waitMs: PICKS_LOCK_WAIT_MS }).catch(
    () => null,
  );
  try {
    const lastPicked = await readPicks(paths);
    const { result, picked } = choose(lastPicked);
    if (release && picked) {
      const next = { version: 1, lastPicked: { ...lastPicked, [picked]: new Date(clock()).toISOString() } };
      await writeAtomic(paths.picksPath, toText(next)).catch(() => {});
    }
    return result;
  } finally {
    await release?.();
  }
}
