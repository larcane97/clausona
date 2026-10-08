import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
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

/** A file's text, or undefined when it is not there. Any other failure is a warning. */
export async function readText(file: string, warnings: Warning[]): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
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
    return (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
  } catch (error) {
    if (!isMissing(error)) warnings.push({ file: dir, message: `could not be listed: ${reason(error)}` });
    return [];
  }
}

export type EntryInfo = {
  kind: "dir" | "file" | "missing" | "other";
  /** Set for a symlink or junction; `broken` when what it names is gone. */
  link?: { target: string; broken: boolean };
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
  const own = await lstat(p).catch(() => null);
  if (!own) return { kind: "missing" };
  if (!own.isSymbolicLink()) return { kind: kindOf(own), createdAt: createdAt(own) };
  const raw = await readlink(p).catch(() => "");
  const target = path.resolve(path.dirname(p), raw);
  const followed = await stat(p).catch(() => null);
  if (!followed) return { kind: "missing", link: { target, broken: true } };
  return { kind: kindOf(followed), link: { target, broken: false }, createdAt: createdAt(followed) };
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

/** How much file content `hashTree` reads before it hashes the rest by path and size. */
const HASH_BYTE_BUDGET = 4 * 1024 * 1024;

/**
 * A digest of a folder's files - relative paths, sizes and contents - to tell two copies of
 * a skill apart. A skill can carry large assets, so past the budget a file counts by its path
 * and size only: enough to see a copy that changed, without reading a 50 MB model file. A file
 * it cannot read, gone since it was listed or not readable, counts the same way. A symlinked
 * subfolder is not followed, so a link loop cannot hang the walk, and two copies that differ
 * only inside one hash alike.
 */
export async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  let budget = HASH_BYTE_BUDGET;
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relPath);
        continue;
      }
      const full = path.join(dir, relPath);
      const stats = await stat(full).catch(() => null);
      if (!stats?.isFile()) continue;
      hash.update(`${relPath}\0${stats.size}\0`);
      if (stats.size > budget) continue;
      const bytes = await readFile(full).catch(() => null);
      if (!bytes) continue;
      budget -= stats.size;
      // A plain view of the same bytes: this repo's @types/node Buffer is not a BinaryLike under TypeScript 5.9.
      hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
  };
  await walk("");
  return hash.digest("hex");
}

/** The directory holding the `.git` entry (a repo's folder or a worktree's file) at or above `dir`. */
export async function gitRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    if (
      await lstat(path.join(current, ".git")).then(
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
