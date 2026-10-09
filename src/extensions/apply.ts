import path from "node:path";

import type { ExtensionsCommand, Reach, Stop, Verb } from "./actions.js";
import { bytesHash, canonical, valueHash } from "./hash.js";
import { backupRoot, stashDir } from "./places.js";
import type { Expect, FileChange, Plan } from "./plan.js";
import { hashTree, isRecord, samePath } from "./read.js";
import { parseStash, type StashFile, stashItem, stashText } from "./stash.js";
import {
  CLAUDE_JSON_LOCK,
  ensureDir,
  entryKind,
  type FileRead,
  listEntries,
  makeLink,
  moveTo,
  privateDir,
  readLinkInfo,
  readMaybe,
  realOrSelf,
  removeEmptyDirs,
  removeFile,
  removeLink,
  removeTree,
  withLock,
  writeAtomic,
  writePrivate,
} from "./writers/fs.js";
import {
  editJson,
  entryAt,
  type JsonEdit,
  JsonEditError,
  NO_PROJECT,
  readJsonText,
  resolvePath,
  touchedPath,
  valueAt,
  withValueAt,
  writeJsonText,
} from "./writers/json.js";
import { editToml, parseTomlText, type SkillSelector, selects, TomlEditError, tomlValueAt } from "./writers/toml.js";

/**
 * A plan carried out: every file it touches backed up first under
 * `~/.clausona/backups/extensions/<operation id>/` with a manifest, `.claude.json` changed only
 * under Claude Code's own lock, each file re-read and its expects checked just before it is
 * written, and the first change that cannot go ahead stops the rest. Undo walks the newest
 * operation back, putting back only what still holds what the apply wrote. Every write goes
 * through writers/fs.ts.
 */

export type WriteEnv = {
  homeDir: string;
  backupRoot: string;
  stashDir: string;
  now: () => number;
  lockWaitMs?: number;
};

export function writeEnvFor(homeDir: string, now: () => number = Date.now): WriteEnv {
  return { homeDir, backupRoot: backupRoot(homeDir), stashDir: stashDir(homeDir), now };
}

export const KEEP_OPERATIONS = 50;

/** e.g. 20261010T043648123Z-skills-rm, 20261010T043648123Z-mcp-off-everywhere; "-2", "-3" on a clash. */
export const OP_ID_RE = /^\d{8}T\d{9}Z-(skills|mcp|hooks)-(off|on|visibility|rm)(-everywhere)?(-\d+)?$/;

export function operationId(now: number, plan: Plan): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "");
  // rm has no reach.
  const everywhere = plan.verb !== "rm" && plan.reach === "everywhere" ? "-everywhere" : "";
  return `${stamp}-${plan.command}-${plan.verb}${everywhere}`;
}

export type ManifestEntry = {
  /** The real path changed: a file edited or created, a folder or file moved, a link removed, a stash file. */
  path: string;
  /**
   * The path as the plan named it, when that is not `path`: a file reached through a link, or
   * through a linked folder above it. A `lock` is taken at `<named ?? path>.lock`, where Claude
   * Code takes it.
   */
  named?: string;
  what: "json" | "toml" | "folder" | "file" | "link" | "stash";
  change: "edited" | "created" | "removed";
  /** The copy of what was there, relative to the operation dir ("files/3"); null for a new file or a link. */
  backup: string | null;
  link?: { target: string; type: "dir" | "file" | "junction" };
  /** bytesHash of a file, hashTree of a folder, null when it was not there. */
  hashBefore: string | null;
  /** bytesHash after; null when removed. */
  hashAfter: string | null;
  /** JSON only: each path an edit changed (touchedPath) and valueHash of what it holds after (null = absent). */
  touched?: { path: (string | number)[]; hash: string | null }[];
  createdDirs?: string[];
  lock?: true;
  /**
   * A stash file: the index in `entries` of the JSON edit it goes with. Undo removes it, or puts
   * it back, only once that edit is undone or was never made, so the entry ends up in exactly one
   * place: the tool's file or the stash.
   */
  with?: number;
  /** Set once an undo has dealt with it - put back, or left alone for good. A `locked` skip leaves it unset, to try again. */
  undone?: UndoOutcome;
  done: boolean;
};

