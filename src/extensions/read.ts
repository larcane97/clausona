import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { Warning } from "./model.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many file-system calls the whole process keeps in flight. `mapLimit` bounds one call site
 * only, and many folders listed and hashed side by side would still open thousands of files at
 * once - past the open-file limit, where a read fails with EMFILE and a skill drops out of the
 * list with a warning. Node's thread pool runs four calls at a time either way; this many queued
 * keep it busy while each waits on the disk.
 */
export const FS_SLOTS = 64;
let slotsTaken = 0;
const waiting: (() => void)[] = [];

/**
 * `call` once one of the FS_SLOTS is free, holding it until `call` settles. Every file-system
 * call the inventory makes goes through here - the sources reach it through these helpers - and
 * each holds its slot for that one call alone: one that waited on more limited work while it held
 * a slot could wait forever, once every slot was held that way.
 */
async function limited<T>(call: () => Promise<T>): Promise<T> {
  if (slotsTaken < FS_SLOTS) slotsTaken++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await call();
  } finally {
    // The slot passes straight to the first in line, so a newcomer cannot take it ahead of it.
    const next = waiting.shift();
    if (next) next();
    else slotsTaken--;
  }
}

/** `realpath`, within the process's file-system limit. */
export function realPath(p: string): Promise<string> {
  return limited(() => realpath(p));
}

/** A file's text, or undefined when it is not there. Any other failure is a warning. */
export async function readText(file: string, warnings: Warning[]): Promise<string | undefined> {
  try {
    return await limited(() => readFile(file, "utf8"));
  } catch (error) {
    if (!isMissing(error)) warnings.push({ file, message: `could not be read: ${reason(error)}` });
    return undefined;
  }
}

/**
 * Why a file is not valid JSON, keeping only where. V8's own message quotes the text around
 * the bad token, and in a settings file that text can be an API key or a token, while a
 * warning reaches the TUI and `--json`.
 */
function invalidJson(error: unknown): string {
  const at = /at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(reason(error));
  if (!at) return "is not valid JSON";
  return at[2] && at[3]
    ? `is not valid JSON at line ${at[2]}, column ${at[3]}`
    : `is not valid JSON at position ${at[1]}`;
}

/** A JSON file holding an object, or undefined when it is missing; malformed or not an object is a warning. */
export async function readJsonObject(file: string, warnings: Warning[]): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file, warnings);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
    warnings.push({ file, message: "is not a JSON object" });
  } catch (error) {
    warnings.push({ file, message: invalidJson(error) });
  }
  return undefined;
}

/** A directory's entries without dot-entries, sorted; none when it is not there. */
export async function listNames(dir: string, warnings: Warning[]): Promise<string[]> {
  try {
    return (await limited(() => readdir(dir))).filter((name) => !name.startsWith(".")).sort();
  } catch (error) {
    if (!isMissing(error)) warnings.push({ file: dir, message: `could not be listed: ${reason(error)}` });
    return [];
  }
}

export type EntryInfo = {
  kind: "dir" | "file" | "missing" | "other";
  /** Set for a symlink or junction; `broken` when what it names is gone. */
  link?: { target: string; broken: boolean };
  /** When the entry itself appeared: for a link, the link's own birth time, not its target's. */
  createdAt?: number;
};

function createdAt(stats: { birthtimeMs: number; mtimeMs: number }): number {
  // Linux filesystems without birth times report 0; the modification time is the next best.
  return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
}

function kindOf(stats: { isDirectory(): boolean; isFile(): boolean }): EntryInfo["kind"] {
  return stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "other";
}

/** What is at `p`: its kind as followed through a link, and the link itself if it is one. */
export async function entryInfo(p: string): Promise<EntryInfo> {
  const own = await limited(() => lstat(p)).catch(() => null);
  if (!own) return { kind: "missing" };
  if (!own.isSymbolicLink()) return { kind: kindOf(own), createdAt: createdAt(own) };
  const raw = await limited(() => readlink(p)).catch(() => "");
  const target = path.resolve(path.dirname(p), raw);
  const followed = await limited(() => stat(p)).catch(() => null);
  // A link dates from when it was made, not from its target: a skill linked in today is new
  // here, however old the folder it leads to.
  if (!followed) return { kind: "missing", link: { target, broken: true }, createdAt: createdAt(own) };
  return { kind: kindOf(followed), link: { target, broken: false }, createdAt: createdAt(own) };
}

