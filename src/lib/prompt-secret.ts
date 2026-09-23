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
export const PASTE_START = `${ESC}[200~`;
export const PASTE_END = `${ESC}[201~`;

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
 *
 * Only the 7-bit forms. The 8-bit C1 introducers - DCS 0x90, SOS 0x98, OSC 0x9d, PM 0x9e,
 * APC 0x9f - cannot reach this grammar: both callers decode UTF-8, so a lone C1 byte
 * arrives as U+FFFD long before it gets here, and code for them would be code no input can
 * run.
 */
const STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);

/**
 * Whether a byte cannot be part of any sequence's body: a C0 control or DEL.
 *
 * Inside a body it means the ESC in front was a keypress rather than an introducer - ECMA-48's
 * rule, and the one ink's own parser applies to a CSI. No terminal puts a line break, a Ctrl-C
 * or a backspace inside a sequence it is sending; a person who pressed a stray Alt+[ or Alt+]
 * and went on typing does. A prompt with no way out is the failure this reader gives up a lot
 * to avoid, and in raw mode Ctrl-C, Ctrl-D and Enter are all bytes like any other - so it is
 * every control byte, rather than a list of the ones someone thought of.
 *
 * BEL is the one exception, and only inside a string: see `scanStringEscape`.
 */
function interruptsSequence(char: string): boolean {
  return char < " " || char === "\u007f";
}

/** What a sequence an interruption ended resolves as: the Escape keypress it turned out to be. */
const LONE_ESCAPE = { consumed: 1, kind: "skip" } as const;

const UNREADABLE_INPUT =
  'Could not read the key: this terminal sent something the prompt cannot interpret, and a key read from it might be incomplete. Pipe the key in instead: printf %s "$KEY" | clausona … , or point at it with --key-from env:NAME.';

const TRUNCATED_PASTE =
  'Could not read the key: the input ended in the middle of a paste, so only part of the key arrived. Nothing was saved. Try again, or pipe the key in: printf %s "$KEY" | clausona … .';

const LOST_PASTE_START =
  'Could not read the key: a paste ended whose start never arrived, so only part of the key did. Nothing was saved. Try again, or pipe the key in: printf %s "$KEY" | clausona … .';

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
 *
 * A sequence a keystroke interrupts resolves the same way as that last case, so an Alt+[
 * followed by an Enter is a `[` and an Enter, and a stray introducer can never swallow the
 * keys a person would press to get out.
 */
function scanEscape(buffer: string): EscapeScan {
  if (buffer.length < 2) return "incomplete";
  const second = buffer[1];
  if (second === "[" || second === "O") return scanControlSequence(buffer);
  if (second !== undefined && STRING_INTRODUCERS.has(second)) return scanStringEscape(buffer, second);
  return LONE_ESCAPE;
}

/**
 * Measures a CSI or SS3 sequence by ECMA-48's byte classes, as ink's parser does: parameter
 * and intermediate bytes (`0x20`-`0x3f`) continue it, a final byte (`@`-`~`) ends it, and
 * anything else - a control byte, DEL, another ESC, a character outside ASCII - interrupts it.
 *
 * The one irregular shape is ink's too: a second `[` straight after the first is part of the
 * sequence, not its end. The Linux console sends its function keys that way, `ESC [ [ A`,
 * and taking the `[` as the final byte left the `A` in the key.
 */
function scanControlSequence(buffer: string): EscapeScan {
  for (let i = 2; i < buffer.length; i++) {
    const code = buffer.charCodeAt(i);
    if (i === 2 && buffer[1] === "[" && code === 0x5b) continue;
    if (code >= 0x40 && code <= 0x7e) {
      const sequence = buffer.slice(0, i + 1);
      const kind = sequence === PASTE_START ? "paste-start" : sequence === PASTE_END ? "paste-end" : "skip";
      return { consumed: i + 1, kind };
    }
    if (code < 0x20 || code > 0x3f) return LONE_ESCAPE;
  }
  return buffer.length > MAX_ESCAPE_LENGTH ? "runaway" : "incomplete";
}

/**
 * Measures a string sequence, which ends at a terminator rather than at a final byte.
 *
 * ST (`ESC \`) ends all five. BEL ends an OSC as well, because that is the form every shell
 * actually sends for a window title - and only an OSC. Inside the other four a BEL is body:
 * letting it end them would cut a DCS short and spill its tail into the key, and taking it
 * as an interruption would spill the whole body. Refusing to measure a BEL-terminated DCS
 * costs a refusal; mis-measuring one costs a credential.
 *
 * Any other control byte, or an ESC that does not begin ST, interrupts the sequence and it
 * resolves as the lone Escape it was: only the ESC is dropped, and the introducer is the
 * first character of what was typed. That arm is the whole reason this function cannot
 * simply wait. Five of the bytes a key can begin with - `]`, `P`, `X`, `^`, `_` - are
 * introducers, and a key beginning with one of them, typed after a stray Escape, would
 * otherwise be swallowed into a payload whose end never comes: no answer, no refusal, and
 * nothing on screen to say why. An ESC with nothing after it yet may be ST's first half, so
 * that one waits.
 */
function scanStringEscape(buffer: string, introducer: string): EscapeScan {
  for (let i = 2; i < buffer.length; i++) {
    const char = buffer[i] ?? "";
    if (char === ESC) {
      if (i + 1 === buffer.length) break;
      return buffer[i + 1] === ST_FINAL ? { consumed: i + 2, kind: "skip" } : LONE_ESCAPE;
    }
    if (char === BEL) {
      if (introducer === "]") return { consumed: i + 1, kind: "skip" };
      continue;
    }
    if (interruptsSequence(char)) return LONE_ESCAPE;
  }
  return buffer.length > MAX_STRING_ESCAPE_LENGTH ? "runaway" : "incomplete";
}

/**
 * What a chunk of terminal input adds to a secret being typed: the one reader behind both this
 * prompt and the TUI's key field, which reads the same terminal.
 *
 * One reader, because the grammar above is the thing being reused: a character filter alone
 * appends `0;title` or `<0;10;5M` to the key the moment the terminal reports something, and a
 * corrupted credential is then stored and reported as success. And because the two callers
 * once drifted apart on the bytes that are keystrokes, not characters - the prompt acted on
 * an Enter, a Ctrl-U or a Backspace wherever it fell, and the key field dropped one that
 * arrived inside a run of text and appended what came after it.
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
 * chunks is still measured as one - which sequences can be split that way is what
 * `SecretChunkEdge` is about. `pasting` says a paste's opening bracket arrived and its
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
   * Set when what the caller holds cannot be trusted to be a key. The caller says so and
   * stores nothing; the wording is the caller's, because the way out differs between a
   * prompt and a form.
   *
   * - `"unreadable"`: input that cannot be measured, so where the sequence ended is a guess,
   *   and a guess would take part of a credential with it.
   * - `"lost-paste-start"`: a paste's closing bracket with no paste open. The terminal says a
   *   paste just ended, so its opening bracket - and the key's head with it - went somewhere
   *   this reader never saw, and the text before the bracket is the back of a key. Nothing in
   *   the chunk is kept, and the caller clears what it already took.
   */
  problem?: "unreadable" | "lost-paste-start";
  /**
   * Set when the reader stopped at a keystroke: `text` is everything before it, and `rest` is
   * everything after it, not yet read. The caller acts on the key and, if it is still reading,
   * hands `rest` back.
   */
  keystroke?: { key: SecretKeystroke; rest: string };
};