export type Manifest = {
  version: 1;
  id: string;
  command: ExtensionsCommand;
  verb: Verb;
  reach: Reach;
  /** plan.done */
  summary: string;
  project: string | null;
  createdAt: string;
  status: "applying" | "applied" | "stopped";
  stop?: Stop;
  undoneAt: string | null;
  undo?: { restored: string[]; skipped: { file: string; reason: string }[] };
  entries: ManifestEntry[];
};

export type OperationRef = { id: string; dir: string; command: ExtensionsCommand; summary: string; createdAt: string };

export type ApplyResult =
  | { status: "applied"; operation: OperationRef; done: number }
  | { status: "stopped"; operation: OperationRef; done: number; total: number; stop: Stop }
  | { status: "nothing" };

export type UndoPreview = {
  operation: OperationRef;
  files: { path: string; action: "put back" | "remove" | "edit back" }[];
};
export type UndoSkip = { file: string; reason: "changed" | "occupied" | "locked" | "missing" | "failed" };
/** What undo did with one entry, once it is settled: anything but `locked`. */
export type UndoOutcome = "restored" | Exclude<UndoSkip["reason"], "locked">;
export type UndoResult = { operation: OperationRef; restored: string[]; skipped: UndoSkip[] };

const MANIFEST = "manifest.json";
const COMMANDS: ReadonlySet<string> = new Set(["skills", "mcp", "hooks"] satisfies ExtensionsCommand[]);
const WHATS: ReadonlySet<string> = new Set(["json", "toml", "folder", "file", "link", "stash"]);
const CHANGES: ReadonlySet<string> = new Set(["edited", "created", "removed"]);
const LINK_TYPES: ReadonlySet<string> = new Set(["dir", "file", "junction"]);
const OUTCOMES: ReadonlySet<string> = new Set(["restored", "changed", "occupied", "missing", "failed"]);

const hashOf = (value: unknown): string | null => (value === undefined ? null : valueHash(value));

function lockOptions(env: WriteEnv) {
  return { ...CLAUDE_JSON_LOCK, waitMs: env.lockWaitMs ?? CLAUDE_JSON_LOCK.waitMs };
}

function refOf(manifest: Manifest, dir: string): OperationRef {
  const { id, command, summary, createdAt } = manifest;
  return { id, dir, command, summary, createdAt };
}

/** Where a backup named in a manifest is; undefined for anything but `files/<n>`, which cannot lead out of `dir`. */
function backupPath(dir: string, backup: string | null): string | undefined {
  return backup !== null && /^files\/\d+$/.test(backup) ? path.join(dir, ...backup.split("/")) : undefined;
}

/** What a file is called where it is shown: as the plan named it. */
function shown(entry: ManifestEntry): string {
  return entry.named ?? entry.path;
}

// ─── Apply ──────────────────────────────────────────────────────────

/** One apply under way: its folder, its manifest, and how many backup files it has made. */
type Run = { env: WriteEnv; dir: string; manifest: Manifest; backups: number };

async function save(run: { dir: string; manifest: Manifest }): Promise<void> {
  await writePrivate(path.join(run.dir, MANIFEST), `${JSON.stringify(run.manifest, null, 2)}\n`);
}

/** The next `files/<n>`, counted from 1. */
function nextBackup(run: Run): { rel: string; abs: string } {
  run.backups += 1;
  return { rel: `files/${run.backups}`, abs: path.join(run.dir, "files", String(run.backups)) };
}

