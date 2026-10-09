import { parse } from "smol-toml";

import { canonical } from "../hash.js";
import { isRecord, samePath } from "../read.js";

/**
 * Edits to a Codex config.toml made as line edits, so its comments, line endings, quoted keys
 * and subtables stay as written, then checked: the result is parsed again and must hold exactly
 * what the edits intend. Pure: text in, text out; writing the file is writers/fs.ts's.
 */

export type SkillSelector = { name: string } | { path: string };

export type TomlEdit =
  /** null removes the line. */
  | { op: "mcp-enabled"; server: string; enabled: boolean | null }
  /** The table and its subtables. */
  | { op: "mcp-delete"; server: string }
  /** null removes the [[skills.config]] entry. */
  | { op: "skill-config"; selector: SkillSelector; enabled: boolean | null };

/** Its message is a fixed phrase, with a position at most: never the file's text. */
export class TomlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlEditError";
  }
}

const UNUSUAL_FORM = "is written in a form clausona does not edit";
const NOT_AS_INTENDED = "would not read back as intended after the edit";

/** smol-toml's parse; a failure is TomlEditError("is not valid TOML at line L, column C") or ("is not valid TOML"), never its code block. */
export function parseTomlText(text: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    // smol-toml's message carries a code block of the text around the error: a key or a token, maybe.
    throw new TomlEditError(
      isRecord(error) && typeof error.line === "number" && typeof error.column === "number"
        ? `is not valid TOML at line ${error.line}, column ${error.column}`
        : "is not valid TOML",
    );
  }
}

/** A TOML table as smol-toml reads it; a date or time is a Date, not a table. */
function isTable(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !(value instanceof Date);
}

/** An own data property, so a "__proto__" key stays a key and does not change the prototype. */
function put(table: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Tables and arrays copied; anything else - a date among them - shared, since nothing edits it. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy);
  if (!isTable(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) put(out, key, copy(value[key]));
  return out;
}

export function tomlValueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let at = value;
  for (const seg of path) {
    if (typeof seg === "number") at = Array.isArray(at) ? at[seg] : undefined;
    else at = isTable(at) && Object.hasOwn(at, seg) ? at[seg] : undefined;
  }
  return at;
}

/** The table at `key` in `table`, made when absent; a value of another kind there is a form clausona does not edit. */
function tableIn(table: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.hasOwn(table, key)) put(table, key, {});
  const found = table[key];
  if (!isTable(found)) throw new TomlEditError(UNUSUAL_FORM);
  return found;
}

/** Whether a [[skills.config]] entry is the one `selector` names: by its name, or by its path as samePath compares; Codex ignores an entry with both. */
function selects(entry: unknown, selector: SkillSelector): boolean {
  if (!isTable(entry)) return false;
  if ("name" in selector) return entry.name === selector.name && entry.path === undefined;
  return typeof entry.path === "string" && entry.name === undefined && samePath(entry.path, selector.path);
}

function expectOne(root: Record<string, unknown>, edit: TomlEdit): void {
  switch (edit.op) {
    case "mcp-enabled": {
      if (edit.enabled !== null) {
        put(tableIn(tableIn(root, "mcp_servers"), edit.server), "enabled", edit.enabled);
        return;
      }
      const server = tomlValueAt(root, ["mcp_servers", edit.server]);
      if (isTable(server)) delete server.enabled;
      return;
    }
    case "mcp-delete": {
      const servers = tomlValueAt(root, ["mcp_servers"]);
      if (isTable(servers)) delete servers[edit.server];
      return;
    }
    case "skill-config": {
      const config = tomlValueAt(root, ["skills", "config"]);
      const list = Array.isArray(config) ? config : [];
      const matches = list.filter((entry) => selects(entry, edit.selector));
      if (edit.enabled === null) {
        if (matches.length === 0) return;
        const left = list.filter((entry) => !matches.includes(entry));
        const skills = tableIn(root, "skills");
        if (left.length > 0) put(skills, "config", left);
        else delete skills.config;
        return;
      }
      for (const entry of matches) put(entry as Record<string, unknown>, "enabled", edit.enabled);
      if (matches.length > 0) return;
      const added = { ...edit.selector, enabled: edit.enabled };
      if (Array.isArray(config)) config.push(added);
      else put(tableIn(root, "skills"), "config", [added]);
      return;
    }
  }
}

