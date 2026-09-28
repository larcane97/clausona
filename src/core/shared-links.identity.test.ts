import { describe, expect, it, vi } from "vitest";

// Isolated from shared-links.test.ts because it has to fake what the filesystem
// reports, which a whole-module mock cannot do alongside the real-fs cases.
const stats = vi.hoisted(() => ({ target: {} as Record<string, bigint>, source: {} as Record<string, bigint> }));

// As Node reports them: bigints when asked for, otherwise the nearest number - which a
// Windows file index above 2^53 does not always fit.
const reported = vi.hoisted(
  () => (fields: Record<string, bigint>, options?: { bigint?: boolean }) =>
    Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, options?.bigint ? value : Number(value)])),
);

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async (_path: string, options?: { bigint?: boolean }) => ({
    isSymbolicLink: () => false,
    isFile: () => true,
    ...reported(stats.target, options),
  })),
  stat: vi.fn(async (_path: string, options?: { bigint?: boolean }) => ({
    isFile: () => true,
    ...reported(stats.source, options),
  })),
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
    stats.target = { dev: 0n, ino: 0n };
    stats.source = { dev: 0n, ino: 0n };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: false,
      pointsToSource: false,
      targetExists: true,
    });
  });

  it("still matches when the inode is real", async () => {
    stats.target = { dev: 66n, ino: 4242n };
    stats.source = { dev: 66n, ino: 4242n };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: true,
      pointsToSource: true,
    });
  });

  it("does not match different inodes on the same device", async () => {
    stats.target = { dev: 66n, ino: 4242n };
    stats.source = { dev: 66n, ino: 9999n };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: false,
    });
  });

  // NTFS file indexes are 64 bits and often above 2^53, where a number keeps only every
  // other integer or fewer. Two files made one after the other can then read as one, and
  // the account's own settings.json was taken for a link to the primary's and not backed up.
  it("does not match two files whose indexes round to the same number", async () => {
    const [first, second] = [12666373953642761n, 12666373953642760n];
    expect(Number(first), "these no longer differ as numbers").toBe(Number(second));
    stats.target = { dev: 66n, ino: first };
    stats.source = { dev: 66n, ino: second };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: false,
      pointsToSource: false,
    });
  });

  it("still matches one file whose index is above 2^53", async () => {
    stats.target = { dev: 66n, ino: 12666373953642761n };
    stats.source = { dev: 66n, ino: 12666373953642761n };

    expect(await inspectSharedLink("/x/target.json", "/x/source.json")).toMatchObject({
      isSharedLink: true,
      pointsToSource: true,
    });
  });
});
