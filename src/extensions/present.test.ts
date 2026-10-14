import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { tilde } from "./present.js";

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

describe("tilde", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("takes the home dir in any case on Windows, where Codex writes its keys in lower case", () => {
    const home = path.join(path.sep, "Users", "Me");
    const lower = path.join(path.sep, "users", "me", "repos", "main");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(tilde(lower, home)).toBe(`~${path.sep}repos${path.sep}main`);
    expect(tilde(path.join(path.sep, "users", "me"), home)).toBe("~");
    // A folder whose name only starts like the home dir's is not under it.
    expect(tilde(path.join(path.sep, "users", "me2"), home)).toBe(path.join(path.sep, "users", "me2"));
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(tilde(lower, home)).toBe(lower);
    expect(tilde(path.join(home, "repos"), home)).toBe(`~${path.sep}repos`);
  });
});
