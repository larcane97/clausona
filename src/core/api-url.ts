/**
 * What is wrong with a base URL. Never the URL itself, and never anything taken from the
 * part of it that can hold a password: a caller cannot echo a credential by repeating what
 * it was told here. `scheme` is safe - a URL scheme cannot contain userinfo.
 */
export type BaseUrlProblem =
  | { reason: "empty" }
  | { reason: "unparseable" }
  | { reason: "scheme"; scheme: string }
  | { reason: "credentials" };

/**
 * The one definition of a base URL clausona will accept, shared by the command that stores
 * one and the check that reports on one already stored.
 *
 * It lives in core so both can use it: `src/lib` may import `src/core`, not the other way
 * round, and a second copy of these rules in the doctor drifted the moment one side was
 * hardened - a URL `add --api` refuses would have gone on being reported healthy.
 *
 * The rules: absolute, http or https, and carrying no userinfo. A password in the URL would
 * be persisted to profiles.json and exported in plain text with it, which is exactly what
 * the key source exists to avoid.
 */
export function checkBaseUrl(baseUrl: string): { ok: true; url: URL } | { ok: false; problem: BaseUrlProblem } {
  if (baseUrl.trim() === "") return { ok: false, problem: { reason: "empty" } };

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, problem: { reason: "unparseable" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, problem: { reason: "scheme", scheme: url.protocol.slice(0, -1) } };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: { reason: "credentials" } };
  }
  return { ok: true, url };
}

/**
 * Whether an endpoint is Anthropic's own, which is what decides the auth scheme offered
 * by default: Anthropic's API reads the key from X-Api-Key, and everything else -
 * gateways, proxies, self-hosted servers - overwhelmingly takes a Bearer token.
 *
 * Matched on the hostname, exactly: `URL.host` carries the port, and a plain
 * `endsWith("anthropic.com")` would also accept `evilanthropic.com` - which would hand
 * that host a key in the header Anthropic's own API expects.
 *
 * Here rather than at one call site because both surfaces that offer a default need it,
 * and the second copy is how the two would come to disagree about the same URL.
 */
export function isAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

/** What stands in, on every output path, for anything clausona will not print. */
export const HIDDEN = "<hidden>";

/**
 * A parsed URL with the three parts that can carry a credential - userinfo, query and
 * fragment - replaced by HIDDEN. Returned as `original` when there is none of them, so an
 * ordinary URL reads exactly as it was typed rather than as the parser re-spells it.
 *
 * The query goes with the userinfo because it is where a gateway that takes its key as a
 * parameter has it, and neither is part of saying where a profile points - scheme, host and
 * path are.
 */
function withoutUrlSecrets(url: URL, original: string): string {
  const userinfo = url.username !== "" || url.password !== "";
  if (!userinfo && url.search === "" && url.hash === "") return original;
  const authority = url.host === "" ? "" : `//${userinfo ? `${HIDDEN}@` : ""}${url.host}`;
  return `${url.protocol}${authority}${url.pathname}${url.search ? `?${HIDDEN}` : ""}${url.hash ? `#${HIDDEN}` : ""}`;
}

/**
 * A base URL as clausona prints it, on every path but the one that hands it to the tool.
 *
 * One that does not parse is hidden whole: it cannot be taken apart, and it can still hold a
 * password - `//admin:pw@host` is one. The same reason `baseUrlProblem` never quotes a URL
 * it refuses.
 */
export function redactBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string") return HIDDEN;
  if (baseUrl.trim() === "") return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return HIDDEN;
  }
  if (url.host !== "") return withoutUrlSecrets(url, baseUrl);
  // No host: an opaque URL. `admin:pw@host` is one - the parser takes `admin` for the scheme
  // and reports no userinfo - so the scheme-less rule applies before anything else, and the
  // query and fragment are cut by hand, there being no host to rebuild around.
  const bare = baseUrl.replace(BARE_USERINFO, `$1${HIDDEN}@`);
  if (bare === baseUrl) return withoutUrlSecrets(url, baseUrl);
  return bare.replace(/\?[^#]*/, `?${HIDDEN}`).replace(/#[\s\S]*$/, `#${HIDDEN}`);
}

/**
 * Userinfo that no URL parser reads as userinfo: `user:pass@host`, `:pass@host`, after spaces
 * or a bare `//`, at the start of any line. The password runs to the last `@` before a space,
 * so a `/`, `?`, `#` or `@` inside it does not end it early and leave its tail behind. A
 * `scheme://` is not this form: EMBEDDED_USERINFO has it.
 */
const BARE_USERINFO = /^(\s*)(?:\/\/)?(?![a-z][a-z0-9+.-]*:\/\/)[^\s@/]*:[^\s]*@/gim;

/** `scheme://userinfo@` anywhere in a value - after other words, or on any line. */
const EMBEDDED_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s]*@/gi;

/**
 * Whether a base URL carries userinfo in the scheme-less form, which the parser reports as a
 * scheme instead. The caller that would name "the scheme" must not: it is a username, and a
 * token pasted there comes back lowercased as one.
 */
export function hasBareUserinfo(baseUrl: string): boolean {
  return new RegExp(BARE_USERINFO.source, "im").test(baseUrl);
}

/**
 * A value from a profile's env map, with any URL credential in it hidden. HTTPS_PROXY is the
 * usual carrier - `http://user:pass@proxy:8080` - and proxies take the scheme-less form too.
 * A URL is looked for anywhere in the value, not only as the whole of it: after an option
 * name, or on a second line.
 *
 * Unlike `redactBaseUrl`, a value that is not a URL is left alone: most of the map is model
 * ids and numbers. A query is hidden only on a value that is a URL with a host, so one that
 * merely parses as a URL - an ARN, `foo:bar?x` - is not rewritten.
 */
export function redactUrlsIn(value: string): string {
  let shown = value;
  try {
    const url = new URL(value.trim());
    if (url.host !== "") shown = withoutUrlSecrets(url, value);
  } catch {
    // Not a URL as a whole; the embedded and scheme-less forms below are what is left.
  }
  return shown.replace(EMBEDDED_USERINFO, `$1${HIDDEN}@`).replace(BARE_USERINFO, `$1${HIDDEN}@`);
}