/** `base`, or `base-2`, `base-3`… when an operation of that name is there already. */
async function freeId(env: WriteEnv, base: string): Promise<string> {
  const taken = new Set(await listEntries(env.backupRoot));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const changed = (file: string): Stop => ({ file, reason: "changed" });
const failed = (file: string, detail: string): Stop => ({ file, reason: "failed", detail });

/** What a failure may say: an edit error's fixed phrase, or a file-system error's code - never a message that could quote a file. */
function detailOf(error: unknown): string {
  if (error instanceof JsonEditError || error instanceof TomlEditError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "unexpected error";
}

/**
 * Backs up what is there, records the entry - with the hash it will have, not done yet - and saves
 * the manifest, then writes `next` over the file through its link - a new file 0644, an existing
 * one in its own mode - and marks the entry done. What it records first is what undo needs if the
 * write is never recorded done. A stash entry it is given is tied to it. Returns its index.
 */
async function replaceFile(
  run: Run,
  file: string,
  what: "json" | "toml",
  read: FileRead | undefined,
  next: string,
  more: { lock?: boolean; touched?: ManifestEntry["touched"]; stash?: ManifestEntry } = {},
): Promise<number> {
  const real = read?.real ?? (await realOrSelf(file));
  let backup: string | null = null;
  if (read) {
    const into = nextBackup(run);
    await writePrivate(into.abs, read.bytes);
    backup = into.rel;
  }
  const entry: ManifestEntry = {
    path: real,
    ...(real !== file ? { named: file } : {}),
    what,
    change: read ? "edited" : "created",
    backup,
    hashBefore: read ? bytesHash(read.bytes) : null,
    // Known before the write, so a file that holds it was written, done or not.
    hashAfter: bytesHash(next),
    ...(more.touched ? { touched: more.touched } : {}),
    ...(more.lock ? { lock: true as const } : {}),
    done: false,
  };
  run.manifest.entries.push(entry);
  const at = run.manifest.entries.length - 1;
  if (more.stash) more.stash.with = at;
  await save(run);
  if (!read) {
    const made = await ensureDir(path.dirname(real));
    if (made.length > 0) {
      entry.createdDirs = made;
      await save(run);
    }
  }
  await writeAtomic(real, next, read ? read.mode & 0o777 : 0o644);
  entry.done = true;
  await save(run);
  return at;
}

/** A stash file as clausona wrote it, or undefined when it is not one. */
function parseStashText(text: string): StashFile | undefined {
  try {
    return parseStash(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function jsonExpectsHold(value: unknown, expects: readonly Expect[]): boolean {
  // Any other kind of expect is none a JSON file can meet: fail closed.
  return expects.every((e) => e.type === "value" && hashOf(valueAt(value, e.path)) === e.hash);
}

/** Each path the edits changed, once, with the fingerprint of what it holds in `next`. */
function touchedIn(next: string, edits: readonly JsonEdit[]): NonNullable<ManifestEntry["touched"]> {
  const { value } = readJsonText(next);
  const found = new Map<string, { path: (string | number)[]; hash: string | null }>();
  for (const edit of edits) {
    const at = touchedPath(value, edit);
    if (at && !found.has(canonical(at))) found.set(canonical(at), { path: at, hash: hashOf(valueAt(value, at)) });
  }
  return [...found.values()];
}

type JsonChange = Extract<FileChange, { kind: "json" }>;
type TomlChange = Extract<FileChange, { kind: "toml" }>;
type RemoveChange = Extract<FileChange, { kind: "remove" }>;

/**
 * A JSON file's change, run whole inside the lock when it takes one. First, with nothing written
 * yet: the file re-read, the kept copy a restore takes its entry from read, the expects checked
 * and the new text made. Then the writes: the stash file an entry goes into, the backup, the file,
 * and last the kept copy a restore used, into the backup.
 */
async function jsonChange(run: Run, change: JsonChange): Promise<Stop | undefined> {
  const file = change.file;
  const read = await readMaybe(file);
  if (!read && !change.create) return changed(file);
  const text = read?.text ?? "";
  let value: Record<string, unknown>;
  try {
    value = readJsonText(text).value;
  } catch (error) {
    if (error instanceof JsonEditError) return failed(file, error.message);
    throw error;
  }

  // What a restore puts back. Something at its place already is a conflict, which says more
  // than the expect of nothing there would.
  let kept: { stash: StashFile; read: FileRead; file: string } | undefined;
  if (change.fromStash !== undefined) {
    const stashRead = await readMaybe(change.fromStash);
    const stash = stashRead ? parseStashText(stashRead.text) : undefined;
    if (!stashRead || !stash) return changed(change.fromStash);
    if (change.edits.some((edit) => edit.op === "restore" && valueAt(value, edit.path) !== undefined)) {
      return { file, reason: "conflict", name: stash.name, rowKey: stashItem(stash, change.fromStash).id };
    }
    kept = { stash, read: stashRead, file: change.fromStash };
  }

  if (!jsonExpectsHold(value, change.expect)) return changed(file);

  let stashed: { file: string; text: string } | undefined;
  if (change.stash) {
    const taking = change.edits.find((edit) => edit.op === "delete" || edit.op === "hook-remove");
    const entry = taking ? entryAt(value, taking) : undefined;
    const at = resolvePath(value, change.stash.meta.path);
    if (entry === undefined || !at) return changed(file);
    // Never over another kept entry.
    if ((await entryKind(change.stash.file)) !== "missing") return changed(change.stash.file);
    const stashedAt = new Date(run.env.now()).toISOString();
    const made = stashText({ version: 1, ...change.stash.meta, path: at, entry, stashedAt });
    stashed = { file: change.stash.file, text: made };
  }

  let next: string;
  try {
    next = editJson(text, change.edits, kept?.stash.entry);
  } catch (error) {
    if (error instanceof JsonEditError)
      return error.message === NO_PROJECT ? changed(file) : failed(file, error.message);
    throw error;
  }
  // As asked already: nothing to write, back up or undo.
  if (next === text) return undefined;

  let stashEntry: ManifestEntry | undefined;
  if (stashed) {
    // Written before the entry leaves its file, so at every moment one of the two holds it.
    await writePrivate(stashed.file, stashed.text);
    stashEntry = {
      path: stashed.file,
      what: "stash",
      change: "created",
      backup: null,
      hashBefore: null,
      hashAfter: bytesHash(stashed.text),
      done: true,
    };
    run.manifest.entries.push(stashEntry);
  }
  const edited = await replaceFile(run, file, "json", read, next, {
    lock: change.lock,
    touched: touchedIn(next, change.edits),
    ...(stashEntry ? { stash: stashEntry } : {}),
  });

  if (kept) {
    // The kept copy goes into the backup, where undo finds it to put back.
    const into = nextBackup(run);
    const entry: ManifestEntry = {
      path: kept.file,
      what: "stash",
      change: "removed",
      backup: into.rel,
      hashBefore: bytesHash(kept.read.bytes),
      hashAfter: null,
      with: edited,
      done: false,
    };
    run.manifest.entries.push(entry);
    await save(run);
    await privateDir(path.dirname(into.abs));
    await moveTo(kept.file, into.abs);
    entry.done = true;
    await save(run);
  }
  return undefined;
}

/** `[[skills.config]]`'s enabled for `selector`, matched as writers/toml.ts matches it; the last of several, as the inventory reads them. Not a boolean reads as none. */
function skillEnabled(value: unknown, selector: SkillSelector): boolean | null {
  const config = tomlValueAt(value, ["skills", "config"]);
  let enabled: boolean | null = null;
  for (const entry of Array.isArray(config) ? config : []) {
    if (isRecord(entry) && selects(entry, selector) && typeof entry.enabled === "boolean") enabled = entry.enabled;
  }
  return enabled;
}

function tomlExpectsHold(value: unknown, expects: readonly Expect[]): boolean {
  return expects.every((e) => {
    if (e.type === "toml") return hashOf(tomlValueAt(value, e.path)) === e.hash;
    if (e.type === "skill-config") return skillEnabled(value, e.selector) === e.enabled;
    return false;
  });
}

async function tomlChange(run: Run, change: TomlChange): Promise<Stop | undefined> {
  const file = change.file;
  const read = await readMaybe(file);
  if (!read && !change.create) return changed(file);
  const text = read?.text ?? "";
  let next: string;
  try {
    if (!tomlExpectsHold(parseTomlText(text), change.expect)) return changed(file);
    next = editToml(text, change.edits);
  } catch (error) {
    if (error instanceof TomlEditError) return failed(file, error.message);
    throw error;
  }
  if (next === text) return undefined;
  await replaceFile(run, file, "toml", read, next);
  return undefined;
}

const KIND_OF: Record<RemoveChange["what"], "dir" | "file" | "link"> = { folder: "dir", file: "file", link: "link" };

/** Whether what is at `file` is still what the plan saw: its kind, its real path, a link's target. */
async function removalHolds(change: RemoveChange): Promise<boolean> {
  const file = change.file;
  const kind = await entryKind(file);
  if (kind !== KIND_OF[change.what]) return false;
  for (const e of change.expect) {
    if (e.type !== "entry" || e.kind !== kind) return false;
    if (e.realPath !== undefined && !samePath(await realOrSelf(file), e.realPath)) return false;
    if (e.target !== undefined && !samePath((await readLinkInfo(file)).target, e.target)) return false;
  }
  return true;
}

/** A link unlinked, never followed; a folder or a file moved into the backup, where undo finds it. */
async function removeChange(run: Run, change: RemoveChange): Promise<Stop | undefined> {
  const file = change.file;
  if (!(await removalHolds(change))) return changed(file);
  if (change.what === "link") {
    const entry: ManifestEntry = {
      path: file,
      what: "link",
      change: "removed",
      backup: null,
      link: await readLinkInfo(file),
      hashBefore: null,
      hashAfter: null,
      done: false,
    };
    run.manifest.entries.push(entry);
    await save(run);
    await removeLink(file);
    entry.done = true;
    await save(run);
    return undefined;
  }
  let hashBefore: string;
  if (change.what === "folder") {
    hashBefore = await hashTree(file);
  } else {
    const read = await readMaybe(file);
    if (!read) return changed(file);
    hashBefore = bytesHash(read.bytes);
  }
  const into = nextBackup(run);
  const entry: ManifestEntry = {
    path: file,
    what: change.what,
    change: "removed",
    backup: into.rel,
    hashBefore,
    hashAfter: null,
    done: false,
  };
  run.manifest.entries.push(entry);
  await save(run);
  await privateDir(path.dirname(into.abs));
  await moveTo(file, into.abs);
  entry.done = true;
  await save(run);
  return undefined;
}

async function applyChange(run: Run, change: FileChange): Promise<Stop | undefined> {
  try {
    switch (change.kind) {
      case "json": {
        if (!change.lock) return await jsonChange(run, change);
        const result = await withLock(`${change.file}.lock`, lockOptions(run.env), () => jsonChange(run, change));
        return result === "locked" ? { file: change.file, reason: "locked" } : result;
      }
      case "toml":
        return await tomlChange(run, change);
      case "remove":
        return await removeChange(run, change);
    }
  } catch (error) {
    return failed(change.file, detailOf(error));
  }
}

/**
 * Carries out `plan`'s changes in order, each behind a backup, and stops at the first that cannot
 * go ahead: what was done before it stays done, and undoable. A plan without changes makes
 * nothing, not even the backup folder.
 */
export async function apply(plan: Plan, env: WriteEnv): Promise<ApplyResult> {
  if (plan.changes.length === 0) return { status: "nothing" };
  const at = env.now();
  const id = await freeId(env, operationId(at, plan));
  const dir = path.join(env.backupRoot, id);
  await privateDir(dir);
  const manifest: Manifest = {
    version: 1,
    id,
    command: plan.command,
    verb: plan.verb,
    reach: plan.reach,
    summary: plan.done,
    project: plan.project,
    createdAt: new Date(at).toISOString(),
    status: "applying",
    undoneAt: null,
    entries: [],
  };
  const run: Run = { env, dir, manifest, backups: 0 };
  await save(run);

  let done = 0;
  let stop: Stop | undefined;
  for (const change of plan.changes) {
    stop = await applyChange(run, change);
    if (stop) break;
    done += 1;
  }
  manifest.status = stop ? "stopped" : "applied";
  if (stop) manifest.stop = stop;
  await save(run);
  // Pruning is housekeeping: it never fails what was applied.
  await pruneOperations(env).catch(() => []);
  const operation = refOf(manifest, dir);
  return stop
    ? { status: "stopped", operation, done, total: plan.changes.length, stop }
    : { status: "applied", operation, done };
}

// ─── Undo ───────────────────────────────────────────────────────────

/** The operation dirs, newest first by name. */
async function operationIds(env: WriteEnv): Promise<string[]> {
  return (await listEntries(env.backupRoot))
    .filter((name) => OP_ID_RE.test(name))
    .sort()
    .reverse();
}

const isHash = (value: unknown) => value === null || typeof value === "string";
const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function isTouched(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        isRecord(t) &&
        Array.isArray(t.path) &&
        t.path.every((seg) => typeof seg === "string" || isIndex(seg)) &&
        isHash(t.hash),
    )
  );
}

/** Every key an entry may hold, of its type: a damaged manifest is no manifest, and undo never trips on one. */
function isEntry(value: unknown): value is ManifestEntry {
  if (!isRecord(value)) return false;
  const { path: at, named, what, change, backup, link, hashBefore, hashAfter, touched, createdDirs } = value;
  return (
    typeof at === "string" &&
    (named === undefined || typeof named === "string") &&
    typeof what === "string" &&
    WHATS.has(what) &&
    typeof change === "string" &&
    CHANGES.has(change) &&
    (backup === null || typeof backup === "string") &&
    (link === undefined ||
      (isRecord(link) &&
        typeof link.target === "string" &&
        typeof link.type === "string" &&
        LINK_TYPES.has(link.type))) &&
    isHash(hashBefore) &&
    isHash(hashAfter) &&
    (touched === undefined || isTouched(touched)) &&
    (createdDirs === undefined || (Array.isArray(createdDirs) && createdDirs.every((d) => typeof d === "string"))) &&
    (value.lock === undefined || value.lock === true) &&
    (value.with === undefined || isIndex(value.with)) &&
    (value.undone === undefined || (typeof value.undone === "string" && OUTCOMES.has(value.undone))) &&
    typeof value.done === "boolean"
  );
}

function isManifest(value: unknown): value is Manifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.command !== "string" ||
    !COMMANDS.has(value.command) ||
    typeof value.verb !== "string" ||
    typeof value.reach !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.createdAt !== "string" ||
    !(value.undoneAt === null || typeof value.undoneAt === "string") ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isEntry)
  ) {
    return false;
  }
  const entries = value.entries as ManifestEntry[];
  // Only a stash entry goes with an edit, and that edit is a JSON one of the same operation.
  return entries.every(
    (entry) => entry.with === undefined || (entry.what === "stash" && entries[entry.with]?.what === "json"),
  );
}

