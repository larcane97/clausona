import { Text, useInput, useStdin } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult } from "../types.js";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({
    accounts: [],
    profileNames: {},
    defaultProfile: "default",
  })),
}));

vi.mock("../lib/service", () => ({
  listProfiles: vi.fn(async () => [
    {
      name: "default",
      tool: "claude" as const,
      email: "default@example.com",
      configDir: "/Users/test/.claude",
      isPrimary: true,
      isActive: true,
      today: { cost: 1, inputTokens: 10, outputTokens: 5 },
      week: { cost: 1, inputTokens: 10, outputTokens: 5 },
      month: { cost: 1, inputTokens: 10, outputTokens: 5 },
      total: { cost: 1, inputTokens: 10, outputTokens: 5 },
    },
  ]),
  doctorProfiles: vi.fn(async () => [
    {
      name: "default",
      email: "default@example.com",
      configDir: "/Users/test/.claude",
      isPrimary: true,
      healthy: true,
      issues: [],
    },
  ]),
  fetchProfileQuotas: vi.fn(async () => ({})),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => []),
  addApiProfile: vi.fn(async () => ({ name: "gateway", configDir: "/Users/test/.claude-gateway" })),
}));

import { ADD_METHODS, App } from "./App.js";

/**
 * Waits for a frame that satisfies `check`, rather than for a fixed number of milliseconds.
 *
 * Every screen here paints from an async read, so a sleep is a guess at how long that
 * takes: too short and the suite flakes under load, too long and every test pays for it.
 * The timeout is a ceiling on failure, not the normal cost.
 */
