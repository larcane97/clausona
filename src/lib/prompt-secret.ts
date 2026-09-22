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
 * backspace and Ctrl-C.
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
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const char of text) {
        // An arrow key or any other escape sequence arrives as one read starting with
        // ESC. Dropping the rest of that read keeps its letters ("[A") out of the key.
        if (char === ESC) return;
        if (ENTER.has(char)) {
          finish(() => {
            output.write("\n");
            resolve(typed.trim());
          });
          return;
        }
        if (char === CTRL_C) {
          finish(() => {
            output.write("\n");
            reject(new PromptCancelledError());
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
