/**
 * Whether Codex 0.159.3 reads a SKILL.md's front matter, as `parse_skill_frontmatter_metadata`
 * (codex-rs/skills, parser.rs) reads it: serde_yaml, a libyaml port, into `name` and
 * `description`, strings, and `metadata`, a mapping whose `short-description` is a string. When
 * that fails Codex quotes, line by line, an unquoted value that holds `: ` or starts like a flow
 * collection that does not parse, and tries once more. A description it then finds empty, or
 * none, it refuses too.
 *
 * Not a YAML parser: a check of the block mappings, sequences and scalars front matter is written
 * in, flow collections over one line or several, tags, anchors and aliases, explicit `? ` keys and
 * the `---` and `...` document markers. It says a front matter does not read only where libyaml
 * refuses it, or serde finds the three fields of the wrong shape - each rule as Codex's
 * skills/list showed it; for what it does not follow - a `%TAG` directive, an explicit key in a
 * flow collection, a block scalar as a key, an alias to the node it sits in - it says nothing, and
 * the skill reads as it did before.
 */

/**
 * A node's shape: what the three fields' types turn on. A scalar says whether it is plain, its
 * tag, and whether it is null or blank as it stands, and keeps its value - all its lines, its
 * escapes read - as far as the name and the description shown need it: their whitespace Codex
 * collapses (`sanitize_single_line`), so a line break is a space here. An alias names the node it
 * stands for, if one is anchored before it.
 */
type Shape =
  | { kind: "empty"; tag?: string }
  | { kind: "scalar"; text: string; value: string; null: boolean; blank: boolean; plain: boolean; tag?: string }
  | { kind: "seq" }
  | { kind: "map"; entries: Entry[] }
  | { kind: "alias"; target?: Shape; open: boolean };

type Entry = { key: Shape; value: Shape };
type MapShape = Extract<Shape, { kind: "map" }>;

/** libyaml, or serde, refuses it. */
class Invalid extends Error {}
/** Something this check does not follow: it says nothing. */
class Unknown extends Error {}

/** The tag `!!null` resolves to: serde_yaml takes a plain scalar under it as null, or refuses it. */
const NULL_TAG = "tag:yaml.org,2002:null";

/**
 * What Codex reads of a SKILL.md's front matter, `block`: why it does not load the skill, if it
 * does not - the front matter is not valid YAML, or it has no description (none, a null one, or
 * one of whitespace alone), which Codex checks after the name's length - and, where it reads the
 * front matter, the `name` and `description` it gives the skill, each on one line as
 * `sanitize_single_line` makes it; no name where the field is none or empty, as Codex then takes
 * the folder's. `followed` is false where this check says nothing (Unknown), and then only that.
 */
export type CodexFrontMatter = {
  error?: "invalid front matter" | "no description";
  name?: string;
  description?: string;
  followed: boolean;
};

export function codexFrontMatter(block: string): CodexFrontMatter {
  try {
    let root = read(block);
    if (root === undefined) {
      const repaired = repairedFields(block);
      if (repaired !== undefined) root = read(repaired);
    }
    if (root === undefined) return { error: "invalid front matter", followed: true };
    const map = root;
    const field = (name: string) => (map === "empty" ? undefined : fieldOf(map, name));
    const description = field("description");
    const error = description === undefined || stringField(description) !== "text" ? "no description" : undefined;
    const name = rustSingleLine(stringOf(field("name")) ?? "");
    const shown = rustSingleLine(stringOf(description) ?? "");
    return {
      ...(error ? { error } : {}),
      ...(name ? { name } : {}),
      ...(shown ? { description: shown } : {}),
      followed: true,
    };
  } catch (error) {
    if (error instanceof Unknown) return { followed: false };
    throw error;
  }
}

/** Why Codex does not load a SKILL.md whose front matter is `block`, if it does not (codexFrontMatter). */
export function codexFrontMatterError(block: string): "invalid front matter" | "no description" | undefined {
  return codexFrontMatter(block).error;
}

/** A field's string as serde gets it, undefined for none: a null, or no value at all. */
function stringOf(shape: Shape | undefined): string | undefined {
  if (shape === undefined) return undefined;
  const node = resolved(shape);
  if (node.kind === "empty") return node.tag === undefined ? undefined : "";
  if (node.kind !== "scalar") return undefined;
  if (node.plain && (node.tag === NULL_TAG || (node.tag === undefined && node.null))) return undefined;
  return node.value;
}

/** Codex's `sanitize_single_line`: the words of `text`, split at Rust's whitespace, joined by one space. */
function rustSingleLine(text: string): string {
  return text.split(RUST_SPACES).filter(Boolean).join(" ");
}

