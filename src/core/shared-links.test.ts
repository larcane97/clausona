import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createSharedLink, inspectSharedLink } from "./shared-links.js";

describe("Windows shared links", () => {
  it.runIf(process.platform === "win32")("uses an unprivileged junction for directories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-junction-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    mkdirSync(source);
    writeFileSync(path.join(source, "marker.txt"), "shared");

    try {
      await createSharedLink(source, target, { platform: "win32", isDirectory: true });

      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(target, "marker.txt"), "utf8")).toBe("shared");
      expect(await inspectSharedLink(target, source)).toMatchObject({
        isSharedLink: true,
        pointsToSource: true,
        targetExists: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("falls back to a hard link for files without symlink privilege", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-hardlink-"));
    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    writeFileSync(source, "shared");

    try {
      await createSharedLink(source, target, { platform: "win32", isDirectory: false });

      expect(readFileSync(target, "utf8")).toBe("shared");
      expect(await inspectSharedLink(target, source)).toMatchObject({
        isSharedLink: true,
        pointsToSource: true,
        targetExists: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Runs everywhere: the symlink is refused the way Windows refuses it without Developer Mode.
describe("createSharedLink where Windows refuses a file symlink", () => {
  let root: string;
  const notPermitted = (async () => {
    throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
  }) as unknown as typeof import("node:fs/promises").symlink;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clausona-no-symlink-"));
    return () => rmSync(root, { recursive: true, force: true });
  });

  it("links nothing for a file that may not be hard-linked", async () => {
    const source = path.join(root, "config.toml");
    const target = path.join(root, "profile-config.toml");
    writeFileSync(source, "model = 'x'\n");

    const linked = await createSharedLink(source, target, {
      platform: "win32",
      isDirectory: false,
      hardLink: false,
      makeSymlink: notPermitted,
    });

    expect(linked).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("still falls back to a hard link for any other file", async () => {
    const source = path.join(root, "AGENTS.md");
    const target = path.join(root, "profile-AGENTS.md");
    writeFileSync(source, "shared");

    const linked = await createSharedLink(source, target, {
      platform: "win32",
      isDirectory: false,
      makeSymlink: notPermitted,
    });

    expect(linked).toBe(true);
    expect(statSync(target, { bigint: true }).ino).toBe(statSync(source, { bigint: true }).ino);
  });
});

// Runs everywhere: identity is what setupSharedLinks uses to decide whether a file is
// shared state it may delete, or the user's own data it must back up first.
describe("inspectSharedLink identity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clausona-identity-"));
    return () => rmSync(root, { recursive: true, force: true });
  });

  it("recognises a hard link to the source", async () => {
    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    writeFileSync(source, "shared");
    linkSync(source, target);

    expect(await inspectSharedLink(target, source)).toMatchObject({
      isSharedLink: true,
      pointsToSource: true,
      targetExists: true,
    });
  });

  it("does not mistake an unrelated file with identical contents for a link", async () => {
    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    writeFileSync(source, "shared");
    writeFileSync(target, "shared");

    expect(await inspectSharedLink(target, source)).toMatchObject({
      isSharedLink: false,
      pointsToSource: false,
      targetExists: true,
    });
  });

  it("reports a symlink aimed somewhere else as pointing away from the source", async () => {
    const source = path.join(root, "source.json");
    const other = path.join(root, "other.json");
    const target = path.join(root, "target.json");
    writeFileSync(source, "shared");
    writeFileSync(other, "mine");
    symlinkSync(other, target);

    expect(await inspectSharedLink(target, source)).toMatchObject({
      isSharedLink: true,
      pointsToSource: false,
    });
  });

  it("reports a directory of real data as not a link", async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    mkdirSync(source);
    mkdirSync(target);

    expect(await inspectSharedLink(target, source)).toMatchObject({
      isSharedLink: false,
      targetExists: true,
    });
  });

  it("reports a missing target as absent", async () => {
    expect(await inspectSharedLink(path.join(root, "nope"), path.join(root, "src"))).toEqual({
      isSharedLink: false,
      pointsToSource: false,
      targetExists: false,
    });
  });
});
