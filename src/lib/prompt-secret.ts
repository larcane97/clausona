/**
 * Reads an API key without ever putting it on screen or on a command line.
 *
 * Two modes, chosen by whether stdin is a terminal:
 *
 * - **Not a terminal.** The key is read from stdin and the prompt is never printed. This
 *   is how a script or an agent supplies one: `printf %s "$KEY" | clausona add … --api`.
 * - **A terminal.** The key is typed, and nothing it contains reaches stdout. The
 *   terminal's own echo is what would otherwise print it - into the window and into the
 *   scrollback - so it is turned off for the duration with raw mode and restored on every
 *   way out, including an interrupt. `readline` cannot do this: with `terminal: true` it
 *   echoes every character, and with `terminal: false` it is not reading from a terminal
 *   at all.
 *
 * Raw mode also turns off the line discipline, so this reader is what handles Enter,
 * backspace, Ctrl-C and the escape sequences a terminal sends - including the brackets
 * around a paste, which is how most people put a key into a prompt.
 */

import { StringDecoder } from "node:string_decoder";

const ENTER = new Set(["\r", "\n"]);
/** Erase: what the Backspace key sends (DEL on most terminals, BS on some). */
const ERASE = new Set(["\u007f", "\u0008"]);
const CTRL_C = "\u0003";
/** End of input: on an empty line the shell's EOF, otherwise "I am done typing". */
const CTRL_D = "\u0004";
/** Kill line: clears what has been typed so far. */
const CTRL_U = "\u0015";
const ESC = "\u001b";

/**
 * Bracketed paste (DEC private mode 2004): what a terminal wraps pasted text in so that a
 * program can tell it apart from typing. Nothing in clausona turns the mode on, and the
 * shells disable it around a command, but it is left on by any program that set it and
 * exited without restoring it - so a paste can arrive bracketed, and pasting is how most
 * people put a key into a prompt.
 */
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/**
 * A CSI or SS3 sequence longer than this is not one this reader knows how to skip. It gives
 * up rather than guess, because guessing wrong means dropping part of a credential.
 */
const MAX_ESCAPE_LENGTH = 32;

/**
 * The same ceiling for a string-terminated sequence, and deliberately a far higher one: the
 * body of an OSC 52 clipboard reply is the clipboard, so length there is data rather than a
 * sign the reader has lost the thread. A terminator makes the measurement exact however long
 * the body runs; the cap only stops a terminator that never comes from buffering forever.
 */
const MAX_STRING_ESCAPE_LENGTH = 4096;

/** Ends a string sequence, alongside ST. Only OSC is terminated this way in practice. */
const BEL = "\u0007";
/** String terminator (ST), in its two-byte form - the only form a terminal sends here. */
const ST_FINAL = "\\";

/**
 * The introducers whose sequence is a *string*: OSC (`]`), DCS (`P`), SOS (`X`), PM (`^`)
 * and APC (`_`). Unlike a CSI they do not end at the first byte in `@`-`~` - their body is
 * arbitrary text and they run to a terminator - so measuring one as a CSI would cut it in
 * half and leave the rest in the key.
 */
const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);

const UNREADABLE_INPUT =
  'Could not read the key: this terminal sent something the prompt cannot interpret, and a key read from it might be incomplete. Pipe the key in instead: printf %s "$KEY" | clausona … , or point at it with --key-from env:NAME.';

const TRUNCATED_PASTE =
  'Could not read the key: the input ended in the middle of a paste, so only part of the key arrived. Nothing was saved. Try again, or pipe the key in: printf %s "$KEY" | clausona … .';

type EscapeScan =
  | { consumed: number; kind: "paste-start" | "paste-end" | "skip" }
  /** The sequence has not finished arriving; wait for the next read. */
  | "incomplete"
  /** Not a sequence this reader can measure, so where it ends is a guess. */
  | "runaway";

/**
 * Measures the escape sequence at the front of `buffer`, which starts with ESC.
 *
 * Measuring it is the whole point: the previous version abandoned the rest of the read at
 * the first ESC, so a bracketed paste took the key with it - and a paste split across two
 * reads left a *fragment*, which would then be stored and reported as success.
 *
 * - ESC `[` or ESC `O` begins a CSI or SS3 sequence, which runs to the first byte in the
 *   range `@`-`~`. That covers the arrow keys and both paste markers.
 * - ESC `]`, `P`, `X`, `^` or `_` begins a string sequence, which runs to a terminator
 *   instead. `ESC ] 0 ; title BEL` is what a shell sends to set the window title and it
 *   arrives unasked, so taking the one-byte skip below would leave `0;title` in the key.
 * - Any other ESC is a standalone Escape keypress, and only the ESC is dropped. The byte
 *   after it is real input and is acted on: an Enter still submits, and the first
 *   character of a key typed after a stray Escape is still part of the key. Taking that
 *   byte as the second half of an Alt-combo would lose one or the other, and nothing at
 *   this prompt is bound to Alt.
 */
