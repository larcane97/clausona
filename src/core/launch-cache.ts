import { chmod, link, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { type BuiltEnv, isSecretEnvName } from "../lib/profile-env.js";
import type { Profile, ToolName } from "../types.js";
import { carriesCredentialToken } from "./credential-token.js";
import { posixQuote, type ShellInitPaths } from "./shell.js";

/**
 * The launch cache: the script `clausona _launch <tool>` printed last time, kept where the
 * shell hook can eval it without starting Node. A clausona process costs 0.1-0.4 s before the
 * tool even starts, and on the common path the answer never changes between runs - the same
 * profile, the same config dir, the same exports.
 *
 * What makes it safe to reuse:
 * - it is written only for a profile whose script holds nothing that is resolved at launch
 *   or said at launch - no key, no cleared variable, no warning (see `isCacheable`);
 * - it is written under the registry lock, and only if profiles.json is still the file the
 *   script was rendered from, so a `csn use` that lands meanwhile cannot be undone by it;
 * - every registry save deletes it, still under the lock;
 * - the hook trusts it only while profiles.json is still the very file it was rendered from,
 *   and not changed since. POSIX: a hard link to profiles.json sits next to the script (see
 *   `launchRefPath`), and the hook wants profiles.json to be that same file and the script to
 *   be newer than it. PowerShell: the script carries profiles.json's exact write time and
 *   length, and the hook wants both to match. Either way a delete that failed is covered, and
 *   so is a backup moved back over profiles.json, whose older time a plain time comparison
 *   would have trusted. Not covered: a copy that keeps its time written over profiles.json in
 *   place (`cp -p`), which leaves the same file with an old time and the same length.
 *
 * The file name carries the version, because a hook is rendered by one version and must
 * only ever read what that same version wrote.
 */

export type LaunchFormat = "posix" | "json";

const LAUNCH_PREFIX = "launch-";
const LAUNCH_NAME = /^launch-(.+)-([a-z]+)\.(sh|json|ref)$/;

export function launchCacheDir(clausonaDir: string): string {
  return path.join(clausonaDir, "cache");
}

export function launchCachePath(clausonaDir: string, tool: ToolName, format: LaunchFormat, version: string): string {
  const extension = format === "posix" ? "sh" : "json";
  return path.join(launchCacheDir(clausonaDir), `${LAUNCH_PREFIX}${version}-${tool}.${extension}`);
}

/**
 * A hard link to the profiles.json a tool's POSIX script was rendered from. It is that file,
 * not a note of its inode number, so the number cannot be handed to another file while the
 * script is still around; a save renames a new file into place, so profiles.json stops being
 * this one, and `[[ profiles.json -ef ref ]]` - a builtin in bash 3.2 and zsh - says so.
 */
export function launchRefPath(clausonaDir: string, tool: ToolName, version: string): string {
  return path.join(launchCacheDir(clausonaDir), `${LAUNCH_PREFIX}${version}-${tool}.ref`);
}

/** Ticks - 100 ns since 0001-01-01, .NET's DateTime - at the Unix epoch. */
const UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;

/**
 * profiles.json as the PowerShell hook sees it: LastWriteTimeUtc.Ticks and Length, both as
 * strings, because ticks run past 2^53. NTFS keeps times in 100 ns units and Node reports
 * them exactly, so these are the very numbers Get-Item gives.
 */
export function registryStamp(stat: NonNullable<RegistryStat>): { ticks: string; length: string } {
  return { ticks: String(stat.mtimeNs / 100n + UNIX_EPOCH_TICKS), length: String(stat.size) };
}

/**
 * Whether a profile's launch script may be written to disk.
 *
 * - Never for an API profile: its script carries the key it just resolved, and a key must
 *   stay in the store it came from. Its env is also built from a source that can change
 *   without profiles.json changing - an exported variable, a command's output.
 * - Never when the build warned. A warning is a persistent misconfiguration and has to
 *   reach the user on every launch, which a script replayed from disk would not do.
 * - Never when something is cleared or guarded. Only an API profile does either today; the
 *   guard exists to stop a launch, which is a decision to make afresh each time.
 * - Never when the env map carries a secret, by name or by shape. A subscription profile may
 *   keep another service's token there, in plain text in profiles.json; the cache would be
 *   one more copy of it on disk.
 */
export function isCacheable(profile: Profile, built: BuiltEnv, guard: readonly string[]): boolean {
  if (profile.kind === "api" || profile.api !== undefined) return false;
  if (built.warnings.length > 0 || built.unset.length > 0 || guard.length > 0) return false;
  return !Object.entries(built.env).some(([key, value]) => isSecretEnvName(key) || carriesCredentialToken(value));
}

/**
 * profiles.json's identity: which file it is and which version of it. A save replaces the
 * file (tmp + rename), which changes the inode; a hand edit in place changes the size or the
 * mtime. bigint because a Windows file id exceeds 2^53 and would round to its neighbour's.
 */
export type RegistryStat = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint } | null;

