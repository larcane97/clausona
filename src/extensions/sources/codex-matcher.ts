/**
 * Whether Codex 0.159.3 skips a hook group for its matcher ("invalid matcher"). On an event whose
 * matcher it reads, Codex takes "" and "*" as any tool and a matcher of ASCII letters, digits,
 * `_` and `|` as names, and compiles any other with Rust's regex crate (1.12, regex-syntax 0.8):
 * where that fails, it skips the whole group (codex-rs hooks discovery.rs, events/common.rs).
 *
 * JS's RegExp has no say here, as the two dialects differ both ways: JS takes lookaround,
 * backreferences, `[]`, `\e`, `\0`, `a{` and `a{,2}`, which Rust refuses, and refuses `(?i)`,
 * `(?P<n>x)`, `a**`, `x{2}{3}` and `[a--b]`, which Rust takes. So this is a port of regex-syntax's
 * parser, and says a matcher is skipped only where that parser refuses it, which Codex then does
 * for sure. What the parser takes and the compiler still refuses reads as fine, leaning to "Codex
 * runs it": a Unicode property Rust does not know (`\p{Foo}`), a class that matches no UTF-8
 * under `(?-u)`, a pattern past the size limit (10 MB compiled) or nested past 250 deep.
 */
export function codexSkipsMatcher(matcher: string): boolean {
  if (matcher === "" || matcher === "*" || /^[A-Za-z0-9_|]*$/.test(matcher)) return false;
  try {
    new RustRegexParser(matcher).parse();
    return false;
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

/** What a primitive is, as far as a class needs to know: a range takes literals alone, a class no assertion. */
type Primitive = { kind: "literal"; c: number } | { kind: "assertion" } | { kind: "class" } | { kind: "dot" };
type Frame = { kind: "group"; ignoreSpace: boolean } | { kind: "alternation" };

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

/**
 * regex-syntax 0.8's ast::parse::ParserI, as the regex crate configures it (no octal, no `x` at
 * the start, no empty minimum in `{,n}`), keeping only what decides an error. Positions count
 * Unicode scalar values, as Rust's chars do. Each method names the one it ports.
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

  /** parse_with_comments. `last` is what the concatenation being built ends with. */
  parse(): void {
    let last: "none" | "flags" | "other" = "none";
    for (;;) {
      this.bumpSpace();
      if (this.eof()) break;
      switch (this.char()) {
        case "(":
          last = this.pushGroup();
          break;
        case ")":
          this.popGroup();
          last = "other";
          break;
        case "|":
          if (this.stack.at(-1)?.kind !== "alternation") this.stack.push({ kind: "alternation" });
          this.bump();
          last = "none";
          break;
        case "[":
          this.parseSetClass();
          last = "other";
          break;
        case "?":
        case "*":
        case "+":
          if (last !== "other") refuse();
          if (this.bump() && this.char() === "?") this.bump();
          break;
        case "{":
          if (last !== "other") refuse();
          this.parseCountedRepetition();
          break;
        default:
          this.parsePrimitive();
          last = "other";
      }
    }
    // pop_group_end: no group left open.
    const top = this.stack.pop();
    if (top?.kind === "group" || (top?.kind === "alternation" && this.stack.pop() !== undefined)) refuse();
  }

  /** push_group: a group opens a concatenation; a set of flags goes on in this one. */
  private pushGroup(): "none" | "flags" {
    const group = this.parseGroup();
    if (group.setFlags) {
      if (group.x !== undefined) this.ignoreSpace = group.x;
      return "flags";
    }
    this.stack.push({ kind: "group", ignoreSpace: this.ignoreSpace });
    if (group.x !== undefined) this.ignoreSpace = group.x;
    return "none";
  }

  /** pop_group: a `)` closes the innermost group, through its alternation. */
  private popGroup(): void {
    let top = this.stack.pop();
    if (top?.kind === "alternation") top = this.stack.pop();
    if (top?.kind !== "group") refuse();
    this.ignoreSpace = top.ignoreSpace;
    this.bump();
  }

  /** parse_counted_repetition, from its `{`. */
  private parseCountedRepetition(): void {
    if (!this.bumpAndBumpSpace()) refuse();
    const start = this.parseDecimal();
    if (this.eof()) refuse();
    let end: number | undefined;
    if (this.char() === ",") {
      if (!this.bumpAndBumpSpace()) refuse();
      if (this.char() !== "}") end = this.parseDecimal();
    }
    if (this.eof() || this.char() !== "}") refuse();
    if (this.bumpAndBumpSpace() && this.char() === "?") this.bump();
    if (end !== undefined && start > end) refuse();
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

  /** parse_group, from its `(`: a group, with the `x` its flags set, or a set of flags alone. */
  private parseGroup(): { setFlags: boolean; x?: boolean } {
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
    return { setFlags: end === ")", ...(flags.x !== undefined ? { x: flags.x } : {}) };
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
  private parseFlags(): { count: number; x?: boolean } {
    const seen = new Set<string>();
    let count = 0;
    let negated = false;
    let lastWasNegation = false;
    let x: boolean | undefined;
    while (this.char() !== ":" && this.char() !== ")") {
      const c = this.char();
      if (c !== "-" && !FLAGS.has(c)) refuse();
      if (seen.has(c)) refuse();
      seen.add(c);
      count++;
      lastWasNegation = c === "-";
      if (c === "-") negated = true;
      if (c === "x") x = !negated;
      if (!this.bump()) refuse();
    }
    if (lastWasNegation) refuse();
    return { count, ...(x !== undefined ? { x } : {}) };
  }

  /** parse_primitive. */
  private parsePrimitive(): Primitive {
    const c = this.char();
    if (c === "\\") return this.parseEscape();
    this.bump();
    if (c === ".") return { kind: "dot" };
    if (c === "^" || c === "$") return { kind: "assertion" };
    return { kind: "literal", c: c.codePointAt(0) ?? 0 };
  }

  /** parse_escape, from its `\`. */
  private parseEscape(): Primitive {
    if (!this.bump()) refuse();
    const c = this.char();
    // Octal is off, so `\0` to `\9` are backreferences, which Rust has none of.
    if (/^[0-9]$/.test(c)) refuse();
    if (c === "x" || c === "u" || c === "U") return { kind: "literal", c: this.parseHex() };
    if (c === "p" || c === "P") {
      this.parseUnicodeClass();
      return { kind: "class" };
    }
    if (/^[dswDSW]$/.test(c)) {
      this.bump();
      return { kind: "class" };
    }
    this.bump();
    if (isEscapeable(c)) return { kind: "literal", c: c.codePointAt(0) ?? 0 };
    const special = SPECIAL[c];
    if (special !== undefined) return { kind: "literal", c: special };
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

  /** parse_hex, at its `x`, `u` or `U`: 2, 4 or 8 digits, or any in braces, a Unicode scalar value. */
  private parseHex(): number {
    const digits = this.char() === "x" ? 2 : this.char() === "u" ? 4 : 8;
    if (!this.bumpAndBumpSpace()) refuse();
    let hex = "";
    if (this.char() === "{") {
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
    return Number(value);
  }

  /** parse_unicode_class, at its `p` or `P`: a letter, or a name in braces, which this does not look up. */
  private parseUnicodeClass(): void {
    if (!this.bumpAndBumpSpace()) refuse();
    if (this.char() === "{") {
      while (this.bumpAndBumpSpace() && this.char() !== "}") {}
      if (this.eof()) refuse();
      this.bump();
      return;
    }
    if (this.char() === "\\") refuse();
    this.bumpAndBumpSpace();
  }

  /** parse_set_class, from its `[` to the `]` that closes it, nested classes and all. */
  private parseSetClass(): void {
    let open = 0;
    for (;;) {
      this.bumpSpace();
      if (this.eof()) refuse();
      const c = this.char();
      if (c === "[") {
        if (open > 0 && this.maybeAsciiClass()) continue;
        this.parseSetClassOpen();
        open++;
      } else if (c === "]") {
        this.bump();
        open--;
        if (open === 0) return;
      } else if ((c === "&" || c === "-" || c === "~") && this.peek() === c) {
        this.pos += 2;
      } else {
        this.parseSetClassRange();
      }
    }
  }

  /** parse_set_class_open: `[`, a `^`, any `-`, and a `]` first, all literal. */
  private parseSetClassOpen(): void {
    if (!this.bumpAndBumpSpace()) refuse();
    if (this.char() === "^" && !this.bumpAndBumpSpace()) refuse();
    let dashes = 0;
    while (this.char() === "-") {
      dashes++;
      if (!this.bumpAndBumpSpace()) refuse();
    }
    if (dashes === 0 && this.char() === "]" && !this.bumpAndBumpSpace()) refuse();
  }

  /** maybe_parse_ascii_class: `[:alpha:]` and the like, or back to the `[` for a nested class. */
  private maybeAsciiClass(): boolean {
    const start = this.pos;
    const back = () => {
      this.pos = start;
      return false;
    };
    if (!this.bump() || this.char() !== ":") return back();
    if (!this.bump()) return back();
    if (this.char() === "^" && !this.bump()) return back();
    const nameStart = this.pos;
    while (this.char() !== ":" && this.bump()) {}
    if (this.eof()) return back();
    const name = this.cs.slice(nameStart, this.pos).join("");
    if (!this.bumpIf(":]") || !ASCII_CLASSES.has(name)) return back();
    return true;
  }

  /** parse_set_class_range: an item, or a range of two literals in order. */
  private parseSetClassRange(): void {
    const first = this.parseSetClassItem();
    this.bumpSpace();
    if (this.eof()) refuse();
    if (this.char() !== "-" || this.peekSpace() === "]" || this.peekSpace() === "-") {
      // into_class_set_item: no assertion in a class.
      if (first.kind === "assertion" || first.kind === "dot") refuse();
      return;
    }
    if (!this.bumpAndBumpSpace()) refuse();
    const second = this.parseSetClassItem();
    if (first.kind !== "literal" || second.kind !== "literal" || first.c > second.c) refuse();
  }

  /** parse_set_class_item: an escape, or a char as it is. */
  private parseSetClassItem(): Primitive {
    if (this.char() === "\\") return this.parseEscape();
    const c = this.char();
    this.bump();
    return { kind: "literal", c: c.codePointAt(0) ?? 0 };
  }
}
