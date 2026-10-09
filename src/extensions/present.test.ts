import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every source file under `dir`, relative to src/. */
function sources(dir: string): string[] {
  return readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(dir, file));
}

describe("present", () => {
  it("is what the dashboard reads the inventory through: no TUI file imports the CLI module", () => {
    const importers = sources("tui").filter((file) =>
      /from "[./]*\/extensions\/cli\.js"/.test(readFileSync(path.join(SRC, file), "utf8")),
    );
    expect(importers).toEqual([]);
  });
});
