import { describe, expect, it } from "vitest";

import { codexFrontMatterError, rustTrim } from "./codex-front-matter.js";

/**
 * Front matters and what Codex 0.159.3's `skills/list` said of each, in a scratch CODEX_HOME:
 * the skill listed ("ok"), or an `invalid YAML` error for it ("invalid").
 */
const CODEX: readonly [front: string, codex: "ok" | "invalid"][] = [
  ["name: a\ndescription: d", "ok"],
  // Codex quotes a value with a `: ` in it, or one that starts like a flow collection and does not parse.
  ["description: a: b: c", "ok"],
  ["description: {a: b}", "ok"],
  ["description: d\nargument-hint: [file] <x>", "ok"],
  ["description: @x", "ok"],
  // serde_yaml's Value wants each key once, so this does not parse, and Codex quotes it.
  ["description: {a, a}", "ok"],
  ["description: d # comment", "ok"],
  ["description: foo\n  bar", "ok"],
  ["description: |\n  text", "ok"],
  // libyaml reads a quoted scalar's lines at any indentation.
  ['description: "multi\nline"', "ok"],
  ["description: d\nallowed-tools:\n- Bash\n- Read", "ok"],
  ["description: d\nmetadata:", "ok"],
  ["description: d\nmetadata: {short-description: s}", "ok"],
  ["foo: 1\nfoo: 2\ndescription: d", "ok"],
  ["description:\td", "ok"],
  ["name: 123\ndescription: d", "ok"],
  ["description: |\n  a\n # c", "ok"],
  ['description: "x"#c', "ok"],
  ["name: a\n \t\ndescription: d", "ok"],
  ["description: |2\n  \ta", "ok"],
  ['description: "x" y', "invalid"],
  ["description: 'it's'", "invalid"],
  ["description: foo\nbar", "invalid"],
  ["description: [a, b]", "invalid"],
  ["description: d\nmetadata: x", "invalid"],
  ["description: d\nmetadata: null", "invalid"],
  ["name: a\nname: b\ndescription: d", "invalid"],
  ["\tdescription: d", "invalid"],
  ["description: %foo", "invalid"],
  ["description: *foo", "invalid"],
  ["name: foo\n  description: bar", "invalid"],
  ["hello", "invalid"],
  ["- a", "invalid"],
  ["description: - item", "invalid"],
  ["description: |\n    a\n  b", "invalid"],
  ["description: ]x", "invalid"],
  ["name:x\ndescription: d", "invalid"],
  ["description: |x\n  y", "invalid"],
  ['description: "a\\qb"', "invalid"],
  ["description: d\nmetadata:\n  short-description: s\n version: 1", "invalid"],
  ["description: d\nmetadata: []", "invalid"],
  ["description: d\nmetadata:\n  short-description: [a]", "invalid"],
  ["description:\n  - a", "invalid"],
  ["description:\n  a: b", "invalid"],
  ["description: d\n\tfoo: 1", "invalid"],
  // A colon at the end has no space after it, so Codex does not quote the value.
  ["description: ends with:", "invalid"],
  ["description: ? x", "invalid"],
  ["description: &", "invalid"],
  ["description: [a]#c", "invalid"],
  ['name: n\ndescription: "q"\n  \tmore', "invalid"],
  ["description: |\n   \n  text", "invalid"],
  ["description: |\n  \ta", "invalid"],
  ["%YAML 1.2", "invalid"],
  ["[a]", "invalid"],
];

describe("codexFrontMatterError", () => {
  it("refuses the front matters Codex refuses, and reads the ones it reads", () => {
    const ours = CODEX.map(([front]) => [front, codexFrontMatterError(front) === undefined ? "ok" : "invalid"]);
    expect(ours).toEqual(CODEX);
    expect(codexFrontMatterError('description: "x" y')).toBe("invalid front matter");
  });

  it("refuses a front matter with no description, a null one or a blank one, as Codex does", () => {
    // Codex 0.159.3: "missing field `description`" for each but the last, which it lists.
    const fronts = [
      "name: none",
      'name: empty\ndescription: ""',
      "name: blank\ndescription: |\n",
      "name: null\ndescription: ~",
      "name: comment\ndescription: # none",
      "# only a comment",
      "name: below\ndescription:\n  on the next line",
    ];
    expect(fronts.map(codexFrontMatterError)).toEqual([...Array(6).fill("no description"), undefined]);
  });

  it("says nothing of what it does not follow, though Codex refuses some of it", () => {
    // Codex refuses the second (a document end, then nothing), and reads the first.
    expect(codexFrontMatterError("description: !t x")).toBeUndefined();
    expect(codexFrontMatterError("...")).toBeUndefined();
  });
});

describe("rustTrim", () => {
  it("trims as Rust does: a byte order mark stays, a next-line character goes", () => {
    expect(rustTrim("﻿---")).toBe("﻿---");
    expect(rustTrim("\u0085--- \t")).toBe("---");
  });
});
