/**
 * Whether a string carries something shaped like an API key, anywhere in it.
 *
 * One check for every place a key must not go: the endpoint rule, which refuses a base URL
 * that would put a key into profiles.json in plain text; the options that store what they are
 * given - a model id, a label, the name of the variable a key is read from; and the API form,
 * which will not draw a key in a field that shows what it holds. It lives in core because the
 * endpoint rule does, and nothing here depends on anything but the string.
 *
 * "Anywhere" is the point. The name rule, `looksLikeCredential` below, asks whether a whole
 * value *starts* like a key, which is right for a name and misses the case that matters here:
 * input routed to the wrong field lands at the end of what was already there, and a key
 * appended to an endpoint is `https://gateway.example.comsk-ant-...` - a single hostname,
 * as far as a URL parser is concerned.
 *
 * Caught - the share in parentheses is measured over 20000 random keys of each shape:
 * - `sk-ant-`, `sk-or-` or `sk-proj-` followed by 16 key characters: Anthropic, OpenRouter
 *   and OpenAI project keys, whatever surrounds them (all).
 * - `sk-` or `sk_` followed by key characters that include a run of 16 or more letters and
 *   digits with both in it: OpenAI's other keys and DeepSeek's `sk-` over hex (all).
 * - `sk-` or `sk_` followed by 20 or more URL-safe base64 characters that mix upper and lower
 *   case and change case the way a random string does, not the way words do (see
 *   `looksUrlSafeRandom`): a LiteLLM virtual key, `sk-` and 22 of them (997 in 1000), a
 *   Stripe-style `sk_live_` (998 in 1000), a gateway's `sk_` and 43 of them (all over base62
 *   or hex; all but about 1 in 40000 over URL-safe base64).
 * - A vendor prefix followed by a body in that vendor's alphabet that mixes upper and lower
 *   case: Hugging Face `hf_` and `api_org_` (34 letters), Google `AIza` (35 URL-safe
 *   characters), Fireworks `fw_` at the start of a word, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/
 *   `ghr_`, Replicate `r8_` and Perplexity `pplx-` (all).
 * - With no prefix at all, a run of 32 or more letters and digits in both cases with digits
 *   spread through it: a base62 key body, which is what xAI and Groq keys are after their
 *   prefixes (all), a Mistral or Cohere key (97 and 99 in 100), and what is left of any of
 *   them when the prefix went somewhere else.
 *
 * Missed, and not fixable by looking harder at the string:
 * - a token with no prefix in hex or in one case - a self-hosted gateway's token is often
 *   exactly this, and so are an Azure OpenAI or Together key, a Cloudflare account id and a
 *   UUID, which must not be refused;
 * - a prefix-less base64 token, whose `+`, `/`, `-` and `_` cut it into runs shorter than 32
 *   (about half of them), and an AWS secret key (the same);
 * - a token shorter than the runs above, or cut by its own separators into pieces shorter
 *   than them - which includes a short key whose `sk-` is percent-encoded, since nothing is
 *   decoded first;
 * - a Fireworks key glued straight after a letter, since `nsfw_` is a word.
 *
 * And what it wrongly catches - none of 3431 real model ids and names, none of 11768
 * environment-variable names (the fixtures beside the test are drawn from both):
 * - a single unseparated run of 32 or more letters and digits in both cases with numbers
 *   through it - a mixed-case base62 project id in a path, a 36-character CamelCase label;
 * - `sk-` or `sk_` ending a word, followed by 16 letters and digits with both in it -
 *   `task-queue2025production01` in a path;
 * - one of the vendor prefixes above followed by a long unseparated run in both cases.
 * Nothing in the catalog of Claude Code settings looks like any of these.
 *
 * So this is a backstop, not the guard. In the form, what keeps a key out of the wrong field
 * is routing input by where the cursor is; this is what catches a key that got there anyway.
 */
export function carriesCredentialToken(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (VENDOR_KEY.test(value)) return true;
  for (const prefixed of PREFIXED_KEYS) {
    for (const match of value.matchAll(prefixed)) if (mixesCase(match[1] ?? "")) return true;
  }
  for (const match of value.matchAll(SK_KEY)) {
    const body = match[1] ?? "";
    if (runs(body, 16).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run))) return true;
    if (looksUrlSafeRandom(body)) return true;
  }
  return runs(value, 32).some(looksRandom);
}

/**
 * Whether a whole value *starts* like a key, for a slot that holds a name: a profile's name,
 * or what the URL parser took for a scheme. Two tests, because a prefix list dates: `sk-`,
 * which every Anthropic and OpenAI key starts with (`sk-ant-api03`, `sk-ant-api02`,
 * `sk-ant-admin`) and no name sensibly does, and a length ceiling, since a key is around a
 * hundred characters and a name a person types is not. Neither echoes what it refused.
 */
export function looksLikeCredential(value: string): boolean {
  return typeof value === "string" && (value.toLowerCase().startsWith("sk-") || value.length > MAX_NAME_LENGTH);
}

const MAX_NAME_LENGTH = 64;

const VENDOR_KEY = /sk-(?:ant|or|proj)-[A-Za-z0-9_-]{16}/;

/**
 * Prefixes no word or identifier uses, each with its vendor's alphabet and length; the body
 * is the first group. Written from the vendors' documented formats rather than the shapes
 * above, because a Hugging Face token is letters only and a Google key is URL-safe base64:
 * neither has the run of letters and digits the other rules look for.
 */
const PREFIXED_KEYS = [
  /hf_([A-Za-z]{30,})/g,
  /api_org_([A-Za-z]{30,})/g,
  /AIza([A-Za-z0-9_-]{35})/g,
  // `nsfw_` is how a model id says what it is for, so a letter before the prefix rules it out.
  /(?<![A-Za-z])fw_([A-Za-z0-9]{20,})/g,
  /gh[pousr]_([A-Za-z0-9]{36})/g,
  /r8_([A-Za-z0-9]{30,})/g,
  /pplx-([A-Za-z0-9]{40,})/g,
];

/** `sk-` or `sk_` and the key characters after it. */
const SK_KEY = /sk[-_]([A-Za-z0-9_-]+)/g;

/** The maximal runs of letters and digits in `value` at least `length` long. */
function runs(value: string, length: number): string[] {
  return value.match(new RegExp(`[A-Za-z0-9]{${length},}`, "g")) ?? [];
}

function mixesCase(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value);
}

/**
 * An `sk-` body in URL-safe base64, which its own `-` and `_` can cut below the run of 16
 * the rule above needs. Words follow `sk-` too - `task-`, `desk-`, `risk-`, `flask-` - and
 * what tells a key from them:
 * - it mixes case, where a hostname or a path is lowercase;
 * - its lowercase runs average under three letters, where CamelCase runs lowercase for a
 *   word at a time - or, cut into few pieces, it has a digit instead;
 * - it is cut rarely, where a name is cut between every word: one cut into more than three
 *   pieces, and more than one per six characters, needs the short runs and a piece of six.
 */
function looksUrlSafeRandom(body: string): boolean {
  if (body.length < 20 || !mixesCase(body)) return false;
  const lowercase = body.match(/[a-z]+/g) ?? [];
  const shuffled = lowercase.join("").length < 3 * lowercase.length;
  const pieces = body.split(/[-_]/);
  if (pieces.length > Math.max(3, body.length / 6)) return shuffled && pieces.some((piece) => piece.length >= 6);
  return shuffled || /\d/.test(body);
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