async function waitForFrame(lastFrame: () => string | undefined, check: (frame: string) => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let frame = "";
  while (Date.now() < deadline) {
    frame = lastFrame() ?? "";
    if (check(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a matching frame; last was:\n${frame}`);
}

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";
const CURSOR = "✦";

type Instance = ReturnType<typeof render>;

/**
 * Presses a key and waits for the frame it produced.
 *
 * Not politeness: a handler reads the state of the render it was registered in, so two
 * keys pressed inside one tick are both answered from the state before either of them - a
 * person's keystrokes are separated by a repaint, and the test has to be too.
 */
async function press(instance: Instance, keys: string, timeout = 3000) {
  // One turn of the event loop before the key is sent. ink re-subscribes its input handler
  // in an effect, which runs after the frame has been written - so a key sent the instant a
  // frame appears is answered by the handler belonging to the frame before it, and a step
  // that has just been left swallows it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = instance.lastFrame();
  instance.stdin.write(keys);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (instance.lastFrame() !== before) return;
  }
  throw new Error(`pressing ${JSON.stringify(keys)} redrew nothing within ${timeout}ms`);
}

/**
 * Sends a key that is not expected to redraw anything.
 *
 * `press` insists on a redraw, which is what makes it safe everywhere else. The key field
 * is the one place where a keystroke deliberately changes nothing on screen - its mask is
 * a constant, so typing into a field that already holds something draws the same frame -
 * and a wait for a frame that is never coming cannot be a poll. What the keystroke did is
 * asserted where it is visible: in the value the save receives.
 */
async function type(instance: Instance, keys: string) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  instance.stdin.write(keys);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Sends `text` one character at a time.
 *
 * `press` and `type` write a whole string, which ink delivers as one input event - that is
 * a paste, not typing, and the two take different paths through the key field's reader.
 * This is the typing one.
 */
async function typeSlowly(instance: Instance, text: string) {
  for (const char of text) await type(instance, char);
}

/** Whether the cursor is on the row carrying `label`. */
function focusedOn(frame: string, label: string): boolean {
  return frame.split("\n").some((line) => line.includes(label) && line.includes(CURSOR));
}

/** Walks the cursor down to the row carrying `label`, so a test does not count keystrokes. */
async function moveTo(instance: Instance, label: string) {
  for (let step = 0; step < 40; step++) {
    if (focusedOn(instance.lastFrame() ?? "", label)) return;
    await press(instance, DOWN);
  }
  throw new Error(`the cursor never reached '${label}'`);
}

/** A key shape. No frame this suite renders may contain it. */
const KEY = "sk-ant-api03-not-a-real-key-0000000000000000";
/** The constant the key field shows instead. */
const MASK = "\u2022".repeat(8);

describe("App", () => {
  it("offers an API endpoint method", () => {
    expect(ADD_METHODS.map((method) => method.value)).toContain("api");
    expect(ADD_METHODS.find((method) => method.value === "api")?.label).toMatch(/API endpoint/i);
  });

  it("renders the dashboard header", async () => {
    const { lastFrame } = render(<App initialScreen="dashboard" />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("Dashboard"));

    expect(frame).toContain("clausona");
  });

  it("renders mixed claude+codex profiles without double-prefix (regression for T22)", async () => {
    const { listProfiles } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([
      {
        name: "claude:work",
        tool: "claude",
        email: "a@x",
        configDir: "/h/.claude-work",
        isPrimary: false,
        isActive: true,
        today: { cost: 0, inputTokens: 0, outputTokens: 0 },
        week: { cost: 0, inputTokens: 0, outputTokens: 0 },
        month: { cost: 0, inputTokens: 0, outputTokens: 0 },
        total: { cost: 0, inputTokens: 0, outputTokens: 0 },
      },
      {
        name: "codex:default",
        tool: "codex",
        email: "b@x",
        configDir: "/h/.codex",
        isPrimary: true,
        isActive: false,
        today: { cost: 0, inputTokens: 0, outputTokens: 0 },
        week: { cost: 0, inputTokens: 0, outputTokens: 0 },
        month: { cost: 0, inputTokens: 0, outputTokens: 0 },
        total: { cost: 0, inputTokens: 0, outputTokens: 0 },
      },
    ]);
    const { lastFrame } = render(<App initialScreen="use" />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("claude:work"));

    expect(frame).toContain("codex:default");
    expect(frame).not.toMatch(/claude:claude:/);
    expect(frame).not.toMatch(/codex:codex:/);
  });
});

/**
 * Registering an API profile from the dashboard, driven through the keys a person presses.
 *
 * The form's rules and the form's panel are asserted directly, in src/tui/api-form.test.ts
 * and src/tui/components/ApiForm.test.tsx. What is left for this file is the wiring that
 * only exists once the two are joined to the step machine: that the method reaches the
 * form, that the form reaches `addApiProfile` with what was typed, and that the key is in
 * none of the frames drawn along the way.
 */
describe("App add-profile: API endpoint", () => {
  /** Opens the add flow, picks the API method, and stops on the form. */
  async function openApiForm() {
    const instance = render(<App initialScreen="use" />);
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
    await press(instance, "a");
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
    await moveTo(instance, "API endpoint");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
    return instance;
  }

  /** Fills the four fields the form needs, leaving the cursor where the key was typed. */
  async function fillApiForm(instance: Instance) {
    await press(instance, "gateway");
    await moveTo(instance, "Endpoint");
    await press(instance, "https://gateway.example.com");
    await moveTo(instance, "API key");
    await press(instance, KEY);
    await waitForFrame(instance.lastFrame, (frame) => frame.includes(MASK));
  }

  it("registers the endpoint, and never draws the key in any frame along the way", async () => {
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockClear();
    const instance = await openApiForm();
    await fillApiForm(instance);

    await moveTo(instance, "Create profile");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("Added claude:gateway"));

    expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "claude",
        name: "gateway",
        baseUrl: "https://gateway.example.com",
        authScheme: "bearer",
        secret: { source: "keychain" },
        secretValue: KEY,
      }),
    );
    // Not just the last frame: every frame ink drew, which is what a person and their
    // scrollback actually saw.
    for (const frame of instance.frames) {
      expect(frame).not.toContain(KEY);
      expect(frame).not.toContain("sk-");
    }
    instance.unmount();
  });

  it("draws the same thing for a one-character key and a four-hundred-character one", async () => {
    // The panel cannot be handed a key any more - it takes a boolean - so the width
    // guarantee is asserted here, where the real key goes through the real state. Clearing
    // between the two is what makes both frames a redraw that can be waited for.
    const instance = await openApiForm();
    await moveTo(instance, "API key");

    await press(instance, "x");
    const short = await waitForFrame(instance.lastFrame, (f) => f.includes(MASK));
    await press(instance, "\u0015");
    await waitForFrame(instance.lastFrame, (f) => !f.includes(MASK));
    await press(instance, "y".repeat(400));
    const long = await waitForFrame(instance.lastFrame, (f) => f.includes(MASK));

    expect(long).toBe(short);
    instance.unmount();
  });

  it("takes the key's keystrokes itself - typing, erasing and clearing", async () => {
    // The key field has no text input behind it: a text input draws one glyph per
    // character it holds, which is the length this field must not show. So typing, erasing
    // and clearing are the step machine's own work, and are asserted rather than taken on
    // trust from a library. That the display does not grow with the key is asserted in
    // src/tui/components/ApiForm.test.tsx, where the frames can be compared exactly.
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockClear();
    const instance = await openApiForm();
    await press(instance, "gateway");
    await moveTo(instance, "Endpoint");
    await press(instance, "https://gateway.example.com");
    await moveTo(instance, "API key");

    await press(instance, "sk-wrong"); // empty -> set
    await waitForFrame(instance.lastFrame, (f) => f.includes(MASK));
    await press(instance, "\u0015"); // ctrl-u: set -> empty
    const cleared = await waitForFrame(instance.lastFrame, (f) => !f.includes(MASK));

    expect(cleared).toContain("type or paste the key");

    await press(instance, `${KEY.slice(0, 10)}`); // empty -> set again
    await waitForFrame(instance.lastFrame, (f) => f.includes(MASK));
    await typeSlowly(instance, `${KEY.slice(10)}x`); // one character at a time, no redraw
    await type(instance, "\u007f"); // erase the stray 'x' - and redraw nothing at all

    expect(instance.lastFrame()).toContain(MASK);

    await moveTo(instance, "Create profile");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

    // What the save receives is what accumulated here: the wrong key cleared, the right
    // one typed, the stray character erased.
    expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
    for (const drawn of instance.frames) expect(drawn).not.toContain(KEY);
    instance.unmount();
  });

  /**
   * What the terminal sends that nobody pressed.
   *
   * `useInput` strips exactly one leading ESC, so a sequence ink has no name for arrives as
   * its own printable body - and a filter that only drops control characters appends the
   * rest of it to the key. The user sees the same eight bullets either way, the save
   * succeeds, and the failure surfaces later as a 401 pointing at nothing. Each case is
   * asserted against what `addApiProfile` receives, because the screen deliberately shows
   * nothing that could be checked.
   */
  describe("terminal noise arriving mid-key", () => {
    async function keyAfter(send: (instance: Instance) => Promise<void>) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await send(instance);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("✘"));
      const call = vi.mocked(addApiProfile).mock.calls[0]?.[0];
      const frame = instance.lastFrame() ?? "";
      instance.unmount();
      return { secretValue: call?.secretValue, frame, called: vi.mocked(addApiProfile).mock.calls.length };
    }

    it.each([
      ["a focus-in report", "\u001b[I"],
      ["a focus-out report", "\u001b[O"],
      ["an SGR mouse report", "\u001b[<0;10;5M"],
      ["a cursor-position report", "\u001b[12;40R"],
    ])("keeps %s out of the key", async (_case, sequence) => {
      const { secretValue } = await keyAfter(async (instance) => {
        await type(instance, KEY.slice(0, 20));
        await type(instance, sequence);
        await type(instance, KEY.slice(20));
      });

      expect(secretValue).toBe(KEY);
    });

    it("keeps a bracketed paste's markers out of the key", async () => {
      // Nothing in clausona turns mode 2004 on and ink neither sets nor clears it, so
      // whether the brackets arrive is decided by whatever ran in this terminal before.
      const { secretValue } = await keyAfter(async (instance) => {
        await type(instance, `\u001b[200~${KEY}\u001b[201~`);
      });

      expect(secretValue).toBe(KEY);
    });

    it("keeps a paste whole when it is split across two reads", async () => {
      const { secretValue } = await keyAfter(async (instance) => {
        await type(instance, `\u001b[200~${KEY.slice(0, 20)}`);
        await type(instance, `${KEY.slice(20)}\u001b[201~`);
      });

      expect(secretValue).toBe(KEY);
    });

    it("holds the cursor on the key field while a paste is open, and says how to get out", async () => {
      // Between the brackets the terminal has said every byte is pasted data, so an arrow
      // is data too. Letting it navigate would detach the reader mid-paste and send the
      // rest of the key into the next field - which is a plain text field that draws what
      // it holds. Holding the cursor needs a way out, so the refusal says what it is.
      const instance = await openApiForm();
      await moveTo(instance, "API key");
      await type(instance, `\u001b[200~${KEY.slice(0, 5)}`);
      await press(instance, DOWN);
      const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("A paste started and never finished"));

      expect(focusedOn(frame, "API key")).toBe(true);
      instance.unmount();
    });

    it("lets the field be cleared and pasted again after an unfinished paste", async () => {
      // Otherwise a stray opening bracket would lock the form for the rest of the session.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await type(instance, `\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, DOWN);
      await waitForFrame(instance.lastFrame, (f) => f.includes("A paste started and never finished"));

      await press(instance, "\u0015");
      await waitForFrame(instance.lastFrame, (f) => !f.includes(MASK));
      await press(instance, KEY);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      instance.unmount();
    });

    it.each([
      ["an Enter", "\r"],
      ["a down arrow", "\u001b[B"],
      ["an up arrow", "\u001b[A"],
      ["a tab", "\t"],
    ])("keeps a paste on the key field when ink names some of its bytes %s", async (_case, keystroke) => {
      // ink's parser emits a run of text as one event and each escape sequence as its own,
      // so where a read happens to be split decides whether a byte inside a paste is named
      // `return` or is just a character. Nothing about a paste should depend on that.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");

      await type(instance, "\u001b[200~");
      await type(instance, KEY.slice(0, 10));
      await type(instance, keystroke);
      await type(instance, KEY.slice(10));
      await type(instance, "\u001b[201~");

      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      // The tail of a key drawn in the field the cursor moved to is the leak this prevents.
      for (const drawn of instance.frames) expect(drawn).not.toContain(KEY.slice(10));
      instance.unmount();
    });

    it("erases nothing when the field is already empty", async () => {
      const instance = await openApiForm();
      await moveTo(instance, "API key");
      await type(instance, "\u007f");
      await type(instance, "\u007f");

      expect(instance.lastFrame()).toContain("type or paste the key");
      expect(instance.lastFrame()).not.toContain(MASK);
      instance.unmount();
    });

    it("refuses to save when a sequence started and never finished", async () => {
      // An OSC introducer with no terminator: every byte after it is held back waiting for
      // the end of a sequence that never comes, so the field is not the key - it is empty
      // while the key sits unread. Storing on that is the same silent truncation as a
      // half-arrived paste.
      const { called, secretValue, frame } = await keyAfter(async (instance) => {
        await type(instance, `\u001b]0;${KEY}`);
      });

      expect(called).toBe(0);
      expect(secretValue).toBeUndefined();
      expect(frame).toContain("started a sequence and never finished");
    });

    it("lets the field be emptied with backspace after an unfinished paste", async () => {
      // ctrl-u already cleared both; backspacing to empty did not, so the form went on
      // refusing to save while the field read "not set" and there was nothing left to clear.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");

      await type(instance, `\u001b[200~${KEY.slice(0, 5)}`);
      for (let step = 0; step < 5; step++) await type(instance, "\u007f");
      expect(instance.lastFrame()).toContain("type or paste the key");

      await press(instance, KEY);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      instance.unmount();
    });
  });

  /**
   * The characters a key is made of, at the positions where a reader that guesses eats them.
   *
   * `[` and `O` are ordinary base64 characters and they are also the two bytes that follow
   * ESC in a CSI or SS3 sequence. Through ink's `useInput` the two are indistinguishable -
   * it strips one leading ESC and says nothing about having done it - so the field reads the
   * terminal's own bytes instead. Each row here is a key that a previous round stored wrong,
   * behind the same eight bullets and the same "Added".
   */
  describe("ordinary characters that look like the start of a sequence", () => {
    async function keyFrom(send: (instance: Instance) => Promise<void>) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await send(instance);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("✘"));
      const call = vi.mocked(addApiProfile).mock.calls[0]?.[0];
      instance.unmount();
      return call?.secretValue;
    }

    it.each([
      ["an O in the middle", "sk-OK-abcdef"],
      ["an O at the end", "sk-abcdefO"],
      ["a bracket in the middle", "sk-[AB]-abcdef"],
      ["a bracket at the end", "sk-abcdef["],
    ])("stores a key with %s exactly as it was typed", async (_case, text) => {
      expect(await keyFrom((instance) => typeSlowly(instance, text))).toBe(text);
    });

    it.each([
      ["O", `OAbCdEfGh-${KEY}`],
      ["a bracket", `[AbCdEfGh-${KEY}`],
    ])("stores a key pasted whole that starts with %s", async (_case, text) => {
      expect(await keyFrom((instance) => type(instance, text))).toBe(text);
    });

    it("appends a typed character once and only once", async () => {
      // Two readers were live at one point in this task's history - `useInput` and the
      // input events behind it - and two appends of the same keystroke look exactly like
      // one behind a constant mask. One character in, one character stored.
      expect(await keyFrom((instance) => type(instance, "x"))).toBe("x");
    });

    it("comes back to a reader with nothing half-read in it after an escape", async () => {
      // Esc leaves the form and clears the key, but the same Esc is also an input event, and
      // the field's listener is still subscribed when it arrives - so it can park that byte
      // in the reader on the way out. A key beginning with one of the five string-sequence
      // introducers is the one that would then be read as a payload rather than as a key.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const key = `Pk-${KEY.slice(3)}`;
      const instance = await openApiForm();
      await moveTo(instance, "API key");
      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));

      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await press(instance, key);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: key }));
      instance.unmount();
    });

    it("takes `a` and space as characters of the key, not as the form's shortcuts", async () => {
      // `a` unfolds Advanced on a row that is not a typing field, and space toggles the
      // auth scheme and the sessions switch on theirs. Both of those arms sit above the
      // key field's, so the only thing keeping them off this row is their own guards.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await typeSlowly(instance, "sk a b");

      expect(instance.lastFrame()).not.toContain("Context window");
      expect(instance.lastFrame()).toContain("bearer");

      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: "sk a b" }));
      instance.unmount();
    });
  });

  it("does not print the key when the save fails with a message carrying it", async () => {
    // The last branch where the key and an arbitrary string meet. Nothing under
    // `addApiProfile` puts a key into what it throws today; this is what keeps a change
    // down there from turning a failed save into a printed credential.
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockRejectedValueOnce(new Error(`could not store ${KEY} in the credential store`));
    const instance = await openApiForm();
    await fillApiForm(instance);

    await moveTo(instance, "Create profile");
    await press(instance, ENTER);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("could not store"));

    expect(frame).not.toContain(KEY);
    expect(frame).toContain("<redacted>");
    for (const drawn of instance.frames) expect(drawn).not.toContain(KEY);
    instance.unmount();
  });

  it("offers Anthropic's own endpoint the scheme it wants, and a gateway the other", async () => {
    // The same default `clausona add --api` applies, read from the same function, so the
    // two surfaces cannot come to disagree about the same URL.
    const instance = await openApiForm();
    await moveTo(instance, "Endpoint");
    await press(instance, "https://api.anthropic.com");
    const anthropic = await waitForFrame(instance.lastFrame, (frame) => frame.includes("api.anthropic.com"));

    expect(anthropic.split("\n").find((line) => line.includes("Auth"))).toContain("api-key");
    instance.unmount();
  });

  it("forgets the key when the form is left, and keeps the rest of what was typed", async () => {
    const instance = await openApiForm();
    await fillApiForm(instance);

    await press(instance, ESC);
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
    await moveTo(instance, "API endpoint");
    await press(instance, ENTER);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));

    // Coming back to a mask over a value that can no longer be read is a value nobody can
    // check; the field comes back empty on a form that is otherwise as it was left.
    expect(frame).not.toContain(MASK);
    expect(frame).toContain("not set");
    expect(frame).toContain("https://gateway.example.com");
    expect(frame).toContain("gateway");
    for (const drawn of instance.frames) expect(drawn).not.toContain(KEY);
    instance.unmount();
  });

  it("refuses a key typed into the name field, at the field, and does not repeat it", async () => {
    const instance = await openApiForm();

    await press(instance, KEY);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("looks like an API key"));
    const row = frame.split("\n").find((line) => line.includes("looks like an API key")) ?? "";

    // The field shows what was typed into it - it is a plain field and that is what a plain
    // field does. What must not happen is the message repeating it underneath, which is
    // what the CLI's own name check is careful about for the same reason.
    expect(row).not.toContain(KEY);

    // And it does not outlive the step: leaving the form takes a key-shaped name with it,
    // the same way it takes the key.
    await press(instance, ESC);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
    await moveTo(instance, "API endpoint");
    await press(instance, ENTER);
    const back = await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));

    expect(back).not.toContain(KEY);
    instance.unmount();
  });

  it("unfolds the advanced settings on `a`, and folds them again", async () => {
    const instance = await openApiForm();

    // `a` is a shortcut only where no input owns the keystroke, so the cursor first leaves
    // the name field: on a text field, `a` is the letter a.
    await moveTo(instance, "Auth");
    await press(instance, "a");
    await waitForFrame(instance.lastFrame, (frame) => frame.includes("Context window"));

    await press(instance, "a");
    await waitForFrame(instance.lastFrame, (frame) => !frame.includes("Context window"));
    instance.unmount();
  });

  it("types an `a` into a field rather than unfolding the section", async () => {
    const instance = await openApiForm();

    await press(instance, "alpha");
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("alpha"));

    expect(frame).not.toContain("Context window");
    instance.unmount();
  });

  it("says what is missing at the field rather than letting the service refuse it", async () => {
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockClear();
    const instance = await openApiForm();

    await moveTo(instance, "Create profile");
    await press(instance, ENTER);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("Enter a profile name."));

    expect(frame).toContain("Enter the endpoint's base URL.");
    expect(frame).toContain("Enter the API key");
    expect(vi.mocked(addApiProfile)).not.toHaveBeenCalled();
    instance.unmount();
  });
});

