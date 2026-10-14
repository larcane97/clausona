import {
  AGE,
  BOOL,
  GENERAL_CATEGORY,
  GRAPHEME_CLUSTER_BREAK,
  PROPERTY_NAMES,
  PROPERTY_VALUES,
  SCRIPT,
  SCRIPT_EXTENSION,
  SENTENCE_BREAK,
  WORD_BREAK,
} from "./codex-matcher-unicode.js";

/**
 * Whether Codex 0.159.3 skips a hook group for its matcher ("invalid matcher"). On an event whose
 * matcher it reads, Codex takes "" and "*" as any tool and a matcher of ASCII letters, digits,
 * `_` and `|` as names, and compiles any other with Rust's regex crate (1.12, regex-syntax 0.8):
 * where that fails, it skips the whole group (codex-rs hooks discovery.rs, events/common.rs).
 *
 * JS's RegExp has no say here, as the two dialects differ both ways: JS takes lookaround,
 * backreferences, `[]`, `\e`, `\0`, `a{` and `a{,2}`, which Rust refuses, and refuses `(?i)`,
 * `(?P<n>x)`, `a**`, `x{2}{3}` and `[a--b]`, which Rust takes. So this ports what the regex crate
 * does with a pattern, as far as it decides an error: regex-syntax's parser (ast::parse), its nest
 * limit of 250, its translation to HIR - a `\p{…}` name it does not know, and, under `(?-u)`, what
 * could match invalid UTF-8, which a `Regex` refuses - and the compiled size, where a pattern is
 * past the 10 MiB limit for sure. Where the compiler alone could tell, it reads as fine, leaning to
 * "Codex runs it".
 */
export function codexSkipsMatcher(matcher: string): boolean {
  if (matcher === "" || matcher === "*" || /^[A-Za-z0-9_|]*$/.test(matcher)) return false;
  try {
    const ast = new RustRegexParser(matcher).parse();
    if (depth(ast) > NEST_LIMIT) return true;
    translate(ast, { unicode: true });
    return minimumStates(ast) * MIN_STATE_BYTES > SIZE_LIMIT;
  } catch (error) {
    if (error === REFUSED) return true;
    throw error;
  }
}

/** What the parser throws where regex-syntax returns an error. */
const REFUSED = new Error("regex-syntax refuses the pattern");
function refuse(): never {
  throw REFUSED;
}

/** The regex crate's nest limit (RegexBuilder::nest_limit) and size limit (size_limit, 10 MiB). */
const NEST_LIMIT = 250;
const SIZE_LIMIT = 10 * 2 ** 20;
/**
 * What regex-automata's Thompson builder counts for each state in its size check
 * (Builder::memory_usage): `size_of::<State>()`, 32 bytes on the 64-bit builds Codex ships, its
 * largest variants holding a Vec - and more for some, which this leaves out. Measured: Codex runs
 * `a{300000}` and skips `a{400000}`, either side of 10 MiB / 32.
 */
const MIN_STATE_BYTES = 32;

/** A literal: its scalar value, and its byte where it is written `\xNN`, as ast::Literal::byte gives it. */
type Lit = { c: number; byte?: number };
/** A `\p{…}` or `\pX` as the AST holds it: one letter, a name, or a name and a value. */
type UnicodeQuery = { letter: string } | { name: string } | { name: string; value: string };

/** The AST, as far as the checks after parsing look at it. */
type Node =
  | { t: "empty" }
  | { t: "flags"; unicode?: boolean }
  | { t: "literal"; lit: Lit }
  | { t: "dot" }
  | { t: "assertion" }
  | { t: "perl"; negated: boolean }
  | { t: "unicode"; query: UnicodeQuery }
  | { t: "class"; negated: boolean; set: ClassSet }
  | { t: "rep"; min: number; max?: number; sub: Node }
  | { t: "group"; unicode?: boolean; sub: Node }
  | { t: "concat"; items: Node[] }
  | { t: "alt"; branches: Node[] };

type ClassSet = { t: "item"; item: ClassItem } | { t: "op"; lhs: ClassSet; rhs: ClassSet };
type ClassItem =
  | { t: "empty" }
  | { t: "literal"; lit: Lit }
  | { t: "range"; start: Lit; end: Lit }
  | { t: "ascii"; negated: boolean }
  | { t: "perl"; negated: boolean }
  | { t: "unicode"; query: UnicodeQuery }
  | { t: "bracketed"; negated: boolean; set: ClassSet }
  | { t: "union"; items: ClassItem[] };

