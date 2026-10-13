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

  it("leans to running a matcher Rust parses and then cannot compile, as only the compiler knows", () => {
    // Codex skips each; regex-syntax's parser takes them, and the Unicode tables, the UTF-8 check
    // or the size limit refuse them later.
    expect(["\\p{Foo}", "\\pX", "(?-u)\\xFF", "a{4294967295}"].map(codexSkipsMatcher)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