function scanEscape(buffer: string): EscapeScan {
  if (buffer.length < 2) return "incomplete";
  const second = buffer[1];
  if (second === "[" || second === "O") {
    for (let i = 2; i < buffer.length; i++) {
      const code = buffer.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        const sequence = buffer.slice(0, i + 1);
        const kind = sequence === PASTE_START ? "paste-start" : sequence === PASTE_END ? "paste-end" : "skip";
        return { consumed: i + 1, kind };
      }
    }
    return buffer.length > MAX_ESCAPE_LENGTH ? "runaway" : "incomplete";
  }
  if (isStringEscape(buffer)) return scanStringEscape(buffer, second);
  return { consumed: 1, kind: "skip" };
}

/**
 * Measures a string sequence, which ends at a terminator rather than at a final byte.
 *
 * ST (`ESC \`) ends all five. BEL ends an OSC as well, because that is the form every shell
 * actually sends for a window title - and only an OSC, because a BEL inside a DCS body
 * would then cut the sequence short and spill its tail into the key. Refusing to measure a
 * BEL-terminated DCS costs a refusal; mis-measuring one costs a credential.
 */
/** Whether `buffer`, which starts with ESC, is the front of a string sequence. */
function isStringEscape(buffer: string): boolean {
  const second = buffer[1];
  return second !== undefined && STRING_INTRODUCERS.has(second);
}

function scanStringEscape(buffer: string, introducer: string): EscapeScan {
  for (let i = 2; i < buffer.length; i++) {
    if (introducer === "]" && buffer[i] === BEL) return { consumed: i + 1, kind: "skip" };
    if (buffer[i] === ESC && buffer[i + 1] === ST_FINAL) return { consumed: i + 2, kind: "skip" };
  }
  return buffer.length > MAX_STRING_ESCAPE_LENGTH ? "runaway" : "incomplete";
}

/**
 * What a chunk of terminal input adds to a secret being typed somewhere other than this
 * prompt - the TUI's key field, which reads the same terminal.
 *
 * It is here rather than there because the grammar above is the thing being reused: a
 * character filter alone appends `0;title` or `<0;10;5M` to the key the moment the terminal
 * reports something, and a corrupted credential is then stored and reported as success.
 *
 * **The caller must hand over the bytes the terminal sent, ESC included and untouched.**
 * Nothing below invents a byte it was not given. That is a contract rather than a detail:
 * ink's `useInput` strips one leading ESC and offers no flag saying it did, so through it a
 * typed `[` and a stripped `ESC [` are the same string - and a key with `O` in it is an
 * ordinary key. Reconstructing the ESC ate real key material; not reconstructing it
 * appended sequence bodies. The only way out is to read the raw stream, which is what
 * `promptSecret` below already does and what the TUI's key field does too.
 *
 * `pending` carries a sequence that has not finished arriving, so one split across two
 * reads is still measured as one. `pasting` says a paste's opening bracket arrived and its
 * closing one has not: whatever is in the field is the front of a key rather than the key,
 * which is the truncation this reader already refuses to return for its own prompt. A
 * caller with either of them still set at save time is holding a partial key.
 */
export type SecretInputState = {
  /** An unfinished escape sequence, ESC included. */
  pending: string;
  /** Between a paste's brackets. */
  pasting: boolean;
};

export const EMPTY_SECRET_INPUT: SecretInputState = Object.freeze({ pending: "", pasting: false });

export type SecretChunk = {
  state: SecretInputState;
  /** Characters to append to the secret. Never part of an escape sequence. */
  text: string;
  /**
   * Set when the input cannot be measured, so where the sequence ended is a guess and a
   * guess would take part of a credential with it. The caller says so and stores nothing;
   * the wording is the caller's, because the way out differs between a prompt and a form.
   */
  problem?: "unreadable";
};

export function readSecretChunk(state: SecretInputState, chunk: string): SecretChunk {
  let buffer = `${state.pending}${chunk}`;
  let pasting = state.pasting;
  let text = "";

  while (buffer.length > 0) {
    if (buffer[0] === ESC) {
      const sequence = scanEscape(buffer);
      // Still arriving: keep it whole and wait, which is how a paste keeps its second half.
      if (sequence === "incomplete") return { state: { pending: buffer, pasting }, text };
      if (sequence === "runaway") return { state: { ...EMPTY_SECRET_INPUT }, text: "", problem: "unreadable" };
      buffer = buffer.slice(sequence.consumed);
      if (sequence.kind === "paste-start") pasting = true;
      else if (sequence.kind === "paste-end") pasting = false;
      continue;
    }
    const char = buffer[0];
    buffer = buffer.slice(1);
    // Control characters are not part of a key, and some of them move the cursor if they
    // are written back out. A newline is one of them, bracketed or not: a key has none.
    if (char >= " " && char !== "\u007f") text += char;
  }
  return { state: { pending: "", pasting }, text };
}

export type SecretInputStream = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
};

export type SecretOutputStream = { write(chunk: string): unknown };

/** Thrown for Ctrl-C at the prompt, so the caller can report it as a cancellation. */
export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelledError";
  }
}

export type PromptStreams = { input?: SecretInputStream; output?: SecretOutputStream };