/**
 * The seam the key field reads from, pinned.
 *
 * `internal_eventEmitter` is what `useInput` is built on: ink's App parses a read into input
 * events and emits each one there *before* `parseKeypress` and the ESC strip that follows
 * it. So the emitter carries what the terminal sent and `useInput` does not - which is the
 * whole reason the key field reads the emitter.
 *
 * The name says `internal_`, and a future ink could change any of this. If it does, the key
 * field goes back to measuring sequences it can no longer see the start of, which is a
 * corrupted credential stored and reported as success. That is not a thing to find out about
 * in the field, so each property it depends on is asserted here against the real ink.
 */
describe("ink's input event seam", () => {
  function probe() {
    const events: string[] = [];
    const throughUseInput: string[] = [];
    function Probe() {
      const { internal_eventEmitter } = useStdin();
      useEffect(() => {
        const onInput = (input: string) => events.push(input);
        internal_eventEmitter.on("input", onInput);
        return () => {
          internal_eventEmitter.off("input", onInput);
        };
      }, [internal_eventEmitter]);
      useInput((input) => throughUseInput.push(input));
      return <Text>probe</Text>;
    }
    return { instance: render(<Probe />), events, throughUseInput };
  }

  /** ink flushes a lone Escape on a `setImmediate`, so a read is not answered synchronously. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("carries a control sequence whole, ESC included, where useInput has stripped it", async () => {
    const { instance, events, throughUseInput } = probe();
    await settle();
    instance.stdin.write("\u001b[I");
    await settle();

    expect(events).toEqual(["\u001b[I"]);
    // The strip that makes the emitter necessary: through `useInput` this focus report and
    // a key containing `[I` are the same three characters.
    expect(throughUseInput).toEqual(["[I"]);
    instance.unmount();
  });

  it("carries a lone Escape as exactly one character", async () => {
    // What tells a real Escape keypress apart from the front of a sequence. Ink holds an
    // unfinished one and only flushes the bare ESC when nothing followed it.
    const { instance, events } = probe();
    await settle();
    instance.stdin.write("\u001b");
    await settle();

    expect(events).toEqual(["\u001b"]);
    instance.unmount();
  });

  it("reassembles a sequence split across two reads", async () => {
    const { instance, events } = probe();
    await settle();
    instance.stdin.write("\u001b[");
    instance.stdin.write("12;40R");
    await settle();

    expect(events).toEqual(["\u001b[12;40R"]);
    instance.unmount();
  });

  it("splits text from the sequences around it, and leaves the text alone", async () => {
    const { instance, events } = probe();
    await settle();
    instance.stdin.write("sk-OK-abc\u001b[Bsk-[AB]");
    await settle();

    expect(events).toEqual(["sk-OK-abc", "\u001b[B", "sk-[AB]"]);
    instance.unmount();
  });

  it("hands the string family over as an introducer and a payload, which it does not measure", async () => {
    // ink recognises `[` and `O` only, so OSC, DCS, SOS, PM and APC arrive as a two-
    // character event and then ordinary text. Measuring them to their terminator is the
    // key field's own job, and this is the shape it has to join.
    const { instance, events } = probe();
    await settle();
    instance.stdin.write("\u001b]0;a title\u0007");
    await settle();

    expect(events).toEqual(["\u001b]", "0;a title\u0007"]);
    instance.unmount();
  });
});

/**
 * The doctor screen, for the two things the API-profile work changed there: the badge a
 * profile gets in the list, and the claim that every check passed.
 *
 * Text only. chalk is level 0 under a plain `vitest run`, so the frames here carry no ANSI
 * and a colour is not visible to an assertion in this file. It is assertable with
 * FORCE_COLOR set before the modules load, which src/tui/doctor-colour.test.tsx does; the
 * rule both surfaces read is pinned in src/lib/format.test.ts.
 */
describe("App doctor screen", () => {
  async function doctorFrame(issues: DoctorProfileResult["issues"]) {
    const { doctorProfiles } = await import("../lib/service.js");
    vi.mocked(doctorProfiles).mockResolvedValueOnce([
      {
        name: "claude:glm",
        email: "gpu-box",
        configDir: "/Users/test/.claude-glm",
        isPrimary: false,
        healthy: !issues.some((issue) => issue.severity !== "warning"),
        issues,
      },
    ]);
    const { lastFrame } = render(<App initialScreen="doctor" />);
    return waitForFrame(lastFrame, (frame) => frame.includes("claude:glm"));
  }

  it("badges a profile with nothing to report as healthy, and says every check passed", async () => {
    const frame = await doctorFrame([]);

    expect(frame).toContain("healthy");
    expect(frame).toContain("All checks passed");
  });

  it("badges a warnings-only profile with its warnings, and does not claim every check passed", async () => {
    // It is `healthy: true` - the profile works - but "healthy" in the badge would hide the
    // warning, and "All checks passed" directly above a list of findings is a contradiction.
    const frame = await doctorFrame([
      { kind: "shared_api_key_helper", message: "apiKeyHelper also runs here", severity: "warning" },
      { kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" },
    ]);

    expect(frame).toContain("2 warnings");
    expect(frame).not.toContain("All checks passed");
    expect(frame).toContain("apiKeyHelper also runs here");
  });

  it("badges a mixed profile with both counts", async () => {
    const frame = await doctorFrame([
      { kind: "missing_api_secret", message: "no stored key" },
      { kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" },
    ]);

    expect(frame).toContain("1 issue, 1 warning");
    expect(frame).not.toContain("All checks passed");
  });
});