/** The edits applied to the parsed value, as the line edits should leave it. */
export function expectedToml(value: Record<string, unknown>, edits: readonly TomlEdit[]): Record<string, unknown> {
  const root = copy(value) as Record<string, unknown>;
  for (const edit of edits) expectOne(root, edit);
  return root;
}

/** The value with every table that is empty, once its own empty tables are gone, left out. */
function pruned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruned);
  if (!isTable(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const inner = pruned(value[key]);
    if (!(isTable(inner) && Object.keys(inner).length === 0)) put(out, key, inner);
  }
  return out;
}

// ---- The line model ----

/** A line's text without its ending, and the ending: "\r\n", "\n", or "" for a last line without one. */
type Line = { text: string; end: string };
type Doc = { lines: Line[]; eol: string };
type Header = { array: boolean; keys: string[] };
/** What a walk over the lines found: whether each starts inside a string or brackets, and the headers in order. */
type Scan = { inside: boolean[]; headers: { at: number; header: Header | undefined }[] };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) {
      lines.push({ text: text.slice(start), end: "" });
      break;
    }
    const crlf = nl > start && text[nl - 1] === "\r";
    lines.push({ text: text.slice(start, crlf ? nl - 1 : nl), end: crlf ? "\r\n" : "\n" });
    start = nl + 1;
  }
  return lines;
}

function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => line.text + line.end).join("");
}

