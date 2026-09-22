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