/** What a primitive is: a range takes literals alone, a class no assertion. */
type Primitive =
  | { kind: "literal"; lit: Lit }
  | { kind: "assertion" }
  | { kind: "perl"; negated: boolean }
  | { kind: "unicode"; query: UnicodeQuery }
  | { kind: "dot" };
type Frame =
  | { kind: "group"; parent: Node[]; unicode?: boolean; ignoreSpace: boolean }
  | { kind: "alternation"; branches: Node[] };
type ClassFrame = { t: "open"; union: ClassItem[]; negated: boolean } | { t: "op"; lhs: ClassSet };

/** Rust's char::is_whitespace: the Unicode White_Space property. */
const isWhitespace = (c: string) => /^\p{White_Space}$/u.test(c);
const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
/** regex-syntax's is_capture_char: Rust's is_alphabetic first, is_alphanumeric (Alphabetic or N*) after. */
const isCaptureChar = (c: string, first: boolean) =>
  c === "_" || /^\p{Alphabetic}$/u.test(c) || (!first && (c === "." || c === "[" || c === "]" || /^\p{N}$/u.test(c)));
const META = new Set(Array.from("\\.+*?()|[]{}^$#&-~"));
/** regex-syntax's is_escapeable_character: a meta character, or ASCII that is no letter, digit, `<` or `>`. */
const isEscapeable = (c: string) => META.has(c) || (c.length === 1 && c < "\x80" && !/^[0-9A-Za-z<>]$/.test(c));
const SPECIAL: Readonly<Record<string, number>> = { a: 0x07, f: 0x0c, t: 0x09, n: 0x0a, r: 0x0d, v: 0x0b };
const ASCII_CLASSES = new Set([
  "alnum",
  "alpha",
  "ascii",
  "blank",
  "cntrl",
  "digit",
  "graph",
  "lower",
  "print",
  "punct",
  "space",
  "upper",
  "word",
  "xdigit",
]);
const FLAGS = new Set(Array.from("imsUuRx"));
const WORD_BOUNDARIES = new Set(["start", "end", "start-half", "end-half"]);

/** concat.into_ast: nothing is an empty node, one item is that item. */
function concatNode(items: Node[]): Node {
  if (items.length === 0) return { t: "empty" };
  return items.length === 1 ? (items[0] as Node) : { t: "concat", items };
}

/** ClassSetUnion::into_item: nothing is an empty item, one item is that item. */
function unionItem(items: ClassItem[]): ClassItem {
  if (items.length === 0) return { t: "empty" };
  return items.length === 1 ? (items[0] as ClassItem) : { t: "union", items };
}

/**
 * regex-syntax 0.8's ast::parse::ParserI, as the regex crate configures it (no octal, no `x` at
 * the start, no empty minimum in `{,n}`): every error it returns, and the AST as far as the checks
 * after it need it. Positions count Unicode scalar values, as Rust's chars do. Each method names
 * the one it ports.
 */
class RustRegexParser {
  private readonly cs: string[];
  private pos = 0;
  private ignoreSpace = false;
  private readonly names = new Set<string>();
  private readonly stack: Frame[] = [];

  constructor(pattern: string) {
    this.cs = Array.from(pattern);
  }

  private eof(): boolean {
    return this.pos >= this.cs.length;
  }

  private char(): string {
    return this.cs[this.pos] ?? "";
  }

  /** bump: past the current char, and whether another follows. */
  private bump(): boolean {
    if (this.eof()) return false;
    this.pos++;
    return !this.eof();
  }

  private bumpIf(prefix: string): boolean {
    const chars = Array.from(prefix);
    if (!chars.every((c, i) => this.cs[this.pos + i] === c)) return false;
    this.pos += chars.length;
    return true;
  }

  private peek(): string | undefined {
    return this.cs[this.pos + 1];
  }

