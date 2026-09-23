/**
 * Whether a string carries something shaped like an API key, anywhere in it.
 *
 * One check for two jobs: the endpoint rule, which refuses a base URL that would put a key
 * into profiles.json in plain text, and the API form, which will not draw a key in a field
 * that shows what it holds. It lives in core because the first of those does, and nothing
 * here depends on anything but the string.
 *
 * "Anywhere" is the point. The name rule in profile-ref.ts asks whether a whole value
 * *starts* like a key, which is right for a name and misses the case that matters here:
 * input routed to the wrong field lands at the end of what was already there, and a key
 * appended to an endpoint is `https://gateway.example.comsk-ant-...` - a single hostname,
 * as far as a URL parser is concerned.
 *
 * Caught:
 * - `sk-ant-`, `sk-or-` or `sk-proj-` followed by 16 key characters: Anthropic, OpenRouter
 *   and OpenAI project keys, whatever surrounds them. Nothing else is spelled that way.
 * - `sk-` or `sk_` followed by key characters that include a run of 16 or more letters and
 *   digits with both in it: OpenAI, DeepSeek, LiteLLM and the many gateways that copied the
 *   `sk-` shape. The run is what separates a key from a word - `risk-management-v2` has
 *   `sk-` in it and no such run.
 * - With no prefix at all, a run of 32 or more letters and digits in both cases with digits
 *   spread through it: a base62 key body, which is what xAI, Groq, Google, Mistral and Hugging
 *   Face keys are after their prefixes, and what is left of any of them when the prefix went
 *   somewhere else.
 *
 * Missed, and not fixable by looking harder at the string:
 * - a token with no prefix in hex or in one case - a self-hosted gateway's token is often
 *   exactly this, and so is a Cloudflare account id or a UUID, which must not be refused;
 * - a token shorter than the runs above, or cut by its own separators into pieces shorter
 *   than them - which includes a short key whose `sk-` is percent-encoded, since nothing is
 *   decoded first.
 *
 * And what it would wrongly catch: a single unseparated run of 32 or more letters and digits
 * in both cases with numbers through it. No endpoint, model id or setting in the catalog
 * looks like that; one that did would be refused as a key.
 *
 * So this is a backstop, not the guard. In the form, what keeps a key out of the wrong field
 * is routing input by where the cursor is; this is what catches a key that got there anyway.
 */
export function carriesCredentialToken(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (VENDOR_KEY.test(value)) return true;
  for (const match of value.matchAll(SK_KEY)) {
    if (runs(match[1] ?? "", 16).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run))) return true;
  }
  return runs(value, 32).some(looksRandom);
}

const VENDOR_KEY = /sk-(?:ant|or|proj)-[A-Za-z0-9_-]{16}/;

/** `sk-` or `sk_` and the key characters after it. */
const SK_KEY = /sk[-_]([A-Za-z0-9_-]+)/g;

/** The maximal runs of letters and digits in `value` at least `length` long. */
function runs(value: string, length: number): string[] {
  return value.match(new RegExp(`[A-Za-z0-9]{${length},}`, "g")) ?? [];
}

/**
 * Both cases and digits, with the digits spread through the run rather than at its end: a
 * random body changes between letter and digit every few characters, and a name made of
 * words with a version number on the end does it once.
 */
function looksRandom(run: string): boolean {
  if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/\d/.test(run)) return false;
  let boundaries = 0;
  for (let i = 1; i < run.length; i++) {
    if (/\d/.test(run[i] ?? "") !== /\d/.test(run[i - 1] ?? "")) boundaries++;
  }
  return boundaries >= 3;
}
