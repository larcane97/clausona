import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every call read.ts makes into node:fs/promises, counted while it is in flight. Each is held a
 * millisecond longer than the disk takes, so calls pile up as they do on a large home.
 */
const fsCalls = vi.hoisted(() => ({ inFlight: 0, most: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const counted = <F>(call: F): F =>
    (async (...args: unknown[]) => {
      fsCalls.inFlight++;
      fsCalls.most = Math.max(fsCalls.most, fsCalls.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await (call as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        fsCalls.inFlight--;
      }
    }) as F;
  const wrapped = {
    lstat: counted(actual.lstat),
    readdir: counted(actual.readdir),
    readFile: counted(actual.readFile),
    readlink: counted(actual.readlink),
    realpath: counted(actual.realpath),
    stat: counted(actual.stat),
  };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import { entryInfo, FS_SLOTS, gitRoot, hashTree, listNames, readText, realPath } from "./read.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the process-wide file-system limit", () => {
  it("never has more than FS_SLOTS calls in flight however many reads run at once, and uses them all", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clausona-limit-"));
    temps.push(dir);
    const skills = Array.from({ length: 40 }, (_, i) => path.join(dir, `skill-${i}`));
    for (const skill of skills) {
      mkdirSync(path.join(skill, "refs"), { recursive: true });
      writeFileSync(path.join(skill, "SKILL.md"), "body");
      for (const name of ["a", "b", "c", "d"]) writeFileSync(path.join(skill, "refs", `${name}.md`), name);
    }
    fsCalls.most = 0;
    // Each walk keeps its own mapLimit calls queued and waits for slots without holding one, so
    // forty at once, with every other kind of read beside them, still all finish.
    await Promise.all([
      ...skills.map((skill) => hashTree(skill)),
      ...skills.map((skill) => readText(path.join(skill, "SKILL.md"), [])),
      ...skills.map((skill) => entryInfo(skill)),
      ...skills.map((skill) => listNames(skill, [])),
      ...skills.map((skill) => realPath(skill)),
      ...skills.map((skill) => gitRoot(skill)),
    ]);
    expect(fsCalls.inFlight).toBe(0);
    expect(fsCalls.most).toBe(FS_SLOTS);
  });
});