  /** peek_space, as written: in `x` mode the next char past spaces and a `#`. */
  private peekSpace(): string | undefined {
    if (!this.ignoreSpace) return this.peek();
    if (this.eof()) return undefined;
    let start = this.pos + 1;
    let inComment = false;
    for (let i = this.pos + 1; i < this.cs.length; i++) {
      const c = this.cs[i] ?? "";
      if (isWhitespace(c)) continue;
      if (!inComment && c === "#") inComment = true;
      else if (inComment && c === "\n") inComment = false;
      else {
        start = i;
        break;
      }
    }
    return this.cs[start];
  }

  /** bump_space: in `x` mode, past spaces and `#` comments. */
  private bumpSpace(): void {
    if (!this.ignoreSpace) return;
    while (!this.eof()) {
      if (isWhitespace(this.char())) this.bump();
      else if (this.char() === "#") {
        this.bump();
        while (!this.eof()) {
          const c = this.char();
          this.bump();
          if (c === "\n") break;
        }
      } else break;
    }
  }

  private bumpAndBumpSpace(): boolean {
    if (!this.bump()) return false;
    this.bumpSpace();
    return !this.eof();
  }

  /** parse_with_comments: the pattern's AST. */
  parse(): Node {
    let concat: Node[] = [];
    for (;;) {
      this.bumpSpace();
      if (this.eof()) break;
      switch (this.char()) {
        case "(":
          concat = this.pushGroup(concat);
          break;
        case ")":
          concat = this.popGroup(concat);
          break;
        case "|": {
          const top = this.stack.at(-1);
          if (top?.kind === "alternation") top.branches.push(concatNode(concat));
          else this.stack.push({ kind: "alternation", branches: [concatNode(concat)] });
          this.bump();
          concat = [];
          break;
        }
        case "[":
          concat.push(this.parseSetClass());
          break;
        case "?":
        case "*":
        case "+": {
          const sub = this.repeated(concat);
          const op = this.char();
          if (this.bump() && this.char() === "?") this.bump();
          concat.push({ t: "rep", min: op === "+" ? 1 : 0, ...(op === "?" ? { max: 1 } : {}), sub });
          break;
        }
        case "{": {
          const sub = this.repeated(concat);
          concat.push({ t: "rep", ...this.parseCountedRepetition(), sub });
          break;
        }
        default:
          concat.push(primitiveNode(this.parsePrimitive()));
      }
    }
    // pop_group_end: no group left open.
    const top = this.stack.pop();
    if (top?.kind === "group") refuse();
    if (top?.kind === "alternation") {
      if (this.stack.pop() !== undefined) refuse();
      return { t: "alt", branches: [...top.branches, concatNode(concat)] };
    }
    return concatNode(concat);
  }

  /** What a repetition repeats: the concatenation's last node, which no empty or flags node is. */
  private repeated(concat: Node[]): Node {
    const last = concat.at(-1);
    if (last === undefined || last.t === "empty" || last.t === "flags") refuse();
    concat.pop();
    return last;
  }

  /** push_group: a group opens a concatenation; a set of flags goes on in this one. */
  private pushGroup(concat: Node[]): Node[] {
    const group = this.parseGroup();
    if (group.setFlags) {
      if (group.x !== undefined) this.ignoreSpace = group.x;
      concat.push({ t: "flags", ...(group.unicode !== undefined ? { unicode: group.unicode } : {}) });
      return concat;
    }
    this.stack.push({
      kind: "group",
      parent: concat,
      ignoreSpace: this.ignoreSpace,
      ...(group.unicode !== undefined ? { unicode: group.unicode } : {}),
    });
    if (group.x !== undefined) this.ignoreSpace = group.x;
    return [];
  }

  /** pop_group: a `)` closes the innermost group, through its alternation. */
  private popGroup(concat: Node[]): Node[] {
    let top = this.stack.pop();
    let sub = concatNode(concat);
    if (top?.kind === "alternation") {
      sub = { t: "alt", branches: [...top.branches, sub] };
      top = this.stack.pop();
    }
    if (top?.kind !== "group") refuse();
    this.ignoreSpace = top.ignoreSpace;
    this.bump();
    top.parent.push({ t: "group", sub, ...(top.unicode !== undefined ? { unicode: top.unicode } : {}) });
    return top.parent;
  }

