import path from "node:path";

/**
 * Claude Code's list of installed plugins, `plugins/installed_plugins.json` (version 2): for
 * each plugin id, one record per place it is installed - `user`, or `project` and `local` with
 * the project's path - each with the `installPath` of the cached version it loads.
 *
 * Each Claude profile keeps a list of its own, because the paths in it are absolute, and
 * `claude plugin install`, `update` and `uninstall` rewrite only the list of the profile they
 * run in. The plugin sync keeps the lists in step: it keeps a shared list beside the primary's,
 * folds into it what any profile changed since clausona last wrote or read that profile's list,
 * and writes the result to the primary and to the profile being synced, less any record whose
 * folder is not on disk. This module is the part of that which only computes; the files are
 * read and written in service.ts.
 */

export type PluginRecord = Record<string, unknown>;

/** The `plugins` of an installed_plugins.json: each plugin id with its records. */
export type PluginInstalls = Record<string, PluginRecord[]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `plugins` of a parsed installed_plugins.json, or null for anything that is not a version 2
 * list of records. A list this cannot read is never taken for an empty one: that would read as
 * every plugin in it uninstalled.
 */
export function parseInstalls(json: unknown): PluginInstalls | null {
  if (!isObject(json) || json.version !== 2) return null;
  if (json.plugins === undefined) return {};
  if (!isObject(json.plugins)) return null;
  const installs: PluginInstalls = {};
  for (const [id, records] of Object.entries(json.plugins)) {
    if (!Array.isArray(records) || !records.every(isObject)) return null;
    installs[id] = records;
  }
  return installs;
}

/**
 * `installPath` moved into `configDir`'s plugins/: what follows the config dir's `plugins`
 * stays, the directory before it becomes `configDir`. That `plugins` is the last one followed by
 * `cache` or `marketplaces`, the rule Claude Code itself uses to find a config dir in a path, so
 * a plugin or version named `plugins` is not mistaken for it. A path with no such part is moved
 * at its first `plugins`, as clausona always did, and one with none at all is left as it is.
 * Either separator, since a list can be written on Windows.
 */
export function relocateInstallPath(installPath: string, configDir: string): string {
  const parts = installPath.split(/[/\\]/);
  let at = -1;
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] === "plugins" && (parts[i + 1] === "cache" || parts[i + 1] === "marketplaces")) {
      at = i;
      break;
    }
  }
  if (at === -1) at = parts.indexOf("plugins", 1);
  if (at === -1 || at === parts.length - 1) return installPath;
  return path.join(configDir, "plugins", ...parts.slice(at + 1));
}

/** Every record's installPath moved into `configDir`, as relocateInstallPath does. */
export function relocateInstalls(installs: PluginInstalls, configDir: string): PluginInstalls {
  const moved: PluginInstalls = {};
  for (const [id, records] of Object.entries(installs)) {
    moved[id] = records.map((record) =>
      typeof record.installPath === "string"
        ? { ...record, installPath: relocateInstallPath(record.installPath, configDir) }
        : record,
    );
  }
  return moved;
}

/**
 * A record's place: its plugin, its scope and, for `project` and `local`, its project. Claude
 * Code keeps one record per place, and an install, update or uninstall changes one place.
 */
function placeOf(id: string, record: PluginRecord): string {
  const scope = typeof record.scope === "string" ? record.scope : "";
  const project = typeof record.projectPath === "string" ? record.projectPath : "";
  return JSON.stringify([id, scope, project]);
}

type Placed = { id: string; record: PluginRecord };

/** Each place in `installs` with its record, in the list's order. The first of two wins, as in Claude Code. */
function places(installs: PluginInstalls): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  for (const [id, records] of Object.entries(installs)) {
    for (const record of records) {
      const place = placeOf(id, record);
      if (!placed.has(place)) placed.set(place, { id, record });
    }
  }
  return placed;
}

