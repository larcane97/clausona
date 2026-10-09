import { canonical } from "../hash.js";
import type { HookPlace } from "../model.js";
import { isRecord, pathKey } from "../read.js";

/**
 * Edits to a JSON file that keep how the file is written: its indent, key order, line endings,
 * BOM and final newline. Pure: text in, text out; writing the file is writers/fs.ts's.
 */

/** A key, an array index, or a project's key in a `projects` map, found when the edit runs (see resolvePath). */
export type PathSeg = string | number | { projectKey: string };
export type JsonPath = readonly PathSeg[];

export type JsonEdit =
  /** Parents made as objects. */
  | { op: "set"; path: JsonPath; value: string | boolean }
  /** Absent is fine. */
  | { op: "delete"; path: JsonPath }
  /** A string list; made when absent; no duplicate. */
  | { op: "list-add"; path: JsonPath; value: string }
  /** An emptied list stays []. */
  | { op: "list-remove"; path: JsonPath; value: string }
  /** Its group goes when emptied, the event when emptied. */
  | { op: "hook-remove"; place: HookPlace }
  /** Puts `entry` at path; throws "present" when something is there. */
  | { op: "restore"; path: JsonPath }
  /** Puts `entry` back at its place: its group, else a group with its matcher, else a new group. */
  | { op: "hook-restore"; place: HookPlace };

/** Its message is a fixed phrase, with a position at most: never the file's text. */
export class JsonEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonEditError";
  }
}

const IN_THE_WAY = "has a value of another type where the change goes";
/** The message when a path's project has no entry in the file: it went since the inventory read it. */
export const NO_PROJECT = "has no entry for that project";

export type JsonStyle = { indent: string; eol: "\n" | "\r\n"; finalNewline: boolean; bom: boolean };

export const DEFAULT_JSON_STYLE: JsonStyle = Object.freeze({ indent: "  ", eol: "\n", finalNewline: true, bom: false });

const BOM = "\uFEFF";

/** Where JSON.parse stopped, as a line and column, without the text V8 may quote around it. */
function invalidJson(error: unknown, text: string): string {
  const at = /at position (\d+)/.exec(error instanceof Error ? error.message : "");
  if (!at) return "is not valid JSON";
  const position = Math.min(Number(at[1]), text.length);
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - (before.lastIndexOf("\n") + 1) + 1;
  return `is not valid JSON at line ${line}, column ${column}`;
}

function styleOf(text: string, body: string): JsonStyle {
  const oneLine = !/[\r\n]/.test(body.replace(/[\r\n]+$/, ""));
  return {
    indent: oneLine ? "" : (/^([ \t]+)"/m.exec(body)?.[1] ?? DEFAULT_JSON_STYLE.indent),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: /[\r\n]$/.test(text),
    bom: text.startsWith(BOM),
  };
}

/** "" or only whitespace → {} in DEFAULT_JSON_STYLE. Not JSON → JsonEditError("is not valid JSON at line L, column C"); not an object → JsonEditError("is not a JSON object"). */
export function readJsonText(text: string): { value: Record<string, unknown>; style: JsonStyle } {
  if (text.trim() === "") return { value: {}, style: { ...DEFAULT_JSON_STYLE } };
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new JsonEditError(invalidJson(error, body));
  }
  if (!isRecord(value)) throw new JsonEditError("is not a JSON object");
  return { value, style: styleOf(text, body) };
}

/** Whether `container` has `seg` of its own: a key of an object, an index of an array. */
function has(container: unknown, seg: string | number): boolean {
  if (typeof seg === "number")
    return Array.isArray(container) && Number.isInteger(seg) && seg >= 0 && seg < container.length;
  return isRecord(container) && Object.hasOwn(container, seg);
}

function child(container: unknown, seg: string | number): unknown {
  return has(container, seg) ? (container as Record<string | number, unknown>)[seg] : undefined;
}