  /** parse_counted_repetition, from its `{`. */
  private parseCountedRepetition(): { min: number; max?: number } {
    if (!this.bumpAndBumpSpace()) refuse();
    const start = this.parseDecimal();
    if (this.eof()) refuse();
    let end: number | undefined = start;
    if (this.char() === ",") {
      if (!this.bumpAndBumpSpace()) refuse();
      end = this.char() !== "}" ? this.parseDecimal() : undefined;
    }
    if (this.eof() || this.char() !== "}") refuse();
    if (this.bumpAndBumpSpace() && this.char() === "?") this.bump();
    if (end !== undefined && start > end) refuse();
    return { min: start, ...(end !== undefined ? { max: end } : {}) };
  }

  /**
   * parse_decimal: a u32, spaces around it skipped. regex-syntax keeps an empty or too large one
   * as an error for later, and every way on from there returns it, so this refuses at once.
   */
  private parseDecimal(): number {
    while (!this.eof() && isWhitespace(this.char())) this.bump();
    let digits = "";
    while (!this.eof() && /^[0-9]$/.test(this.char())) {
      digits += this.char();
      this.bumpAndBumpSpace();
    }
    while (!this.eof() && isWhitespace(this.char())) this.bumpAndBumpSpace();
    if (digits === "" || BigInt(digits) > 0xffffffffn) refuse();
    return Number(digits);
  }

  /** parse_group, from its `(`: a group, with the flags it sets, or a set of flags alone. */
  private parseGroup(): { setFlags: boolean; x?: boolean; unicode?: boolean } {
    this.bump();
    this.bumpSpace();
    if (this.bumpIf("?=") || this.bumpIf("?!") || this.bumpIf("?<=") || this.bumpIf("?<!")) refuse();
    if (this.bumpIf("?P<") || this.bumpIf("?<")) {
      this.parseCaptureName();
      return { setFlags: false };
    }
    if (!this.bumpIf("?")) return { setFlags: false };
    if (this.eof()) refuse();
    const flags = this.parseFlags();
    const end = this.char();
    this.bump();
    // `(?)` is a repetition with nothing to repeat.
    if (end === ")" && flags.count === 0) refuse();
    return {
      setFlags: end === ")",
      ...(flags.x !== undefined ? { x: flags.x } : {}),
      ...(flags.unicode !== undefined ? { unicode: flags.unicode } : {}),
    };
  }

  /** parse_capture_name, past its `<`. */
  private parseCaptureName(): void {
    if (this.eof()) refuse();
    const start = this.pos;
    for (;;) {
      if (this.char() === ">") break;
      if (!isCaptureChar(this.char(), this.pos === start)) refuse();
      if (!this.bump()) break;
    }
    if (this.eof()) refuse();
    const name = this.cs.slice(start, this.pos).join("");
    this.bump();
    if (name === "" || this.names.has(name)) refuse();
    this.names.add(name);
  }

  /** parse_flags, to the `:` or `)` after them: no flag twice, one `-` at most, and never last. */
  private parseFlags(): { count: number; x?: boolean; unicode?: boolean } {
    const seen = new Set<string>();
    let count = 0;
    let negated = false;
    let lastWasNegation = false;
    let x: boolean | undefined;
    let unicode: boolean | undefined;
    while (this.char() !== ":" && this.char() !== ")") {
      const c = this.char();
      if (c !== "-" && !FLAGS.has(c)) refuse();
      if (seen.has(c)) refuse();
      seen.add(c);
      count++;
      lastWasNegation = c === "-";
      if (c === "-") negated = true;
      if (c === "x") x = !negated;
      if (c === "u") unicode = !negated;
      if (!this.bump()) refuse();
    }
    if (lastWasNegation) refuse();
    return { count, ...(x !== undefined ? { x } : {}), ...(unicode !== undefined ? { unicode } : {}) };
  }

  /** parse_primitive. */
  private parsePrimitive(): Primitive {
    const c = this.char();
    if (c === "\\") return this.parseEscape();
    this.bump();
    if (c === ".") return { kind: "dot" };
    if (c === "^" || c === "$") return { kind: "assertion" };
    return { kind: "literal", lit: { c: c.codePointAt(0) ?? 0 } };
  }

