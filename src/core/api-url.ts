import { carriesCredentialToken, looksLikeCredential } from "./credential-token.js";

/**
 * What is wrong with a base URL. Never the URL itself, and never anything taken from the
 * part of it that can hold a password: a caller cannot echo a credential by repeating what
 * it was told here. Two exceptions:
 * - `scheme`, which is whatever the parser took for the scheme: with no `//` the URL is
 *   opaque, and `admin:pw@host` parses with the username as its scheme. So a caller checks
 *   `hasBareUserinfo` before it names the scheme, and reports that shape as the credentials
 *   it is. A scheme that starts like a key is reported as `key-shaped` instead, and one that
 *   could not be a scheme's name - a token with a colon typed after it - is left undefined,
 *   for the caller to say there is no http(s) scheme without quoting anything;
 * - `parameter`, the name of a query parameter that carries a credential, as typed - which
 *   `isCredentialParameter` has judged to be one - and never its value.
 */
export type BaseUrlProblem =
  | { reason: "empty" }
  | { reason: "key-shaped" }
  | { reason: "unparseable" }
  | { reason: "scheme"; scheme: string | undefined }
  | { reason: "credentials" }
  | { reason: "key-parameter"; parameter: string };

/**
 * Query parameter names that carry a credential, compared without case and with `-` read as
 * `_`. A gateway that takes its key in the URL takes it under one of these, and the name says
 * more than the value's shape can: a short or hex key misses the shape check, and is no less
 * a key for it.
 *
 * The exact names, and any name with a credential word as one of its `_`-separated parts:
 * `x-api-key` (Anthropic's own header name), `client_secret`, `auth_token`, `api_token`,
 * `access_key`. A whole part, so `monkey` or `tokenizer` is not one. The cost is a few
 * ordinary names that have such a part - a pagination `page_token` or `next_token`, a
 * `key_id`, a `sort_key`, an `auth_type` - which `add` then refuses as a base URL's query,
 * where none of them is expected.
 */
const CREDENTIAL_PARAMETERS = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "secret",
  "password",
  "sig",
  "signature",
  "subscription_key",
]);

const CREDENTIAL_PARAMETER_WORD = /(^|_)(key|token|secret|password|passwd|sig|signature|auth|credential)s?(_|$)/;

function isCredentialParameter(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll("-", "_");
  return CREDENTIAL_PARAMETERS.has(normalized) || CREDENTIAL_PARAMETER_WORD.test(normalized);
}

/** What could be a URL scheme's name, and is short enough that a token is not one. */
const SCHEME_NAME = /^[a-z][a-z0-9+.-]{0,9}$/;

/**
 * The one definition of a base URL clausona will accept, shared by the command that stores
 * one and the check that reports on one already stored.
 *
 * It lives in core so both can use it: `src/lib` may import `src/core`, not the other way
 * round, and a second copy of these rules in the doctor drifted the moment one side was
 * hardened - a URL `add --api` refuses would have gone on being reported healthy.
 *
 * The rules: absolute, http or https, and carrying no userinfo, no query parameter named for a
 * credential, and nothing shaped like an API key - in the host, the path, the query or
 * anywhere else. A password or a key in the URL would be persisted to profiles.json and
 * exported in plain text with it, which is exactly what the key source exists to avoid; and a
 * query is where a gateway that takes its key as a parameter would have one. The key check
 * runs first, because a key pasted where the URL goes is better answered with where it
 * belongs than with "not a URL".
 */
export function checkBaseUrl(baseUrl: string): { ok: true; url: URL } | { ok: false; problem: BaseUrlProblem } {
  // A hand edit's `8000`. Typed as a string, and still checked: doctor and `config --base-url`
  // pass whatever is stored, and a throw here took the whole report down with it.
  if (typeof baseUrl !== "string") return { ok: false, problem: { reason: "unparseable" } };
  if (baseUrl.trim() === "") return { ok: false, problem: { reason: "empty" } };
  if (carriesCredentialToken(baseUrl)) return { ok: false, problem: { reason: "key-shaped" } };

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, problem: { reason: "unparseable" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // With no `//` the "scheme" is whatever came before the first colon, and `sk-…:…` is a
    // key with a colon after it - one too short for the check above, which is still a key's
    // beginning to quote back. What was typed is judged, since the parser lowercases it.
    if (looksLikeCredential(baseUrl.trim().split(":")[0] ?? "")) {
      return { ok: false, problem: { reason: "key-shaped" } };
    }
    // Named only when it could be a scheme's name: a letter, then letters, digits, `+`, `-` or
    // `.`, and short. A gateway token with no prefix misses the key check, and before a colon
    // it parses as a scheme too - lowercased, which for hex is still the whole token.
    const scheme = url.protocol.slice(0, -1);
    return { ok: false, problem: { reason: "scheme", scheme: SCHEME_NAME.test(scheme) ? scheme : undefined } };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: { reason: "credentials" } };
  }
  for (const parameter of url.searchParams.keys()) {
    if (isCredentialParameter(parameter)) {
      return { ok: false, problem: { reason: "key-parameter", parameter } };
    }
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

/**
 * Whether plain http to a host keeps the key on this machine: `localhost`, an IPv4 address in
 * 127.0.0.0/8, or `::1`. Takes a parsed URL's `hostname`, which the parser has already
 * lowercased and turned from any IPv4 spelling - `127.1`, `0x7f.0.0.1`, `2130706433` - into
 * four decimal parts, so the address is matched whole: `127.gw.example.com` is a name like
 * any other, and resolves wherever its owner points it.
 *
 * Here rather than beside the one note that uses it, because every route that can store an
 * http URL - `add`, `config`, the API form - has to agree on which ones cross the network.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** Whether a base URL sends the key across the network unencrypted: plain http, off this machine. */
export function sendsKeyInClear(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
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
 * it refuses. So is one carrying a key: `checkBaseUrl` refuses it on the way in, but one
 * stored before that - or by hand - can have the key in its host or path, the two parts
 * printed as they are, so there is no part of it to replace.
 */
export function redactBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string") return HIDDEN;
  if (baseUrl.trim() === "") return baseUrl;
  if (carriesCredentialToken(baseUrl)) return HIDDEN;
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