/**
 * `name` and `description` from a SKILL.md's YAML front matter. Not a YAML parser: the two
 * scalar keys only, plain or quoted, with a folded (`>`) or literal (`|`) block joined into
 * one line - which is all a list row and a detail pane show.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i] ?? "");
    if (!field) continue;
    const key = field[1] as "name" | "description";
    let value = (field[2] ?? "").trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1] ?? "")) {
        i++;
        parts.push((lines[i] ?? "").trim());
      }
      value = parts.filter(Boolean).join(" ");
    } else if (/^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * How many items one `mapLimit` call - one listing, or one step of a walk - works on at once. It
 * bounds that call alone: many listings side by side each keep this many going, and FS_SLOTS is
 * what bounds the file-system calls of them all together. A walk keeps enough queued to use its
 * share of the slots, without a promise and a result held for every entry of a large home.
 */
export const IO_LIMIT = 32;

/**
 * `fn` over `items`, at most `limit` calls at a time, with the results in the items' order -
 * so reading folders in parallel keeps what is listed, and in which order, the same.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** How much file content `hashTree` reads before it hashes the rest by path and size. */
const HASH_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * A digest of a folder's files - relative paths, sizes and contents - to tell two copies of
 * a skill apart. A skill can carry large assets, so past the budget a file counts by its path
 * and size only: enough to see a copy that changed, without reading a 50 MB model file. A file
 * it cannot read, gone since it was listed or not readable, counts the same way. A symlinked
 * subfolder is not followed, so a link loop cannot hang the walk, and two copies that differ
 * only inside one hash alike.
 *
 * A skill can hold a whole node_modules, tens of thousands of files, so the folders are listed
 * and the files stat'ed and read in parallel; the digest then takes them in the order of a walk
 * one entry at a time - each folder's entries by name, a subfolder's files in its place - and
 * comes out the same as that walk's.
 */
export async function hashTree(dir: string): Promise<string> {
  const listings = new Map<string, Dirent[]>();
  let level = [""];
  while (level.length > 0) {
    const listed = await mapLimit(level, IO_LIMIT, async (rel) =>
      (await limited(() => readdir(path.join(dir, rel), { withFileTypes: true })).catch(() => []))
        .filter((entry) => entry.name !== ".DS_Store")
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    const next: string[] = [];
    level.forEach((rel, i) => {
      const entries = listed[i] ?? [];
      listings.set(rel, entries);
      for (const entry of entries) if (entry.isDirectory()) next.push(relativeTo(rel, entry.name));
    });
    level = next;
  }
  const files: string[] = [];
  const inOrder = (rel: string): void => {
    for (const entry of listings.get(rel) ?? []) {
      if (entry.isDirectory()) inOrder(relativeTo(rel, entry.name));
      else files.push(relativeTo(rel, entry.name));
    }
  };
  inOrder("");
  const sizes = await mapLimit(files, IO_LIMIT, async (relPath) => {
    const stats = await limited(() => stat(path.join(dir, relPath))).catch(() => null);
    return stats?.isFile() ? stats.size : undefined;
  });
  // The files that fit the budget if every read succeeds, read ahead; together they are within
  // the budget. A read that fails leaves its share of the budget to later files, which are then
  // read in turn below, as the one-at-a-time walk would.
  let planned = HASH_BYTE_BUDGET;
  const ahead: number[] = [];
  sizes.forEach((size, i) => {
    if (size === undefined || size > planned) return;
    planned -= size;
    ahead.push(i);
  });
  const read = (relPath: string) => limited(() => readFile(path.join(dir, relPath))).catch(() => null);
  const readAhead = await mapLimit(ahead, IO_LIMIT, (i) => read(files[i] ?? ""));
  const contents = new Map(ahead.map((fileIndex, k) => [fileIndex, readAhead[k] ?? null]));
  const hash = createHash("sha256");
  let budget = HASH_BYTE_BUDGET;
  for (const [i, relPath] of files.entries()) {
    const size = sizes[i];
    if (size === undefined) continue;
    hash.update(`${relPath}\0${size}\0`);
    if (size > budget) continue;
    const bytes = contents.has(i) ? contents.get(i) : await read(relPath);
    if (!bytes) continue;
    budget -= size;
    // A plain view of the same bytes: this repo's @types/node Buffer is not a BinaryLike under TypeScript 5.9.
    hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  return hash.digest("hex");
}

/** A path under a walk's root, with `/` as the digest has always had it. */
function relativeTo(rel: string, name: string): string {
  return rel === "" ? name : `${rel}/${name}`;
}

/** The directory holding the `.git` entry (a repo's folder or a worktree's file) at or above `dir`. */
export async function gitRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    if (
      await limited(() => lstat(path.join(current, ".git"))).then(
        () => true,
        () => false,
      )
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A path as a map key: resolved, and case-folded on Windows, where the filesystem is. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && pathKey(a) === pathKey(b);
}

/** Whether `p` is `dir` or inside it, compared as `samePath` compares. */
export function isWithin(p: string | undefined, dir: string | undefined): boolean {
  if (p === undefined || dir === undefined) return false;
  const inner = pathKey(p);
  const outer = pathKey(dir);
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}