  /** parse_escape, from its `\`. */
  private parseEscape(): Primitive {
    if (!this.bump()) refuse();
    const c = this.char();
    // Octal is off, so `\0` to `\9` are backreferences, which Rust has none of.
    if (/^[0-9]$/.test(c)) refuse();
    if (c === "x" || c === "u" || c === "U") return { kind: "literal", lit: this.parseHex() };
    if (c === "p" || c === "P") return { kind: "unicode", query: this.parseUnicodeClass() };
    if (/^[dswDSW]$/.test(c)) {
      this.bump();
      return { kind: "perl", negated: c === "D" || c === "S" || c === "W" };
    }
    this.bump();
    if (isEscapeable(c)) return { kind: "literal", lit: { c: c.codePointAt(0) ?? 0 } };
    const special = SPECIAL[c];
    if (special !== undefined) return { kind: "literal", lit: { c: special } };
    if (c === "A" || c === "z" || c === "B" || c === "<" || c === ">") return { kind: "assertion" };
    if (c !== "b") refuse();
    if (!this.eof() && this.char() === "{") this.maybeSpecialWordBoundary();
    return { kind: "assertion" };
  }

  /** maybe_parse_special_word_boundary, at the `{` after `\b`: `\b{start}` and the like, or a count. */
  private maybeSpecialWordBoundary(): void {
    const start = this.pos;
    const isNameChar = (c: string) => /^[A-Za-z-]$/.test(c);
    if (!this.bumpAndBumpSpace()) refuse();
    if (!isNameChar(this.char())) {
      this.pos = start;
      return;
    }
    let name = "";
    while (!this.eof() && isNameChar(this.char())) {
      name += this.char();
      this.bumpAndBumpSpace();
    }
    if (this.eof() || this.char() !== "}") refuse();
    this.bump();
    if (!WORD_BOUNDARIES.has(name)) refuse();
  }

  /**
   * parse_hex, at its `x`, `u` or `U`: 2, 4 or 8 digits, or any in braces, a Unicode scalar value.
   * Its byte, for `\xNN` alone, as ast::Literal::byte has it.
   */
  private parseHex(): Lit {
    const kind = this.char();
    const digits = kind === "x" ? 2 : kind === "u" ? 4 : 8;
    if (!this.bumpAndBumpSpace()) refuse();
    let hex = "";
    const braced = this.char() === "{";
    if (braced) {
      while (this.bumpAndBumpSpace() && this.char() !== "}") {
        if (!isHex(this.char())) refuse();
        hex += this.char();
      }
      if (this.eof()) refuse();
      this.bumpAndBumpSpace();
      if (hex === "") refuse();
    } else {
      for (let i = 0; i < digits; i++) {
        if (i > 0 && !this.bumpAndBumpSpace()) refuse();
        if (!isHex(this.char())) refuse();
        hex += this.char();
      }
      this.bumpAndBumpSpace();
    }
    const value = BigInt(`0x${hex}`);
    if (value > 0x10ffffn || (value >= 0xd800n && value <= 0xdfffn)) refuse();
    const c = Number(value);
    return kind === "x" && !braced ? { c, byte: c } : { c };
  }

  /** parse_unicode_class, at its `p` or `P`: a letter, or a name in braces, and a value after `=`, `:` or `!=`. */
  private parseUnicodeClass(): UnicodeQuery {
    if (!this.bumpAndBumpSpace()) refuse();
    if (this.char() === "{") {
      let name = "";
      while (this.bumpAndBumpSpace() && this.char() !== "}") name += this.char();
      if (this.eof()) refuse();
      this.bump();
      for (const op of ["!=", ":", "="]) {
        const at = name.indexOf(op);
        if (at >= 0) return { name: name.slice(0, at), value: name.slice(at + op.length) };
      }
      return { name };
    }
    const letter = this.char();
    if (letter === "\\") refuse();
    this.bumpAndBumpSpace();
    return { letter };
  }

