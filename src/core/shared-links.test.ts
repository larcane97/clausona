import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
