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
  // Read as bigints: a Windows file index is 64 bits, and as a number one above 2^53 is
  // rounded, so two files made one after the other could read as the same file.
  const targetStats = await lstat(target, { bigint: true }).catch(() => null);
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
    const sourceStats = await stat(source, { bigint: true }).catch(() => null);
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

/**
 * Links `target` to `source`, which must not exist yet. True when it did.
 *
 * Windows makes a file symlink only with Developer Mode on or the "Create symbolic links"
 * privilege, so there a file falls back to a hard link - unless `hardLink` is false: a file
 * the tool saves by renaming a new one over it leaves a hard link behind at the first save,
 * and the profile goes on reading a copy that no longer follows the primary's. For one of
 * those, a symlink refused for want of the privilege links nothing and returns false, so the
 * caller can keep a copy and say so.
 */
export async function createSharedLink(
  source: string,
  target: string,
  {
    platform = process.platform,
    isDirectory,
    hardLink = true,
    makeSymlink = symlink,
  }: {
    platform?: NodeJS.Platform;
    isDirectory: boolean;
    /** Whether a hard link may stand in for a file symlink Windows refuses. */
    hardLink?: boolean;
    /** fs.symlink, replaceable so a test can refuse it the way Windows does. */
    makeSymlink?: typeof symlink;
  },
): Promise<boolean> {
  if (platform !== "win32") {
    await makeSymlink(source, target);
    return true;
  }

  if (isDirectory) {
    await makeSymlink(source, target, "junction");
    return true;
  }

  try {
    await makeSymlink(source, target, "file");
    return true;
  } catch (symlinkError) {
    if (!hardLink) {
      if ((symlinkError as NodeJS.ErrnoException).code === "EPERM") return false;
      throw new Error(
        `Could not share '${source}' on Windows by a symbolic link, and a hard link would not outlast the next save of it: ${symlinkError instanceof Error ? symlinkError.message : String(symlinkError)}`,
      );
    }
    try {
      await link(source, target);
      return true;
    } catch (hardLinkError) {
      throw new Error(
        `Could not share '${source}' on Windows. Enable Developer Mode for symbolic links, or keep the profile on the same drive as its primary config. ` +
          `Symlink: ${symlinkError instanceof Error ? symlinkError.message : String(symlinkError)}; ` +
          `hard link: ${hardLinkError instanceof Error ? hardLinkError.message : String(hardLinkError)}`,
      );
    }
  }
}