  /** parse_set_class, from its `[` to the `]` that closes it, nested classes and all. */
  private parseSetClass(): Node {
    const stack: ClassFrame[] = [];
    let union: ClassItem[] = [];
    // pop_class_op: the operation on top of the stack, if one is, takes `rhs` for its right side.
    const popOp = (rhs: ClassSet): ClassSet => {
      const top = stack.at(-1);
      if (top?.t !== "op") return rhs;
      stack.pop();
      return { t: "op", lhs: top.lhs, rhs };
    };
    for (;;) {
      this.bumpSpace();
      if (this.eof()) refuse();
      const c = this.char();
      if (c === "[") {
        const ascii = stack.length > 0 ? this.maybeAsciiClass() : undefined;
        if (ascii) {
          union.push(ascii);
          continue;
        }
        const open = this.parseSetClassOpen();
        stack.push({ t: "open", union, negated: open.negated });
        union = open.items;
      } else if (c === "]") {
        this.bump();
        const set = popOp({ t: "item", item: unionItem(union) });
        const open = stack.pop();
        if (open?.t !== "open") refuse();
        if (stack.length === 0) return { t: "class", negated: open.negated, set };
        union = open.union;
        union.push({ t: "bracketed", negated: open.negated, set });
      } else if ((c === "&" || c === "-" || c === "~") && this.peek() === c) {
        this.pos += 2;
        const lhs = popOp({ t: "item", item: unionItem(union) });
        stack.push({ t: "op", lhs });
        union = [];
      } else {
        union.push(this.parseSetClassRange());
      }
    }
  }

  /** parse_set_class_open: `[`, a `^`, any `-`, and a `]` first, all literal. */
  private parseSetClassOpen(): { negated: boolean; items: ClassItem[] } {
    if (!this.bumpAndBumpSpace()) refuse();
    const negated = this.char() === "^";
    if (negated && !this.bumpAndBumpSpace()) refuse();
    const items: ClassItem[] = [];
    while (this.char() === "-") {
      items.push({ t: "literal", lit: { c: 0x2d } });
      if (!this.bumpAndBumpSpace()) refuse();
    }
    if (items.length === 0 && this.char() === "]") {
      items.push({ t: "literal", lit: { c: 0x5d } });
      if (!this.bumpAndBumpSpace()) refuse();
    }
    return { negated, items };
  }

  /** maybe_parse_ascii_class: `[:alpha:]` and the like, or back to the `[` for a nested class. */
  private maybeAsciiClass(): ClassItem | undefined {
    const start = this.pos;
    const back = () => {
      this.pos = start;
      return undefined;
    };
    if (!this.bump() || this.char() !== ":") return back();
    if (!this.bump()) return back();
    const negated = this.char() === "^";
    if (negated && !this.bump()) return back();
    const nameStart = this.pos;
    while (this.char() !== ":" && this.bump()) {}
    if (this.eof()) return back();
    const name = this.cs.slice(nameStart, this.pos).join("");
    if (!this.bumpIf(":]") || !ASCII_CLASSES.has(name)) return back();
    return { t: "ascii", negated };
  }

  /** parse_set_class_range: an item, or a range of two literals in order. */
  private parseSetClassRange(): ClassItem {
    const first = this.parseSetClassItem();
    this.bumpSpace();
    if (this.eof()) refuse();
    if (this.char() !== "-" || this.peekSpace() === "]" || this.peekSpace() === "-") {
      // into_class_set_item: no assertion in a class.
      if (first.kind === "assertion" || first.kind === "dot") refuse();
      return classItem(first);
    }
    if (!this.bumpAndBumpSpace()) refuse();
    const second = this.parseSetClassItem();
    if (first.kind !== "literal" || second.kind !== "literal" || first.lit.c > second.lit.c) refuse();
    return { t: "range", start: first.lit, end: second.lit };
  }

  /** parse_set_class_item: an escape, or a char as it is. */
  private parseSetClassItem(): Primitive {
    if (this.char() === "\\") return this.parseEscape();
    const c = this.char();
    this.bump();
    return { kind: "literal", lit: { c: c.codePointAt(0) ?? 0 } };
  }
}

function primitiveNode(p: Primitive): Node {
  switch (p.kind) {
    case "literal":
      return { t: "literal", lit: p.lit };
    case "perl":
      return { t: "perl", negated: p.negated };
    case "unicode":
      return { t: "unicode", query: p.query };
    case "dot":
      return { t: "dot" };
    case "assertion":
      return { t: "assertion" };
  }
}

/** A class item from a primitive, which no assertion or dot is (checked by the caller). */
function classItem(p: Primitive): ClassItem {
  if (p.kind === "literal") return { t: "literal", lit: p.lit };
  if (p.kind === "perl") return { t: "perl", negated: p.negated };
  if (p.kind === "unicode") return { t: "unicode", query: p.query };
  return refuse();
}