/**
 * The prompt itself. Returns the trimmed key, which may be empty - the caller decides
 * what an empty answer means, because "nothing was piped in" and "Enter was pressed at
 * the prompt" need different advice.
 */
export async function promptSecret(prompt: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  if (!input.isTTY) return readPipedSecret(input);
  return readTypedSecret(prompt, input, output);
}

/** Reads every byte stdin has. A pasted key usually arrives with the newline attached. */
async function readPipedSecret(input: SecretInputStream): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of input) {
    text += typeof chunk === "string" ? chunk : decoder.write(chunk);
  }
  return `${text}${decoder.end()}`.trim();
}

/**
 * Reads a typed key with the terminal's echo off.
 *
 * Nothing but the prompt and one closing newline is ever written to `output`: no
 * characters, and no placeholder stars either, since their count is itself a hint about
 * the key. Chunks go through a StringDecoder rather than `setEncoding`, which would change
 * the shared stdin for whatever runs after this.
 */
function readTypedSecret(prompt: string, input: SecretInputStream, output: SecretOutputStream): Promise<string> {
  if (typeof input.setRawMode !== "function") {
    // Without raw mode the terminal echoes what is typed, and printing the key is worse
    // than refusing to read it. There is another way in, so say what it is.
    throw new Error(
      'This terminal cannot turn off echo, so the key would be printed as you type it. Pipe it in instead: printf %s "$KEY" | clausona … , or use --key-from env:NAME.',
    );
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let typed = "";
    let settled = false;
    /** What has arrived and not been consumed: at most one unfinished escape sequence. */
    let buffer = "";
    /** Between a paste's brackets, where every byte is text rather than a keypress. */
    let pasting = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("error", onError);
      input.off("end", onEnd);
      // A terminal left in raw mode stops echoing the user's *next* command, so this runs
      // on every path out: Enter, EOF, an error, and Ctrl-C.
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // Nothing useful to do: the terminal is gone or was never one.
      }
      input.pause();
      settle();
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (buffer.length > 0 && !settled) {
        if (buffer[0] === ESC) {
          const sequence = scanEscape(buffer);
          // The sequence is still arriving: keep it whole and wait. A sequence split
          // across two reads is how a paste loses its second half otherwise.
          if (sequence === "incomplete") {
            // Except that a string sequence runs to a terminator and is allowed to be long,
            // so one that never terminates absorbs thousands of bytes - and raw mode makes
            // Ctrl-C one of those bytes rather than a signal. A prompt with no way out is
            // worse than mis-measuring a string whose body carries a raw 0x03, which is not
            // a thing a terminal sends. A CSI is capped at 32 bytes and needs no such door.
            if (isStringEscape(buffer) && buffer.includes(CTRL_C)) {
              finish(() => {
                output.write("\n");
                reject(new PromptCancelledError());
              });
            }
            return;
          }
          if (sequence === "runaway") {
            finish(() => {
              output.write("\n");
              reject(new Error(UNREADABLE_INPUT));
            });
            return;
          }
          buffer = buffer.slice(sequence.consumed);
          if (sequence.kind === "paste-start") pasting = true;
          else if (sequence.kind === "paste-end") pasting = false;
          continue;
        }

        const char = buffer[0];
        buffer = buffer.slice(1);

        // Ctrl-C is honoured even between the brackets. A paste whose closing marker never
        // arrives would otherwise leave the prompt with no way out at all, and a raw 0x03
        // byte inside a pasted API key is not a thing; being stuck is.
        if (char === CTRL_C) {
          finish(() => {
            output.write("\n");
            reject(new PromptCancelledError());
          });
          return;
        }

        if (pasting) {
          // Otherwise nothing between the brackets is a keypress - that is what bracketing
          // is for - so a newline in pasted text does not submit. Control characters are
          // not part of a key either way, so they are dropped.
          if (char >= " " && char !== "\u007f") typed += char;
          continue;
        }

        if (ENTER.has(char)) {
          finish(() => {
            output.write("\n");
            resolve(typed.trim());
          });
          return;
        }
        if (char === CTRL_D) {
          finish(() => {
            output.write("\n");
            resolve(typed.trim());
          });
          return;
        }
        if (ERASE.has(char)) {
          typed = typed.slice(0, -1);
          continue;
        }
        if (char === CTRL_U) {
          typed = "";
          continue;
        }
        // Every other control character: not part of a key, and some of them move the
        // cursor if written back out.
        if (char < " ") continue;
        typed += char;
      }
    };

    const onError = (error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    };

    const onEnd = () => {
      finish(() => {
        output.write("\n");
        // Input ran out between a paste's brackets: the terminal was still sending the
        // paste, so what arrived is the front of the key and not the key. Returning it
        // would be the silent truncation this reader exists to stop - a fragment stored
        // and reported as success, then a 401 that points at nothing.
        if (pasting) {
          reject(new Error(TRUNCATED_PASTE));
          return;
        }
        resolve(typed.trim());
      });
    };

    output.write(prompt);
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
    input.on("error", onError);
    input.on("end", onEnd);
  });
}
