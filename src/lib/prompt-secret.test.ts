import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  EMPTY_SECRET_INPUT,
  PromptCancelledError,
  promptSecret,
  readSecretChunk,
  type SecretInputState,
  type SecretInputStream,
  settleSecretInput,
} from "./prompt-secret.js";

/**
 * The property under test is the one a screenshot would show: nothing the user types
 * reaches the output. Every terminal test therefore asserts the *exact* bytes written,
 * not just the absence of the key - a partial echo, a row of stars, or a cursor move
 * would all fail here.
 *
 * The seam is the pair of streams: a Readable standing in for a terminal, with `isTTY`
 * and a `setRawMode` that records what it was asked for, so the restore can be checked
 * without a real terminal.
 */

const PROMPT = "API key: ";
const KEY = "sk-fake-9xQZ-0001";

function fakeTerminal(options: { rawMode?: boolean; canSetRawMode?: boolean } = {}) {
  const input = new Readable({ read() {} }) as SecretInputStream & Readable;
  input.isTTY = true;
  input.isRaw = options.rawMode ?? false;
  const rawModeCalls: boolean[] = [];
  if (options.canSetRawMode !== false) {
    input.setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
      input.isRaw = mode;
      return input;
    };
  }
  const written: string[] = [];
  return {
    input,
    output: {
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    },
    rawModeCalls,
    /** Everything the prompt printed, as one string. */
    screen: () => written.join(""),
    type: (text: string) => input.push(Buffer.from(text, "utf8")),
    close: () => input.push(null),
  };
}

/**
 * The answer, or "no answer" if the prompt is still waiting after `ms`.
 *
 * A prompt that never answers is one of the failures under test, and awaiting it directly
 * turns that into a five-second timeout with nothing to say about what happened.
 */
async function answerWithin(answer: Promise<string>, ms = 200): Promise<string> {
  const silence = new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), ms));
  return Promise.race([answer.catch((error: unknown) => `rejected: ${String(error)}`), silence]);
}

describe("promptSecret on a terminal", () => {
  it("prints the prompt, echoes not one character of the key, and returns it", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    for (const char of KEY) tty.type(char);
    tty.type("\r");

    await expect(answer).resolves.toBe(KEY);
    // The prompt and the newline that ends the line. Nothing else - no key, no stars.
    expect(tty.screen()).toBe(`${PROMPT}\n`);
    expect(tty.screen()).not.toContain(KEY);
  });

  it("takes the key as one pasted chunk, and still echoes nothing", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`${KEY}\n`);

    await expect(answer).resolves.toBe(KEY);
    expect(tty.screen()).toBe(`${PROMPT}\n`);
  });

  it("erases the last character on backspace", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("abX");
    tty.type("\u007f");
    tty.type("c\r");

    await expect(answer).resolves.toBe("abc");
    expect(tty.screen()).toBe(`${PROMPT}\n`);
  });

  it("clears the whole line on ctrl-u", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("wrong-key");
    tty.type("\u0015");
    tty.type(`${KEY}\r`);

    await expect(answer).resolves.toBe(KEY);
  });

  it("swallows an arrow key instead of reading its escape sequence as characters", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("ab");
    tty.type("\u001b[A");
    tty.type("c\r");

    await expect(answer).resolves.toBe("abc");
  });

  it("keeps the characters after an escape sequence in the same read", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    // The old reader abandoned the rest of the read at the first ESC, so everything
    // after the arrow key was lost - silently.
    tty.type(`ab\u001b[A${KEY}\r`);

    await expect(answer).resolves.toBe(`ab${KEY}`);
  });

  it("keeps the character typed after a lone Escape keypress", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    // Taking this as the second half of an Alt-combo would eat the key's first
    // character, and nothing at this prompt is bound to Alt.
    tty.type(`\u001b${KEY}\r`);

    await expect(answer).resolves.toBe(KEY);
  });

  it("acts on an Enter that follows a lone Escape keypress", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(KEY);
    // Consuming the byte after a lone ESC as part of a sequence would swallow this Enter
    // and leave the prompt waiting forever.
    tty.type("\u001b");
    tty.type("\r");

    await expect(answer).resolves.toBe(KEY);
  });

  it("gives up loudly on an escape sequence it cannot measure", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(KEY);
    // A CSI that never reaches its terminator: where it ends would be a guess, and
    // guessing wrong means returning part of a key as if it were the whole one.
    tty.type(`\u001b[${"0".repeat(64)}`);

    await expect(answer).rejects.toThrow(/cannot interpret/);
    expect(tty.screen()).toBe(`${PROMPT}\n`);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });
});