/**
 * How deep the AST nests, as NestLimiter counts it: one for each class, repetition, group,
 * alternation and concatenation on the way down, and in a class for each nested class, union and
 * set operation.
 */
function depth(node: Node): number {
  switch (node.t) {
    case "class":
      return 1 + setDepth(node.set);
    case "rep":
    case "group":
      return 1 + depth(node.sub);
    case "concat":
      return 1 + Math.max(0, ...node.items.map(depth));
    case "alt":
      return 1 + Math.max(0, ...node.branches.map(depth));
    default:
      return 0;
  }
}

function setDepth(set: ClassSet): number {
  return set.t === "op" ? 1 + Math.max(setDepth(set.lhs), setDepth(set.rhs)) : itemDepth(set.item);
}

function itemDepth(item: ClassItem): number {
  if (item.t === "bracketed") return 1 + setDepth(item.set);
  if (item.t === "union") return 1 + Math.max(0, ...item.items.map(itemDepth));
  return 0;
}

/**
 * The translation to HIR (hir::translate), as far as it returns an error for a `Regex`: a
 * `\p{…}` name regex-syntax does not know; and with the `u` flag off, where a pattern could match
 * invalid UTF-8 or a byte class meets Unicode - a `\xNN` past ASCII, a `.`, a negated `\D`, `\S`
 * or `\W`, any `\p`, and in a class a negation, a non-ASCII literal or a negated ASCII class.
 * Flags hold from where they are set to the end of the group they are in, alternatives after them
 * included, as the translator keeps them.
 */
function translate(node: Node, flags: { unicode: boolean }): void {
  switch (node.t) {
    case "flags":
      if (node.unicode !== undefined) flags.unicode = node.unicode;
      return;
    case "literal":
      if (!flags.unicode && (node.lit.byte ?? 0) > 0x7f) refuse();
      return;
    case "dot":
      if (!flags.unicode) refuse();
      return;
    case "perl":
      if (!flags.unicode && node.negated) refuse();
      return;
    case "unicode":
      if (!flags.unicode || !unicodeClassKnown(node.query)) refuse();
      return;
    case "class":
      translateClass(node.negated, node.set, flags.unicode);
      return;
    case "rep":
      translate(node.sub, flags);
      return;
    case "group": {
      const saved = flags.unicode;
      if (node.unicode !== undefined) flags.unicode = node.unicode;
      translate(node.sub, flags);
      flags.unicode = saved;
      return;
    }
    case "concat":
      for (const item of node.items) translate(item, flags);
      return;
    case "alt":
      for (const branch of node.branches) translate(branch, flags);
      return;
    default:
      return;
  }
}

function translateClass(negated: boolean, set: ClassSet, unicode: boolean): void {
  // bytes_fold_and_negate: a negated byte class holds bytes past ASCII.
  if (!unicode && negated) refuse();
  const item = (it: ClassItem): void => {
    switch (it.t) {
      case "literal":
        classLiteral(it.lit, unicode);
        return;
      case "range":
        classLiteral(it.start, unicode);
        classLiteral(it.end, unicode);
        return;
      case "ascii":
      case "perl":
        if (!unicode && it.negated) refuse();
        return;
      case "unicode":
        if (!unicode || !unicodeClassKnown(it.query)) refuse();
        return;
      case "bracketed":
        translateClass(it.negated, it.set, unicode);
        return;
      case "union":
        for (const each of it.items) item(each);
        return;
      default:
        return;
    }
  };
  const walk = (s: ClassSet): void => {
    if (s.t === "item") item(s.item);
    else {
      walk(s.lhs);
      walk(s.rhs);
    }
  };
  walk(set);
}

/** class_literal_byte: without `u`, a class takes an ASCII literal alone, `\xNN` past it being invalid UTF-8. */
function classLiteral(lit: Lit, unicode: boolean): void {
  if (!unicode && lit.c > 0x7f) refuse();
}

/**
 * Whether regex-syntax's unicode::class finds the class a query names: the name normalized
 * (symbolic_name_normalize, UAX44-LM3), then a binary property, a general category or a script;
 * or by value, a general category, a script, an age, a script extension or a break property.
 */
