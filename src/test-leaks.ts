/**
 * The tests' one way of asking whether any part of a secret got out: the output matrix in
 * src/output-redaction.test.tsx, and every TUI frame through src/tui/test-frames.ts.
 *
 * Every `LEAK_WINDOW`-character window of the secret's random body is searched for.
 *
 * - Windows, not the whole secret and not its head: a display that shows the last five
 *   characters of a hidden value - "ends in …2e6f" - leaks as surely as one that shows it all,
 *   and a matrix that searched only the first eight passed the whole suite with exactly that
 *   printed (12b-I4).
 * - Five, because that is the usual length of such a hint, and a window any longer lets it by.
 * - The random body only. A key's public prefix is not the secret: `sk-ant-api03-` is the front
 *   of every Anthropic key, and the TUI's own text shares runs with it - `-api` is in the auth
 *   row's `x-api-key`, and a window of four found it on a screen with no key on it (round 4).
 *   Searching the body alone, the window can be as short as the hint it has to catch.
 *
 * Only for tests. Nothing in the app imports it.
 */
export const LEAK_WINDOW = 5;

/** What every key of a kind begins with, and so is not searched for. A fixture of another kind adds its own. */
const PUBLIC_PREFIXES = [/^sk-ant-[a-z]+\d*-/];

/** The secret without the public prefix of its kind, if it has one. */
export function randomBody(secret: string): string {
  for (const prefix of PUBLIC_PREFIXES) {
    const found = secret.match(prefix);
    if (found) return secret.slice(found[0].length);
  }
  return secret;
}

/**
 * Every window of `secret`'s random body found in any of `texts`, each compared after
 * `normalize` - which is how a caller searches text it has flattened (a frame without its
 * borders) or compacted (JSON without its punctuation). Empty is the only passing answer.
 */
export function leakedWindows(
  texts: readonly string[],
  secret: string,
  normalize: (text: string) => string = (text) => text,
): string[] {
  const haystacks = texts.map(normalize);
  const body = normalize(randomBody(secret));
  // A body with no window in it would pass every search, including one over the secret itself.
  if (body.length < LEAK_WINDOW) throw new Error(`a secret fixture needs a random body of ${LEAK_WINDOW} or more`);
  const found = new Set<string>();
  for (let start = 0; start + LEAK_WINDOW <= body.length; start++) {
    const window = body.slice(start, start + LEAK_WINDOW);
    if (haystacks.some((text) => text.includes(window))) found.add(window);
  }
  return [...found];
}