/** An own data property, so a "__proto__" key stays a key and does not change the prototype. */
function put(container: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The path with each { projectKey } resolved: the key that is the project's path as written, else the first key whose pathKey matches; undefined when none. */
export function resolvePath(root: unknown, path: JsonPath): (string | number)[] | undefined {
  const out: (string | number)[] = [];
  let at: unknown = root;
  for (const seg of path) {
    let step: string | number;
    if (typeof seg === "object") {
      if (!isRecord(at)) return undefined;
      const want = pathKey(seg.projectKey);
      const found = Object.hasOwn(at, seg.projectKey)
        ? seg.projectKey
        : Object.keys(at).find((key) => pathKey(key) === want);
      if (found === undefined) return undefined;
      step = found;
    } else {
      step = seg;
    }
    out.push(step);
    at = child(at, step);
  }
  return out;
}

/** Undefined when absent or unresolved. */
export function valueAt(root: unknown, path: JsonPath): unknown {
  const resolved = resolvePath(root, path);
  if (!resolved) return undefined;
  let at: unknown = root;
  for (const seg of resolved) at = child(at, seg);
  return at;
}

/** The path of a hook's event array: under "hooks", or at the file's root. */
function eventPath(place: HookPlace): string[] {
  return place.base === "hooks" ? ["hooks", place.event] : [place.event];
}

/** The raw entry a delete or hook-remove edit takes out (for a stash). */
export function entryAt(root: unknown, edit: JsonEdit): unknown {
  if (edit.op === "delete") return valueAt(root, edit.path);
  if (edit.op === "hook-remove")
    return valueAt(root, [...eventPath(edit.place), edit.place.group, "hooks", edit.place.index]);
  return undefined;
}

/** The path whose value an edit changes, resolved: its own path, or [base..., event] for a hook edit. Undo compares and restores these. */
export function touchedPath(root: unknown, edit: JsonEdit): (string | number)[] | undefined {
  return edit.op === "hook-remove" || edit.op === "hook-restore" ? eventPath(edit.place) : resolvePath(root, edit.path);
}

/**
 * The object the last key of `path` lives in, its parents made as objects. Throws when a
 * project is not there (an entry is never made for one) or a value of another type is in the way.
 */
function parentMade(root: Record<string, unknown>, path: JsonPath): { parent: Record<string, unknown>; key: string } {
  const resolved = resolvePath(root, path);
  if (!resolved) throw new JsonEditError(NO_PROJECT);
  const key = resolved.at(-1);
  if (typeof key !== "string") throw new JsonEditError(IN_THE_WAY);
  let at: Record<string, unknown> = root;
  for (const seg of resolved.slice(0, -1)) {
    if (typeof seg !== "string") throw new JsonEditError(IN_THE_WAY);
    if (!has(at, seg)) put(at, seg, {});
    const next = at[seg];
    if (!isRecord(next)) throw new JsonEditError(IN_THE_WAY);
    at = next;
  }
  return { parent: at, key };
}

function remove(root: Record<string, unknown>, path: JsonPath): void {
  const resolved = resolvePath(root, path);
  if (!resolved || resolved.length === 0) return;
  const last = resolved.at(-1) as string | number;
  let at: unknown = root;
  for (const seg of resolved.slice(0, -1)) at = child(at, seg);
  if (!has(at, last)) return;
  if (Array.isArray(at)) at.splice(last as number, 1);
  else delete (at as Record<string, unknown>)[last as string];
}

function listAt(root: Record<string, unknown>, path: JsonPath): unknown[] | undefined {
  const list = valueAt(root, path);
  if (list !== undefined && !Array.isArray(list)) throw new JsonEditError(IN_THE_WAY);
  return list;
}

/** A group's matcher as the inventory reads it: a matcher of "" is none. */
function matcherOf(group: Record<string, unknown>): string | undefined {
  return typeof group.matcher === "string" && group.matcher !== "" ? group.matcher : undefined;
}

function isGroup(value: unknown): value is Record<string, unknown> & { hooks: unknown[] } {
  return isRecord(value) && Array.isArray(value.hooks);
}

/** `events = base === "hooks" ? root.hooks : root`, made when `make` and absent. */
function eventsOf(root: Record<string, unknown>, place: HookPlace, make: boolean): Record<string, unknown> | undefined {
  if (place.base === "root") return root;
  if (!has(root, "hooks")) {
    if (!make) return undefined;
    put(root, "hooks", {});
  }
  const events = root.hooks;
  if (isRecord(events)) return events;
  if (make) throw new JsonEditError(IN_THE_WAY);
  return undefined;
}

function hookRemove(root: Record<string, unknown>, place: HookPlace): void {
  const events = eventsOf(root, place, false);
  const groups = child(events, place.event);
  const group = child(groups, place.group);
  if (!events || !Array.isArray(groups) || !isGroup(group) || !has(group.hooks, place.index)) return;
  group.hooks.splice(place.index, 1);
  if (group.hooks.length === 0) groups.splice(place.group, 1);
  if (groups.length === 0) delete events[place.event];
}

function hookRestore(root: Record<string, unknown>, place: HookPlace, entry: unknown): void {
  const events = eventsOf(root, place, true) as Record<string, unknown>;
  if (!has(events, place.event)) put(events, place.event, []);
  const groups = events[place.event];
  if (!Array.isArray(groups)) throw new JsonEditError(IN_THE_WAY);
  const own = groups[place.group];
  if (isGroup(own) && matcherOf(own) === place.matcher) {
    own.hooks.splice(Math.min(place.index, own.hooks.length), 0, entry);
    return;
  }
  const same = groups.find((group) => isGroup(group) && matcherOf(group) === place.matcher);
  if (isGroup(same)) same.hooks.push(entry);
  else groups.push({ ...(place.matcher ? { matcher: place.matcher } : {}), hooks: [entry] });
}

function applyOne(root: Record<string, unknown>, edit: JsonEdit, entry: unknown): void {
  switch (edit.op) {
    case "set": {
      const { parent, key } = parentMade(root, edit.path);
      put(parent, key, edit.value);
      return;
    }
    case "delete":
      remove(root, edit.path);
      return;
    case "list-add": {
      const list = listAt(root, edit.path);
      if (list === undefined) {
        const { parent, key } = parentMade(root, edit.path);
        put(parent, key, [edit.value]);
      } else if (!list.includes(edit.value)) {
        list.push(edit.value);
      }
      return;
    }
    case "list-remove": {
      const list = listAt(root, edit.path);
      if (!list) return;
      for (let i = list.length - 1; i >= 0; i--) if (list[i] === edit.value) list.splice(i, 1);
      return;
    }
    case "hook-remove":
      hookRemove(root, edit.place);
      return;
    case "restore": {
      if (valueAt(root, edit.path) !== undefined) throw new JsonEditError("present");
      const { parent, key } = parentMade(root, edit.path);
      put(parent, key, structuredClone(needEntry(entry)));
      return;
    }
    case "hook-restore":
      hookRestore(root, edit.place, structuredClone(needEntry(entry)));
      return;
  }
}

function needEntry(entry: unknown): unknown {
  if (entry === undefined) throw new JsonEditError("has nothing to put back");
  return entry;
}

/** A changed copy (structuredClone first); `entry` is what restore and hook-restore put back. */
export function applyJsonEdits(
  value: Record<string, unknown>,
  edits: readonly JsonEdit[],
  entry?: unknown,
): Record<string, unknown> {
  const root = structuredClone(value);
  for (const edit of edits) applyOne(root, edit, entry);
  return root;
}

/**
 * A copy of `root` with `value` at `path`, its parents made as objects, or with the key taken out
 * when `value` is undefined. A key already there keeps its place among its siblings. What undo
 * puts back, path by path; throws as `set` does when a value of another type is in the way.
 */
export function withValueAt(root: Record<string, unknown>, path: JsonPath, value: unknown): Record<string, unknown> {
  const out = structuredClone(root);
  if (value === undefined) {
    remove(out, path);
  } else {
    const { parent, key } = parentMade(out, path);
    put(parent, key, structuredClone(value));
  }
  return out;
}

export function writeJsonText(value: Record<string, unknown>, style: JsonStyle): string {
  const body = JSON.stringify(value, null, style.indent).replaceAll("\n", style.eol);
  return `${style.bom ? BOM : ""}${body}${style.finalNewline ? style.eol : ""}`;
}

/** readJsonText, applyJsonEdits, writeJsonText - and the text unchanged, byte for byte, when the value did not change. */
export function editJson(text: string, edits: readonly JsonEdit[], entry?: unknown): string {
  const { value, style } = readJsonText(text);
  const next = applyJsonEdits(value, edits, entry);
  return canonical(next) === canonical(value) ? text : writeJsonText(next, style);
}