export async function statRegistry(registryPath: string): Promise<RegistryStat> {
  try {
    const { dev, ino, size, mtimeNs } = await stat(registryPath, { bigint: true });
    return { dev, ino, size, mtimeNs };
  } catch {
    return null;
  }
}

function sameRegistry(a: RegistryStat, b: RegistryStat): boolean {
  if (a === null || b === null) return false;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/**
 * Writes a launch script to the cache and resolves to whether it did. Never rejects: the
 * cache only ever saves time, so failing to write it is no reason to fail the launch.
 *
 * `withLock` runs its callback holding the registry lock, or resolves to undefined without
 * running it when another process holds the lock. The launch does not wait for it: whoever
 * holds it is most likely changing the registry, and the script about to be written would
 * describe the registry as it was.
 *
 * With `refPath`, for the POSIX script, profiles.json is also hard-linked there (see
 * `launchRefPath`); a link that cannot be made means no script is written, since the hook
 * would never trust it.
 *
 * With `keepVersion`, every other version's launch scripts go once this one is written. They
 * are housekeeping only: no hook of this version reads them.
 */
export async function writeLaunchCache(opts: {
  path: string;
  content: string;
  registryPath: string;
  before: RegistryStat;
  withLock: (fn: () => Promise<boolean>) => Promise<boolean | undefined>;
  refPath?: string;
  keepVersion?: string;
}): Promise<boolean> {
  if (opts.before === null) return false;
  try {
    const wrote = await opts.withLock(async () => {
      if (!sameRegistry(await statRegistry(opts.registryPath), opts.before)) return false;
      const dir = path.dirname(opts.path);
      // Owner-only, like profiles.json: the script names every config dir and env value of
      // the profile it launches.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      // Written aside and renamed into place, so the hook never reads half a script. The
      // names start with the prefix so that an invalidation also sweeps a leftover one.
      const tmpPath = `${opts.path}.tmp.${process.pid}`;
      const refTmpPath = opts.refPath === undefined ? undefined : `${opts.refPath}.tmp.${process.pid}`;
      try {
        if (refTmpPath !== undefined) {
          await rm(refTmpPath, { force: true });
          await link(opts.registryPath, refTmpPath);
        }
        await writeFile(tmpPath, opts.content, { encoding: "utf8", mode: 0o600 });
        await rename(tmpPath, opts.path);
        // The script first and its ref second: in between, the old ref names another file
        // or this same one, and either way the hook reads nothing it should not.
        if (refTmpPath !== undefined && opts.refPath !== undefined) await rename(refTmpPath, opts.refPath);
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {});
        if (refTmpPath !== undefined) await rm(refTmpPath, { force: true }).catch(() => {});
        throw error;
      }
      // writeFile applies the mode only to a file it creates, so it is asserted again.
      await chmod(opts.path, 0o600).catch(() => {});
      if (opts.keepVersion !== undefined) await removeOtherVersions(dir, opts.keepVersion);
      return true;
    });
    return wrote === true;
  } catch {
    return false;
  }
}

async function removeOtherVersions(dir: string, version: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const stale = names.filter((name) => name.startsWith(LAUNCH_PREFIX) && LAUNCH_NAME.exec(name)?.[1] !== version);
  await Promise.all(stale.map((name) => removeFile(path.join(dir, name))));
}

/**
 * Removes every launch script and ref, of every version, and the temp file of a write that
 * died. Never rejects. Run after each registry save, holding the registry lock; a script it
 * could not remove is still ignored by the hook, whose profiles.json is no longer the file
 * the script was rendered from.
 */
export async function invalidateLaunchCache(clausonaDir: string): Promise<void> {
  const dir = launchCacheDir(clausonaDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.filter((name) => name.startsWith(LAUNCH_PREFIX)).map((name) => removeFile(path.join(dir, name))),
  );
}

/**
 * Removes one tool's launch scripts, in both formats, and its ref, for the version `paths`
 * belongs to. Never rejects. Needs no lock: a missing script is only ever a miss.
 */
export async function removeLaunchCache(paths: ShellInitPaths, tool: ToolName): Promise<void> {
  await Promise.all(
    [paths.cachePath(tool, "posix"), paths.cachePath(tool, "json"), paths.refPath(tool)].map(removeFile),
  );
}

/**
 * On Windows a scanner or a pending delete can refuse a delete for a moment, with EBUSY or
 * EPERM; rm retries those only when recursive, which a file never needs.
 */
async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
}

/**
 * The plugin sync is due only when something it reads has changed since it last ran. It
 * leaves this stamp behind, and the hook compares the stamp's mtime with the watch list's.
 */
export function pluginSyncStampPath(configDir: string): string {
  return path.join(configDir, "plugins", ".clausona-synced");
}

