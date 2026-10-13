/**
 * Whether Codex 0.159.3 reads a SKILL.md's front matter, as `parse_skill_frontmatter_metadata`
 * (codex-rs/skills, parser.rs) reads it: serde_yaml, a libyaml port, into `name` and
 * `description`, strings, and `metadata`, a mapping whose `short-description` is a string. When
 * that fails Codex quotes, line by line, an unquoted value that holds `: ` or starts like a flow
 * collection that does not parse, and tries once more.
 *
 * Not a YAML parser: a check of the block mappings, sequences and scalars front matter is written
 * in, and of flow collections on one line. It says a front matter does not read only where
 * libyaml refuses it, or the three fields have the wrong shape; for what it does not follow - a
 * tag, a named anchor, an explicit key, a flow collection over several lines, a second document -
 * it says nothing, and the skill reads as it did before.
 */

/** A node's shape: what the three fields' types turn on. A scalar says whether it is null or blank. */
type Shape =
  | { kind: "empty" }
  | { kind: "scalar"; text: string; null: boolean; blank: boolean }
  | { kind: "seq" }
  | { kind: "map"; entries: [string, Shape][] };

type MapShape = Extract<Shape, { kind: "map" }>;

/** libyaml, or serde, refuses it. */
class Invalid extends Error {}
/** Something this check does not follow: it says nothing. */
class Unknown extends Error {}

/** Why Codex does not load a SKILL.md whose front matter is `block`, if it does not. */
export function codexFrontMatterError(block: string): "invalid front matter" | undefined {
  try {
    let root = read(block);
    if (root === undefined) {
      const repaired = repairedFields(block);
      if (repaired !== undefined) root = read(repaired);
    }
    return root === undefined ? "invalid front matter" : undefined;
  } catch (error) {
    if (error instanceof Unknown) return undefined;
    throw error;
  }
}

