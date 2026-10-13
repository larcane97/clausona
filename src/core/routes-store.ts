import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { acquireFileLock } from "./file-lock.js";
import {
  type BrokenRoute,
  checkRouteName,
  checkRoutesFile,
  emptyRoutesFile,
  type RouteSpec,
  type RoutesFile,
} from "./route-config.js";

/**
 * ~/.clausona/routes.json (the user's routes) and ~/.clausona/route-picks.json (when each
 * profile was last picked, for round-robin). Both are clausona's own files, written whole and
 * atomically under their own lock; neither is profiles.json, so editing routes never touches
 * the launch cache.
 */

export type RoutesPaths = {
  routesPath: string;
  picksPath: string;
  /** Where `route edit` keeps an edit it could not save because routes.json changed meanwhile. */
  editPath: string;
  routesLock: string;
  picksLock: string;
};

/** Evaluated per call, so a test that points HOME elsewhere gets its own files. */
export function routesPaths(clausonaDir: string = path.join(homedir(), ".clausona")): RoutesPaths {
  return {
    routesPath: path.join(clausonaDir, "routes.json"),
    picksPath: path.join(clausonaDir, "route-picks.json"),
    editPath: path.join(clausonaDir, "routes.edit.json"),
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

/**
 * Written aside and renamed into place, so a reader never sees half a file. `mode` is the new
 * file's, so it holds over a file already there too.
 */
async function writeAtomic(filePath: string, text: string, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
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
  // "… in JSON at position N", and "… after JSON at position N" for text after the closing brace.
  const position = /JSON at position (\d+)/.exec(error instanceof Error ? error.message : "");
  if (!position) return "not valid JSON";
  const before = body.slice(0, Number(position[1]));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `not valid JSON (line ${line}, column ${column})`;
}

/** The text as routes.json, checked: its shape as a whole, which a RoutesFileError refuses, and each route on its own. */
function checkText(text: string, filePath: string): { file: RoutesFile; broken: BrokenRoute[] } {
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
  return check;
}

/** routes.json as `route edit` saves it: every route of it has to check out. */
export function parseRoutesText(text: string, filePath: string): RoutesFile {
  const { file, broken } = checkText(text, filePath);
  if (broken.length > 0)
    throw new RoutesFileError(
      filePath,
      broken.flatMap((route) => route.problems),
    );
  return file;
}

/** routes.json exactly as it is on disk, or null when there is none: what `route edit` starts from. */
export function readRoutesText(paths: RoutesPaths = routesPaths()): Promise<string | null> {
  return readText(paths.routesPath);
}

/**
 * routes.json as read: the routes that can be used, and the ones that cannot with their problems.
 * A file that cannot be read as routes at all - not JSON, another version, no object of routes -
 * is refused whole, with a RoutesFileError.
 */
export type LoadedRoutes = { filePath: string; file: RoutesFile; broken: BrokenRoute[] };

export async function loadRoutes(paths: RoutesPaths = routesPaths()): Promise<LoadedRoutes> {
  const text = await readText(paths.routesPath);
  const { file, broken } = text === null ? { file: emptyRoutesFile(), broken: [] } : checkText(text, paths.routesPath);
  return { filePath: paths.routesPath, file, broken };
}

/** The routes that can be used. */
export async function readRoutes(paths: RoutesPaths = routesPaths()): Promise<RoutesFile> {
  return (await loadRoutes(paths)).file;
}

/**
 * How to get past routes that cannot be used: `route edit`, or removing each one whose name can
 * be shown and typed.
 */
export function brokenRoutesHint(broken: BrokenRoute[]): string {
  const removable = broken.map((route) => route.name).filter((name) => checkRouteName(name) === null);
  const edit = `Fix ${broken.length === 1 ? "it" : "them"} with clausona route edit`;
  if (removable.length === 0) return `${edit}.`;
  const remove = removable.map((name) => `clausona route remove ${name}`).join(", ");
  return `${edit}, or remove ${removable.length === 1 ? "the route" : "the routes"}: ${remove}.`;
}

/** Why a write was refused: the file it would write still has routes that cannot be used. */
function refusal(filePath: string, broken: BrokenRoute[]): Error {
  const count = broken.length === 1 ? "a route" : `${broken.length} routes`;
  return new Error(
    [
      `${filePath} has ${count} that cannot be used, so nothing was saved:`,
      ...broken.flatMap((route) => route.problems).map((problem) => `    ${problem}`),
      `  ${brokenRoutesHint(broken)}`,
    ].join("\n"),
  );
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
 *
 * The copy holds the routes that cannot be used too, as they are stored, so that removing one,
 * or a `route set` that mends it, can be written. A file that would still hold one is not: the
 * write is refused with its problems and the way out.
 */
export async function updateRoutes(
  update: (current: RoutesFile) => RoutesFile | null,
  paths: RoutesPaths = routesPaths(),
): Promise<RoutesFile> {
  return withRoutesLock(paths, async () => {
    const { file, broken } = await loadRoutes(paths);
    const current = structuredClone(file);
    // Built rather than assigned: a broken route may be called `__proto__`, which assignment drops.
    current.routes = Object.fromEntries([
      ...Object.entries(current.routes),
      ...broken.map((route): [string, RouteSpec] => [route.name, structuredClone(route.spec) as RouteSpec]),
    ]);
    const next = update(current);
    if (next === null) return file;
    const check = checkRoutesFile(next);
    if (!check.ok) throw new Error(check.problems.join("\n"));
    if (check.broken.length > 0) throw refusal(paths.routesPath, check.broken);
    await writeAtomic(paths.routesPath, toText(check.file));
    return check.file;
  });
}

/** Whether two texts hold the same JSON, however they are spaced; false when either is not JSON. */
function sameJson(a: string, b: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(a.replace(/^\uFEFF/, "")), JSON.parse(b.replace(/^\uFEFF/, "")));
  } catch {
    return false;
  }
}

/**
 * Writes an edited routes.json as the user saved it, if the file is still what the edit
 * started from (`expected`, null for no file). The caller has already checked `text`.
 *
 * When the file changed meanwhile, the edit is kept in routes.edit.json, 0600 as the editor's own
 * scratch file is (it can hold whatever was typed), for the user to paste into the next edit.
 * That copy goes once an edit saves what it holds, and stays through any other save.
 */
export async function replaceRoutesText(
  expected: string | null,
  text: string,
  paths: RoutesPaths = routesPaths(),
): Promise<void> {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  await withRoutesLock(paths, async () => {
    if ((await readText(paths.routesPath)) !== expected) {
      const kept = await writeAtomic(paths.editPath, body, 0o600).then(
        () => true,
        () => false,
      );
      throw new Error(
        kept
          ? `${paths.routesPath} changed while you were editing, so your edit was not saved. It is kept in ${paths.editPath}: run \`clausona route edit\` and paste it in.`
          : `${paths.routesPath} changed while you were editing, so your edit was not saved. Run \`clausona route edit\` again.`,
      );
    }
    await writeAtomic(paths.routesPath, body);
    const kept = await readText(paths.editPath).catch(() => null);
    if (kept !== null && sameJson(kept, text)) await rm(paths.editPath, { force: true }).catch(() => {});
  });
}

const PICKS_VERSION = 1;

/** The pick record, and whether a pick may write over it. */
type PickRecord = { lastPicked: Record<string, string>; writable: boolean };

async function readPickRecord(paths: RoutesPaths): Promise<PickRecord> {
  const text = await readText(paths.picksPath).catch(() => null);
  if (text === null) return { lastPicked: {}, writable: true };
  try {
    const raw = JSON.parse(text) as { version?: unknown; lastPicked?: unknown } | null;
    // Another version's record is that version's, as a newer routes.json is: picks are made from
    // nothing and go unrecorded rather than write over it.
    if (typeof raw?.version === "number" && raw.version !== PICKS_VERSION) return { lastPicked: {}, writable: false };
    if (raw?.version !== PICKS_VERSION || typeof raw.lastPicked !== "object" || raw.lastPicked === null) {
      return { lastPicked: {}, writable: true };
    }
    const lastPicked = Object.fromEntries(
      Object.entries(raw.lastPicked as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return { lastPicked, writable: true };
  } catch {
    // A broken record costs one round-robin turn, never a launch.
    return { lastPicked: {}, writable: true };
  }
}

export async function readPicks(paths: RoutesPaths = routesPaths()): Promise<Record<string, string>> {
  return (await readPickRecord(paths)).lastPicked;
}

/**
 * Picks under the pick-record lock and records the choice, so picks made at the same moment
 * see each other. A lock that cannot be had within 2 s picks from the record as it is and
 * records nothing; so does a record of another version, which is left as it is.
 *
 * `registered` are the profiles there are now: a removed one's pick time is dropped as the record
 * is written. Round-robin compares pick times only among a route's members, which are registered.
 */
export async function pickWithRecord<T>(
  choose: (lastPicked: Record<string, string>) => { result: T; picked?: string },
  clock: () => number,
  paths: RoutesPaths = routesPaths(),
  registered?: ReadonlySet<string>,
): Promise<T> {
  const release = await acquireFileLock(paths.picksLock, { staleMs: LOCK_STALE_MS, waitMs: PICKS_LOCK_WAIT_MS }).catch(
    () => null,
  );
  try {
    const { lastPicked, writable } = await readPickRecord(paths);
    const { result, picked } = choose(lastPicked);
    if (release && picked && writable) {
      const kept = Object.entries(lastPicked).filter(([id]) => !registered || registered.has(id));
      const next = {
        version: PICKS_VERSION,
        lastPicked: { ...Object.fromEntries(kept), [picked]: new Date(clock()).toISOString() },
      };
      await writeAtomic(paths.picksPath, toText(next)).catch(() => {});
    }
    return result;
  } finally {
    await release?.();
  }
}
