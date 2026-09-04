import { describe, expect, it, vi } from "vitest";

// Isolated from shared-links.test.ts because it has to fake what the filesystem
// reports, which a whole-module mock cannot do alongside the real-fs cases.
const stats = vi.hoisted(() => ({ target: {} as Record<string, unknown>, source: {} as Record<string, unknown> }));

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async () => ({
    isSymbolicLink: () => false,
    isFile: () => true,
    ...stats.target,
  })),
  stat: vi.fn(async () => ({ isFile: () => true, ...stats.source })),
  readlink: vi.fn(async () => ""),
  realpath: vi.fn(async (p: string) => p),
  symlink: vi.fn(async () => {}),
  link: vi.fn(async () => {}),
}));

const { inspectSharedLink } = await import("./shared-links.js");

describe("inspectSharedLink when the filesystem cannot identify a file", () => {
  it("treats a zero inode as unusable rather than as a match", async () => {
    // Some Windows network drives report ino 0 for every file. Comparing 0 === 0 would
    // classify the user's own data as a shared link, and setupSharedLinks deletes those
    // without taking a backup first.
    stats.target = { dev: 0, ino: 0 };
    stats.source = { dev: 0, ino: 0 };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: false,
      pointsToSource: false,
      targetExists: true,
    });
  });

  it("still matches when the inode is real", async () => {
    stats.target = { dev: 66, ino: 4242 };
    stats.source = { dev: 66, ino: 4242 };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: true,
      pointsToSource: true,
    });
  });

  it("does not match different inodes on the same device", async () => {
    stats.target = { dev: 66, ino: 4242 };
    stats.source = { dev: 66, ino: 9999 };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: false,
    });
  });
});
