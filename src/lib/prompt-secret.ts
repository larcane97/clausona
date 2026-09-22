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
 * An escape sequence longer than this is not one this reader knows how to skip. It gives
 * up rather than guess, because guessing wrong means dropping part of a credential.
 */
const MAX_ESCAPE_LENGTH = 32;

const UNREADABLE_INPUT =
  'Could not read the key: this terminal sent something the prompt cannot interpret, and a key read from it might be incomplete. Pipe the key in instead: printf %s "$KEY" | clausona … , or point at it with --key-from env:NAME.';

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
 * - ESC before a printable character is an Alt-combo: two bytes, neither part of a key.
 * - ESC before a control character is a standalone Escape keypress. Only the ESC is
 *   dropped, so the character after it - an Enter, most importantly - is still acted on.
 *   Consuming that byte as part of a sequence is what would swallow the Enter and hang
 *   the prompt.
 */
function scanEscape(buffer: string): EscapeScan {
  if (buffer.length < 2) return "incomplete";
  const second = buffer[1];
  if (second !== "[" && second !== "O") {
    return { consumed: second < " " || second === "\u007f" ? 1 : 2, kind: "skip" };
  }
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
          if (sequence === "incomplete") return;
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
