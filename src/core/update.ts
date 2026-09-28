/**
 * Self-update: learning that a newer release exists, and replacing the installed bundle with it.
 *
 * The installers put the whole program in one file, `<appDir>/index.js`, and the launcher only
 * execs node on it, so an update is that one file swapped for the release's `clausona.js`. The
 * dashboard and `clausona update` share everything here. The network is a parameter, so no test
 * ever reaches GitHub.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { appDir } from "./paths.js";

export const RELEASES_URL = "https://github.com/larcane97/clausona/releases";

const CHECK_TIMEOUT_MS = 3_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type ParsedVersion = { core: [number, number, number]; pre: string[] };

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A release outranks every prerelease of itself: 0.3.0 > 0.3.0-beta.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    // Numeric identifiers rank below alphanumeric ones.
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver precedence of two versions, a leading `v` ignored; `null` when either does not parse. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/**
 * Whether `candidate` is a later version than `current`. Something that does not parse is never
 * later, so a malformed tag cannot turn into an offer.
 */
export function isNewer(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0;
}

/** `v0.3.1-beta` → `0.3.1-beta`: the form `__CLAUSONA_VERSION__` and `--version` use. */
export function versionOfTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/** The tag a `releases/latest` redirect points at, from its Location header - absolute or a path. */
export function tagFromLocation(location: string | null): string | null {
  if (!location) return null;
  let pathname: string;
  try {
    pathname = new URL(location, "https://github.com").pathname;
  } catch {
    return null;
  }
  const match = /\/releases\/tag\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * The latest release's tag, or `null` when it cannot be learned in time.
 *
 * `releases/latest` redirects to the release's tag page, so the Location header names the tag
 * without the REST API, whose unauthenticated limit of 60 requests an hour per IP a shared office
 * address runs through. `redirect: "manual"` makes Node's fetch hand back the 302 itself, headers
 * and all. Every failure is `null`: the dashboard then shows nothing, and the CLI says it could
 * not check.
 */
export async function checkLatestTag(options: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<string | null> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS } = options;
  try {
    const response = await fetchFn(`${RELEASES_URL}/latest`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) return null;
    return tagFromLocation(response.headers.get("location"));
  } catch {
    return null;
  }
}

/** A newer release, and where it would go: `target` is `null` for a bundle the installer did not put there. */
export type UpdateOffer = { current: string; latest: string; tag: string; target: string | null };

export async function findUpdate(options: {
  current: string;
  target: string | null;
  check?: () => Promise<string | null>;
}): Promise<UpdateOffer | null> {
  const tag = await (options.check ?? checkLatestTag)();
  if (!tag || !isNewer(tag, options.current)) return null;
  return { current: options.current, latest: versionOfTag(tag), tag, target: options.target };
}

/** The installer one-liner for the platform, as the README gives it. */
export function reinstallCommand(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `irm ${RELEASES_URL}/latest/download/install.ps1 | iex`
    : `curl -fsSL ${RELEASES_URL}/latest/download/install.sh | bash`;
}

/**
 * The installed bundle this process runs from, or `null` when the installer did not put it there.
 *
 * Only `<appDir>/index.js` is ever replaced. A bundle run from a checkout (`node dist/index.js`)
 * or copied elsewhere belongs to whoever put it there. The installed file must also be a regular
 * file: the installer writes one, and renaming over a symlink would replace the link, not what it
 * points at, undoing someone's setup. Both sides go through realpath, so a symlinked data
 * directory still matches, and Windows paths compare without case, as its filesystem does.
 */
