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