/**
 * Bracketed paste (DEC 2004). Each of the first three shapes is a way the previous reader
 * lost a key: the whole key, the key *and* the Enter, and - worst - a fragment of the key
 * that `addApiProfile` would have stored while printing "Added".
 */
describe("promptSecret and a pasted key", () => {
  it("takes a bracketed paste as the key", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b[200~${KEY}\u001b[201~`);
    tty.type("\r");

    await expect(answer).resolves.toBe(KEY);
    expect(tty.screen()).toBe(`${PROMPT}\n`);
  });

  it("takes a bracketed paste that arrives with its Enter", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b[200~${KEY}\u001b[201~\r`);

    await expect(answer).resolves.toBe(KEY);
  });

  it("joins a bracketed paste split across two reads", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b[200~${KEY.slice(0, 6)}`);
    tty.type(`${KEY.slice(6)}\u001b[201~\r`);

    // Not a fragment. A fragment here is stored and reported as a success.
    await expect(answer).resolves.toBe(KEY);
  });

  it("joins a paste whose marker itself is split across two reads", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("\u001b[20");
    tty.type(`0~${KEY}\u001b[201~\r`);

    await expect(answer).resolves.toBe(KEY);
  });

  it("takes the markers as separate reads, the shape that already worked", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("\u001b[200~");
    tty.type(KEY);
    tty.type("\u001b[201~");
    tty.type("\r");

    await expect(answer).resolves.toBe(KEY);
  });

  it("does not submit on a newline inside the brackets", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    // A key copied with its trailing newline. The newline is pasted text, not an Enter.
    tty.type(`\u001b[200~${KEY}\r\u001b[201~`);
    tty.type("more");
    tty.type("\r");

    await expect(answer).resolves.toBe(`${KEY}more`);
  });

  it("refuses a paste the input ends in the middle of, rather than returning its front", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b[200~${KEY.slice(0, 8)}`);
    tty.close();

    // The alternative is a fragment, stored and reported as `✔ Added`.
    await expect(answer).rejects.toThrow(/middle of a paste/);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("still lets ctrl-c out of a paste whose closing marker never arrives", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b[200~${KEY}`);
    tty.type("\u0003");

    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("keeps typing and pasting apart in one read", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`ab\u001b[200~${KEY}\u001b[201~cd\r`);

    await expect(answer).resolves.toBe(`ab${KEY}cd`);
  });

  it("drops the control characters a paste can carry", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("ab\u0007c\r");

    await expect(answer).resolves.toBe("abc");
  });

  it("puts the terminal back the way it found it", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`${KEY}\r`);
    await answer;

    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(tty.input.isRaw).toBe(false);
  });

  it("leaves raw mode on if that is how it found the terminal", async () => {
    const tty = fakeTerminal({ rawMode: true });

    const answer = promptSecret(PROMPT, tty);
    tty.type(`${KEY}\r`);
    await answer;

    expect(tty.rawModeCalls).toEqual([true, true]);
    expect(tty.input.isRaw).toBe(true);
  });

  it("restores the terminal on ctrl-c and reports the cancellation", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("half-typed");
    tty.type("\u0003");

    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(tty.input.isRaw).toBe(false);
    expect(tty.screen()).toBe(`${PROMPT}\n`);
  });

  it("ends on ctrl-d with whatever was typed", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(KEY);
    tty.type("\u0004");

    await expect(answer).resolves.toBe(KEY);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("ends when the terminal closes without an Enter", async () => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(KEY);
    tty.close();

    await expect(answer).resolves.toBe(KEY);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("refuses to read at all when echo cannot be turned off", async () => {
    const tty = fakeTerminal({ canSetRawMode: false });

    await expect(promptSecret(PROMPT, tty)).rejects.toThrow(/cannot turn off echo/);
    // Not even the prompt: nothing was read, so nothing was asked for.
    expect(tty.screen()).toBe("");
  });
});

describe("promptSecret off a terminal", () => {
  function pipe(chunks: (string | Buffer)[]) {
    const written: string[] = [];
    return {
      input: Readable.from(chunks) as SecretInputStream,
      output: {
        write(chunk: string) {
          written.push(chunk);
          return true;
        },
      },
      screen: () => written.join(""),
    };
  }

  it("reads a piped key and never prints the prompt", async () => {
    // `printf %s "$KEY" | clausona add … --api`, with the newline printf leaves off.
    const piped = pipe([Buffer.from(KEY, "utf8")]);

    await expect(promptSecret(PROMPT, piped)).resolves.toBe(KEY);
    expect(piped.screen()).toBe("");
  });

  it("drops the newline `echo` adds", async () => {
    const piped = pipe([Buffer.from(`${KEY}\n`, "utf8")]);

    await expect(promptSecret(PROMPT, piped)).resolves.toBe(KEY);
  });

  it("joins a key split across reads", async () => {
    const piped = pipe([Buffer.from("sk-fake-", "utf8"), Buffer.from("9xQZ-0001\n", "utf8")]);

    await expect(promptSecret(PROMPT, piped)).resolves.toBe(KEY);
  });

  it("returns nothing when nothing was piped in", async () => {
    const piped = pipe([]);

    await expect(promptSecret(PROMPT, piped)).resolves.toBe("");
    expect(piped.screen()).toBe("");
  });
});

/**
 * `readSecretChunk`, which is the same grammar applied to input that arrives somewhere
 * other than the reader above - the TUI's key field.
 *
 * Its contract is that it is handed the bytes the terminal sent, ESC included. That is the
 * whole lesson of this bug's two rounds: ink's `useInput` strips one leading ESC and hands
 * over no flag saying it did, so a typed `[` and a stripped `ESC [` are the same string.
 * The first round appended the sequence's body to the key; the second reconstructed the ESC
 * and ate real key material instead. There is no third guess, so the caller reads the raw
 * stream and this function never invents a byte it was not given.
 */
describe("readSecretChunk", () => {
  const KEY = "sk-ant-api03-not-a-real-key-0000000000000000";
  const read = (chunk: string, state: SecretInputState = EMPTY_SECRET_INPUT) => readSecretChunk(state, chunk, "read");

  /** What a person typing produces: one chunk per character, fed through the same state. */
  function typed(text: string) {
    let state: SecretInputState = EMPTY_SECRET_INPUT;
    let out = "";
    for (const char of text) {
      const chunk = readSecretChunk(state, char, "read");
      state = chunk.state;
      out += chunk.text;
    }
    return { text: out, state };
  }

  it("passes an ordinary key through untouched", () => {
    expect(read(KEY).text).toBe(KEY);
  });

  /**
   * The positions that are actually at risk: `[` and `O` are ordinary characters in a key,
   * and they are also the two bytes that follow ESC in a CSI or SS3 sequence. Anything that
   * treats them as a sequence without an ESC in front of them eats key material - silently,
   * behind a mask that is the same eight bullets either way.
   */
  const AT_RISK: [string, string][] = [
    ["an O in the middle of a typed key", "sk-OK-abcdef"],
    ["an O at the end of a typed key", "sk-abcdefO"],
    ["a bracket in the middle of a typed key", "sk-[AB]-abcdef"],
    ["a bracket at the end of a typed key", "sk-abcdef["],
  ];

  it.each(AT_RISK)("keeps %s, typed one character at a time", (_case, text) => {
    const result = typed(text);

    expect(result.text).toBe(text);
    // Nothing parked: every byte of a typed key is a byte of the key.
    expect(result.state).toEqual(EMPTY_SECRET_INPUT);
  });

  it.each([
    ["a key pasted whole that starts with O", `OAbCdEfGh-${KEY}`],
    ["a key pasted whole that starts with a bracket", `[AbCdEfGh-${KEY}`],
  ])("keeps %s", (_case, text) => {
    expect(read(text).text).toBe(text);
  });

  // Each of these fires without anyone pressing a key. A focus report arrives whenever the
  // window loses or regains focus - alt-tabbing to a password manager to copy the key does
  // it - and a mouse report whenever the pointer moves over the terminal.
  const REPORTS: [string, string][] = [
    ["a focus-in report", "\u001b[I"],
    ["a focus-out report", "\u001b[O"],
    ["an SGR mouse report", "\u001b[<0;10;5M"],
    ["an SGR mouse release", "\u001b[<0;10;5m"],
    ["a cursor-position report", "\u001b[12;40R"],
    ["a device-attributes reply", "\u001b[?1;2c"],
    ["an SS3 function key", "\u001bOP"],
  ];

  it.each(REPORTS)("drops %s that opens the chunk", (_case, sequence) => {
    expect(read(sequence).text).toBe("");
    expect(read(`${sequence}${KEY}`).text).toBe(KEY);
  });

  it.each(REPORTS)("drops %s that lands inside the chunk", (_case, sequence) => {
    expect(read(`sk-AAA${sequence}BBB`).text).toBe("sk-AAABBB");
  });

  it("drops a bracketed paste's markers and keeps what they wrap", () => {
    expect(read(`\u001b[200~${KEY}\u001b[201~`).text).toBe(KEY);
  });

  it("keeps a paste whole across two reads, marker and all", () => {
    const first = read(`\u001b[200~${KEY.slice(0, 20)}`);
    const second = readSecretChunk(first.state, `${KEY.slice(20)}\u001b[201~`, "read");

    expect(first.text + second.text).toBe(KEY);
    expect(second.state.pasting).toBe(false);
  });

  it("keeps a marker split down the middle whole", () => {
    // The worst split: the opening bracket itself arrives in two pieces.
    const first = read("\u001b[20");
    const second = readSecretChunk(first.state, `0~${KEY}\u001b[201~`, "read");

    expect(first.text).toBe("");
    expect(second.text).toBe(KEY);
  });

  it("says a paste is still open when its closing marker has not arrived", () => {
    // The caller refuses to save on this, rather than storing the front of a key.
    const open = read(`\u001b[200~${KEY.slice(0, 20)}`);

    expect(open.state.pasting).toBe(true);
    expect(open.text).toBe(KEY.slice(0, 20));
  });

  it("holds an unfinished sequence back rather than guessing where it ends", () => {
    const partial = read("\u001b[<0;10");

    expect(partial.text).toBe("");
    expect(partial.state.pending).toBe("\u001b[<0;10");
  });

  it("refuses input it cannot measure rather than appending part of it", () => {
    const runaway = read(`\u001b[${"9".repeat(40)}`);

    expect(runaway.problem).toBe("unreadable");
    expect(runaway.text).toBe("");
  });

  it("drops the control characters the prompt drops, newlines included", () => {
    expect(read(`sk-\u0000A\u001fB\rC\nD\u007fE`).text).toBe("sk-ABCDE");
  });
});

/**
 * The string-terminated sequences: OSC, DCS, SOS, PM and APC.
 *
 * They do not end at a final byte in `@`-`~` the way a CSI does - they run to a string
 * terminator - so measuring them as a one-byte skip leaves their whole body in the key.
 * `ESC ] 0 ; title BEL` is what a shell prompt sends to set the window title, and it
 * arrives whenever something repaints the title while the field has focus.
 */
describe("string-terminated escape sequences", () => {
  const KEY = "sk-ant-api03-not-a-real-key-0000000000000000";
  const read = (chunk: string, state: SecretInputState = EMPTY_SECRET_INPUT) => readSecretChunk(state, chunk, "read");

  const STRINGS: [string, string][] = [
    ["an OSC ended with BEL", "\u001b]0;a title\u0007"],
    ["an OSC ended with ST", "\u001b]0;a title\u001b\\"],
    ["an OSC 52 clipboard reply", "\u001b]52;c;c2stZmFrZQ==\u0007"],
    ["a DCS status reply", "\u001bP1$r0m\u001b\\"],
    ["an APC string", "\u001b_G i=1,a=T\u001b\\"],
    ["a PM string", "\u001b^something\u001b\\"],
    ["an SOS string", "\u001bXsomething\u001b\\"],
  ];

  it.each(STRINGS)("drops %s that lands in the middle of a key", (_case, sequence) => {
    expect(read(`sk-ant-api${sequence}03-rest`).text).toBe("sk-ant-api03-rest");
  });

  it.each(STRINGS)("drops %s at the prompt too", async (_case, sequence) => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`sk-ant-api${sequence}03-rest\r`);

    await expect(answer).resolves.toBe("sk-ant-api03-rest");
  });

  it("joins one split across two reads", () => {
    const first = read("\u001b]0;a ti");
    const second = readSecretChunk(first.state, `tle\u0007${KEY}`, "read");

    expect(first.text).toBe("");
    expect(second.text).toBe(KEY);
  });

  /**
   * The length cap is deliberately not the CSI one. An OSC 52 clipboard payload *is* the
   * body of the sequence, so a long one is data rather than a sign the reader has lost the
   * thread - measuring it by its terminator is exact however long it runs.
   */
  it("skips a string sequence far longer than a CSI is allowed to be", () => {
    const clipboard = `\u001b]52;c;${"c2stZmFrZQ".repeat(100)}\u0007`;

    expect(read(`${clipboard}${KEY}`).text).toBe(KEY);
  });

  /** There is still a ceiling, so a terminator that never comes cannot buffer forever. */
  it("refuses a string sequence whose terminator never arrives", () => {
    const runaway = read(`\u001b]52;c;${"c2stZmFrZQ".repeat(500)}`);

    expect(runaway.problem).toBe("unreadable");
    expect(runaway.text).toBe("");
  });

  /**
   * The five introducers are exactly where the lone-Escape contract changed meaning, and
   * the fixture key above begins with `s`, which proves nothing about them. A key beginning
   * with one of these bytes, typed after a stray Escape, must still be the key - not a
   * payload the reader waits forever for the end of.
   */
  const INTRODUCERS: [string, string][] = [
    ["OSC", "]"],
    ["DCS", "P"],
    ["SOS", "X"],
    ["PM", "^"],
    ["APC", "_"],
  ];

  it.each(INTRODUCERS)("keeps a key beginning with %s's introducer, typed after a lone Escape", async (_n, byte) => {
    const tty = fakeTerminal();
    const key = `${byte}k-fake-9xQZ-0001`;

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b${key}\r`);

    await expect(answer).resolves.toBe(key);
  });

  it.each(INTRODUCERS)("resolves %s's introducer across reads once the Enter arrives", (_n, byte) => {
    // How the same keystrokes reach the TUI: ink emits the ESC and the introducer as one
    // event and the rest as another, so the reader only learns this was never a sequence
    // when the line break turns up.
    const first = read(`\u001b${byte}`);
    const second = readSecretChunk(first.state, "k-fake-9xQZ-0001\r", "read");

    expect(first.text).toBe("");
    expect(second.text).toBe(`${byte}k-fake-9xQZ-0001`);
    expect(second.state.pending).toBe("");
  });

  it("still lets ctrl-c out of a string sequence whose terminator never arrives", async () => {
    // The cost of the ceiling above: until it is reached, an unterminated sequence absorbs
    // every byte after it - and raw mode makes Ctrl-C one of those bytes rather than a
    // signal. Four thousand characters of no way out is worse than mis-measuring a string
    // whose body carries a raw 0x03, which is not a thing a terminal sends.
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001b]0;${KEY}`);
    tty.type("\u0003");

    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
    expect(tty.rawModeCalls).toEqual([true, false]);
  });

  it("holds an unterminated string sequence back rather than guessing where it ends", () => {
    // A key typed after a stray OSC introducer is not lost, it is parked - and the caller
    // refuses to save a field with anything parked behind it.
    const partial = read(`\u001b]0;${KEY}`);

    expect(partial.text).toBe("");
    expect(partial.state.pending).toBe(`\u001b]0;${KEY}`);
  });
});

/**
 * A keystroke arriving inside a sequence's body.
 *
 * ECMA-48's rule, and the one ink's own parser applies to a CSI: a byte that cannot be part
 * of the body ends the sequence there, unfinished. No terminal puts a line break, a Ctrl-C or
 * a second ESC inside a sequence it is sending; a person who pressed Alt+[ or Alt+] and kept
 * typing does. So the ESC was a keypress - only it is dropped, what followed it is text, and
 * the interrupting byte is acted on exactly as it would be anywhere else.
 *
 * One exception, pinned below: a BEL. It ends an OSC, and inside the other four string types
 * it is body, not an interruption.
 */
describe("a keystroke inside a sequence", () => {
  const read = (chunk: string, state: SecretInputState = EMPTY_SECRET_INPUT) => readSecretChunk(state, chunk, "read");

  /** Each introducer, with a body it could legitimately have got as far as. */
  const OPEN: [string, string][] = [
    ["a CSI", "\u001b[12"],
    ["an SS3", "\u001bO"],
    ["an OSC", "\u001b]0;ab"],
    ["a DCS", "\u001bP1$r"],
    ["an SOS", "\u001bXab"],
    ["a PM", "\u001b^ab"],
    ["an APC", "\u001b_ab"],
  ];

  /** Every byte a person produces at a prompt that is not a character of the key. */
  const KEYSTROKES: [string, string][] = [
    ["an Enter", "\r"],
    ["a line feed", "\n"],
    ["a Ctrl-C", "\u0003"],
    ["a Ctrl-D", "\u0004"],
    ["a tab", "\t"],
    ["a Ctrl-U", "\u0015"],
    ["a backspace sent as BS", "\u0008"],
    ["a backspace sent as DEL", "\u007f"],
    ["an arrow key", "\u001b[B"],
  ];

  const CASES = OPEN.flatMap(([opened, prefix]) =>
    KEYSTROKES.map(([keystroke, byte]) => [opened, keystroke, prefix, byte] as const),
  );

  it.each(CASES)("ends %s at %s, and keeps what was typed after the ESC", (_opened, _keystroke, prefix, byte) => {
    const result = read(`${prefix}${byte}`);

    // The ESC goes; the introducer and whatever followed it were typed.
    expect(result.text).toBe(prefix.slice(1));
    expect(result.state).toEqual(EMPTY_SECRET_INPUT);
    expect(result.problem).toBeUndefined();
  });

  it("does not let a BEL end a DCS, so the rest of its body stays out of the key", () => {
    // A BEL ends an OSC because that is how every shell sets a window title. Letting it end
    // the other four would cut a DCS short at a stray BEL and spill the tail into the key;
    // taking it as an interruption would put the whole body there.
    expect(read("sk-ant-api\u001bP1$r\u0007tail\u001b\\03-rest").text).toBe("sk-ant-api03-rest");
  });

  it("measures a Linux console function key, ESC [ [ A, whole", () => {
    // ink keeps the second `[` as part of the sequence; taking it as the final byte instead
    // left the `A` in the key.
    expect(read("sk-AAA\u001b[[ABBB").text).toBe("sk-AAABBB");
  });

  it.each(OPEN)("lets ctrl-c out of %s at the prompt, and puts the terminal back", async (_opened, prefix) => {
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(prefix);
    tty.type("\u0003");

    expect(await answerWithin(answer)).toBe("rejected: PromptCancelledError: Cancelled.");
    expect(tty.rawModeCalls).toEqual([true, false]);
    expect(tty.screen()).toBe(`${PROMPT}\n`);
  });

  it("ends the prompt on ctrl-d after a stray DCS introducer", async () => {
    // Ctrl-D is the prompt's fourth way to finish, and a string body swallowed it.
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type(`\u001bP${KEY}`);
    tty.type("\u0004");

    expect(await answerWithin(answer)).toBe(`P${KEY}`);
  });

  it("answers an Enter pressed after a stray CSI introducer", async () => {
    // Nothing ends a CSI but a final byte, and a C0 is not one: this prompt waited for a
    // letter that was never coming.
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("\u001b[");
    tty.type("\r");

    expect(await answerWithin(answer)).toBe("[");
  });

  it("keeps a bracketed paste whole after a stray CSI introducer", async () => {
    // The paste's own ESC ends the stray one, so the paste is read as a paste - rather than
    // `[ESC[200~` being taken as one long CSI and `200~` put in front of the key.
    const tty = fakeTerminal();

    const answer = promptSecret(PROMPT, tty);
    tty.type("\u001b[");
    tty.type(`\u001b[200~${KEY}\u001b[201~\r`);

    expect(await answerWithin(answer)).toBe(`[${KEY}`);
  });
});

/**
 * The key field's input: one of ink's input events at a time, not raw reads.
 *
 * ink's parser measures every CSI and SS3 before it emits anything, and holds one that is
 * still arriving until a `setImmediate` passes with nothing more. So an event that is an
 * unfinished `ESC [` or `ESC O` is ink saying no more came: it was a keypress, Alt+[ or
 * Alt+Shift+O, and joining it to the next event is second-guessing a parse that has already
 * been done. The string family is different - ink does not measure it at all, and hands over
 * the introducer and the body as separate events - so that is still joined.
 */
describe("readSecretChunk on ink's input events", () => {
  const KEY = "sk-ant-api03-not-a-real-key-0000000000000000";

  function events(...chunks: string[]) {
    let state: SecretInputState = EMPTY_SECRET_INPUT;
    let text = "";
    let problem: string | undefined;
    for (const chunk of chunks) {
      const result = readSecretChunk(state, chunk, "event");
      state = result.state;
      text += result.text;
      problem ??= result.problem;
    }
    return { state, text, problem };
  }

  it.each([
    ["Alt+Shift+O, then a paste", ["\u001bO", KEY], `O${KEY}`],
    ["Alt+[, then a paste", ["\u001b[", KEY], `[${KEY}`],
    ["Alt+[, then a bracketed paste", ["\u001b[", "\u001b[200~", KEY, "\u001b[201~"], `[${KEY}`],
  ])("takes %s as the two keystrokes they were", (_case, chunks, expected) => {
    const result = events(...chunks);

    // What was typed, and all of the paste: the paste's first character is not eaten as the
    // final byte of a sequence ink had already given up on.
    expect(result.text).toBe(expected);
    expect(result.state).toEqual(EMPTY_SECRET_INPUT);
  });

  it("types a CSI ink flushed early into the key - the residual this rule costs", () => {
    // A terminal reply split across two turns of the event loop - a laggy SSH link - reaches
    // the field as an unfinished CSI and then text, which is indistinguishable from Alt+[
    // and typing. Pinned so that the cost of the rule is visible rather than discovered.
    expect(events("\u001b[", "12;40R", KEY).text).toBe(`[12;40R${KEY}`);
  });

  it("drops a lone Escape and parks nothing", () => {
    expect(events(KEY, "\u001b")).toEqual({ state: EMPTY_SECRET_INPUT, text: KEY, problem: undefined });
  });

  it("still joins a string sequence across events, which ink does not measure", () => {
    expect(events("\u001b]", "0;a title\u0007", KEY).text).toBe(KEY);
    expect(events("\u001bP", "1$r0m", "\u001b\\", KEY).text).toBe(KEY);
  });

  it("still joins a string terminator split after its ESC", () => {
    expect(events("\u001b]", "0;a title", "\u001b", "\\", KEY).text).toBe(KEY);
  });

  it.each([
    ["after its ESC", ["\u001b", "[201~"]],
    ["inside the CSI", ["\u001b[20", "1~"]],
  ])("closes a paste whose end marker ink flushed early, split %s", (_case, marker) => {
    // Between the brackets there are no keypresses, so a flush boundary there is only a slow
    // read: the terminal is still sending its own end marker.
    const result = events("\u001b[200~", KEY, ...marker);

    expect(result.text).toBe(KEY);
    expect(result.state).toEqual(EMPTY_SECRET_INPUT);
  });

  it("refuses an unfinished CSI too long for any keypress", () => {
    expect(events(KEY.slice(0, 20), `\u001b[${"9".repeat(40)}`)).toEqual({
      state: EMPTY_SECRET_INPUT,
      text: KEY.slice(0, 20),
      problem: "unreadable",
    });
  });
});

/**
 * What a field's half-read input comes to when the field is left.
 *
 * Leaving the key field is an arrow, a tab or an Enter, and each of those interrupts a
 * sequence still open: whichever of the field's two input handlers runs first, the parked
 * bytes must come out the same.
 */
describe("settleSecretInput", () => {
  it("resolves a string sequence still waiting for its terminator as the lone Escape it was", () => {
    expect(settleSecretInput({ pending: "\u001b]0;abc", pasting: false })).toEqual({
      state: EMPTY_SECRET_INPUT,
      text: "]0;abc",
    });
  });

  it("resolves one whose last byte could have begun a terminator", () => {
    expect(settleSecretInput({ pending: "\u001bPabc\u001b", pasting: false }).text).toBe("Pabc");
  });

  it("gives the same text as the arrow key it stands in for", () => {
    const parked = readSecretChunk(EMPTY_SECRET_INPUT, "\u001b]0;abc", "event").state;

    expect(settleSecretInput(parked).text).toBe(readSecretChunk(parked, "\u001b[B", "event").text);
  });

  it("leaves an open paste to the caller, which refuses to save one", () => {
    const open = { pending: "\u001b[20", pasting: true };

    expect(settleSecretInput(open)).toEqual({ state: open, text: "" });
  });

  it("has nothing to say when nothing is parked", () => {
    expect(settleSecretInput(EMPTY_SECRET_INPUT)).toEqual({ state: EMPTY_SECRET_INPUT, text: "" });
  });
});
