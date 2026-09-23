import { leakedWindows } from "../test-leaks.js";

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
 * into one run. Then the windows of the secret's random body are searched for, by the rule the
 * output matrix uses too - `leakedWindows` in src/test-leaks.ts, which says why five and why not
 * the key's public prefix. A key drawn beside another panel, where flattening cannot rejoin
 * it, is still found wherever five characters of its body sit together on one line.
 *
 * Only for tests. Nothing in the app imports it.
 */

/** ANSI SGR and cursor sequences, the box-drawing block (U+2500-U+257F), and whitespace of any kind. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is required to match ANSI escape sequences
const DRAWING = /\u001b\[[0-9;?]*[A-Za-z]|[─-╿]|\s/g;

export function flatten(frame: string): string {
  return frame.replace(DRAWING, "");
}

/** Every window of `secret` found in any frame. Empty is the only passing answer. */
export function windowsOnScreen(frames: readonly (string | undefined)[], secret: string): string[] {
  return leakedWindows(
    frames.map((frame) => frame ?? ""),
    secret,
    flatten,
  );
}