/** The front matter's mapping, or "empty" for one with no node at all; undefined where Codex fails to read it. */
function read(text: string): MapShape | "empty" | undefined {
  try {
    const root = new Reader(text.split("\n")).document();
    if (root === undefined) return "empty";
    return root.kind === "map" && fieldsRead(root) ? root : undefined;
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
}

/** Whether serde reads the three fields: each once, `name` and `description` no list or mapping, `metadata` a mapping. */
function fieldsRead(root: MapShape): boolean {
  const once = (map: MapShape, names: readonly string[]) => {
    const keys = map.entries.map(([key]) => key).filter((key) => names.includes(key));
    return new Set(keys).size === keys.length;
  };
  if (!once(root, ["name", "description", "metadata"])) return false;
  for (const [key, value] of root.entries) {
    if ((key === "name" || key === "description") && (value.kind === "seq" || value.kind === "map")) return false;
    if (key !== "metadata") continue;
    // An empty value reads as no metadata; `null`, `~` or any other scalar is no mapping.
    if (value.kind === "empty") continue;
    if (value.kind !== "map" || !once(value, ["short-description"])) return false;
    const short = fieldOf(value, "short-description");
    if (short?.kind === "seq" || short?.kind === "map") return false;
  }
  return true;
}

function fieldOf(map: MapShape, name: string): Shape | undefined {
  return map.entries.find(([key]) => key === name)?.[1];
}

const NULL = /^(~|null|Null|NULL)$/;
const MARKER = /^(\.\.\.|---)([ \t]|$)/;

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/** A `- ` (or a lone `-`) that starts a sequence entry. */
function isEntry(text: string): boolean {
  return text[0] === "-" && (text.length === 1 || isBlank(text[1]));
}

/** Whitespace as Rust's `trim` takes it: Unicode's White_Space, which leaves out U+FEFF where JavaScript's takes it. */
const RUST_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM_START = new RegExp(`^[${RUST_SPACE}]+`);
const RUST_TRIM_END = new RegExp(`[${RUST_SPACE}]+$`);
const RUST_WHITESPACE = new RegExp(`^[${RUST_SPACE}]$`);

/** `text` trimmed as Rust's `trim` does. */
export function rustTrim(text: string): string {
  return text.replace(RUST_TRIM_START, "").replace(RUST_TRIM_END, "");
}

/**
 * Codex's `repair_frontmatter_scalar_fields`: each `key: value` line whose unquoted value holds a
 * `: `, or starts like a flow collection that does not parse, with that value single-quoted.
 * Undefined when no line changes.
 */
function repairedFields(front: string): string | undefined {
  let changed = false;
  let blockIndent: number | undefined;
  const out: string[] = [];
  for (const line of front.split("\n")) {
    const indent = line.length - line.replace(/^ +/, "").length;
    if (blockIndent !== undefined) {
      if (rustTrim(line) === "" || indent > blockIndent) {
        out.push(line);
        continue;
      }
      blockIndent = undefined;
    }
    const colon = line.indexOf(":");
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (colon < 0 || rustTrim(key) === "" || (value !== "" && !RUST_WHITESPACE.test(value[0] ?? ""))) {
      out.push(line);
      continue;
    }
    const trimmed = value.replace(RUST_TRIM_START, "");
    const leading = value.slice(0, value.length - trimmed.length);
    let scalar = trimmed;
    let comment = "";
    for (let k = 0; k < trimmed.length; k++) {
      if (trimmed[k] === "#" && (k === 0 || RUST_WHITESPACE.test(trimmed[k - 1] ?? ""))) {
        const end = trimmed.slice(0, k).replace(RUST_TRIM_END, "").length;
        scalar = trimmed.slice(0, end);
        comment = trimmed.slice(end);
        break;
      }
    }
    scalar = scalar.replace(RUST_TRIM_END, "");
    const first = scalar[0];
    if (first === undefined || first === "'" || first === '"') {
      out.push(line);
      continue;
    }
    if (first === "|" || first === ">") {
      blockIndent = indent;
      out.push(line);
      continue;
    }
    const colonSeparator = [...scalar].some((ch, k, all) => ch === ":" && RUST_WHITESPACE.test(all[k + 1] ?? ""));
    const flowLike = "[{@`".includes(first) && !flowParses(scalar);
    if (!colonSeparator && !flowLike) {
      out.push(line);
      continue;
    }
    out.push(`${key}:${leading}'${scalar.replaceAll("'", "''")}'${comment}`);
    changed = true;
  }
  return changed ? out.join("\n") : undefined;
}

/**
 * Whether a value starting `[`, `{`, `@` or a backtick parses as a YAML document of its own, as
 * serde_yaml's Value takes it: a mapping in it holds each key once.
 */
function flowParses(scalar: string): boolean {
  if (scalar[0] === "@" || scalar[0] === "`") return false;
  try {
    flow(scalar, true);
    return true;
  } catch (error) {
    if (error instanceof Invalid) return false;
    // What the check does not follow, it takes to parse: then it does not quote it either.
    return true;
  }
}

/**
 * Reads the block structure line by line: each mapping and sequence at its column, as libyaml
 * holds a block at its indentation, and a value in a mapping or an entry as a scalar, a quoted
 * or block scalar, a flow collection, or a block below its line.
 */
class Reader {
  private i = 0;
  private readonly lines: string[];
  private readonly anchors: boolean;

  constructor(lines: string[]) {
    this.lines = lines;
    this.anchors = lines.some((line) => /(^|[\s[{,])&\S/.test(line));
  }

  document(): Shape | undefined {
    const j = this.peek();
    if (j === undefined) return undefined;
    const { indent, text } = this.at(j);
    let root: Shape;
    if (text[0] === "[" || text[0] === "{") {
      // A flow collection for the whole document: a mapping reads as any other.
      this.i = j + 1;
      root = flow(text);
    } else {
      if ("?&!*".includes(text[0] ?? "")) throw new Unknown();
      // A scalar or a sequence where Codex wants a mapping.
      if (!this.isKey(text)) throw new Invalid();
      root = this.map(indent);
    }
    if (this.peek() !== undefined) throw new Invalid();
    return root;
  }

  /**
   * The next line that starts a token, past blank and comment lines; undefined at the end. Here
   * a tab in a line's indentation, or a directive, is no token libyaml can start.
   */
  private peek(): number | undefined {
    for (let j = this.i; j < this.lines.length; j++) {
      const line = this.lines[j] ?? "";
      if (/^ *\t/.test(line) || line.startsWith("%")) throw new Invalid();
      // A document marker: another document, which this check does not follow.
      if (MARKER.test(line)) throw new Unknown();
      if (/^ *(#.*)?$/.test(line)) continue;
      return j;
    }
    return undefined;
  }

  private at(j: number): { indent: number; text: string } {
    const line = this.lines[j] ?? "";
    const text = line.replace(/^ +/, "");
    return { indent: line.length - text.length, text };
  }

  /** Whether a line's text is a mapping key. A flow collection is a value, which says so itself if it is a key. */
  private isKey(text: string): boolean {
    if (text[0] === "[" || text[0] === "{") return false;
    try {
      key(text);
      return true;
    } catch (error) {
      if (error instanceof Invalid) return false;
      throw error;
    }
  }

  private map(n: number): MapShape {
    const entries: [string, Shape][] = [];
    for (let j = this.peek(); j !== undefined; j = this.peek()) {
      const { indent, text } = this.at(j);
      if (indent < n) break;
      // A line deeper than the keys, or an entry where a key goes.
      if (indent > n || isEntry(text)) throw new Invalid();
      const { name, rest } = key(text);
      this.i = j + 1;
      const value = rest.replace(/^[ \t]+/, "");
      entries.push([name, value === "" || value.startsWith("#") ? this.below(n, true) : this.inline(n, value)]);
    }
    return { kind: "map", entries };
  }

  /**
   * A value that starts on the next line: a sequence there - at the key's own column too, as
   * YAML allows - a mapping or a scalar indented more than `n`; else none.
   */
  private below(n: number, compact: boolean): Shape {
    const j = this.peek();
    if (j === undefined) return { kind: "empty" };
    const { indent, text } = this.at(j);
    if (isEntry(text) && (indent > n || (compact && indent === n))) return this.seq(indent);
    if (indent <= n) return { kind: "empty" };
    if (this.isKey(text)) return this.map(indent);
    this.i = j + 1;
    return this.inline(n, text);
  }

  private seq(n: number): Shape {
    for (let j = this.peek(); j !== undefined; j = this.peek()) {
      const { indent, text } = this.at(j);
      if (indent !== n || !isEntry(text)) break;
      const after = text.slice(1);
      if (after.startsWith("\t")) throw new Unknown();
      const content = after.replace(/^ +/, "");
      if (content === "" || content.startsWith("#")) {
        this.i = j + 1;
        this.below(n, false);
        continue;
      }
      if (isEntry(content) || this.isKey(content)) {
        // A sequence or a mapping that starts on the entry's line, at the column it starts at.
        const column = n + text.length - content.length;
        this.lines[j] = " ".repeat(column) + content;
        if (isEntry(content)) this.seq(column);
        else this.map(column);
        continue;
      }
      this.i = j + 1;
      this.inline(n, content);
    }
    return { kind: "seq" };
  }

  /** A value on the line just read, `text` being where it starts, in a block at indentation `n`. */
  private inline(n: number, text: string): Shape {
    const c = text[0] ?? "";
    if (c === '"' || c === "'") return this.quoted(text);
    if (c === "|" || c === ">") return this.block(n, text);
    if (c === "[" || c === "{") return flow(text);
    // An anchor needs a name; a named one, or a tag, this check does not follow.
    if (c === "&") throw /^&[0-9A-Za-z_-]/.test(text) ? new Unknown() : new Invalid();
    if (c === "!") throw new Unknown();
    // An alias to no anchor; one there could be, this check does not follow.
    if (c === "*") throw this.anchors ? new Unknown() : new Invalid();
    // An entry, or an explicit key, on a key's own line.
    if (isEntry(text) || (c === "?" && (text.length === 1 || isBlank(text[1])))) throw new Invalid();
    if (c === ":" && (text.length === 1 || isBlank(text[1]))) throw new Unknown();
    if ("@`%,]}".includes(c)) throw new Invalid();
    return this.plain(n, text);
  }

  /**
   * A plain scalar and the lines below that go on with it, indented more than `n`, as libyaml
   * reads them: a blank line is the scalar's, a comment line ends it, and a tab short of that
   * indentation is refused.
   */
  private plain(n: number, text: string): Shape {
    const first = plainLine(text);
    let ended = first.comment;
    let lines = 1;
    while (!ended && this.i < this.lines.length) {
      const line = this.lines[this.i] ?? "";
      const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
      if (lead.slice(0, n + 1).includes("\t")) throw new Invalid();
      const rest = line.slice(lead.length);
      if (rest === "") {
        this.i++;
        continue;
      }
      if (rest.startsWith("#")) {
        this.i++;
        break;
      }
      if (lead.length <= n || MARKER.test(line)) break;
      this.i++;
      ended = plainLine(rest).comment;
      lines++;
    }
    return { kind: "scalar", text: first.text, null: lines === 1 && NULL.test(first.text), blank: false };
  }

  /** A quoted scalar from the line just read, over as many lines as it takes; then nothing but a comment. */
  private quoted(text: string): Shape {
    const q = text[0];
    let line = text;
    let k = 1;
    let content = "";
    for (;;) {
      if (k >= line.length) {
        // On to the next line, which libyaml reads at any indentation.
        const next = this.lines[this.i];
        if (next === undefined || MARKER.test(next)) throw new Invalid();
        this.i++;
        line = next;
        k = 0;
        content += " ";
        continue;
      }
      const ch = line[k] ?? "";
      if (q === "'" && ch === "'") {
        if (line[k + 1] === "'") {
          content += "'";
          k += 2;
          continue;
        }
        break;
      }
      if (q === '"' && ch === '"') break;
      if (q === '"' && ch === "\\") {
        const length = escapeLength(line, k);
        content += escapeBlank(line.slice(k, k + length)) ? " " : "x";
        k += length;
        continue;
      }
      content += ch;
      k++;
    }
    // libyaml takes a `#` right after the closing quote for a comment too.
    if (!/^[ \t]*(#.*)?$/.test(line.slice(k + 1))) throw new Invalid();
    return { kind: "scalar", text: content, null: false, blank: rustTrim(content) === "" };
  }

  /**
   * A block scalar: its header, then the lines indented as its first line is, or as the header
   * says - more than `n` either way - a blank line before the first one counting too, as libyaml
   * reads it. A tab short of that indentation is refused.
   */
  private block(n: number, header: string): Shape {
    const indicators = /^[|>]([1-9][+-]?|[+-][1-9]?)?[ \t]*(#.*)?$/.exec(header);
    if (!indicators) throw new Invalid();
    const given = /[1-9]/.exec(indicators[1] ?? "")?.[0];
    let indent = given === undefined ? undefined : n + Number(given);
    let longest = 0;
    let blank = true;
    for (let j = this.i; j < this.lines.length; j++) {
      const line = this.lines[j] ?? "";
      const spaces = line.length - line.replace(/^ +/, "").length;
      if (line[spaces] === "\t" && (indent === undefined || spaces < indent)) throw new Invalid();
      const text = line.slice(spaces);
      if (text === "") {
        longest = Math.max(longest, spaces);
        continue;
      }
      indent ??= Math.max(longest, spaces, n + 1);
      if (spaces < indent) {
        // What is left at another column is a token where none can go; a comment is none.
        if (spaces > n && !text.startsWith("#")) throw new Invalid();
        break;
      }
      blank = false;
      this.i = j + 1;
    }
    // Trailing blank lines are the scalar's too; leaving them to be skipped reads the same.
    return { kind: "scalar", text: "", null: false, blank };
  }
}

/** A mapping key on a line, and what follows its `:`. */
function key(text: string): { name: string; rest: string } {
  const c = text[0] ?? "";
  if (c === '"' || c === "'") {
    const end = quotedEnd(text);
    // A key on one line only.
    if (end === undefined) throw new Invalid();
    const after = text.slice(end).replace(/^[ \t]*/, "");
    if (after[0] !== ":" || !(after.length === 1 || isBlank(after[1]))) throw new Invalid();
    return { name: text.slice(1, end - 1), rest: after.slice(1) };
  }
  if ("?[{&!*".includes(c) || (c === ":" && (text.length === 1 || isBlank(text[1])))) throw new Unknown();
  if ("@`%|>,]}#".includes(c) || isEntry(text)) throw new Invalid();
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "#" && isBlank(text[k - 1])) break;
    if (text[k] === ":" && (k + 1 === text.length || isBlank(text[k + 1]))) {
      return { name: text.slice(0, k).replace(/[ \t]+$/, ""), rest: text.slice(k + 1) };
    }
  }
  throw new Invalid();
}

/** Where a quoted scalar that opens `text` ends on this line, past its closing quote; undefined when it goes on. */
function quotedEnd(text: string): number | undefined {
  const q = text[0];
  for (let k = 1; k < text.length; k++) {
    const ch = text[k];
    if (q === "'" && ch === "'") {
      if (text[k + 1] === "'") {
        k++;
        continue;
      }
      return k + 1;
    }
    if (q === '"' && ch === "\\") {
      k += escapeLength(text, k) - 1;
      continue;
    }
    if (q === '"' && ch === '"') return k + 1;
  }
  return undefined;
}

/** The escapes libyaml takes after a backslash, and how many hex digits follow the three that take them. */
const ESCAPES = new Set([...'0abt\tnvfre "/\\N_LP']);
const HEX: Record<string, number> = { x: 2, u: 4, U: 8 };

/** How long the escape at `line[k]` is: a backslash at the line's end, a line break escaped, is one. */
function escapeLength(line: string, k: number): number {
  const e = line[k + 1];
  if (e === undefined) return 1;
  if (ESCAPES.has(e)) return 2;
  const digits = HEX[e];
  const hex = digits === undefined ? "" : line.slice(k + 2, k + 2 + digits);
  if (digits === undefined || hex.length < digits || !/^[0-9a-fA-F]+$/.test(hex)) throw new Invalid();
  return 2 + digits;
}

/** Whether an escape stands for whitespace, as Rust's `trim` takes it. */
function escapeBlank(sequence: string): boolean {
  return (
    sequence === "\\" ||
    /^\\[tnvfr \tNLP_]$/.test(sequence) ||
    /^\\(x|u00|U000000)(0[9a-dA-D]|20|85|[aA]0)$/.test(sequence)
  );
}

/** A plain scalar's text on one line, and whether a comment ends it; a `: ` in it is a mapping libyaml does not allow there. */
function plainLine(text: string): { text: string; comment: boolean } {
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "#" && (k === 0 || isBlank(text[k - 1]))) return { text: text.slice(0, k).trimEnd(), comment: true };
    if (ch === ":" && (k + 1 === text.length || isBlank(text[k + 1]))) throw new Invalid();
  }
  return { text: text.trimEnd(), comment: false };
}

const FLOW_INDICATORS = ",[]{}";

/**
 * A flow collection that opens `text`, and nothing after it but a comment. One that does not
 * close on its line, or holds what the check does not follow, is not followed. `unique`: a
 * mapping must hold each key once, as serde_yaml's Value wants it.
 */
function flow(text: string, unique = false): Shape {
  let k = 0;
  const skip = () => {
    while (isBlank(text[k])) k++;
    // A comment runs to the line's end, so the collection goes on below.
    if (text[k] === "#" && isBlank(text[k - 1])) throw new Unknown();
  };
  const node = (): Shape => {
    skip();
    const c = text[k];
    if (c === undefined) throw new Unknown();
    if (c === "[" || c === "{") return collection();
    if (c === '"' || c === "'") {
      const end = quotedEnd(text.slice(k));
      if (end === undefined) throw new Unknown();
      const content = text.slice(k + 1, k + end - 1);
      k += end;
      return { kind: "scalar", text: content, null: false, blank: rustTrim(content) === "" };
    }
    if ("&!*?".includes(c)) throw new Unknown();
    const next = text[k + 1];
    if (c === "-" && (next === undefined || isBlank(next))) throw new Invalid();
    if (c === ":" && (next === undefined || isBlank(next) || FLOW_INDICATORS.includes(next))) throw new Unknown();
    if ("@`%|>#".includes(c)) throw new Invalid();
    if (FLOW_INDICATORS.includes(c)) return { kind: "empty" };
    const start = k;
    while (k < text.length) {
      const ch = text[k] ?? "";
      const after = text[k + 1];
      if (FLOW_INDICATORS.includes(ch)) break;
      if (ch === ":" && (after === undefined || isBlank(after) || FLOW_INDICATORS.includes(after))) break;
      if (ch === "#" && isBlank(text[k - 1])) break;
      k++;
    }
    const value = text.slice(start, k).trimEnd();
    return { kind: "scalar", text: value, null: NULL.test(value), blank: false };
  };
  const collection = (): Shape => {
    const open = text[k++];
    const close = open === "[" ? "]" : "}";
    const entries: [string, Shape][] = [];
    for (;;) {
      skip();
      if (text[k] === undefined) throw new Unknown();
      if (text[k] === close) break;
      if (text[k] === ",") throw new Unknown();
      const first = node();
      skip();
      let value: Shape = { kind: "empty" };
      if (text[k] === ":") {
        k++;
        value = node();
        skip();
      }
      if (open === "{") {
        if (first.kind !== "scalar") throw new Unknown();
        if (unique && entries.some(([name]) => name === first.text)) throw new Invalid();
        entries.push([first.text, value]);
      }
      if (text[k] === ",") {
        k++;
        continue;
      }
      if (text[k] === close) break;
      if (text[k] === undefined) throw new Unknown();
      throw new Invalid();
    }
    k++;
    return open === "[" ? { kind: "seq" } : { kind: "map", entries };
  };
  const shape = collection();
  // A comment can follow right after it, as libyaml reads it.
  const rest = text.slice(k);
  if (/^[ \t]*(#.*)?$/.test(rest)) return shape;
  if (/^[ \t]*:/.test(rest)) throw new Unknown();
  throw new Invalid();
}
