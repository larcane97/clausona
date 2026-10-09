import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { leakedWindows } from "../test-leaks.js";
import type { Warning } from "./model.js";
import {
  entryInfo,
  gitRoot,
  hashTree,
  listNames,
  mapLimit,
  parseFrontmatter,
  readJsonObject,
  samePath,
} from "./read.js";

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
    // Node 20 gives the position alone; later versions add the line and column.
    expect(warnings[0]?.message).toMatch(/^is not valid JSON at (position 2|line 1, column 3)$/);
  });

  it("never quotes the text around a syntax error, which can be a secret", async () => {
    // Built from pieces, so a push-protection scan does not take them for real keys.
    const key = ["sk-ant-api03-", "QZXJ7wvKpLmN8rTy", "UbHc5dFgA2sE9oIuWq"].join("");
    const token = ["Zq8vT3kLmW2x", "R9pNcY7bH4dF", "jS6gA1eUoI5t"].join("");
    const dir = tempDir();
    // V8 quotes about ten characters either side of a bad token: the key's public prefix here,
    // and the head of the token, which has no public prefix, in the second file.
    writeFileSync(path.join(dir, "key.json"), `{"env":{"API_KEY": ${key}}}`);
    writeFileSync(path.join(dir, "token.json"), `{"mcpServers":{"x":{"env":{"TOKEN": ${token}}}}}`);
    const warnings: Warning[] = [];
    await readJsonObject(path.join(dir, "key.json"), warnings);
    await readJsonObject(path.join(dir, "token.json"), warnings);
    const messages = warnings.map((w) => w.message);
    expect(leakedWindows(messages, key)).toEqual([]);
    expect(leakedWindows(messages, token)).toEqual([]);
    expect(messages).toEqual(["is not valid JSON", "is not valid JSON"]);
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
  it("hashes files in the walk's order: by name, a subfolder's files in its place", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "b", "d"), { recursive: true });
    writeFileSync(path.join(dir, "a.md"), "1");
    writeFileSync(path.join(dir, "b", "c.md"), "22");
    writeFileSync(path.join(dir, "b", "d", "e.md"), "333");
    writeFileSync(path.join(dir, "f.md"), "4444");
    writeFileSync(path.join(dir, ".DS_Store"), "skipped");
    // The digest a walk one entry at a time makes; reading in parallel must not change it, or
    // copies hashed before and after would stop matching.
    const expected = createHash("sha256");
    for (const [rel, text] of [
      ["a.md", "1"],
      ["b/c.md", "22"],
      ["b/d/e.md", "333"],
      ["f.md", "4444"],
    ]) {
      expected.update(`${rel}\0${text.length}\0`);
      expected.update(text);
    }
    expect(await hashTree(dir)).toBe(expected.digest("hex"));
  });

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

  // Mode 000 stops a read only for a non-root user on POSIX; Windows ignores it and root reads anyway.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "counts a file it cannot read by path and size, and reads on",
    async () => {
      const dir = tempDir();
      for (const copy of ["a", "b", "c"]) {
        mkdirSync(path.join(dir, copy));
        writeFileSync(path.join(dir, copy, "locked.md"), copy === "a" ? "one" : "two");
        chmodSync(path.join(dir, copy, "locked.md"), 0o000);
        writeFileSync(path.join(dir, copy, "z.md"), copy === "c" ? "changed" : "same");
      }
      const [a, b, c] = await Promise.all(["a", "b", "c"].map((copy) => hashTree(path.join(dir, copy))));
      // The locked files differ only in contents, which cannot be read, so a and b hash alike;
      // c differs in a file after the locked one, so the walk went on past it.
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves the budget a failed read did not use to the files after it",
    async () => {
      const dir = tempDir();
      for (const copy of ["a", "b"]) {
        mkdirSync(path.join(dir, copy));
        writeFileSync(path.join(dir, copy, "a-locked.bin"), "x".repeat(3 * 1024 * 1024));
        chmodSync(path.join(dir, copy, "a-locked.bin"), 0o000);
        writeFileSync(path.join(dir, copy, "b.bin"), `${"y".repeat(2 * 1024 * 1024 - 1)}${copy}`);
      }
      // The locked 3 MB file is not read, so the 2 MB after it still fits the 4 MB budget and
      // its contents - which differ - are hashed.
      expect(await hashTree(path.join(dir, "a"))).not.toBe(await hashTree(path.join(dir, "b")));
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips a file it read ahead once the reads before it have used the budget",
    async () => {
      const MB = 1024 * 1024;
      const dir = tempDir();
      for (const copy of ["a", "b"]) {
        mkdirSync(path.join(dir, copy));
        writeFileSync(path.join(dir, copy, "a-locked.bin"), "x".repeat(2 * MB));
        chmodSync(path.join(dir, copy, "a-locked.bin"), 0o000);
        writeFileSync(path.join(dir, copy, "b.bin"), "y".repeat(3 * MB));
        writeFileSync(path.join(dir, copy, "c.bin"), `${"z".repeat(2 * MB - 1)}${copy}`);
      }
      // Planned as if the locked 2 MB file were read, the 3 MB file does not fit the 4 MB budget
      // and the last 2 MB does, so that one is read ahead. The locked read fails, the 3 MB file is
      // read in its place, and 1 MB is left: the file read ahead then counts by path and size
      // only, as in a walk one file at a time, so the byte that differs is not hashed.
      expect(await hashTree(path.join(dir, "a"))).toBe(await hashTree(path.join(dir, "b")));
    },
  );
});

describe("mapLimit", () => {
  it("keeps the items' order whichever call finishes first", async () => {
    const delays = [30, 5, 20, 0, 10];
    const out = await mapLimit(delays, 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:0", "4:10"]);
  });

  it("never has more than the limit in flight, and uses all of it", async () => {
    let inFlight = 0;
    let most = 0;
    await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (i) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, i % 4));
        inFlight--;
      },
    );
    expect(most).toBe(3);
  });

  it("rejects with the error a call throws", async () => {
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (n) => {
        await new Promise((resolve) => setTimeout(resolve, n));
        if (n === 2) throw new Error("call 2 failed");
        return n;
      }),
    ).rejects.toThrow("call 2 failed");
  });

  it("is empty for no items and runs one at a time below a limit of 1", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    let inFlight = 0;
    let most = 0;
    const out = await mapLimit([1, 2, 3], 0, async (n) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(most).toBe(1);
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
