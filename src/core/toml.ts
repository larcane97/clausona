/**
 * The raw text of `key`'s value in a TOML document's root table - `"~/state"` for
 * `key = "~/state"  # comment` - or undefined when the root table does not set it.
 *
 * Not a parser, and no dependency for one lookup: just enough of TOML to find a root key
 * reliably. Strings of all four kinds are stepped over whole, so a `#`, `=`, `[` or line
 * break inside one means nothing; comments are dropped; an array or inline table runs to its
 * closing bracket across lines. The root table ends at the first table header, so the same
 * key under `[profiles.x]` is not it. A key matches bare or quoted, and a dotted key never
 * does. A document that is not valid TOML gives whatever this reading of it finds.
 */
export function tomlRootValue(text: string, key: string): string | undefined {
  for (const raw of statements(text.replace(/^﻿/, ""))) {
    const statement = raw.trim();
    if (statement === "") continue;
    if (statement.startsWith("[")) return undefined;
    const equals = keyEnd(statement);
    if (equals < 0) continue;
    if (unquoteKey(statement.slice(0, equals).trim()) === key) return statement.slice(equals + 1).trim();
  }
  return undefined;
}

/** The document cut into statements: at each line break outside a string and outside brackets. */
function* statements(text: string): Generator<string> {
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const end = multilineStringEnd(text, i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" && depth === 0) {
      yield current;
      current = "";
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if ((ch === "]" || ch === "}") && depth > 0) depth--;
    current += ch;
    i++;
  }
  yield current;
}

/** Just past a one-line string opened at `start`; at the line break when it is not closed. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== "\n") {
    if (quote === '"' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Just past a multi-line string opened at `start`, whose closing quotes may run on by two more. */
function multilineStringEnd(text: string, start: number): number {
  const delimiter = text.slice(start, start + 3);
  let i = start + 3;
  while (i < text.length) {
    if (delimiter === '"""' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      i += 3;
      // `""""` closes with a quote inside the string: up to two may come before the delimiter.
      for (let extra = 0; extra < 2 && text[i] === delimiter[0]; extra++) i++;
      return i;
    }
    i++;
  }
  return i;
}

/** Where the key of `statement` ends: its first `=` outside a quoted key. */
function keyEnd(statement: string): number {
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i];
    if (ch === '"' || ch === "'") {
      i = stringEnd(statement, i);
      continue;
    }
    if (ch === "=") return i;
    i++;
  }
  return -1;
}

function unquoteKey(key: string): string {
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key) as string;
    } catch {
      return key.slice(1, -1);
    }
  }
  return key;
}