export function unicodeClassKnown(query: UnicodeQuery): boolean {
  if ("letter" in query) return binaryKnown(query.letter);
  if (!("value" in query)) return binaryKnown(query.name);
  const property = PROPERTY_NAMES[normalized(query.name)];
  const value = normalized(query.value);
  if (property === undefined) return false;
  if (property === "General_Category") {
    const canon = canonicalGencat(value);
    return canon !== undefined && gencatKnown(canon);
  }
  if (property === "Script") {
    const canon = PROPERTY_VALUES.Script?.[value];
    return canon !== undefined && SCRIPT.has(canon);
  }
  const canon = PROPERTY_VALUES[property]?.[value];
  if (canon === undefined) return false;
  const sets: Readonly<Record<string, ReadonlySet<string>>> = {
    Age: AGE,
    Script_Extensions: SCRIPT_EXTENSION,
    Grapheme_Cluster_Break: GRAPHEME_CLUSTER_BREAK,
    Sentence_Break: SENTENCE_BREAK,
    Word_Break: WORD_BREAK,
  };
  return sets[property]?.has(canon) ?? false;
}

/** canonical_binary: a binary property - `cf`, `sc` and `lc` being categories - else a category, else a script. */
function binaryKnown(name: string): boolean {
  const norm = normalized(name);
  if (norm !== "cf" && norm !== "sc" && norm !== "lc") {
    const property = PROPERTY_NAMES[norm];
    if (property !== undefined)
      return property === "Decimal_Number" || property === "White_Space" || BOOL.has(property);
  }
  const gencat = canonicalGencat(norm);
  if (gencat !== undefined) return gencatKnown(gencat);
  const script = PROPERTY_VALUES.Script?.[norm];
  return script !== undefined && SCRIPT.has(script);
}

function canonicalGencat(norm: string): string | undefined {
  const special: Readonly<Record<string, string>> = { any: "Any", assigned: "Assigned", ascii: "ASCII" };
  return special[norm] ?? PROPERTY_VALUES.General_Category?.[norm];
}

/** gencat: the three special ones, `Decimal_Number`, and the categories general_category.rs names. */
function gencatKnown(canon: string): boolean {
  return ["Any", "Assigned", "ASCII", "Decimal_Number"].includes(canon) || GENERAL_CATEGORY.has(canon);
}

/**
 * symbolic_name_normalize: an `is` prefix dropped, spaces, `_` and `-` dropped, ASCII lowered,
 * anything past ASCII dropped; `isc` stays itself.
 */
function normalized(name: string): string {
  const bytes = new TextEncoder().encode(name);
  const startsWithIs =
    bytes.length >= 2 && (bytes[0] === 0x69 || bytes[0] === 0x49) && (bytes[1] === 0x73 || bytes[1] === 0x53);
  let out = "";
  for (const b of bytes.slice(startsWithIs ? 2 : 0)) {
    if (b === 0x20 || b === 0x5f || b === 0x2d) continue;
    if (b >= 0x41 && b <= 0x5a) out += String.fromCharCode(b + 0x20);
    else if (b <= 0x7f) out += String.fromCharCode(b);
  }
  return startsWithIs && out === "c" ? "isc" : out;
}

/**
 * The fewest states regex-automata's Thompson compiler makes for a node, which its size check
 * counts: a literal, a dot, a Perl or Unicode class or a class with a member at least one; an
 * assertion, an empty node or flags none; a repetition each copy it compiles - its maximum, or its
 * minimum when unbounded - times its node's; the rest their parts summed.
 */
function minimumStates(node: Node): number {
  switch (node.t) {
    case "literal":
    case "dot":
    case "perl":
    case "unicode":
      return 1;
    case "class":
      return !node.negated && node.set.t === "item" && hasMember(node.set.item) ? 1 : 0;
    case "rep":
      return (node.max ?? Math.max(node.min, 1)) * minimumStates(node.sub);
    case "group":
      return minimumStates(node.sub);
    case "concat":
      return node.items.reduce((sum, item) => sum + minimumStates(item), 0);
    case "alt":
      return node.branches.reduce((sum, branch) => sum + minimumStates(branch), 0);
    default:
      return 0;
  }
}

/** Whether a class item holds a member for sure: a literal, a range, or a class not negated. */
function hasMember(item: ClassItem): boolean {
  if (item.t === "union") return item.items.some(hasMember);
  return item.t === "literal" || item.t === "range" || ((item.t === "perl" || item.t === "ascii") && !item.negated);
}
