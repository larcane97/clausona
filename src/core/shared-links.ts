import { link, lstat, readlink, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";

export type SharedLinkInfo = {
  isSharedLink: boolean;
  pointsToSource: boolean;
  targetExists: boolean;
};

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    // Strip the long-path prefix. UNC first: \\?\UNC\server\share is \\server\share,
    // not UNC\server\share.
    const resolved = path
      .resolve(value)
      .replace(/^\\\\\?\\UNC\\/, "\\\\")
      .replace(/^\\\\\?\\/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export async function inspectSharedLink(target: string, source: string): Promise<SharedLinkInfo> {
  const targetStats = await lstat(target).catch(() => null);
  if (!targetStats) {
    return { isSharedLink: false, pointsToSource: false, targetExists: false };
  }

  if (targetStats.isSymbolicLink()) {
    const resolvedTarget = await realpath(target).catch(() => null);
    const resolvedSource = await realpath(source).catch(() => source);
    if (resolvedTarget) {
      return {
        isSharedLink: true,
        pointsToSource: samePath(resolvedTarget, resolvedSource),
        targetExists: true,
      };
    }

    const rawTarget = await readlink(target);
    const absoluteTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(target), rawTarget);
    return {
      isSharedLink: true,
      pointsToSource: samePath(absoluteTarget, source),
      targetExists: false,
    };
  }

  if (targetStats.isFile()) {
    const sourceStats = await stat(source).catch(() => null);
    // A zero inode means the filesystem could not report a file index (some Windows
    // network drives). Comparing 0 === 0 would call two unrelated files the same file,
    // and setupSharedLinks deletes what it believes is a shared link without backing
    // it up first — so an unusable identity is treated as "not a link".
    const identifiable = Boolean(targetStats.ino) && Boolean(sourceStats?.ino);
    const sameFile = Boolean(
      identifiable &&
        sourceStats?.isFile() &&
        sourceStats.dev === targetStats.dev &&
        sourceStats.ino === targetStats.ino,
    );
    return { isSharedLink: sameFile, pointsToSource: sameFile, targetExists: true };
  }

  return { isSharedLink: false, pointsToSource: false, targetExists: true };
}

export async function createSharedLink(
  source: string,
  target: string,
  {
    platform = process.platform,
    isDirectory,
  }: {
    platform?: NodeJS.Platform;
    isDirectory: boolean;
  },
): Promise<void> {
  if (platform !== "win32") {
    await symlink(source, target);
    return;
  }

  if (isDirectory) {
    await symlink(source, target, "junction");
    return;
  }

  try {
    await symlink(source, target, "file");
  } catch (symlinkError) {
    try {
      await link(source, target);
    } catch (hardLinkError) {
      throw new Error(
        `Could not share '${source}' on Windows. Enable Developer Mode for symbolic links, or keep the profile on the same drive as its primary config. ` +
          `Symlink: ${symlinkError instanceof Error ? symlinkError.message : String(symlinkError)}; ` +
          `hard link: ${hardLinkError instanceof Error ? hardLinkError.message : String(hardLinkError)}`,
      );
    }
  }
}
