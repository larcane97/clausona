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

type Import = { module: string; typeOnly: boolean };

/**
 * Each import or re-export in `source`: static, side-effect, dynamic or require. A relative
 * module is resolved from `file` to its path under src/ without an extension
 * (`extensions/writers/fs`); a `node:` one is named without the prefix (`fs/promises`). Only
 * `import type …` and `export type …` are type-only: `import { type X }` still loads the module.
 */
function importsIn(source: string, file: string): Import[] {
  const found: Import[] = [];
  const statement =
    /\b(?:import|export)\s+(type\s+)?(?:[\w$*{},\s]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    const specifier = match[2] ?? match[3] ?? match[4] ?? "";
    const module = specifier.startsWith(".")
      ? path.posix.join(path.posix.dirname(file), specifier).replace(/\.[jt]sx?$/, "")
      : specifier.replace(/^node:/, "");
    found.push({ module, typeOnly: match[1] !== undefined });
  }
  return found;
}

const IMPORTS = new Map(FILES.map((file) => [file, importsIn(text(file), file)]));

/** The files that import a module `test` names, with type-only imports when `types` is set. */
function importers(test: (module: string) => boolean, types = true): string[] {
  return FILES.filter((file) =>
    (IMPORTS.get(file) ?? []).some((found) => test(found.module) && (types || !found.typeOnly)),
  );
}

const FS = (module: string) => module === "fs" || module === "fs/promises";

describe("who may touch the file system", () => {
  it("knows each way of importing a module", () => {
    const at = "extensions/writers/x.ts";
    const modules = (source: string) => importsIn(source, at).map((found) => found.module);
    for (const line of [
      'import { writeFile } from "node:fs/promises";',
      "import fs from 'fs';",
      'import * as fs from "fs/promises";',
      'import "node:fs";',
      'const fs = await import("node:fs");',
      'const fs = require("fs");',
      'export { rm } from "node:fs/promises";',
      'import {\n  rm,\n  type Stats,\n} from "node:fs/promises";',
    ]) {
      expect(modules(line).filter(FS), line).toHaveLength(1);
    }
    expect(modules('import { x } from "./fs.js";')).toEqual(["extensions/writers/fs"]);
    expect(modules('import { x } from "../writers/fs.js";')).toEqual(["extensions/writers/fs"]);
    expect(importsIn('import { x } from "../../extensions/apply.js";', "tui/extensions/X.tsx")).toEqual([
      { module: "extensions/apply", typeOnly: false },
    ]);
    expect(importsIn('import { acquireDirLock } from "../../core/dir-lock.js";', at)).toEqual([
      { module: "core/dir-lock", typeOnly: false },
    ]);
    expect(modules('import { x } from "node:fs-extra";')).toEqual(["fs-extra"]);
    expect(modules('export const from = "./fs.js";')).toEqual([]);
    expect(importsIn('import type { Plan } from "./plan.js";', at)).toEqual([
      { module: "extensions/writers/plan", typeOnly: true },
    ]);
    expect(importsIn('import { type Plan } from "./plan.js";', at)).toEqual([
      { module: "extensions/writers/plan", typeOnly: false },
    ]);
    expect(importsIn('export type { Plan } from "./plan.js";', at)).toEqual([
      { module: "extensions/writers/plan", typeOnly: true },
    ]);
  });

  it("lists the files it checks", () => {
    expect(FILES).toContain("extensions/read.ts");
    expect(FILES).toContain("extensions/writers/fs.ts");
    expect(FILES).toContain("extensions/apply.ts");
    expect(FILES).toContain("tui/App.tsx");
    expect(FILES).not.toContain("extensions/test-home.ts");
    expect(FILES.some((file) => /\.test\.tsx?$/.test(file))).toBe(false);
  });

  it("has read.ts, with only the read calls, and writers/fs.ts alone import fs", () => {
    expect(importers(FS)).toEqual(["extensions/read.ts", "extensions/writers/fs.ts"]);
    const lines = text("extensions/read.ts")
      .split(/\r?\n/)
      .filter((line) => importsIn(line, "extensions/read.ts").some((found) => FS(found.module)));
    expect(lines).toEqual([
      'import type { Dirent } from "node:fs";',
      'import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";',
    ]);
  });

  it("has writers/fs.ts alone take a lock, and apply.ts alone use writers/fs.ts", () => {
    expect(importers((module) => module === "core/dir-lock")).toEqual(["extensions/writers/fs.ts"]);
    expect(importers((module) => module === "core/file-lock")).toEqual([]);
    expect(importers((module) => module === "extensions/writers/fs")).toEqual(["extensions/apply.ts"]);
  });

  it("has git-tracked.ts alone start a process (git ls-files, which only reads)", () => {
    expect(FILES).toContain("extensions/git-tracked.ts");
    expect(importers((module) => module === "child_process")).toEqual(["extensions/git-tracked.ts"]);
  });

  it("has the TUI import what writes as types only", () => {
    const writes = (module: string) =>
      module === "extensions/apply" || module.startsWith("extensions/writers/") || module === "extensions/git-tracked";
    expect(importers(writes, false).filter((file) => file.startsWith("tui/"))).toEqual([]);
  });

  it("has the TUI never import the CLI, not even for a type", () => {
    const cli = (module: string) => module === "extensions/cli" || module === "extensions/cli-help";
    expect(importers(cli).filter((file) => file.startsWith("tui/"))).toEqual([]);
  });
});