export function installTarget(options: {
  entryPath: string | undefined;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string | null {
  const { entryPath, platform } = options;
  if (!entryPath) return null;
  const expected = (platform === "win32" ? path.win32 : path.posix).join(appDir(options), "index.js");
  try {
    if (!lstatSync(expected).isFile()) return null;
    const running = realpathSync(entryPath);
    const installed = realpathSync(expected);
    const same = platform === "win32" ? running.toLowerCase() === installed.toLowerCase() : running === installed;
    return same ? expected : null;
  } catch {
    return null;
  }
}

/** `installTarget` for this process: the launcher runs `node <appDir>/index.js`, so that is argv[1]. */
export function currentInstallTarget(): string | null {
  return installTarget({
    entryPath: process.argv[1],
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  });
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 10_000;
/** Pauses between renames on Windows, where a scanner still holding the new file fails one with EPERM or EBUSY. */
const RENAME_RETRY_DELAYS_MS = [100, 300, 1000] as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is required to match ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/g;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function download(fetchFn: FetchLike, url: string, what: string): Promise<Uint8Array> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Could not download ${what}: ${messageOf(error)}`);
  }
}

/** The digest in a `sha256sum` line: `<hex>  clausona.js`, or `<hex> *clausona.js` in binary mode. */
function digestIn(text: string): string | null {
  return /\b[0-9a-f]{64}\b/i.exec(text)?.[0].toLowerCase() ?? null;
}

/**
 * Runs the downloaded bundle once, as the launcher will, and requires it to report the version
 * that was offered. The checksum proves the bytes are the ones published; this proves they start
 * on this machine's node and are the release the user said yes to.
 */
function verifyCandidate(nodePath: string, candidate: string, version: string) {
  const result = spawnSync(nodePath, [candidate, "--version"], { encoding: "utf8", timeout: VERIFY_TIMEOUT_MS });
  if (result.error) throw new Error(`The downloaded v${version} did not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`The downloaded v${version} exited with ${result.status ?? result.signal} on --version.`);
  }
  const reported = /\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.stdout.replace(ANSI, ""))?.[1];
  if (reported !== version) {
    throw new Error(`The downloaded file reports ${reported ? `v${reported}` : "no version"}, not v${version}.`);
  }
}

/**
 * `rename`, retried on Windows while something holds the file. An antivirus scanner opening a
 * freshly written executable is the usual cause, and it lets go within a second.
 */
export async function replaceFile(
  from: string,
  to: string,
  options: {
    platform: NodeJS.Platform;
    delaysMs: readonly number[];
    rename?: (from: string, to: string) => Promise<void>;
  },
): Promise<void> {
  const renameFile = options.rename ?? rename;
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const held = options.platform === "win32" && (code === "EPERM" || code === "EBUSY");
      if (!held || attempt >= options.delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.delaysMs[attempt]));
    }
  }
}

/**
 * Replaces the installed bundle at `target` with release `tag`'s `clausona.js`, or throws and
 * leaves it exactly as it was.
 *
 * The download names the tag rather than `latest`, so a release published since the check cannot
 * swap in a version other than the one offered. The new file is written beside the old one, for
 * two reasons. The final rename then stays on one filesystem and is atomic: the shell hook runs
 * this program before every `claude` and `codex`, and it reads either the whole old file or the
 * whole new one. And the new file keeps a `.js` name, without which node refuses to run it
 * (ERR_UNKNOWN_FILE_EXTENSION).
 */
export async function performUpdate(options: {
  tag: string;
  target: string;
  fetch?: FetchLike;
  nodePath?: string;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const {
    tag,
    target,
    fetch: fetchFn = globalThis.fetch,
    nodePath = process.execPath,
    platform = process.platform,
  } = options;
  const version = versionOfTag(tag);
  const base = `${RELEASES_URL}/download/${encodeURIComponent(tag)}`;

  const bundle = await download(fetchFn, `${base}/clausona.js`, `clausona ${tag}`);
  // Required, not best-effort: the release that ships this updater is the first to publish one,
  // so every release an updater can be offered has it.
  const published = digestIn(
    new TextDecoder().decode(await download(fetchFn, `${base}/clausona.js.sha256`, `the checksum for ${tag}`)),
  );
  if (!published) throw new Error(`The checksum published for ${tag} is not a SHA-256 digest.`);
  if (createHash("sha256").update(bundle).digest("hex") !== published) {
    throw new Error(`The download of ${tag} does not match its published checksum.`);
  }

  const candidate = path.join(path.dirname(target), `index.update-${process.pid}.js`);
  try {
    await writeFile(candidate, bundle);
    verifyCandidate(nodePath, candidate, version);
    await replaceFile(candidate, target, { platform, delaysMs: RENAME_RETRY_DELAYS_MS });
  } catch (error) {
    await rm(candidate, { force: true }).catch(() => {});
    // A filesystem refusal (EACCES on a root-owned install, say) says which file it was about.
    if ((error as NodeJS.ErrnoException).code) throw new Error(`Could not replace ${target}: ${messageOf(error)}`);
    throw error;
  }
}

/** What the dashboard needs to offer an update. index.tsx hands it the real one; tests hand it a fake. */
export type Updater = {
  find: () => Promise<UpdateOffer | null>;
  install: (offer: UpdateOffer) => Promise<void>;
};

export function createUpdater(): Updater {
  const target = currentInstallTarget();
  return {
    find: () => findUpdate({ current: __CLAUSONA_VERSION__, target }),
    install: (offer) =>
      offer.target
        ? performUpdate({ tag: offer.tag, target: offer.target })
        : Promise.reject(new Error("This clausona was not installed by the installer, so it cannot replace itself.")),
  };
}
