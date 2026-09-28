/**
 * Self-update: learning that a newer release exists, and replacing the installed bundle with it.
 *
 * The installers put the whole program in one file, `<appDir>/index.js`, and the launcher only
 * execs node on it, so an update is that one file swapped for the release's `clausona.js`. The
 * dashboard and `clausona update` share everything here. The network is a parameter, so no test
 * ever reaches GitHub.
 */

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
