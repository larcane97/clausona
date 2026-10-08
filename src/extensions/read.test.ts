import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Warning } from "./model.js";
import { entryInfo, gitRoot, hashTree, listNames, parseFrontmatter, readJsonObject, samePath } from "./read.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-read-"));
  temps.push(dir);
  return dir;
}
const linkType = process.platform === "win32" ? "junction" : "dir";

describe("parseFrontmatter", () => {
  it("reads plain and quoted values", () => {
    expect(parseFrontmatter('---\nname: eli5\ndescription: "Explain: simply"\n---\nbody')).toEqual({
      name: "eli5",
      description: "Explain: simply",
    });
  });

  it("joins a folded description and stops at the next key", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: >\n  first line\n  second line\nother: 1\n---\n")).toEqual({
      name: "x",
      description: "first line second line",
    });
  });

  it("reads CRLF files", () => {
    expect(parseFrontmatter("---\r\nname: w\r\ndescription: d\r\n---\r\n")).toEqual({ name: "w", description: "d" });
  });

  it("is empty without front matter", () => {
    expect(parseFrontmatter("# Title\n")).toEqual({});
  });
});

describe("readJsonObject", () => {
  it("is undefined and quiet for a missing file", async () => {
    const warnings: Warning[] = [];
    expect(await readJsonObject(path.join(tempDir(), "none.json"), warnings)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns for malformed JSON and for a non-object", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "bad.json"), "{ nope");
    writeFileSync(path.join(dir, "list.json"), "[1]");
    const warnings: Warning[] = [];
    expect(await readJsonObject(path.join(dir, "bad.json"), warnings)).toBeUndefined();
    expect(await readJsonObject(path.join(dir, "list.json"), warnings)).toBeUndefined();
    expect(warnings.map((w) => path.basename(w.file))).toEqual(["bad.json", "list.json"]);
  });
});

describe("listNames and entryInfo", () => {
  it("lists visible entries sorted and nothing for a missing dir", async () => {
    const dir = tempDir();
    for (const name of ["b", "a", ".hidden"]) mkdirSync(path.join(dir, name));
    expect(await listNames(dir, [])).toEqual(["a", "b"]);
    expect(await listNames(path.join(dir, "missing"), [])).toEqual([]);
  });

  it("tells a link from its target and finds a broken one", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "target"));
    symlinkSync(path.join(dir, "target"), path.join(dir, "good"), linkType);
    symlinkSync(path.join(dir, "gone"), path.join(dir, "broken"), linkType);
    expect((await entryInfo(path.join(dir, "target"))).kind).toBe("dir");
    const good = await entryInfo(path.join(dir, "good"));
    expect(good.kind).toBe("dir");
    expect(good.link?.broken).toBe(false);
    expect(samePath(good.link?.target, path.join(dir, "target"))).toBe(true);
    const broken = await entryInfo(path.join(dir, "broken"));
    expect(broken.kind).toBe("missing");
    expect(broken.link?.broken).toBe(true);
    expect((await entryInfo(path.join(dir, "nothing"))).kind).toBe("missing");
  });
});

describe("hashTree", () => {
  it("is equal for equal folders and differs when a file differs", async () => {
    const dir = tempDir();
    for (const copy of ["one", "two", "three"]) {
      mkdirSync(path.join(dir, copy, "refs"), { recursive: true });
      writeFileSync(path.join(dir, copy, "SKILL.md"), "same");
      writeFileSync(path.join(dir, copy, "refs", "a.md"), copy === "three" ? "changed" : "same");
    }
    const [one, two, three] = await Promise.all(["one", "two", "three"].map((c) => hashTree(path.join(dir, c))));
    expect(one).toBe(two);
    expect(one).not.toBe(three);
  });

  it("stops reading contents past its byte budget", async () => {
    const dir = tempDir();
    const big = "x".repeat(5 * 1024 * 1024);
    for (const copy of ["a", "b"]) {
      mkdirSync(path.join(dir, copy));
      writeFileSync(path.join(dir, copy, "huge.bin"), `${big}${copy}`);
    }
    // Past 4 MB a file counts by path and size only, so these two same-size files hash alike.
    expect(await hashTree(path.join(dir, "a"))).toBe(await hashTree(path.join(dir, "b")));
  });
});

describe("gitRoot", () => {
  it("finds the dir holding .git from below it, a file or a folder", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(path.join(dir, "repo", "src", "deep"), { recursive: true });
    mkdirSync(path.join(dir, "wt"), { recursive: true });
    writeFileSync(path.join(dir, "wt", ".git"), "gitdir: elsewhere\n");
    expect(await gitRoot(path.join(dir, "repo", "src", "deep"))).toBe(path.join(dir, "repo"));
    expect(await gitRoot(path.join(dir, "wt"))).toBe(path.join(dir, "wt"));
  });
});