/** JSON with each object's keys sorted, so two records written in another key order compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isObject(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

export function sameRecord(a: PluginRecord, b: PluginRecord): boolean {
  return canonical(a) === canonical(b);
}

/** When a record was last changed: Claude Code stamps `lastUpdated` on every install and update. */
function recordTime(record: PluginRecord): number {
  for (const key of ["lastUpdated", "installedAt"]) {
    const value = record[key];
    const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

export type ProfileInstalls = {
  /**
   * The profile's list as it is now, its paths under the primary's config dir. Null when it has
   * no list, or one that cannot be read: there is nothing to learn from it then.
   */
  current: PluginInstalls | null;
  /**
   * The list as clausona last wrote it to the profile or read it there, in the same form. Null
   * when the profile has never been synced, or its record is gone: then nothing it lacks counts
   * as an uninstall, and what it lists counts as an install only as `joinedAfter` says.
   */
  base: PluginInstalls | null;
  /** When the profile's list was last written, in ms: the time of every uninstall in it. */
  changedAt: number;
};

export type MergeOptions = {
  /** Whether a record's folder is on disk. One that is not still counts, but loses to one that is. */
  loads: (record: PluginRecord) => boolean;
  /**
   * For a profile with no base, when the last sync anywhere was, in ms: only a record it changed
   * after that is an install or update of its own, and the rest of its list is taken to be an
   * old copy of the shared one. Undefined for the very first sync, which has no shared list to
   * go by, and takes every record each profile lists.
   */
  joinedAfter?: number;
};

/** A record a place should end with, or null to drop the place, and when that was decided. */
type Candidate = { record: PluginRecord | null; time: number };

/**
 * The shared list after every profile's changes since its base are folded into `shared`, the
 * shared list as the last sync left it (null for the first).
 *
 * A place a profile lists differently from its base was installed or updated there; a place
 * its base has and its list does not was uninstalled there. A place no profile changed keeps
 * the shared record, so a profile that merely still lists a plugin someone uninstalled - it has
 * not been synced since - does not bring it back. When more than one profile changed a place,
 * or a change meets a shared record newer than it, the latest wins: a record's time is its
 * `lastUpdated`, an uninstall's the time its list was written. On a tie a change beats the
 * shared record, and the earlier profile beats the later.
 *
 * A record whose folder is not on disk stays, so a version that is only gone for now is back
 * once its folder is; it is written to no profile meanwhile (see loadableInstalls). It loses to
 * any record of the same place that loads and to any uninstall, whatever their times: a
 * profile's leftover from a cache of its own must not hide the version everyone can load.
 *
 * The shared list's order is kept; places that are new follow, in the order the profiles are
 * given.
 */
export function mergeInstalls(
  shared: PluginInstalls | null,
  profiles: readonly ProfileInstalls[],
  { loads, joinedAfter }: MergeOptions,
): PluginInstalls {
  const start = places(shared ?? {});
  const order = new Map<string, string>([...start].map(([place, { id }]) => [place, id]));
  const changes = new Map<string, Candidate[]>();
  const propose = (place: string, id: string, candidate: Candidate) => {
    if (!order.has(place)) order.set(place, id);
    const list = changes.get(place) ?? [];
    list.push(candidate);
    changes.set(place, list);
  };

  for (const profile of profiles) {
    if (profile.current === null) continue;
    const now = places(profile.current);
    const before = profile.base === null ? null : places(profile.base);
    for (const [place, { id, record }] of now) {
      const was = before?.get(place);
      if (was && sameRecord(was.record, record)) continue;
      const time = recordTime(record);
      if (before === null && joinedAfter !== undefined && time <= joinedAfter) continue;
      propose(place, id, { record, time });
    }
    if (before === null) continue;
    for (const [place, { id }] of before) {
      if (!now.has(place)) propose(place, id, { record: null, time: profile.changedAt });
    }
  }

  const latest = (candidates: Candidate[]) => {
    let winner: Candidate | undefined;
    for (const candidate of candidates) if (!winner || candidate.time > winner.time) winner = candidate;
    return winner;
  };
  const merged: PluginInstalls = {};
  for (const [place, id] of order) {
    const kept = start.get(place);
    const candidates = [
      ...(changes.get(place) ?? []),
      ...(kept ? [{ record: kept.record, time: recordTime(kept.record) }] : []),
    ];
    const firm = candidates.filter((candidate) => candidate.record === null || loads(candidate.record));
    const winner = latest(firm.length > 0 ? firm : candidates);
    if (!winner?.record) continue;
    if (!merged[id]) merged[id] = [];
    merged[id].push(winner.record);
  }
  return merged;
}

/** `installs` without the records whose folder is not on disk: what a profile is given to load. */
export function loadableInstalls(installs: PluginInstalls, loads: (record: PluginRecord) => boolean): PluginInstalls {
  const loadable: PluginInstalls = {};
  for (const [id, records] of Object.entries(installs)) {
    const kept = records.filter(loads);
    if (kept.length > 0) loadable[id] = kept;
  }
  return loadable;
}

/** Whether a list has no records at all. */
export function isEmptyInstalls(installs: PluginInstalls): boolean {
  return Object.values(installs).every((records) => records.length === 0);
}

/**
 * How `here` differs from `there`, one line per place, for doctor: a version on each side, or
 * which side has it. Both lists in the same form. Sorted by plugin id.
 */
export function describeDifferences(here: PluginInstalls, there: PluginInstalls, home: string): string[] {
  const ours = places(here);
  const theirs = places(there);
  const lines: { id: string; line: string }[] = [];
  const version = (record: PluginRecord) => (typeof record.version === "string" ? record.version : undefined);
  for (const place of new Set([...ours.keys(), ...theirs.keys()])) {
    const mine = ours.get(place);
    const other = theirs.get(place);
    if (mine && other && sameRecord(mine.record, other.record)) continue;
    const { id, record } = (mine ?? other) as Placed;
    const project = typeof record.projectPath === "string" ? record.projectPath.replace(home, "~") : undefined;
    const name =
      record.scope === "project" || record.scope === "local" ? `${id} (${record.scope}, ${project ?? "?"})` : id;
    let line: string;
    if (!other) line = `${name} only here`;
    else if (!mine) line = `${name} missing here`;
    else if (version(mine.record) !== version(other.record)) {
      line = `${name} ${version(mine.record) ?? "unversioned"} here, ${version(other.record) ?? "unversioned"} in the primary`;
    } else line = `${name} recorded differently`;
    lines.push({ id, line });
  }
  return lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(({ line }) => line);
}