/** Just past a one-line string opened at `start`; the line's end when it is not closed. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (quote === '"' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Just past the close of a multi-line string at or after `from`, whose closing quotes may run on by two more; -1 when it runs past this line. */
function multilineEnd(text: string, from: number, delimiter: string): number {
  let i = from;
  while (i < text.length) {
    if (delimiter === '"""' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      i += 3;
      for (let extra = 0; extra < 2 && text[i] === delimiter[0]; extra++) i++;
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * The walk `statements()` in src/core/toml.ts makes, line by line: strings of all four kinds are
 * stepped over whole, comments dropped, and brackets counted, so a line that starts inside a
 * multi-line string, an open array or an inline table is known. Only a line that starts outside
 * them all, whose first non-blank character is `[`, is a header.
 */
function scan(lines: readonly Line[]): Scan {
  const inside: boolean[] = [];
  const headers: Scan["headers"] = [];
  let open: string | undefined;
  let depth = 0;
  lines.forEach(({ text }, at) => {
    const starts = open !== undefined || depth > 0;
    inside.push(starts);
    if (!starts && /^\s*\[/.test(text)) headers.push({ at, header: headerOf(text) });
    let i = 0;
    while (i < text.length) {
      if (open !== undefined) {
        const end = multilineEnd(text, i, open);
        if (end < 0) break;
        open = undefined;
        i = end;
        continue;
      }
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        open = text.slice(i, i + 3);
        i += 3;
        continue;
      }
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        i = stringEnd(text, i);
        continue;
      }
      if (ch === "#") break;
      if (ch === "[" || ch === "{") depth++;
      else if ((ch === "]" || ch === "}") && depth > 0) depth--;
      i++;
    }
  });
  return { inside, headers };
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** One key of a header at `i`: bare, basic-quoted or literal-quoted; undefined when it is none of them. */
function keyAt(text: string, i: number): { key: string; end: number } | undefined {
  const bare = BARE_KEY.exec(text.slice(i));
  if (bare) return { key: bare[0], end: i + bare[0].length };
  if (text[i] === "'") {
    const close = text.indexOf("'", i + 1);
    return close < 0 ? undefined : { key: text.slice(i + 1, close), end: close + 1 };
  }
  if (text[i] !== '"') return undefined;
  const end = stringEnd(text, i);
  try {
    const key: unknown = JSON.parse(text.slice(i, end));
    return typeof key === "string" ? { key, end } : undefined;
  } catch {
    return undefined;
  }
}

function skipBlanks(text: string, i: number): number {
  while (text[i] === " " || text[i] === "\t") i++;
  return i;
}

/** A header line's keys: `[a."b".'c']` or `[[a.b]]`, whitespace around dots, a trailing comment; undefined for a form not read here. */
function headerOf(line: string): Header | undefined {
  const text = line.trim();
  const array = text.startsWith("[[");
  const keys: string[] = [];
  let i = array ? 2 : 1;
  for (;;) {
    const key = keyAt(text, skipBlanks(text, i));
    if (!key) return undefined;
    keys.push(key.key);
    i = skipBlanks(text, key.end);
    if (text[i] !== ".") break;
    i++;
  }
  const close = array ? "]]" : "]";
  if (!text.startsWith(close, i) || !/^\s*(#.*)?$/.test(text.slice(i + close.length))) return undefined;
  return { array, keys };
}

function isServerTable(header: Header | undefined, server: string): boolean {
  return header !== undefined && !header.array && isServerPart(header, server) && header.keys.length === 2;
}

/** `[mcp_servers.<server>]` and every table or array of tables under it. */
function isServerPart(header: Header | undefined, server: string): boolean {
  return (
    header !== undefined && header.keys.length >= 2 && header.keys[0] === "mcp_servers" && header.keys[1] === server
  );
}

function isSkillEntry(header: Header | undefined): boolean {
  return (
    header?.array === true && header.keys.length === 2 && header.keys[0] === "skills" && header.keys[1] === "config"
  );
}

/** A key as a new header writes it: bare when it can be. */
function keyText(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** The line just past the table whose header is headers[k]: the next header's, or the end. */
function tableEnd(scanned: Scan, k: number, lines: readonly Line[]): number {
  return scanned.headers[k + 1]?.at ?? lines.length;
}

const ENABLED = /^(\s*)(?:enabled|"enabled"|'enabled')\s*=/;
const ENABLED_BOOL = /^(\s*)(?:enabled|"enabled"|'enabled')\s*=\s*(true|false)(\s*(?:#.*)?)$/;

/** The table's own `enabled` line, between its header and the next; -1 when there is none. */
function enabledLine(doc: Doc, scanned: Scan, k: number): number {
  for (let i = scanned.headers[k].at + 1; i < tableEnd(scanned, k, doc.lines); i++) {
    if (!scanned.inside[i] && ENABLED.test(doc.lines[i].text)) return i;
  }
  return -1;
}

function insertAfter(doc: Doc, at: number, text: string): void {
  const before = doc.lines[at];
  // A last line without an ending gets one, and the new line becomes the last without one.
  const line = { text, end: before.end === "" ? "" : doc.eol };
  if (before.end === "") before.end = doc.eol;
  doc.lines.splice(at + 1, 0, line);
}

/** Sets the `enabled` of the table whose header is headers[k]: its line in place, or a new one right after the header. */
function setEnabled(doc: Doc, scanned: Scan, k: number, enabled: boolean): void {
  const at = enabledLine(doc, scanned, k);
  if (at < 0) {
    insertAfter(doc, scanned.headers[k].at, `enabled = ${enabled}`);
    return;
  }
  const line = doc.lines[at];
  const bool = ENABLED_BOOL.exec(line.text);
  if (bool?.[2] === String(enabled)) return;
  // A comment after the value stays.
  line.text = `${(bool ?? ENABLED.exec(line.text))?.[1] ?? ""}enabled = ${enabled}${bool?.[3] ?? ""}`;
}

/** New lines at the end, after one blank line when the file does not end with one. */
function append(doc: Doc, texts: readonly string[]): void {
  const last = doc.lines.at(-1);
  if (last) {
    if (last.end === "") last.end = doc.eol;
    if (last.text.trim() !== "") doc.lines.push({ text: "", end: doc.eol });
  }
  for (const text of texts) doc.lines.push({ text, end: doc.eol });
}

/** The lines left out; where two blank lines meet at a join, one of them too. */
function removeLines(doc: Doc, scanned: Scan, removed: ReadonlySet<number>): void {
  const kept: Line[] = [];
  let joined = false;
  let lastBlank = false;
  doc.lines.forEach((line, i) => {
    if (removed.has(i)) {
      joined = true;
      return;
    }
    const blank = !scanned.inside[i] && line.text.trim() === "";
    if (!(joined && blank && lastBlank)) {
      kept.push(line);
      lastBlank = blank;
    }
    joined = false;
  });
  doc.lines = kept;
}

function isComment(doc: Doc, scanned: Scan, i: number): boolean {
  return !scanned.inside[i] && doc.lines[i].text.trimStart().startsWith("#");
}

/**
 * Takes out the tables whose headers are headers[k] for each k: each from its header through
 * the line before the next header, but for the comment lines directly above a next table that
 * stays, which are that table's.
 */
function removeTables(doc: Doc, scanned: Scan, which: readonly number[]): void {
  const starts = new Set(which.map((k) => scanned.headers[k].at));
  const removed = new Set<number>();
  for (const k of which) {
    const start = scanned.headers[k].at;
    const next = scanned.headers[k + 1];
    let stop = tableEnd(scanned, k, doc.lines);
    if (next && !starts.has(next.at)) while (stop - 1 > start && isComment(doc, scanned, stop - 1)) stop--;
    for (let i = start; i < stop; i++) removed.add(i);
  }
  removeLines(doc, scanned, removed);
}

/** Whether the table whose header is headers[k] has a key line other than `skip`. */
function hasKeys(doc: Doc, scanned: Scan, k: number, skip: number): boolean {
  for (let i = scanned.headers[k].at + 1; i < tableEnd(scanned, k, doc.lines); i++) {
    if (i === skip || scanned.inside[i]) continue;
    const text = doc.lines[i].text.trim();
    if (text !== "" && !text.startsWith("#")) return true;
  }
  return false;
}

function headerIndexes(scanned: Scan, test: (header: Header | undefined) => boolean): number[] {
  return scanned.headers.flatMap(({ header }, k) => (test(header) ? [k] : []));
}

/** One edit made on the lines; `state` is the value the lines hold before it. */
function lineEdit(doc: Doc, state: Record<string, unknown>, edit: TomlEdit): void {
  const scanned = scan(doc.lines);
  switch (edit.op) {
    case "mcp-enabled": {
      const [k] = headerIndexes(scanned, (header) => isServerTable(header, edit.server));
      if (k === undefined) {
        if (tomlValueAt(state, ["mcp_servers", edit.server]) !== undefined) throw new TomlEditError(UNUSUAL_FORM);
        if (edit.enabled !== null) append(doc, [`[mcp_servers.${keyText(edit.server)}]`, `enabled = ${edit.enabled}`]);
        return;
      }
      if (edit.enabled !== null) {
        setEnabled(doc, scanned, k, edit.enabled);
        return;
      }
      const at = enabledLine(doc, scanned, k);
      if (at < 0) return;
      const subtables = headerIndexes(scanned, (h) => isServerPart(h, edit.server) && !isServerTable(h, edit.server));
      const header = scanned.headers[k].at;
      const emptied = !hasKeys(doc, scanned, k, at) && subtables.length === 0;
      removeLines(doc, scanned, new Set(emptied ? [header, at] : [at]));
      return;
    }
    case "mcp-delete": {
      const parts = headerIndexes(scanned, (header) => isServerPart(header, edit.server));
      if (parts.length > 0) removeTables(doc, scanned, parts);
      else if (tomlValueAt(state, ["mcp_servers", edit.server]) !== undefined) throw new TomlEditError(UNUSUAL_FORM);
      return;
    }
    case "skill-config": {
      const entries = headerIndexes(scanned, isSkillEntry);
      const config = tomlValueAt(state, ["skills", "config"]);
      // The n-th [[skills.config]] header is skills.config[n]: unless the counts agree, the list is written another way.
      if (config !== undefined && !(Array.isArray(config) && config.length === entries.length)) {
        throw new TomlEditError(UNUSUAL_FORM);
      }
      const matches = entries.filter((_, n) => selects((config as unknown[] | undefined)?.[n], edit.selector));
      if (edit.enabled === null) {
        if (matches.length > 0) removeTables(doc, scanned, matches);
        return;
      }
      if (matches.length === 0) {
        const selector =
          "name" in edit.selector
            ? `name = ${JSON.stringify(edit.selector.name)}`
            : `path = ${JSON.stringify(edit.selector.path)}`;
        append(doc, ["[[skills.config]]", selector, `enabled = ${edit.enabled}`]);
        return;
      }
      // Last first, so a line put in leaves the earlier tables' line numbers as they were.
      for (const k of [...matches].reverse()) setEnabled(doc, scanned, k, edit.enabled);
      return;
    }
  }
}

/** The line edits, then the check: parseTomlText(result) must canonical-equal expectedToml(parseTomlText(text)), both with empty tables pruned. Else TomlEditError. */
export function editToml(text: string, edits: readonly TomlEdit[]): string {
  const before = parseTomlText(text);
  const doc: Doc = { lines: splitLines(text), eol: text.includes("\r\n") ? "\r\n" : "\n" };
  let state = before;
  for (const edit of edits) {
    lineEdit(doc, state, edit);
    state = expectedToml(state, [edit]);
  }
  const result = joinLines(doc.lines);
  let after: Record<string, unknown>;
  try {
    after = parseTomlText(result);
  } catch {
    throw new TomlEditError(NOT_AS_INTENDED);
  }
  if (canonical(pruned(after)) !== canonical(pruned(state))) throw new TomlEditError(NOT_AS_INTENDED);
  return result;
}
