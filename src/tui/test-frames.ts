/**
 * The TUI tests' one way of asking whether a secret was ever on screen.
 *
 * Not `frame.includes(secret)`. That passes a frame which wraps the secret over two lines,
 * or cuts it at the panel's edge, or draws it between two borders - and each of those is the
 * secret on screen. Measured in review: a 107-character key drawn in the Model row wrapped,
 * 88 four-character slices of it were on screen, and a search for its whole tail found it in
 * no frame at all.
 *
 * So each frame is flattened first: ANSI styling, the box-drawing borders ink draws around a
 * panel, padding and line breaks all go, which puts a secret wrapped inside one panel back
 * into one run. Then every `WINDOW`-character window of the secret is searched for.
 *
 * Why eight. Shorter windows of a random key start to turn up in the TUI's own words - four
 * characters of base62 match ordinary text often enough to fail a suite that leaks nothing -
 * and eight characters of a key is a leak in itself. A key drawn beside another panel, where
 * flattening cannot rejoin it, is still found wherever eight of its characters sit together
 * on one line; what this can miss is a fragment of seven or fewer at a line's end.
 *
 * Only for tests. Nothing in the app imports it.
 */
export const WINDOW = 8;

/** ANSI SGR and cursor sequences, the box-drawing block (U+2500-U+257F), and whitespace of any kind. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is required to match ANSI escape sequences
const DRAWING = /\u001b\[[0-9;?]*[A-Za-z]|[─-╿]|\s/g;

export function flatten(frame: string): string {
  return frame.replace(DRAWING, "");
}

/** Every window of `secret` found in any frame. Empty is the only passing answer. */
export function windowsOnScreen(frames: readonly (string | undefined)[], secret: string): string[] {
  const flat = frames.map((frame) => flatten(frame ?? ""));
  const bare = flatten(secret);
  const found = new Set<string>();
  for (let start = 0; start + WINDOW <= bare.length; start++) {
    const window = bare.slice(start, start + WINDOW);
    if (flat.some((frame) => frame.includes(window))) found.add(window);
  }
  return [...found];
}