/**
 * A byte a person presses that is not a character of the key, and that a caller has to act on
 * where it falls: text before it and text after it can belong to different things.
 *
 * - `"enter"`: CR or LF.
 * - `"tab"`: Tab.
 * - `"erase"`: Backspace, sent as DEL by most terminals and as BS by some.
 * - `"clear"`: Ctrl-U, kill-line.
 * - `"interrupt"`: Ctrl-C. Raw mode makes it a byte, not a signal.
 * - `"end"`: Ctrl-D.
 *
 * Between a paste's brackets every byte is pasted data, not a keypress, so only an interrupt
 * is reported there: a paste whose end never comes would otherwise leave no way out. Pasted
 * control characters are dropped either way - a key has no whitespace in it.
 */
export type SecretKeystroke = "enter" | "tab" | "erase" | "clear" | "interrupt" | "end";

function keystrokeOf(char: string, pasting: boolean): SecretKeystroke | undefined {
  if (char === CTRL_C) return "interrupt";
  if (pasting) return undefined;
  if (ENTER.has(char)) return "enter";
  if (char === "\t") return "tab";
  if (ERASE.has(char)) return "erase";
  if (char === CTRL_U) return "clear";
  if (char === CTRL_D) return "end";
  return undefined;
}

/**
 * What the end of a chunk handed to `readSecretChunk` means, which the caller has to say
 * because the reader cannot tell.
 *
 * - `"read"`: only where a read from the terminal happened to stop - `promptSecret`'s reads.
 *   Nothing has measured the bytes, so a sequence cut off there is joined to the next chunk.
 * - `"event"`: the end of one of ink's input events. ink's parser measures every CSI and SS3
 *   before it emits anything, and holds one still arriving until a `setImmediate` passes
 *   with nothing more - so an event that is an unfinished `ESC [` or `ESC O`, or a bare ESC,
 *   is ink saying nothing followed. It was a keypress, Alt+[ or Alt+Shift+O or Escape, and it
 *   resolves here as one. Joining it to the next event instead is second-guessing a parse
 *   already done: Alt+Shift+O and a paste lost the paste's first character to it, taken as
 *   the SS3's final byte. The string family is not measured by ink at all - the introducer
 *   and the body arrive as separate events - so it is still joined across events, and so is
 *   anything inside a paste, where there are no keypresses and a flush boundary is only a
 *   slow read of the terminal's own end marker.
 *
 *   What this costs: a terminal report that does arrive split across two turns of the event
 *   loop - a laggy SSH link can do it - reaches the field as an unfinished CSI and then text,
 *   exactly what Alt+[ and typing look like, and its body goes into the key. Outside a paste,
 *   nothing at this layer can tell the two apart.
 */
