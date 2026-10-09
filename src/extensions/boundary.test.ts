import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test source file under `dir`, relative to src/ with `/` between parts; the test fixture left out. */
function sources(dir: string): string[] {
  return readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
    .map((file) => `${dir}/${file.split(path.sep).join("/")}`)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && file !== "extensions/test-home.ts")
    .sort();
}

const FILES = [...sources("extensions"), ...sources("tui")];
const text = (file: string) => readFileSync(path.join(SRC, file), "utf8");

/** An import or re-export of a module whose specifier matches `module`: static, side-effect, dynamic or require. */
function importOf(module: string): RegExp {
  return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](?:${module})["']`);
}
const FS = importOf("(?:node:)?fs(?:/promises)?");
const PROCESS = importOf("(?:node:)?child_process");
const LOCK = importOf("[./]*/core/(?:dir|file)-lock(?:\\.js)?");

describe("who may touch the file system", () => {
  it("knows each way of importing a module", () => {
    for (const line of [
      'import { writeFile } from "node:fs/promises";',
      "import fs from 'fs';",
      'import * as fs from "fs/promises";',
      'import "node:fs";',
      'const fs = await import("node:fs");',
      'const fs = require("fs");',
      'export { rm } from "node:fs/promises";',
    ]) {
      expect(FS.test(line), line).toBe(true);
    }
    expect(FS.test('import { x } from "./fs.js";')).toBe(false);
    expect(FS.test('import { x } from "node:fs-extra";')).toBe(false);
    expect(PROCESS.test('import { spawn } from "node:child_process";')).toBe(true);
    expect(LOCK.test('import { acquireDirLock } from "../../core/dir-lock.js";')).toBe(true);
    expect(LOCK.test('import { acquireFileLock } from "../core/file-lock.js";')).toBe(true);
  });

  it("lists the files it checks", () => {
    expect(FILES).toContain("extensions/read.ts");
    expect(FILES).toContain("tui/App.tsx");
    expect(FILES).not.toContain("extensions/test-home.ts");
    expect(FILES.some((file) => /\.test\.tsx?$/.test(file))).toBe(false);
  });

  it("has read.ts alone import fs, and only the read calls", () => {
    expect(FILES.filter((file) => FS.test(text(file)))).toEqual(["extensions/read.ts"]);
    const lines = text("extensions/read.ts")
      .split(/\r?\n/)
      .filter((line) => FS.test(line));
    expect(lines).toEqual([
      'import type { Dirent } from "node:fs";',
      'import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";',
    ]);
  });

  it("has no file start a process or take a lock", () => {
    expect(FILES.filter((file) => PROCESS.test(text(file)) || LOCK.test(text(file)))).toEqual([]);
  });
});