/** The front matter's mapping, or "empty" for one with no node at all; undefined where Codex fails to read it. */
function read(text: string): MapShape | "empty" | undefined {
  try {
    const root = new Reader(text.split("\n")).document();
    if (root === undefined || root.kind === "empty") return "empty";
    return root.kind === "map" && fieldsRead(root) ? root : undefined;
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
}

/**
 * An alias as serde reads it where it deserializes one: the node it names, or a refusal ("unknown
 * anchor") where none is anchored before it. One inside the node it names, this does not follow.
 */
function resolved(shape: Shape): Exclude<Shape, { kind: "alias" }> {
  if (shape.kind !== "alias") return shape;
  if (shape.open) throw new Unknown();
  if (shape.target === undefined) throw new Invalid();
  return resolved(shape.target);
}

/**
 * A mapping's keys as serde takes them for a struct's fields: a scalar's text, an empty key as
 * "", and no sequence or mapping, which is no field name. Each value it deserializes too, so an
 * alias among them must name a node.
 */
function fieldNames(map: MapShape): [string, Shape][] {
  return map.entries.map(({ key, value }) => {
    const k = resolved(key);
    resolved(value);
    if (k.kind === "seq" || k.kind === "map") throw new Invalid();
    if (k.tag === NULL_TAG) throw new Unknown();
    return [k.kind === "empty" ? "" : k.text, value];
  });
}

/** Whether serde reads the three fields: each once, `name` and `description` strings, `metadata` a mapping. */
function fieldsRead(root: MapShape): boolean {
  const once = (fields: [string, Shape][], names: readonly string[]) => {
    const keys = fields.map(([key]) => key).filter((key) => names.includes(key));
    return new Set(keys).size === keys.length;
  };
  const fields = fieldNames(root);
  if (!once(fields, ["name", "description", "metadata"])) return false;
  for (const [key, value] of fields) {
    if ((key === "name" || key === "description") && stringField(value) === "invalid") return false;
    if (key !== "metadata") continue;
    const metadata = resolved(value);
    // An empty plain value reads as no metadata, tagged or not; `null`, `~` or any other scalar is no mapping.
    if (metadata.kind === "empty") continue;
    if (metadata.kind !== "map") return false;
    const inner = fieldNames(metadata);
    if (!once(inner, ["short-description"])) return false;
    const short = inner.find(([name]) => name === "short-description")?.[1];
    if (short !== undefined && stringField(short) === "invalid") return false;
  }
  return true;
}

/**
 * An `Option<String>` field as serde_yaml reads it: none for no value or a plain null, a blank
 * string, text, or a refusal - a sequence or mapping, or a plain scalar `!!null` that is not null
 * (an empty one too). Any other tag leaves the scalar's text, `~` and `null` included.
 */
function stringField(shape: Shape): "none" | "blank" | "text" | "invalid" {
  const node = resolved(shape);
  if (node.kind === "seq" || node.kind === "map") return "invalid";
  if (node.kind === "empty") {
    if (node.tag === undefined) return "none";
    return node.tag === NULL_TAG ? "invalid" : "blank";
  }
  if (node.plain && node.tag === NULL_TAG) return node.null ? "none" : "invalid";
  if (node.plain && node.tag === undefined && node.null) return "none";
  return node.blank ? "blank" : "text";
}

function fieldOf(map: MapShape, name: string): Shape | undefined {
  return fieldNames(map).find(([key]) => key === name)?.[1];
}

const NULL = /^(~|null|Null|NULL)$/;
const MARKER = /^(\.\.\.|---)([ \t]|$)/;
const END = /^\.\.\.([ \t]|$)/;

function isBlank(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

/** A `- ` (or a lone `-`) that starts a sequence entry. */
function isEntry(text: string): boolean {
  return text[0] === "-" && (text.length === 1 || isBlank(text[1]));
}

/** A `? ` (or a lone `?`) that starts an explicit key. */
function isExplicitKey(text: string): boolean {
  return text[0] === "?" && (text.length === 1 || isBlank(text[1]));
}

/** A `: ` (or a lone `:`) that starts the value of an explicit key. */
function isExplicitValue(text: string): boolean {
  return text[0] === ":" && (text.length === 1 || isBlank(text[1]));
}

/** Nothing but blanks and a comment. */
function isRestBlank(text: string): boolean {
  return /^[ \t]*(#.*)?$/.test(text);
}

/** Whitespace as Rust's `trim` takes it: Unicode's White_Space, which leaves out U+FEFF where JavaScript's takes it. */
const RUST_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM_START = new RegExp(`^[${RUST_SPACE}]+`);
const RUST_TRIM_END = new RegExp(`[${RUST_SPACE}]+$`);
const RUST_WHITESPACE = new RegExp(`^[${RUST_SPACE}]$`);
const RUST_SPACES = new RegExp(`[${RUST_SPACE}]+`);

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
 * serde_yaml's Value takes it: a mapping in it holds each key once. A tag, an anchor or an alias
 * in it, this does not follow.
 */
function flowParses(scalar: string): boolean {
  if (scalar[0] === "@" || scalar[0] === "`") return false;
  try {
    const flow = new Flow([scalar], 0, 0, { unique: true });
    flow.collection();
    const rest = scalar.slice(flow.col);
    if (isRestBlank(rest)) return true;
    if (/^[ \t]*:/.test(rest)) throw new Unknown();
    return false;
  } catch (error) {
    if (error instanceof Invalid) return false;
    // What the check does not follow, it takes to parse: then it does not quote it either.
    return true;
  }
}

/** What a flow collection reader shares with the block reader: the anchors so far, and those still open. */
type Anchors = { done: Map<string, Shape>; open: Set<string> };

/** Properties on a node: its tag, resolved, its anchor, and what follows them. */
type Properties = { tag?: string; anchor?: string; rest: string };

const WORD = /^[0-9A-Za-z_-]$/;
/** The characters of a tag's URI, as libyaml scans one (scan_tag_uri); a verbatim `!<…>` tag takes `,`, `[` and `]` too. */
const URI = /^[0-9A-Za-z_\-;/?:@&=+$.!~*'()]$/;
const VERBATIM_URI = /^[0-9A-Za-z_\-;/?:@&=+$.!~*'(),[\]]$/;
/** What may follow an anchor or an alias's name, beside a blank (scan_anchor). */
const AFTER_ANCHOR = "?:,]}%@`";

/**
 * A tag at the start of `text`, as libyaml scans it (scan_tag): `!<uri>`, `!!suffix`, `!suffix`
 * or `!` alone; then a blank or the line's end, or a `,` in a flow collection. A handle other
 * than `!` and `!!` is undefined without a `%TAG` directive.
 */
function scanTag(text: string, flow: boolean): { tag: string; length: number } {
  let k: number;
  let tag: string;
  if (text[1] === "<") {
    const uri = scanUri(text, 2, true);
    if (uri.length === 0 || text[uri.end] !== ">") throw new Invalid();
    tag = uri.value;
    k = uri.end + 1;
  } else {
    let h = 1;
    while (WORD.test(text[h] ?? "")) h++;
    if (text[h] === "!") {
      if (h > 1) throw new Invalid();
      const suffix = scanUri(text, h + 1, false);
      if (suffix.length === 0) throw new Invalid();
      tag = `tag:yaml.org,2002:${suffix.value}`;
      k = suffix.end;
    } else {
      const suffix = scanUri(text, 1, false);
      tag = suffix.length === 0 ? "!" : `!${suffix.value}`;
      k = suffix.end;
    }
  }
  const next = text[k];
  if (next !== undefined && !isBlank(next) && !(flow && next === ",")) throw new Invalid();
  return { tag, length: k };
}

/** A tag's URI from `text[k]`: its characters, each `%XX` octet decoded and checked as UTF-8 (scan_uri_escapes). */
function scanUri(text: string, k: number, verbatim: boolean): { value: string; length: number; end: number } {
  const start = k;
  let value = "";
  const allowed = verbatim ? VERBATIM_URI : URI;
  while (k < text.length) {
    const c = text[k] ?? "";
    if (c === "%") {
      const bytes: number[] = [];
      const octet = () => {
        const hex = text.slice(k + 1, k + 3);
        if (text[k] !== "%" || !/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Invalid();
        k += 3;
        return Number.parseInt(hex, 16);
      };
      const lead = octet();
      const width =
        (lead & 0x80) === 0
          ? 1
          : (lead & 0xe0) === 0xc0
            ? 2
            : (lead & 0xf0) === 0xe0
              ? 3
              : (lead & 0xf8) === 0xf0
                ? 4
                : 0;
      if (width === 0) throw new Invalid();
      bytes.push(lead);
      for (let n = 1; n < width; n++) {
        const trail = octet();
        if ((trail & 0xc0) !== 0x80) throw new Invalid();
        bytes.push(trail);
      }
      value += new TextDecoder().decode(new Uint8Array(bytes));
      continue;
    }
    if (!allowed.test(c)) break;
    value += c;
    k++;
  }
  return { value, length: k - start, end: k };
}

/** An anchor's or an alias's name after its `&` or `*`, and where it ends: one or more word characters. */
function scanName(text: string, k: number): { name: string; end: number } {
  let end = k;
  while (WORD.test(text[end] ?? "")) end++;
  const next = text[end];
  if (end === k || (next !== undefined && !isBlank(next) && !AFTER_ANCHOR.includes(next))) throw new Invalid();
  return { name: text.slice(k, end), end };
}

/**
 * A node's tag and anchor at the start of `text`, either first, each at most once, and what
 * follows them past blanks. In a block, a name followed by an indicator, which libyaml allows,
 * this does not follow.
 */
function properties(text: string, flow: boolean): Properties {
  let rest = text;
  let tag: string | undefined;
  let anchor: string | undefined;
  for (;;) {
    if (rest[0] === "!") {
      if (tag !== undefined) throw new Invalid();
      const scanned = scanTag(rest, flow);
      tag = scanned.tag;
      rest = rest.slice(scanned.length);
    } else if (rest[0] === "&") {
      if (anchor !== undefined) throw new Invalid();
      const scanned = scanName(rest, 1);
      anchor = scanned.name;
      rest = rest.slice(scanned.end);
      if (!flow && rest !== "" && !isBlank(rest[0])) throw new Unknown();
    } else break;
    rest = rest.replace(/^[ \t]+/, "");
  }
  // An alias takes no properties.
  if (rest[0] === "*") throw new Invalid();
  return { ...(tag !== undefined ? { tag } : {}), ...(anchor !== undefined ? { anchor } : {}), rest };
}

/** A node with its tag: a scalar's, or an empty one's; a collection's serde does not look at. */
function tagged(node: Shape, tag: string | undefined): Shape {
  if (tag === undefined || (node.kind !== "scalar" && node.kind !== "empty")) return node;
  return { ...node, tag };
}

/**
 * Reads the block structure line by line: each mapping and sequence at its column, as libyaml
 * holds a block at its indentation, and a value in a mapping or an entry as a scalar, a quoted
 * or block scalar, a flow collection, an alias, or a block below its line, each with its
 * properties. A `...` ends the document; after it only comments and more `...` can come, as a
 * second document, one a `---` starts too, serde refuses.
 */
class Reader {
  private i = 0;
  private readonly lines: string[];
  private readonly anchors: Anchors = { done: new Map(), open: new Set() };
  /** Whether a token is read: a `...` before one is no document end but a node missing. */
  private started = false;
  /** The marker line peek() stopped at, the document ending there. */
  private ended: number | undefined;

  constructor(lines: string[]) {
    this.lines = lines;
  }

  document(): Shape | undefined {
    let j = this.directives(this.peek());
    if (j === undefined) return undefined;
    let { indent, text } = this.at(j);
    if (/^---([ \t]|$)/.test(this.lines[j] ?? "")) {
      // An explicit start, which libyaml takes with a comment, properties or a flow collection after it.
      this.started = true;
      const rest = text.slice(3).replace(/^[ \t]+/, "");
      if (isRestBlank(rest)) {
        this.i = j + 1;
        j = this.peek();
        if (j === undefined) return this.end(undefined);
        ({ indent, text } = this.at(j));
      } else {
        this.i = j + 1;
        return this.end(this.markerContent(rest));
      }
    }
    this.started = true;
    let root: Shape;
    if (text[0] === "[" || text[0] === "{") {
      this.i = j + 1;
      root = this.flow(text);
    } else if ((text[0] === "!" || text[0] === "&") && !this.isKey(text)) {
      // Properties for the whole document: the mapping below, or a flow collection after them.
      const props = properties(text, false);
      this.i = j + 1;
      root = this.propertied(props, -1, true);
    } else {
      // A scalar, an alias or a sequence where Codex wants a mapping.
      if (!this.isKey(text)) throw new Invalid();
      root = this.map(indent);
    }
    return this.end(root);
  }

  /**
   * `%` directives at the start: each `%YAML 1.1` or `1.2` this follows, before the `---` that
   * must come after them; any other, such as a `%TAG`, not.
   */
  private directives(first: number | undefined): number | undefined {
    let j = first;
    let any = false;
    while (j !== undefined && (this.lines[j] ?? "").startsWith("%")) {
      if (any || !/^%YAML[ \t]+1\.[12][ \t]*(#.*)?$/.test(this.lines[j] ?? "")) throw new Unknown();
      any = true;
      this.i = j + 1;
      j = this.peek();
    }
    if (any && (j === undefined || !/^---([ \t]|$)/.test(this.lines[j] ?? ""))) throw new Invalid();
    return j;
  }

  /** What follows `--- ` on its line: properties for the node below, a flow collection, or a scalar Codex wants no root of. */
  private markerContent(rest: string): Shape {
    const c = rest[0] ?? "";
    if (c === "!" || c === "&") return this.propertied(properties(rest, false), -1, true);
    if (c === "[" || c === "{") return this.flow(rest);
    if (c === "*") return this.alias(rest);
    if (/^[0-9A-Za-z'"|>-]/.test(rest) || isExplicitKey(rest)) throw new Invalid();
    throw new Unknown();
  }

  /** The document's root, once nothing of it is left: after a `...` only comments and more `...`, and no `---`. */
  private end(root: Shape | undefined): Shape | undefined {
    if (this.peek() !== undefined) throw new Invalid();
    if (this.ended === undefined) return root;
    if (!END.test(this.lines[this.ended] ?? "")) throw new Invalid();
    for (let j = this.ended; j < this.lines.length; j++) {
      const line = this.lines[j] ?? "";
      const rest = END.test(line) ? line.slice(3) : line;
      if (/^ *\t/.test(rest) && j !== this.ended) throw new Invalid();
      if (!/^[ \t]*(#.*)?$/.test(rest)) throw new Invalid();
    }
    return root;
  }

  /**
   * The next line that starts a token, past blank and comment lines; undefined at the end, or at
   * a document marker, where the document ends. Here a tab in a line's indentation, or a
   * directive, is no token libyaml can start; nor is a `...` before any.
   */
  private peek(): number | undefined {
    if (this.ended !== undefined) return undefined;
    for (let j = this.i; j < this.lines.length; j++) {
      const line = this.lines[j] ?? "";
      if (/^ *\t/.test(line)) throw new Invalid();
      if (line.startsWith("%")) {
        if (this.started) throw new Invalid();
        return j;
      }
      if (MARKER.test(line)) {
        if (!this.started && END.test(line)) throw new Invalid();
        if (!this.started) return j;
        this.ended = j;
        return undefined;
      }
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

  /** Whether a line's text is a mapping key: an explicit one, or an implicit one, past its properties. A flow collection is a value. */
  private isKey(text: string): boolean {
    if (isExplicitKey(text)) return true;
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
    const entries: Entry[] = [];
    for (let j = this.peek(); j !== undefined; j = this.peek()) {
      const { indent, text } = this.at(j);
      if (indent < n) break;
      // A line deeper than the keys, or an entry where a key goes.
      if (indent > n || isEntry(text)) throw new Invalid();
      if (isExplicitKey(text)) {
        entries.push(this.explicit(j, n, text));
        continue;
      }
      const { name, rest, props } = key(text);
      this.i = j + 1;
      const keyShape = name.alias !== undefined ? this.aliasNamed(name.alias) : this.keyScalar(name, props);
      const value = rest.replace(/^[ \t]+/, "");
      entries.push({
        key: keyShape,
        value: value === "" || value.startsWith("#") ? this.below(n, true) : this.inline(n, value, true),
      });
    }
    return { kind: "map", entries };
  }

  /** A key's scalar, with its tag, its anchor recorded for an alias after it. */
  private keyScalar(name: { text: string; plain: boolean }, props: Properties | undefined): Shape {
    const shape: Shape = {
      kind: "scalar",
      text: name.text,
      value: name.text,
      null: false,
      blank: false,
      plain: name.plain,
      ...(props?.tag !== undefined ? { tag: props.tag } : {}),
    };
    if (props?.anchor !== undefined) this.anchors.done.set(props.anchor, shape);
    return shape;
  }

  /**
   * An explicit key at indentation `n`, from its `? ` line: the key after it or below it, and
   * the value after a `: ` line at the same indentation, if one follows; else none.
   */
  private explicit(j: number, n: number, text: string): Entry {
    // libyaml takes no tab after an indicator in a block.
    if (text[1] === "\t") throw new Invalid();
    this.i = j + 1;
    const key = this.after(j, n, text, false);
    const v = this.peek();
    if (v === undefined) return { key, value: { kind: "empty" } };
    const at = this.at(v);
    if (at.indent !== n || !isExplicitValue(at.text)) return { key, value: { kind: "empty" } };
    if (at.text[1] === "\t") throw new Unknown();
    this.i = v + 1;
    return { key, value: this.after(v, n, at.text, true) };
  }

  /**
   * The node after an indicator - `? `, `: ` - on line `j`: below it, or on the line, where a
   * sequence or a mapping starts at the column it starts at.
   */
  private after(j: number, n: number, text: string, compact: boolean): Shape {
    const content = text.slice(1).replace(/^ +/, "");
    if (content.startsWith("\t")) throw new Unknown();
    if (content === "" || content.startsWith("#")) return this.below(n, compact);
    if (isEntry(content) || this.isKey(content)) {
      const column = n + text.length - content.length;
      this.lines[j] = " ".repeat(column) + content;
      this.i = j;
      return isEntry(content) ? this.seq(column) : this.map(column);
    }
    return this.inline(n, content, compact);
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
    return this.inline(n, text, false);
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
      this.inline(n, content, false);
    }
    return { kind: "seq" };
  }

  /**
   * A value on the line just read, `text` being where it starts, in a block at indentation `n`.
   * `compact`: a sequence below may sit at the column of the key it is the value of.
   */
  private inline(n: number, text: string, compact: boolean): Shape {
    const c = text[0] ?? "";
    if (c === "!" || c === "&") return this.propertied(properties(text, false), n, compact);
    if (c === "*") return this.alias(text);
    if (c === '"' || c === "'") return this.quoted(text);
    if (c === "|" || c === ">") return this.block(n, text);
    if (c === "[" || c === "{") return this.flow(text);
    // An entry, or an explicit key, on a key's own line.
    if (isEntry(text) || isExplicitKey(text)) throw new Invalid();
    if (c === ":" && (text.length === 1 || isBlank(text[1]))) throw new Unknown();
    if ("@`%,]}".includes(c)) throw new Invalid();
    return this.plain(n, text);
  }

  /** A node after its properties: on the line, or below it, with its tag, its anchor recorded for an alias after it. */
  private propertied(props: Properties, n: number, compact: boolean): Shape {
    const { rest, tag, anchor } = props;
    if (anchor !== undefined) this.anchors.open.add(anchor);
    const node = isRestBlank(rest) ? this.below(n, compact) : this.inline(n, rest, compact);
    const shape = tagged(node, tag);
    if (anchor !== undefined) {
      this.anchors.open.delete(anchor);
      this.anchors.done.set(anchor, shape);
    }
    return shape;
  }

  /** An alias on the line just read, and nothing after it but a comment. */
  private alias(text: string): Shape {
    const { name, end } = scanName(text, 1);
    if (!isRestBlank(text.slice(end))) throw new Invalid();
    return this.aliasNamed(name);
  }

  private aliasNamed(name: string): Shape {
    const target = this.anchors.done.get(name);
    return { kind: "alias", ...(target !== undefined ? { target } : {}), open: this.anchors.open.has(name) };
  }

  /**
   * A flow collection that opens `text`, the rest of the line just read, over as many lines as it
   * takes; then nothing on its last line but a comment.
   */
  private flow(text: string): Shape {
    const line = this.i - 1;
    const start = (this.lines[line] ?? "").length - text.length;
    const flow = new Flow(this.lines, line, start, { unique: false, anchors: this.anchors });
    const shape = flow.collection();
    this.i = flow.line + 1;
    const rest = (this.lines[flow.line] ?? "").slice(flow.col);
    if (isRestBlank(rest)) return shape;
    // As a key: one line, which this does not follow, or several, which libyaml refuses.
    if (/^[ \t]*:/.test(rest) && flow.line === line) throw new Unknown();
    throw new Invalid();
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
    let value = first.text;
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
      const next = plainLine(rest);
      ended = next.comment;
      value += ` ${next.text}`;
      lines++;
    }
    const isNull = lines === 1 && NULL.test(first.text);
    return { kind: "scalar", text: first.text, value, null: isNull, blank: false, plain: true };
  }

  /** A quoted scalar from the line just read, over as many lines as it takes; then nothing but a comment. */
  private quoted(text: string): Shape {
    const q = text[0];
    let line = text;
    let k = 1;
    let content = "";
    let value = "";
    for (;;) {
      if (k >= line.length) {
        // On to the next line, which libyaml reads at any indentation.
        const next = this.lines[this.i];
        if (next === undefined || MARKER.test(next)) throw new Invalid();
        this.i++;
        line = next;
        // libyaml drops a continued line's leading blanks.
        k = 0;
        while (isBlank(line[k])) k++;
        content += " ";
        // An escaped line break joins the lines with nothing between them.
        if (value.endsWith(ESCAPED_BREAK)) value = value.slice(0, -ESCAPED_BREAK.length);
        else value += " ";
        continue;
      }
      const ch = line[k] ?? "";
      if (q === "'" && ch === "'") {
        if (line[k + 1] === "'") {
          content += "'";
          value += "'";
          k += 2;
          continue;
        }
        break;
      }
      if (q === '"' && ch === '"') break;
      if (q === '"' && ch === "\\") {
        const length = escapeLength(line, k);
        const sequence = line.slice(k, k + length);
        content += escapeBlank(sequence) ? " " : "x";
        value += escaped(sequence);
        k += length;
        continue;
      }
      content += ch;
      value += ch;
      k++;
    }
    // libyaml takes a `#` right after the closing quote for a comment too.
    if (!isRestBlank(line.slice(k + 1))) throw new Invalid();
    return { kind: "scalar", text: content, value, null: false, blank: rustTrim(content) === "", plain: false };
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
    const content: string[] = [];
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
      content.push(line.slice(indent));
      this.i = j + 1;
    }
    // Trailing blank lines are the scalar's too; leaving them to be skipped reads the same.
    return { kind: "scalar", text: "", value: content.join(" "), null: false, blank, plain: false };
  }
}

/**
 * A mapping key on a line, past its properties, and what follows its `:`: a plain or quoted
 * scalar's text, or an alias's name. A key that starts with `?` or `:` and no blank after is a
 * plain one; a flow collection as a key this does not follow.
 */
function key(text: string): {
  name: { text: string; plain: boolean; alias?: string };
  rest: string;
  props?: Properties;
} {
  let props: Properties | undefined;
  let line = text;
  if (line[0] === "!" || line[0] === "&") {
    props = properties(line, false);
    line = props.rest;
    if (isRestBlank(line)) throw new Invalid();
  }
  const c = line[0] ?? "";
  const colonAfter = (after: string) => {
    const at = after.replace(/^[ \t]*/, "");
    if (at[0] !== ":" || !(at.length === 1 || isBlank(at[1]))) throw new Invalid();
    return at.slice(1);
  };
  if (c === "*") {
    const { name, end } = scanName(line, 1);
    return { name: { text: "", plain: true, alias: name }, rest: colonAfter(line.slice(end)) };
  }
  if (c === '"' || c === "'") {
    const end = quotedEnd(line);
    // A key on one line only.
    if (end === undefined) throw new Invalid();
    return {
      name: { text: line.slice(1, end - 1), plain: false },
      rest: colonAfter(line.slice(end)),
      ...(props ? { props } : {}),
    };
  }
  if (c === "[" || c === "{") throw new Unknown();
  if (isExplicitKey(line) || isExplicitValue(line)) throw new Invalid();
  if ("@`%|>,]}#".includes(c) || isEntry(line)) throw new Invalid();
  for (let k = 0; k < line.length; k++) {
    if (line[k] === "#" && isBlank(line[k - 1])) break;
    if (line[k] === ":" && (k + 1 === line.length || isBlank(line[k + 1]))) {
      const name = { text: line.slice(0, k).replace(/[ \t]+$/, ""), plain: true };
      return { name, rest: line.slice(k + 1), ...(props ? { props } : {}) };
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

/** What a value keeps for a backslash at a line's end, which the line break after it then drops. */
const ESCAPED_BREAK = "\u0000break";

/** What libyaml makes of an escape in a double-quoted scalar. */
function escaped(sequence: string): string {
  if (sequence === "\\") return ESCAPED_BREAK;
  const e = sequence[1] ?? "";
  const named: Record<string, string> = {
    "0": "\0",
    a: "\x07",
    b: "\b",
    t: "\t",
    "\t": "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    e: "\x1b",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    N: "\u0085",
    _: "\u00a0",
    L: "\u2028",
    P: "\u2029",
  };
  const plain = named[e];
  if (plain !== undefined) return plain;
  const code = Number.parseInt(sequence.slice(2), 16);
  return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
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
 * A flow collection from `lines[line][col]`, over as many lines as it takes, as libyaml reads
 * one: a line break and a comment are blanks there, a tab too, and a plain or quoted scalar goes
 * on over lines. `unique`: a mapping must hold each key once, as serde_yaml's Value wants it.
 * Without `anchors` - a value checked as a document of its own - a tag, an anchor or an alias it
 * does not follow. A document marker in it, or an explicit key, neither.
 */
class Flow {
  line: number;
  col: number;
  private readonly lines: string[];
  private readonly unique: boolean;
  private readonly anchors: Anchors | undefined;

  constructor(lines: string[], line: number, col: number, options: { unique: boolean; anchors?: Anchors }) {
    this.lines = lines;
    this.line = line;
    this.col = col;
    this.unique = options.unique;
    this.anchors = options.anchors;
  }

  /** The character at the position: "\n" at a line's end with a line after it, undefined at the end of all. */
  private ch(): string | undefined {
    const text = this.lines[this.line] ?? "";
    if (this.col < text.length) return text[this.col];
    return this.line + 1 < this.lines.length ? "\n" : undefined;
  }

  private nextLine(): void {
    this.line++;
    this.col = 0;
    if (MARKER.test(this.lines[this.line] ?? "")) throw new Unknown();
  }

  /** Past blanks, line breaks and comments; whether it went past a line break. */
  private skip(): boolean {
    let broke = false;
    for (;;) {
      const c = this.ch();
      if (c === " " || c === "\t") this.col++;
      else if (c === "#") this.col = (this.lines[this.line] ?? "").length;
      else if (c === "\n") {
        this.nextLine();
        broke = true;
      } else return broke;
    }
  }

  collection(): Shape {
    const open = this.ch();
    this.col++;
    const close = open === "[" ? "]" : "}";
    const entries: Entry[] = [];
    for (;;) {
      this.skip();
      const c = this.ch();
      if (c === undefined) throw new Invalid();
      if (c === close) break;
      if (c === ",") throw new Unknown();
      const first = this.node();
      const broke = this.skip();
      let value: Shape = { kind: "empty" };
      if (this.ch() === ":") {
        // A key ends on its own line: a `:` after a line break follows none.
        if (broke) throw new Invalid();
        this.col++;
        value = this.node();
        this.skip();
      }
      if (open === "{") {
        if (first.kind !== "scalar") throw new Unknown();
        if (this.unique && entries.some(({ key }) => key.kind === "scalar" && key.text === first.text)) {
          throw new Invalid();
        }
        entries.push({ key: first, value });
      }
      const after = this.ch();
      if (after === ",") {
        this.col++;
        continue;
      }
      if (after === close) break;
      throw new Invalid();
    }
    this.col++;
    return open === "[" ? { kind: "seq" } : { kind: "map", entries };
  }

  private node(): Shape {
    this.skip();
    const text = this.lines[this.line] ?? "";
    const c = this.ch();
    if (c === undefined) throw new Invalid();
    if (c === "[" || c === "{") return this.collection();
    if (c === '"' || c === "'") return this.quoted();
    if (c === "!" || c === "&") {
      if (this.anchors === undefined) throw new Unknown();
      const props = properties(text.slice(this.col), true);
      this.col = text.length - props.rest.length;
      if (props.anchor !== undefined) this.anchors.open.add(props.anchor);
      const next = this.ch();
      // Across a line break the node goes on; a `,` or a closing bracket leaves it empty.
      const node: Shape = next !== undefined && ",]}".includes(next) ? { kind: "empty" } : this.node();
      const shape = tagged(node, props.tag);
      if (props.anchor !== undefined) {
        this.anchors.open.delete(props.anchor);
        this.anchors.done.set(props.anchor, shape);
      }
      return shape;
    }
    if (c === "*") {
      if (this.anchors === undefined) throw new Unknown();
      const { name, end } = scanName(text, this.col + 1);
      this.col = end;
      const target = this.anchors.done.get(name);
      return { kind: "alias", ...(target !== undefined ? { target } : {}), open: this.anchors.open.has(name) };
    }
    const next = text[this.col + 1];
    if (c === "?" && (next === undefined || isBlank(next))) throw new Unknown();
    if (c === "-" && (next === undefined || isBlank(next))) throw new Invalid();
    if (c === ":" && (next === undefined || isBlank(next) || FLOW_INDICATORS.includes(next))) throw new Unknown();
    if ("@`%|>".includes(c)) throw new Invalid();
    if (FLOW_INDICATORS.includes(c)) return { kind: "empty" };
    return this.plain();
  }

  /** A plain scalar, on to the next lines while they go on with it. */
  private plain(): Shape {
    let value = "";
    let lines = 1;
    for (;;) {
      const text = this.lines[this.line] ?? "";
      const start = this.col;
      while (this.col < text.length) {
        const ch = text[this.col] ?? "";
        const after = text[this.col + 1];
        if (FLOW_INDICATORS.includes(ch)) break;
        if (ch === ":" && (after === undefined || isBlank(after) || FLOW_INDICATORS.includes(after))) break;
        if (ch === "#" && isBlank(text[this.col - 1])) break;
        this.col++;
      }
      value += (value === "" ? "" : " ") + text.slice(start, this.col).trim();
      if (this.col < text.length) break;
      // At the line's end: the scalar goes on where the next line that holds anything starts it.
      let j = this.line + 1;
      while (j < this.lines.length && /^[ \t]*$/.test(this.lines[j] ?? "")) j++;
      const next = this.lines[j];
      if (next === undefined || MARKER.test(next)) break;
      const lead = /^[ \t]*/.exec(next)?.[0].length ?? 0;
      const c = next[lead] ?? "";
      const after = next[lead + 1];
      if (c === "#" || FLOW_INDICATORS.includes(c)) break;
      if (c === ":" && (after === undefined || isBlank(after) || FLOW_INDICATORS.includes(after))) break;
      this.line = j;
      this.col = lead;
      lines++;
    }
    const text = value.trimEnd();
    return { kind: "scalar", text, value: text, null: lines === 1 && NULL.test(text), blank: false, plain: true };
  }

  /** A quoted scalar, over as many lines as it takes; a document marker in it libyaml refuses. */
  private quoted(): Shape {
    const q = this.ch();
    this.col++;
    let content = "";
    let value = "";
    for (;;) {
      const text = this.lines[this.line] ?? "";
      if (this.col >= text.length) {
        if (this.line + 1 >= this.lines.length || MARKER.test(this.lines[this.line + 1] ?? "")) throw new Invalid();
        this.line++;
        this.col = 0;
        while (isBlank(this.lines[this.line]?.[this.col])) this.col++;
        content += " ";
        if (value.endsWith(ESCAPED_BREAK)) value = value.slice(0, -ESCAPED_BREAK.length);
        else value += " ";
        continue;
      }
      const ch = text[this.col] ?? "";
      if (q === "'" && ch === "'") {
        if (text[this.col + 1] === "'") {
          content += "'";
          value += "'";
          this.col += 2;
          continue;
        }
        break;
      }
      if (q === '"' && ch === '"') break;
      if (q === '"' && ch === "\\") {
        const length = escapeLength(text, this.col);
        const sequence = text.slice(this.col, this.col + length);
        content += escapeBlank(sequence) ? " " : "x";
        value += escaped(sequence);
        this.col += length;
        continue;
      }
      content += ch;
      value += ch;
      this.col++;
    }
    this.col++;
    return { kind: "scalar", text: content, value, null: false, blank: rustTrim(content) === "", plain: false };
  }
}