export type SecretChunkEdge = "read" | "event";

export function readSecretChunk(state: SecretInputState, chunk: string, edge: SecretChunkEdge): SecretChunk {
  let buffer = `${state.pending}${chunk}`;
  let pasting = state.pasting;
  let text = "";

  while (buffer.length > 0) {
    if (buffer[0] === ESC) {
      let sequence = scanEscape(buffer);
      if (sequence === "incomplete") {
        // Still arriving: keep it whole and wait, which is how a paste keeps its second half.
        if (edge === "read" || pasting || isStringSequence(buffer))
          return { state: { pending: buffer, pasting }, text };
        sequence = LONE_ESCAPE;
      }
      if (sequence === "runaway") return { state: { ...EMPTY_SECRET_INPUT }, text: "", problem: "unreadable" };
      if (sequence.kind === "paste-end" && !pasting)
        return { state: { ...EMPTY_SECRET_INPUT }, text: "", problem: "lost-paste-start" };
      buffer = buffer.slice(sequence.consumed);
      if (sequence.kind === "paste-start") pasting = true;
      else if (sequence.kind === "paste-end") pasting = false;
      continue;
    }
    const char = buffer[0] ?? "";
    buffer = buffer.slice(1);
    const key = keystrokeOf(char, pasting);
    if (key) return { state: { pending: "", pasting }, text, keystroke: { key, rest: buffer } };
    // Every other control character is not part of a key, and some of them move the cursor if
    // they are written back out.
    if (char >= " " && char !== "\u007f") text += char;
  }
  return { state: { pending: "", pasting }, text };
}

function isStringSequence(buffer: string): boolean {
  return buffer[0] === ESC && STRING_INTRODUCERS.has(buffer[1] ?? "");
}

/**
 * What a field's half-read input comes to once nothing more is coming for it: the field has
 * been left.
 *
 * Leaving is an arrow, a tab or an Enter, and each of those interrupts a sequence still open
 * - so this resolves one exactly as that keystroke would have, as a lone Escape followed by
 * text. The caller needs it because the keystroke reaches two handlers, the reader and the
 * one that moves the cursor, and the outcome must not depend on which of them hears it first.
 *
 * An open paste is left as it is. Its bytes are data, not a sequence a keystroke interrupted,
 * and a caller holds the field while one is open and refuses to save one.
 */
export function settleSecretInput(state: SecretInputState): SecretChunk {
  if (state.pending === "" || state.pasting) return { state, text: "" };
  return readSecretChunk(EMPTY_SECRET_INPUT, state.pending.slice(1), "event");
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
    /** How far through a sequence or a paste the reader is: `readSecretChunk`'s state. */
    let reader: SecretInputState = { ...EMPTY_SECRET_INPUT };

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

    const refuse = (message: string) =>
      finish(() => {
        output.write("\n");
        reject(new Error(message));
      });

    // The grammar is `readSecretChunk`'s, with a read's end meaning only that the read stopped
    // there: a sequence cut off by it is joined to the next one. What is this prompt's own is
    // what each keystroke does here.
    const onData = (chunk: Buffer | string) => {
      let rest = typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (!settled) {
        const read = readSecretChunk(reader, rest, "read");
        reader = read.state;
        switch (read.problem) {
          case undefined:
            break;
          case "unreadable":
            refuse(UNREADABLE_INPUT);
            return;
          case "lost-paste-start":
            refuse(LOST_PASTE_START);
            return;
          default: {
            const unhandled: never = read.problem;
            throw new Error(`unhandled key input problem: ${JSON.stringify(unhandled)}`);
          }
        }
        typed += read.text;
        if (!read.keystroke) return;
        rest = read.keystroke.rest;
        switch (read.keystroke.key) {
          // Enter, or Ctrl-D: on an empty line the shell's EOF, otherwise "I am done typing".
          case "enter":
          case "end":
            finish(() => {
              output.write("\n");
              resolve(typed.trim());
            });
            return;
          // Honoured even between a paste's brackets. A paste whose closing marker never
          // arrives would otherwise leave the prompt with no way out at all, and a raw 0x03
          // byte inside a pasted API key is not a thing; being stuck is.
          case "interrupt":
            finish(() => {
              output.write("\n");
              reject(new PromptCancelledError());
            });
            return;
          case "erase":
            typed = typed.slice(0, -1);
            break;
          case "clear":
            typed = "";
            break;
          // Not part of a key, and nothing at this prompt is bound to it.
          case "tab":
            break;
          default: {
            const unhandled: never = read.keystroke.key;
            throw new Error(`unhandled keystroke: ${JSON.stringify(unhandled)}`);
          }
        }
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
        if (reader.pasting) {
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
