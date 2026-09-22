import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { PromptCancelledError, promptSecret, type SecretInputStream } from "./prompt-secret.js";

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
