import { describe, expect, it } from "vitest";

import { codexSkipsMatcher } from "./codex-matcher.js";

// Each verdict is Codex 0.159.3's own: one PreToolUse group per matcher in a hooks.json, and
// whether hooks/list listed its hook or warned "invalid matcher".
describe("codexSkipsMatcher", () => {
  it("takes what Codex compiles, JavaScript's RegExp refusing some of it", () => {
    const runs = [
      "",
      "*",
      "Bash",
      "Bash|Read",
      "mcp__.*",
      "^Bash$",
      "(Bash|Read)",
      "a**",
      "x{2}{3}",
      "x+*",
      "(?i)bash",
      "(?i:bash)",
      "(?P<n>x)",
      "(?<a>x)",
      "(?x) a b",
      "(?s).",
      "(?-i)a",
      "(?U)a+",
      "(?m)^a",
      "(?R)",
      "[a--b]",
      "[a&&b]",
      "[a~~b]",
      "[[:alpha:]]",
      "[[:foo:]]",
      "[]a]",
      "\\pL",
      "\\p{Greek}",
      "\\x{41}",
      "\\u{41}",
      "\\z",
      "\\A",
      "\\<",
      "\\b{start}",
      "\\-",
      "\\_",
      "\\ ",
      "\\%",
      "}",
      "]",
      "a{ 2 }",
      "x{1,}",
      "a{99999}",
      "^*",
      "(?x)a{ 2 }",
      "(?x)[a - z]",
      "é+",
      "Bash(git:*)",
    ];
    expect(runs.filter(codexSkipsMatcher)).toEqual([]);
  });

  it("skips what Codex cannot parse, JavaScript's RegExp taking some of it", () => {
    const skips = [
      "(",
      ")",
      "[",
      "*abc",
      "?",
      "+x",
      "a|*",
      "(?i)*",
      "{",
      "a{",
      "a{1",
      "a{,2}",
      "a{1,2",
      "a{2,1}",
      "a{4294967296}",
      "\\",
      "[z-a]",
      "[]",
      "[^]",
      "[a-\\d]",
      "[\\d-z]",
      "[\\b]",
      "(?=a)",
      "(?!a)",
      "(?<=a)b",
      "(?<!a)b",
      "(a)\\1",
      "\\0",
      "\\c",
      "\\e",
      "\\k<x>",
      "\\y",
      "\\Q",
      "\\é",
      "\\x4",
      "\\u004",
      "\\x{110000}",
      "\\x{D800}",
      "\\p",
      "\\b{foo}",
      "(?)",
      "(?ii)",
      "(?i-)",
      "(?--i)",
      "(?q)",
      "(?P=n)",
      "(?<n>a)(?<n>b)",
      "(?<a-b>x)",
      "(?<>a)",
      "(?<1a>x)",
      "Bash(",
    ];
    expect(skips.filter((m) => !codexSkipsMatcher(m))).toEqual([]);
  });

  it("skips what Rust's translator and compiler refuse: Unicode names, invalid UTF-8, nesting and size", () => {
    const deep = (n: number) => `${"(".repeat(n)}a${")".repeat(n)}`;
    const skips = [
      // regex-syntax's Unicode tables know none of these names.
      "\\p{Foo}",
      "\\pX",
      "\\p{}",
      "\\p{Script}",
      "\\p{script=foo}",
      "\\p{Age=99.0}",
      "\\p{Bidi_Class=L}",
      "\\p{Block=Greek}",
      "[\\p{Foo}]",
      // `is` dropped, `isc` names ISO_Comment, which is no binary property.
      "\\p{isc}",
      // Under (?-u), what could match invalid UTF-8, or a byte class that meets Unicode.
      "(?-u)\\xFF",
      "(?-u).",
      "(?-u)\\W",
      "(?-u)\\pL",
      "(?-u)[^a]",
      "(?-u)[é]",
      "(?-u)[[:^alpha:]]",
      "a(?-u)|.",
      // Past the nest limit of 250, and past the 10 MiB size limit.
      deep(251),
      "a{400000}",
      "a{4294967295}",
      "(a{1000}){2000}",
    ];
    expect(skips.filter((m) => !codexSkipsMatcher(m))).toEqual([]);
    const runs = [
      "\\pL",
      "\\pl",
      "\\p{ letter }",
      "\\p{Is_Letter}",
      "\\p{greek}",
      "\\p{G-r-e-e-k}",
      "\\p{sc!=Greek}",
      "\\p{scx=Greek}",
      "\\p{Age=16.0}",
      "\\p{gcb=Extend}",
      "\\p{cf}",
      "\\p{c}",
      "\\p{Any}",
      "(?-u)\\x7F",
      "(?-u)\\x{FF}",
      "(?-u)é",
      "(?-u)\\B",
      "(?-u)[a-z]",
      "(?-u:a).",
      deep(250),
      "a{300000}",
    ];
    expect(runs.filter(codexSkipsMatcher)).toEqual([]);
  });

  it("leans to running a matcher only compiling it could tell, past the size limit by more than its count", () => {
    // Codex skips each: a Unicode class compiles to many states, which the lower bound counts as one.
    expect(["\\w[^a]{100000}", "\\P{Script=Greek}\\S{300000}"].map(codexSkipsMatcher)).toEqual([false, false]);
  });
});