/** An operation's manifest; undefined when it is missing or not one clausona wrote. */
async function readManifest(dir: string): Promise<Manifest | undefined> {
  const read = await readMaybe(path.join(dir, MANIFEST)).catch(() => undefined);
  if (!read) return undefined;
  try {
    const value: unknown = JSON.parse(read.text);
    return isManifest(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The hash of what is at `file` now; null when nothing is there. */
async function hashNow(file: string): Promise<string | null> {
  const current = await readMaybe(file);
  return current ? bytesHash(current.bytes) : null;
}

/**
 * Whether an entry's change was made: done, or - when a stop or a crash kept it from being
 * recorded done - a file that holds what the write was to leave, or a move into the backup whose
 * backup is there and whose own place is empty. Anything it cannot look at reads as not made.
 */
async function changeMade(entry: ManifestEntry, dir: string): Promise<boolean> {
  if (entry.done) return true;
  try {
    if (entry.what === "json" || entry.what === "toml") {
      return entry.hashAfter !== null && (await hashNow(entry.path)) === entry.hashAfter;
    }
    const moved =
      entry.change === "removed" && (entry.what === "folder" || entry.what === "file" || entry.what === "stash");
    const backup = backupPath(dir, entry.backup);
    if (!moved || backup === undefined) return false;
    return (await entryKind(backup)) !== "missing" && (await entryKind(entry.path)) === "missing";
  } catch {
    return false;
  }
}

/** The newest operation not undone yet, and the indexes of its entries with a change made that no undo has settled. */
type Found = { manifest: Manifest; dir: string; made: number[] };

/** The newest operation not undone yet (of `command`, when given) with a change made. */
async function newestOperation(env: WriteEnv, command?: ExtensionsCommand): Promise<Found | null> {
  for (const id of await operationIds(env)) {
    const dir = path.join(env.backupRoot, id);
    const manifest = await readManifest(dir);
    if (!manifest || manifest.undoneAt !== null) continue;
    if (command !== undefined && manifest.command !== command) continue;
    const made: number[] = [];
    for (const [at, entry] of manifest.entries.entries()) {
      if (entry.undone === undefined && (await changeMade(entry, dir))) made.push(at);
    }
    if (made.length > 0) return { manifest, dir, made };
  }
  return null;
}

function actionOf(entry: ManifestEntry): UndoPreview["files"][number]["action"] {
  return entry.change === "removed" ? "put back" : entry.change === "created" ? "remove" : "edit back";
}

/** The newest operation not undone yet (of `command`, when given), or null. */
export async function lastOperation(env: WriteEnv, command?: ExtensionsCommand): Promise<UndoPreview | null> {
  const found = await newestOperation(env, command);
  if (!found) return null;
  const files: UndoPreview["files"] = [];
  for (const at of found.made) {
    const entry = found.manifest.entries[at] as ManifestEntry;
    const file = { path: shown(entry), action: actionOf(entry) };
    if (!files.some((f) => f.path === file.path && f.action === file.action)) files.push(file);
  }
  return { operation: refOf(found.manifest, found.dir), files };
}

type Outcome = "restored" | UndoSkip["reason"];

/**
 * Rule B: for JSON, when the file as a whole changed since, each path the apply edited that still
 * holds what it wrote gets the backup's value back - absent where the backup had none - and
 * everything else in the file stays as it is now, in the file's style. Any other path is a change
 * someone made since: the file is left alone.
 */
async function undoPaths(entry: ManifestEntry, current: FileRead, before: FileRead | undefined): Promise<boolean> {
  const touched = entry.touched ?? [];
  if (touched.length === 0) return false;
  try {
    const now = readJsonText(current.text);
    if (!touched.every((t) => hashOf(valueAt(now.value, t.path)) === t.hash)) return false;
    const was = before ? readJsonText(before.text).value : {};
    let next = now.value;
    for (const t of touched) next = withValueAt(next, t.path, valueAt(was, t.path));
    if (canonical(next) !== canonical(now.value)) {
      await writeAtomic(current.real, writeJsonText(next, now.style), current.mode & 0o777);
    }
    return true;
  } catch (error) {
    if (error instanceof JsonEditError) return false;
    throw error;
  }
}

/** A file apply edited or made: whole, when it is still what apply wrote, else path by path for JSON. */
async function undoFile(entry: ManifestEntry, dir: string): Promise<Outcome> {
  const backup = backupPath(dir, entry.backup);
  const before = backup === undefined ? undefined : await readMaybe(backup);
  if (entry.backup !== null && !before) return "missing";
  const current = await readMaybe(entry.path);
  if ((current ? bytesHash(current.bytes) : null) === entry.hashAfter) {
    if (before) {
      await writeAtomic(
        current?.real ?? (await realOrSelf(entry.path)),
        before.bytes,
        current ? current.mode & 0o777 : 0o644,
      );
    } else {
      if (current) await removeFile(entry.path);
      await removeEmptyDirs(entry.createdDirs ?? []);
    }
    return "restored";
  }
  if (entry.what !== "json" || !current) return "changed";
  return (await undoPaths(entry, current, before)) ? "restored" : "changed";
}

/** Something moved into the backup, moved back to its place when that is still empty. */
async function moveBack(entry: ManifestEntry, dir: string): Promise<Outcome> {
  const backup = backupPath(dir, entry.backup);
  if (backup === undefined || (await entryKind(backup)) === "missing") return "missing";
  if ((await entryKind(entry.path)) !== "missing") return "occupied";
  if (entry.what === "stash") await privateDir(path.dirname(entry.path));
  else await ensureDir(path.dirname(entry.path));
  await moveTo(backup, entry.path);
  return "restored";
}

async function undoEntry(entry: ManifestEntry, dir: string, env: WriteEnv): Promise<Outcome> {
  switch (entry.what) {
    case "json":
    case "toml": {
      if (!entry.lock) return undoFile(entry, dir);
      const result = await withLock(`${shown(entry)}.lock`, lockOptions(env), () => undoFile(entry, dir));
      return result === "locked" ? "locked" : result;
    }
    case "folder":
    case "file":
      return moveBack(entry, dir);
    case "link": {
      if (!entry.link) return "missing";
      if ((await entryKind(entry.path)) !== "missing") return "occupied";
      await ensureDir(path.dirname(entry.path));
      await makeLink(entry.link.target, entry.path, entry.link.type);
      return "restored";
    }
    case "stash": {
      if (entry.change === "removed") return moveBack(entry, dir);
      const current = await readMaybe(entry.path);
      if (!current) return "missing";
      if (bytesHash(current.bytes) !== entry.hashAfter) return "changed";
      await removeFile(entry.path);
      return "restored";
    }
  }
}

/**
 * Undoes the newest operation not undone yet (of `command`, when given), last change first, so a
 * file changed twice ends as it was before the first. Each change goes back only while it holds
 * what apply wrote; the rest is listed as skipped and left alone. A stash file goes with its JSON
 * edit: that edit is undone first, and the stash file follows only once it is undone or was never
 * made - else it is skipped for the same reason, so the entry stays in one place. A step that
 * fails is skipped as `failed`, and what went back before it is still recorded. While anything is
 * skipped `locked`, the operation stays the one the next undo takes, for the entries left. Null
 * when there is none.
 */
export async function undo(env: WriteEnv, command?: ExtensionsCommand): Promise<UndoResult | null> {
  const found = await newestOperation(env, command);
  if (!found) return null;
  const { manifest, dir } = found;
  const entries = manifest.entries;
  const made = new Set(found.made);
  const outcomes = new Map<number, Outcome>();
  const order: number[] = [];
  const record = (at: number, outcome: Outcome): Outcome => {
    outcomes.set(at, outcome);
    order.push(at);
    return outcome;
  };
  const undoAt = async (at: number): Promise<Outcome> => {
    const known = outcomes.get(at) ?? entries[at]?.undone;
    if (known !== undefined) return known;
    const entry = entries[at] as ManifestEntry;
    try {
      return record(at, await undoEntry(entry, dir, env));
    } catch {
      return record(at, "failed");
    }
  };
  /** Whether a stash entry's step may go ahead: "go", or the reason to skip it with. */
  const pairAllows = async (stash: ManifestEntry): Promise<"go" | Outcome> => {
    const edit = stash.with === undefined ? undefined : entries[stash.with];
    if (stash.with === undefined || !edit) return "go";
    if (edit.undone !== undefined || made.has(stash.with)) {
      const outcome = await undoAt(stash.with);
      return outcome === "restored" ? "go" : outcome;
    }
    // Never made only when the file is still as it was before the edit; otherwise it may hold
    // the edit under later changes, and the stash file stays.
    const before = await hashNow(edit.path).catch(() => undefined);
    return before === edit.hashBefore ? "go" : "changed";
  };

  for (let at = entries.length - 1; at >= 0; at--) {
    if (!made.has(at) || outcomes.has(at)) continue;
    const entry = entries[at] as ManifestEntry;
    if (entry.what === "stash") {
      const allowed = await pairAllows(entry);
      if (allowed !== "go") {
        record(at, allowed);
        continue;
      }
    }
    await undoAt(at);
  }

  const restored: string[] = [];
  const skipped: UndoSkip[] = [];
  for (const at of order) {
    const entry = entries[at] as ManifestEntry;
    const outcome = outcomes.get(at) as Outcome;
    if (outcome !== "locked") entry.undone = outcome;
    const file = shown(entry);
    if (outcome !== "restored") skipped.push({ file, reason: outcome });
    else if (!restored.includes(file)) restored.push(file);
  }
  // Claude Code was saving: the entries left are tried again by the next undo, rather than the
  // operation before this one.
  if (!skipped.some((skip) => skip.reason === "locked")) manifest.undoneAt = new Date(env.now()).toISOString();
  const earlier = manifest.undo;
  manifest.undo = {
    restored: [...new Set([...(earlier?.restored ?? []), ...restored])],
    skipped: [...(earlier?.skipped ?? []).filter((skip) => skip.reason !== "locked"), ...skipped],
  };
  await save({ dir, manifest });
  return { operation: refOf(manifest, dir), restored, skipped };
}

/** Removes operation dirs beyond the newest `keep`; returns the ids removed. */
export async function pruneOperations(env: WriteEnv, keep = KEEP_OPERATIONS): Promise<string[]> {
  const removed: string[] = [];
  for (const id of (await operationIds(env)).slice(keep)) {
    try {
      await removeTree(path.join(env.backupRoot, id), env.backupRoot);
      removed.push(id);
    } catch {
      // Not a folder of clausona's after all, or not removable now: left for the next prune.
    }
  }
  return removed;
}