/**
 * What `syncPluginsJson(configDir, primary)` reads, as paths whose mtime changes when it
 * does:
 * - the profile's own known_marketplaces.json and installed_plugins.json;
 * - the primary's marketplaces directory, whose listing it reads;
 * - the primary's installed_plugins.json, which it reads when the profile has none;
 * - the primary's plugin cache, and `cacheDirs`: its marketplace and plugin directories as
 *   they were when the list was made (see pluginCacheWatchDirs). An installPath is
 *   `cache/<marketplace>/<plugin>/<version>`, and the sync drops an entry whose path is gone,
 *   so a version added or removed has to change the mtime of something watched - which is
 *   the plugin directory holding it, not `cache` itself.
 *
 * Not watched: anything deeper than a version directory, which does not decide whether an
 * installPath exists, and a marketplace or plugin directory created after the list was made
 * - its parent's mtime changes, so the sync is due, and a sync that changes anything drops
 * the launch cache so the next launch lists it. It also reads other profiles'
 * known_marketplaces.json, but only for a marketplace on disk that the profile's JSON lacks -
 * and that marketplace appearing is already a change to the listing. A path that does not
 * exist is never due.
 */
export function pluginSyncWatchList(configDir: string, primary: string, cacheDirs: readonly string[] = []): string[] {
  return [
    path.join(configDir, "plugins", "known_marketplaces.json"),
    path.join(configDir, "plugins", "installed_plugins.json"),
    path.join(primary, "plugins", "marketplaces"),
    path.join(primary, "plugins", "installed_plugins.json"),
    path.join(primary, "plugins", "cache"),
    ...cacheDirs,
  ];
}

/**
 * The primary's `plugins/cache/<marketplace>` and `plugins/cache/<marketplace>/<plugin>`
 * directories that exist now, for pluginSyncWatchList. Two readdirs deep, at `_launch` time
 * only; the hook then checks them with a builtin per path.
 */
export async function pluginCacheWatchDirs(primary: string): Promise<string[]> {
  const cache = path.join(primary, "plugins", "cache");
  const dirs: string[] = [];
  for (const marketplace of await readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = path.join(cache, marketplace.name);
    dirs.push(marketplaceDir);
    for (const plugin of await readdir(marketplaceDir, { withFileTypes: true }).catch(() => [])) {
      if (plugin.isDirectory()) dirs.push(path.join(marketplaceDir, plugin.name));
    }
  }
  return dirs;
}

const STAMP_NOTE =
  "Written by clausona each time it syncs this profile's plugin files. The shell hook compares\n" +
  "their times with this file's to tell whether they need syncing again.\n";

/**
 * Runs a plugin sync and stamps it - only if it succeeded. The sync swallows its own errors so
 * that it never stops a launch, and a stamp written over a failed one (a rename Windows
 * refused with EBUSY, say) would mark it done, and it would never be tried again until
 * something it watches changed.
 *
 * The stamp's time is taken before the sync reads anything: it is written aside first, as
 * `<stamp>.tmp-<pid>`, and renamed into place, which keeps that time, once the sync has
 * worked. A watched file that changes while the sync runs, or after it within the same tick
 * of a coarse clock - a whole second on bash 3.2 or some filesystems - is then at least as
 * new as the stamp, which the check counts as due. A stamp taken after the sync would have
 * counted it synced. It is written, not merely touched, so the kernel's clock gives it its
 * time, the clock the watched files' times come from. Never rejects.
 */
export async function syncWithStamp<T extends { ok: boolean }>(configDir: string, sync: () => Promise<T>): Promise<T> {
  const stampPath = pluginSyncStampPath(configDir);
  const pendingPath = `${stampPath}.tmp-${process.pid}`;
  const pending = await mkdir(path.dirname(stampPath), { recursive: true })
    .then(() => writeFile(pendingPath, STAMP_NOTE, "utf8"))
    .then(
      () => true,
      () => false,
    );
  const result = await sync();
  if (pending) {
    if (result.ok) await rename(pendingPath, stampPath).catch(() => removeFile(pendingPath));
    else await removeFile(pendingPath);
  }
  return result;
}

/**
 * The POSIX launch script's last line for claude: run the plugin sync when the stamp is
 * missing or anything it watches is at least as new as the stamp - "the stamp is not newer",
 * so a change in the same tick as the stamp counts as due (see syncWithStamp). A watched path
 * that does not exist is never due. It runs after the exports, so `_sync-plugins` finds the
 * profile's CLAUDE_CONFIG_DIR, as it always has.
 *
 * `[[ ... -nt ... ]]` is a builtin in both zsh and bash, so a fresh stamp costs no process at
 * all. Every path is single-quoted, so no `!` can reach a double-quoted string.
 */
export function renderPosixSyncCheck(configDir: string, primary: string, cacheDirs: readonly string[] = []): string {
  const stamp = posixQuote(pluginSyncStampPath(configDir));
  const due = pluginSyncWatchList(configDir, primary, cacheDirs).map((watched) => {
    const quoted = posixQuote(watched);
    return `( -e ${quoted} && ! ${stamp} -nt ${quoted} )`;
  });
  return `if [[ ! -e ${stamp} || ${due.join(" || ")} ]]; then clausona _sync-plugins 2>/dev/null; fi`;
}
