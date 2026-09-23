import type { EventEmitter } from "node:events";

import { Text, useInput, useStdin } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, QuotaSnapshot } from "../types.js";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({
    accounts: [],
    profileNames: {},
    defaultProfile: "default",
  })),
}));

// The service's one pure rule the form applies itself, as it is: see `offeredAuthScheme`.
vi.mock("../lib/service", async (importOriginal) => ({
  defaultAuthScheme: (await importOriginal<typeof import("../lib/service.js")>()).defaultAuthScheme,
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
  loginProfile: vi.fn(),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => []),
  addApiProfile: vi.fn(async () => ({ name: "gateway", configDir: "/Users/test/.claude-gateway" })),
}));

import { fitModel } from "../lib/format.js";
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON } from "../lib/prompt-secret.js";

/**
 * These tests drive the whole App a keystroke at a time, and every step already fails on its own
 * at three seconds (`press`, `waitForFrame`) - so a hang still fails at the step that hung. What
 * five seconds per test did not survive was a machine at a load average of 55, where forty slow
 * but correct steps add up.
 */
vi.setConfig({ testTimeout: 15_000 });

import { ADD_METHODS, App } from "./App.js";
import {
  KEY_HAS_WHITESPACE,
  KEY_REQUIRED,
  LOST_PASTE_START,
  MISPLACED_KEY,
  PASTE_SKIPPED,
  UNFINISHED_PASTE,
  UNREADABLE_KEY_INPUT,
} from "./api-form.js";
import {
  CURSOR,
  DOWN,
  ENTER,
  ESC,
  focusedOn,
  type Instance,
  moveTo,
  press,
  renderAt,
  sendBeforeEffects,
  type,
  typeSlowly,
  type WatchedInstance,
  waitForFrame,
} from "./test-drive.js";
import { windowsOnScreen } from "./test-frames.js";

/**
 * A key shape, random like a real one so that no five characters of its body turn up in the
 * TUI's own text. No frame this suite renders may contain any five characters of its body.
 */
const KEY = "sk-ant-api03-fAkE7wvKpLmN8rTyUbHc5dFgA2sE9oIuWqXv3Bn6Mk1Lp8Rt";
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

  it("names the account a re-login landed on when it is not the registered one", async () => {
    const { listProfiles, loginProfile } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([WORK]).mockResolvedValueOnce([WORK]);
    vi.mocked(loginProfile).mockResolvedValueOnce({
      status: "other_account",
      signedInAs: "other@example.com",
      profile: { tool: "claude", configDir: WORK.configDir, email: WORK.email },
    });

    await withTerminalHandOver(async () => {
      const { lastFrame, stdin } = render(<App initialScreen="use" />);
      const frame = () => lastFrame() ?? "";
      await until(() => frame().includes("claude:work"));
      await pressUntil(stdin, "l", () => frame().includes(OVERLAY));
      await pressUntil(stdin, "y", () => !frame().includes(OVERLAY));
      await until(() => frame().includes("other@example.com"));

      // The row below always shows work@example.com, so check the message itself.
      expect(frame()).toContain("is signed in as other@example.com, not work@example.com");
      expect(frame()).not.toContain("Re-login completed");
    });
  });

  it("comes back from a re-login that fails, reloads, shows why, and takes input again", async () => {
    const { listProfiles, loginProfile } = await import("../lib/service.js");
    // A sign-in can fail after it has already changed the stored account, so the list is
    // reloaded either way; the second listing stands in for that changed state.
    vi.mocked(listProfiles)
      .mockResolvedValueOnce([WORK])
      .mockResolvedValueOnce([{ ...WORK, email: "reloaded@example.com" }]);
    vi.mocked(loginProfile).mockRejectedValueOnce(new Error("claude login failed."));

    await withTerminalHandOver(async () => {
      const { lastFrame, stdin } = render(<App initialScreen="use" />);
      const frame = () => lastFrame() ?? "";
      await until(() => frame().includes("claude:work"));
      await pressUntil(stdin, "l", () => frame().includes(OVERLAY));
      await pressUntil(stdin, "y", () => !frame().includes(OVERLAY));
      await until(() => frame().includes("claude login failed."));
      await until(() => frame().includes("reloaded@example.com"));

      await pressUntil(stdin, "l", () => frame().includes(OVERLAY));
    });
  });
});

/**
 * An API profile has no account email, so every line that names one goes through
 * `displayName` - its label - as `list`, `config --show` and the doctor already do.
 */
describe("App profile list, for an API profile", () => {
  const usage = { cost: 0, inputTokens: 0, outputTokens: 0 };
  const gateway = {
    name: "claude:gw",
    tool: "claude" as const,
    kind: "api" as const,
    email: "",
    label: "gpu-box",
    configDir: "/h/.claude-gw",
    isPrimary: false,
    isActive: true,
    today: usage,
    week: usage,
    month: usage,
    total: usage,
  };

  it("names it by its label", async () => {
    const { listProfiles } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([gateway]);

    const { lastFrame } = render(<App initialScreen="use" />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("claude:gw"));

    // The list draws the detail on the line under the name. Checked there, not anywhere in
    // the frame: the preview beside it already said "gpu-box" before this was fixed.
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes(`${CURSOR}  claude:gw`));
    expect(lines[row + 1]).toContain("gpu-box");
  });

  it("says which endpoint it switched to, not an empty ()", async () => {
    const { listProfiles } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([gateway]);
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const instance = render(<App initialScreen="use" />);
      await waitForFrame(instance.lastFrame, (f) => f.includes("claude:gw"));
      await type(instance, ENTER);
      const deadline = Date.now() + 3000;
      while (!written.join("").includes("Switched") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      write.mockRestore();
    }

    expect(written.join("")).toContain("Switched to claude:gw (gpu-box)");
  });

  it("keeps the preview's quota through a switch from the dashboard, and reads it again", async () => {
    // The reload after a switch replaced the list with one that carries no quota, and the fetch
    // was keyed on the profile set alone - unchanged by a switch - so the panel read "loading…"
    // until the TUI was restarted.
    const { fetchProfileQuotas } = await import("../lib/service.js");
    const quota: QuotaSnapshot = { state: "ok", fetchedAt: Date.now(), session: { usedPercent: 42, resetsAt: null } };
    vi.mocked(fetchProfileQuotas).mockImplementation(async () => ({ default: quota }));

    try {
      const instance = render(<App />);
      await waitForFrame(instance.lastFrame, (f) => f.includes("42%"));
      // The dashboard's first action opens the profile list; Enter there switches.
      await type(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Select a profile"));
      const fetchesBefore = vi.mocked(fetchProfileQuotas).mock.calls.length;
      await type(instance, ENTER);
      const { setActiveProfileByName } = await import("../lib/service.js");
      await waitForFrame(instance.lastFrame, () => vi.mocked(setActiveProfileByName).mock.calls.length > 0);
      expect(setActiveProfileByName).toHaveBeenCalledWith("default");
      const deadline = Date.now() + 3000;
      while (vi.mocked(fetchProfileQuotas).mock.calls.length === fetchesBefore && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(vi.mocked(fetchProfileQuotas).mock.calls.length).toBeGreaterThan(fetchesBefore);
      expect(instance.lastFrame()).toContain("42%");
      expect(instance.lastFrame()).not.toContain("loading");
      instance.unmount();
    } finally {
      vi.mocked(fetchProfileQuotas).mockImplementation(async () => ({}));
    }
  });

  /**
   * The preview's Model row is cut to the width its value has, from the middle so the end of
   * the id - which tells one model from another - stays. That width was estimated from the
   * terminal's, one way for two screens that lay the panel out differently: one column too many
   * below 80 columns, so ink cut the cut id again from the end (`o……`), and one too few at 100,
   * where the id fits. So the width a row has is read off the frame here - from where its value
   * starts to the panel's right border, less the padding - and the row must draw exactly what
   * `fitModel` makes of the id at that width.
   */
  describe("the preview's model row", () => {
    const MODEL = "openrouter/z-ai/glm-5.3";
    const routed = {
      ...gateway,
      api: {
        baseUrl: "https://openrouter.ai/api",
        authScheme: "bearer" as const,
        secret: { source: "keychain" as const },
      },
      env: { ANTHROPIC_MODEL: MODEL },
      model: MODEL,
    };
    /** Label column (12) and its gap (1); the panel's right padding (2). */
    const LABEL = 13;
    const PADDING = 2;

    it.each([
      ["use", 60],
      ["use", 79],
      ["use", 100],
      ["dashboard", 60],
      ["dashboard", 79],
      ["dashboard", 100],
    ] as const)("on the %s screen at %i columns draws the id cut to the row's width, and no further", async (screen, columns) => {
      const { listProfiles } = await import("../lib/service.js");
      vi.mocked(listProfiles).mockResolvedValueOnce([routed]);
      const instance = renderAt(<App initialScreen={screen} />, columns);

      const frame = await waitForFrame(instance.lastFrame, (f) => /Model {2,}\S/.test(f));
      const line = frame.split("\n").find((candidate) => /Model {2,}\S/.test(candidate)) ?? "";
      const start = line.indexOf("Model") + LABEL;
      const width = line.indexOf("│", start) - PADDING - start;
      const drawn = line.slice(start, start + width).trimEnd();
      instance.unmount();

      expect(drawn).toBe(fitModel(MODEL, width));
      if (columns === 100) expect(drawn).toBe(MODEL);
    });
  });

  /**
   * Re-login is an OAuth sign-in, and `loginProfile` refuses an API profile: offering it there
   * got a confirmation and then a refusal. The action is offered for the kind it can work for.
   */
  describe("the re-login action", () => {
    it("is offered for an account, and asks before signing in", async () => {
      const { listProfiles } = await import("../lib/service.js");
      vi.mocked(listProfiles).mockResolvedValueOnce([WORK]);
      const instance = render(<App initialScreen="use" />);

      const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("claude:work"));
      expect(frame).toContain("re-login");
      await press(instance, "l");
      await waitForFrame(instance.lastFrame, (f) => f.includes(OVERLAY));
    });

    it("is not offered for an API profile, and l asks nothing", async () => {
      const { listProfiles, loginProfile } = await import("../lib/service.js");
      vi.mocked(listProfiles).mockResolvedValueOnce([gateway]);
      vi.mocked(loginProfile).mockClear();
      const instance = render(<App initialScreen="use" />);

      const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("claude:gw"));
      expect(frame).not.toContain("re-login");
      await type(instance, "l");
      // The sessions action works for this profile, so its overlay says the `l` before it was
      // heard - and, had that opened the sign-in overlay, `s` would have gone to it instead.
      await press(instance, "s");
      await waitForFrame(instance.lastFrame, (f) => f.includes('Change sessions for "claude:gw"'));

      expect(instance.frames.some((f) => f.includes("Re-login"))).toBe(false);
      expect(vi.mocked(loginProfile)).not.toHaveBeenCalled();
    });
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
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
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
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
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
      const frame = await waitForFrame(instance.lastFrame, (f) => f.includes(UNFINISHED_PASTE));

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
      await waitForFrame(instance.lastFrame, (f) => f.includes(UNFINISHED_PASTE));

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
      ["a down arrow", "\u001b[B"],
      ["an up arrow", "\u001b[A"],
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
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it.each([
      ["an Enter", "\r"],
      ["a tab", "\t"],
    ])("keeps a paste on the key field when ink names %s in it, and refuses the key it is inside", async (_case, keystroke) => {
      // The cursor stays, as for an arrow; but a pasted Enter or tab is whitespace in the key
      // (Ruling 98), where an arrow's bytes are a sequence the reader drops.
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
      const held = instance.lastFrame() ?? "";

      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes(KEY_HAS_WHITESPACE));

      expect(focusedOn(held, "API key")).toBe(true);
      expect(vi.mocked(addApiProfile)).not.toHaveBeenCalled();
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
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

    it("shows a field holding parked bytes as holding something, and types them once a key ends them", async () => {
      // Alt+] is ESC ], an OSC introducer, and in this form it can only be a keystroke: a
      // real Escape leaves the form, and nothing here asks the terminal for a reply. What
      // follows it is parked - a real OSC's body arrives as an event of its own - so for a
      // moment the field holds bytes and no text. It used to say "type or paste the key"
      // over them, which invited a second paste on top. The arrow that leaves the field
      // interrupts the sequence, and it resolves as typed: `]` and then the paste, exactly
      // as a stray `]` would have.
      const { called, secretValue } = await keyAfter(async (instance) => {
        await type(instance, "\u001b]");
        await type(instance, KEY);

        expect(instance.lastFrame()).toContain(MASK);
        expect(instance.lastFrame()).not.toContain("type or paste the key");
      });

      expect(called).toBe(1);
      expect(secretValue).toBe(`]${KEY}`);
    });

    it.each([
      ["a string sequence", `\u001b]${"x".repeat(5000)}`],
      ["a CSI", `\u001b[${"9".repeat(40)}`],
    ])("clears the field, and saves nothing, when %s runs past what can be measured", async (_kind, runaway) => {
      // Where such a sequence ended is a guess, and the front of the key typed before it is
      // not the key. Without this arm the form stored those first twenty characters.
      const { called, frame } = await keyAfter(async (instance) => {
        await type(instance, KEY.slice(0, 20));
        await type(instance, runaway);
        const refused = await waitForFrame(instance.lastFrame, (f) => f.includes(UNREADABLE_KEY_INPUT));

        expect(refused).toContain("type or paste the key");
      });

      expect(called).toBe(0);
      expect(frame).toContain(KEY_REQUIRED);
    });

    it("clears the unfinished-paste message once the paste does finish", async () => {
      // The paste's trailing newline arrived as an event of its own, which the hold answers;
      // the closing bracket arrived after it, with no text of its own to clear the message.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");

      await type(instance, `\u001b[200~${KEY}`);
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes(UNFINISHED_PASTE));
      await press(instance, "\u001b[201~");

      expect(instance.lastFrame()).not.toContain(UNFINISHED_PASTE);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));
      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      instance.unmount();
    });

    it("holds an Esc while a paste is open, so an end marker split after its ESC does not leave the form", async () => {
      // ink flushes the ESC on its own when the rest of the marker is a read behind, and the
      // Esc keypress it looks like left the form and took the key with it.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");

      await type(instance, `\u001b[200~${KEY}`);
      await press(instance, ESC);
      const held = await waitForFrame(instance.lastFrame, (f) => f.includes(UNFINISHED_PASTE));

      expect(focusedOn(held, "API key")).toBe(true);
      await press(instance, "[201~");
      expect(instance.lastFrame()).not.toContain(UNFINISHED_PASTE);

      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));
      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      instance.unmount();
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

    it.each([
      ["Alt+Shift+O, then a paste", ["\u001bO", KEY], `O${KEY}`],
      ["Alt+[, then a bracketed paste", ["\u001b[", `\u001b[200~${KEY}\u001b[201~`], `[${KEY}`],
    ])("takes %s as the two keystrokes they were", async (_case, reads, expected) => {
      // ink holds the unfinished ESC O or ESC [ for a turn, then hands it over on its own:
      // a keypress. Joining it to the paste took the paste's first character as the SS3's
      // final byte, or put `200~` in front of the key.
      expect(
        await keyFrom(async (instance) => {
          for (const read of reads) await type(instance, read);
        }),
      ).toBe(expected);
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

      // Taken into the key, the spaces are what the save refuses (Ruling 98) - which is how it
      // shows they went there rather than to a shortcut.
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes(KEY_HAS_WHITESPACE));

      expect(vi.mocked(addApiProfile)).not.toHaveBeenCalled();
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

    expect(frame).toContain("<redacted>");
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
    instance.unmount();
  });

  /**
   * Ruling 88: input that arrives in the same read as a keystroke moving the cursor.
   *
   * ink emits every event of a read synchronously, and a field's handlers are re-subscribed
   * only after the render that follows - so the rest of a read reaches the handler of the
   * field the cursor is leaving. A person's keystrokes are separated by a repaint; a laggy
   * SSH link, a busy event loop or an auto-type tool delivers them together, which is what
   * `type` does with its whole argument. Each case below is a route that put a key in the
   * wrong field, and each asserts that no five characters of its body were ever on screen.
   */
  describe("input coalesced with a keystroke that moves the cursor", () => {
    async function filledTo(label: string) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, label);
      return instance;
    }

    async function submit(instance: Instance) {
      const { addApiProfile } = await import("../lib/service.js");
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("\u2718"));
      return vi.mocked(addApiProfile).mock.calls[0]?.[0];
    }

    const row = (instance: Instance, label: string) =>
      (instance.lastFrame() ?? "").split("\n").find((line) => line.includes(label)) ?? "";

    it("drops a paste that arrives with the arrows leaving the endpoint, rather than drawing it there", async () => {
      const instance = await filledTo("Endpoint");

      await type(instance, `${DOWN}${DOWN}${KEY}`);

      expect(focusedOn(instance.lastFrame() ?? "", "API key")).toBe(true);
      expect(row(instance, "Endpoint")).toContain("https://gateway.example.com ");
      // Dropped where the user can see it: the field it was meant for is still empty.
      expect(row(instance, "API key")).toContain("type or paste the key");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);

      // And a second paste, now that the field has the cursor, is the key - and the endpoint
      // is only the endpoint. This is where a key used to be stored as the base URL.
      await press(instance, KEY);
      const saved = await submit(instance);

      expect(saved).toEqual(expect.objectContaining({ baseUrl: "https://gateway.example.com", secretValue: KEY }));
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("drops a paste that arrives with the arrows leaving the name", async () => {
      const instance = await openApiForm();

      await type(instance, `${DOWN}${DOWN}${DOWN}${KEY}`);

      expect(focusedOn(instance.lastFrame() ?? "", "API key")).toBe(true);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("keeps typing after an arrow out of the key it follows, and out of the field it was aimed at", async () => {
      const instance = await filledTo("API key");

      await type(instance, `${KEY}${DOWN}glm-5`);

      expect(focusedOn(instance.lastFrame() ?? "", "Model")).toBe(true);
      expect(row(instance, "Model")).not.toContain("glm-5");
      const saved = await submit(instance);

      expect(saved?.secretValue).toBe(KEY);
      expect(saved?.env).toEqual({});
      instance.unmount();
    });

    it("keeps an erase that arrives with the arrow leaving the key field off the key", async () => {
      // The form's own keys act on the field under the cursor now, not on the one in the
      // handler's render: that one is still the key field for the rest of this read, and an
      // erase there took the key's last character with it.
      const instance = await filledTo("API key");
      await press(instance, KEY);

      await type(instance, `${DOWN}\u007f`);

      expect(focusedOn(instance.lastFrame() ?? "", "Model")).toBe(true);
      expect((await submit(instance))?.secretValue).toBe(KEY);
      instance.unmount();
    });

    it("keeps a paste that arrives with the Esc leaving the form out of the key it just cleared", async () => {
      const instance = await filledTo("API key");

      await type(instance, `${ESC}${ESC}${KEY}`);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));

      expect(instance.lastFrame()).not.toContain(MASK);
      expect(await submit(instance)).toBeUndefined();
      expect(instance.lastFrame()).toContain(KEY_REQUIRED);
      instance.unmount();
    });

    it("sends a paste that starts in the read that moved the cursor nowhere, not into the key", async () => {
      // The reviewer's one-read case, x + down + the front of a paste. It reached the key
      // field's reader after the cursor had left: the key became x plus the paste's front,
      // with a paste still open, and only the save's refusal stood between that and "Added".
      // Now the paste is not the key field's at all - it began after the cursor moved - so
      // the key is the x that was typed into it, and the paste went nowhere visible.
      const instance = await filledTo("API key");

      await type(instance, `x${DOWN}\u001b[200~${KEY.slice(0, 20)}`);

      expect(focusedOn(instance.lastFrame() ?? "", "Model")).toBe(true);
      const saved = await submit(instance);

      expect(saved?.secretValue).toBe("x");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("drops the rest of that paste too, wherever the cursor is when it arrives", async () => {
      // A paste is one thing. Its head went nowhere, and its tail arrives a read later, when
      // the cursor is on Model and Model's handler is listening: delivering it there put the
      // back half of a key in a row that draws what it holds. Twenty characters, so that it is
      // the paste's routing being tested here and not the token check, which would miss them.
      const instance = await filledTo("API key");

      await type(instance, `${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, KEY.slice(20, 40));
      await type(instance, "\u001b[201~");

      expect(focusedOn(instance.lastFrame() ?? "", "Model")).toBe(true);
      expect(row(instance, "Model")).not.toContain("[201~");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      expect(await submit(instance)).toBeUndefined();
      instance.unmount();
    });

    it("drops the rest of a paste that began with the arrow onto the key field, rather than keep its tail as the key", async () => {
      const instance = await filledTo("Auth");

      await type(instance, `${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, `${KEY.slice(20)}\u001b[201~`);

      expect(focusedOn(instance.lastFrame() ?? "", "API key")).toBe(true);
      expect(row(instance, "API key")).toContain("type or paste the key");
      expect(await submit(instance)).toBeUndefined();
      instance.unmount();
    });

    it("holds an Esc while a paste is being dropped, says how to get out, and leaves once an arrow has", async () => {
      // The Esc may be the front of the paste's own end marker, split from it by a slow read -
      // acting on it left the form. An arrow ends the drop, and then Esc is Esc again.
      const instance = await filledTo("Endpoint");
      await type(instance, `${DOWN}${DOWN}\u001b[200~${KEY.slice(0, 20)}`);

      await press(instance, ESC);
      const held = await waitForFrame(instance.lastFrame, (f) => f.includes(PASTE_SKIPPED));

      expect(focusedOn(held, "API key")).toBe(true);
      await press(instance, DOWN);
      expect(instance.lastFrame()).not.toContain(PASTE_SKIPPED);
      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));
      await press(instance, "-two");

      expect(row(instance, "Name")).toContain("gateway-two");
      instance.unmount();
    });

    it("lets a real keystroke end a dropped paste whose closing bracket never comes", async () => {
      // Otherwise every field would go on dropping what was typed into it.
      const instance = await filledTo("Endpoint");

      await type(instance, `${DOWN}${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, DOWN);
      await press(instance, "glm-5");

      expect(row(instance, "Model")).toContain("glm-5");
      instance.unmount();
    });
  });

  /**
   * Ruling 92: a read that lands between the commit that draws a frame and the effects that
   * frame subscribes in.
   *
   * React runs passive effects - `useEffect`, and every `useInput` subscription - a turn of the
   * event loop after the commit that drew the frame, and a read can arrive in that turn. Arrow
   * onto the key field and paste at once, on a busy machine, and the field's listener had not
   * been subscribed yet: the paste's head went nowhere, its tail was stored as the key, and the
   * form said "Added" over the same eight bullets. `sendBeforeEffects` lands a read in that turn
   * on purpose, every time, rather than waiting for a machine slow enough.
   */
  describe("input that arrives before a frame's effects have run", () => {
    async function formAt() {
      const instance = renderAt(<App initialScreen="use" />, 100);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      return instance;
    }

    async function filledTo(label: string) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await formAt();
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, label);
      return instance;
    }

    async function submit(instance: Instance) {
      const { addApiProfile } = await import("../lib/service.js");
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("✘"));
      return vi.mocked(addApiProfile).mock.calls[0]?.[0];
    }

    const row = (instance: Instance, label: string) =>
      (instance.lastFrame() ?? "").split("\n").find((line) => line.includes(label)) ?? "";

    it.each([
      ["a bracketed paste split over two reads", `\u001b[200~${KEY.slice(0, 20)}`, `${KEY.slice(20)}\u001b[201~`],
      ["an unbracketed paste split over two reads", KEY.slice(0, 20), KEY.slice(20)],
      ["a bracketed paste in one read", `\u001b[200~${KEY}\u001b[201~`, ""],
      ["an unbracketed paste in one read", KEY, ""],
    ])("takes all of %s that starts the moment the cursor is drawn on the key field", async (_case, head, tail) => {
      const instance = await filledTo("Auth");

      sendBeforeEffects(instance, (frame) => focusedOn(frame, "API key"), head);
      await press(instance, DOWN);
      if (tail !== "") await type(instance, tail);
      const saved = await submit(instance);

      expect(saved?.secretValue).toBe(KEY);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("subscribes the form's listener once a visit, whatever the cursor does, and lets go when the flow closes", async () => {
      // What keeps the gap above shut: nothing about the listener changes when the cursor
      // moves, so no cursor move can leave a turn in which it is missing. It is there from the
      // method step, whose Enter opens the form, so it hears that read too. It is found by its
      // name, so renaming it fails this test rather than letting it pass over nothing.
      const seam: { emitter?: EventEmitter } = {};
      function Seam() {
        seam.emitter = useStdin().internal_eventEmitter;
        return null;
      }
      const instance = renderAt(
        <>
          <App initialScreen="use" />
          <Seam />
        </>,
        100,
      );
      const listening = () =>
        (seam.emitter?.listeners("input") ?? []).filter((listener) => listener.name === "hearApiFormInput");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));

      expect(listening()).toHaveLength(0);
      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      const [first] = listening();

      expect(listening()).toHaveLength(1);
      await moveTo(instance, "API endpoint");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
      for (const label of ["API key", "Model", "Create profile", "Name", "API key"]) {
        await moveTo(instance, label);
        expect(listening()).toEqual([first]);
      }
      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      expect(listening()).toEqual([first]);

      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (frame) => !frame.includes("Choose how to add"));
      expect(listening()).toHaveLength(0);

      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      expect(listening()).toHaveLength(1);
      expect(listening()[0]).not.toBe(first);

      instance.unmount();
      expect(listening()).toHaveLength(0);
    });

    it("saves the key the screen shows, not the one a frame before it", async () => {
      // The same turn, one handler over: the App's own keys. ink subscribes a `useInput`
      // handler in an effect too, so an Enter landing the moment "Create profile" is drawn was
      // answered by the handler of the frame before - with the key as that frame had it. The
      // read that brought the key's last characters also brought the arrows down to Create
      // profile, so that frame had only the head, and the head is what was saved.
      const instance = await filledTo("API key");
      await type(instance, KEY.slice(0, 20));

      sendBeforeEffects(instance, (frame) => focusedOn(frame, "Create profile"), ENTER);
      await type(instance, `${KEY.slice(20)}${DOWN}${DOWN}${DOWN}${DOWN}`);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("✘"));

      const { addApiProfile } = await import("../lib/service.js");
      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(expect.objectContaining({ secretValue: KEY }));
      instance.unmount();
    });

    it("drops a paste that begins with the arrow off the name in the turn the form opens", async () => {
      // The form's listener is subscribed in the commit that opens the form, not an effect
      // after it: an arrow and a paste arriving together right then is the paste the form
      // drops whole, and its tail - twenty characters, too short to look like a key - must
      // not land in whichever field has the cursor when it arrives.
      const instance = await formAt();

      sendBeforeEffects(instance, (frame) => frame.includes("Create profile"), `${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (frame) => focusedOn(frame, "Endpoint"));
      await type(instance, `${KEY.slice(20, 40)}\u001b[201~`);

      expect(focusedOn(instance.lastFrame() ?? "", "Endpoint")).toBe(true);
      expect(row(instance, "Endpoint")).not.toContain("[201~");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("clears the field and says to paste again when a paste ends there that never began there", async () => {
      // The end marker is the terminal saying a paste just finished. With no paste open, its
      // start - and the key's head with it - went somewhere else, and what the field holds is
      // the back of a key. Stored, it is the tail again, behind the same mask.
      const instance = await filledTo("API key");

      await type(instance, `${KEY.slice(20)}\u001b[201~`);
      await waitForFrame(instance.lastFrame, (f) => f.includes(LOST_PASTE_START));

      expect(row(instance, "API key")).toContain("type or paste the key");
      expect(await submit(instance)).toBeUndefined();
      expect(instance.lastFrame()).toContain(KEY_REQUIRED);

      // The way out the message gives works: the next paste is the key.
      await moveTo(instance, "API key");
      await press(instance, KEY);
      expect((await submit(instance))?.secretValue).toBe(KEY);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("does the same when ctrl-u emptied the field while the paste was still arriving", async () => {
      // ctrl-u is the stated way out of a paste that never finished. If it did finish after all,
      // what arrives after the clear is the rest of that paste and not a key.
      const instance = await filledTo("API key");

      await type(instance, `\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, "\u0015");
      await waitForFrame(instance.lastFrame, (f) => !f.includes(MASK));
      await type(instance, `${KEY.slice(20)}\u001b[201~`);
      await waitForFrame(instance.lastFrame, (f) => f.includes(LOST_PASTE_START));

      expect(await submit(instance)).toBeUndefined();
      instance.unmount();
    });

    it("leaves a key already in the field alone when the tail of a dropped paste arrives there", async () => {
      // A paste that began in the read that brought the cursor here is dropped whole, end
      // marker included, before the reader hears any of it. Were its tail read as a paste that
      // lost its start, the field would be cleared - and with it a key that was already right.
      const instance = await filledTo("API key");
      await press(instance, KEY);
      await moveTo(instance, "Auth");

      await type(instance, `${DOWN}\u001b[200~https://other.`);
      await type(instance, "example.com/v1\u001b[201~");

      expect(instance.lastFrame()).not.toContain(LOST_PASTE_START);
      expect((await submit(instance))?.secretValue).toBe(KEY);
      instance.unmount();
    });
  });

  /**
   * A keystroke that ink could not name, because it arrived inside a run of text.
   *
   * ink names Tab, Enter, Backspace or Ctrl-U only when the byte is a read of its own. In one
   * read with text around it, it is a control character in a text event: `useInput` sees no
   * Tab, the cursor did not move, and the key field's reader dropped the byte and appended what
   * came after it - `<KEY>glm-5`, behind the mask, and "Added". Each byte is asserted typed,
   * between a paste's brackets, and right after a paste closes, against what the save gets and
   * against every frame.
   */
  describe("a keystroke inside a run of text on the key field", () => {
    const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

    async function keyAfter(...reads: string[]) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      for (const read of reads) await type(instance, read);
      const landed = instance.lastFrame() ?? "";
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      const done = await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("✘"));
      const saved = vi.mocked(addApiProfile).mock.calls[0]?.[0];
      const leaked = windowsOnScreen(instance.frames, KEY);
      instance.unmount();
      return { saved, landed, leaked, done };
    }

    const MOVES: [string, string][] = [
      ["a tab", "\t"],
      ["an Enter", "\r"],
      ["a line feed", "\n"],
    ];

    it.each(MOVES)("ends the key at %s typed with it, and moves on without the text after it", async (_c, byte) => {
      // What the named key does - the cursor goes to Model - and the text after it was typed
      // after that move, where input has nowhere to go until a frame draws the cursor.
      const { saved, landed, leaked } = await keyAfter(`${KEY}${byte}glm-5`);

      expect(saved?.secretValue).toBe(KEY);
      expect(saved?.env).toEqual({});
      expect(focusedOn(landed, "Model")).toBe(true);
      expect(landed).not.toContain("glm-5");
      expect(leaked).toEqual([]);
    });

    it.each(MOVES)("does the same with %s right after a paste closes", async (_c, byte) => {
      const { saved, landed, leaked } = await keyAfter(`${PASTE(KEY)}${byte}glm-5`);

      expect(saved?.secretValue).toBe(KEY);
      expect(saved?.env).toEqual({});
      expect(focusedOn(landed, "Model")).toBe(true);
      expect(leaked).toEqual([]);
    });

    const ALL: [string, string][] = [
      ...MOVES,
      ["a Ctrl-U", "\u0015"],
      ["a backspace sent as DEL", "\u007f"],
      ["a backspace sent as BS", "\u0008"],
      ["a Ctrl-C", "\u0003"],
      ["a Ctrl-D", "\u0004"],
    ];

    it.each(
      ALL.filter(([, byte]) => !MOVES.some(([, move]) => move === byte)),
    )("reads %s between a paste's brackets as pasted data", async (_c, byte) => {
      // The terminal has said every byte until the closing bracket is pasted: nothing in it is a
      // keypress, and a key has no control characters in it.
      const { saved, landed, leaked } = await keyAfter(PASTE(`${KEY.slice(0, 20)}${byte}${KEY.slice(20)}`));

      expect(saved?.secretValue).toBe(KEY);
      expect(focusedOn(landed, "API key")).toBe(true);
      expect(leaked).toEqual([]);
    });

    it.each(
      MOVES,
    )("refuses a key with %s between a paste's brackets, which is whitespace inside it", async (_c, byte) => {
      // Ruling 98. Pasted, it is not a keypress but a line break or a tab in what was copied - two
      // lines, or a key and something after it - and joining the halves stored neither.
      const { saved, landed, leaked, done } = await keyAfter(PASTE(`${KEY.slice(0, 20)}${byte}${KEY.slice(20)}`));

      expect(saved).toBeUndefined();
      expect(focusedOn(landed, "API key")).toBe(true);
      expect(done).toContain(KEY_HAS_WHITESPACE);
      expect(focusedOn(done, "API key")).toBe(true);
      expect(done).not.toContain(MASK);
      expect(leaked).toEqual([]);
    });

    it("takes a key pasted with the newline it was copied with, trimmed", async () => {
      const { saved, leaked } = await keyAfter(PASTE(`${KEY}\n`));

      expect(saved?.secretValue).toBe(KEY);
      expect(leaked).toEqual([]);
    });

    it.each([
      ["typed", ["x-junk", `\u0015${KEY}`]],
      ["typed with the junk in the same read", [`x-junk\u0015${KEY}`]],
      ["right after a paste closes", [`${PASTE("x-junk")}\u0015${KEY}`]],
    ])("clears the field at a Ctrl-U %s, and keeps what follows it", async (_c, reads) => {
      const { saved, leaked } = await keyAfter(...reads);

      expect(saved?.secretValue).toBe(KEY);
      expect(leaked).toEqual([]);
    });

    it.each([
      ["DEL", "\u007f"],
      ["BS", "\u0008"],
    ])("erases one character at a backspace sent as %s, typed or right after a paste closes", async (_c, byte) => {
      const typed = await keyAfter(`${KEY}xy${byte}${byte}`);
      const afterPaste = await keyAfter(`${PASTE(`${KEY}xy`)}${byte}${byte}`);

      expect(typed.saved?.secretValue).toBe(KEY);
      expect(afterPaste.saved?.secretValue).toBe(KEY);
      expect([...typed.leaked, ...afterPaste.leaked]).toEqual([]);
    });

    it.each([
      ["typed", `${KEY}\u0003glm-5`],
      ["right after a paste closes", `${PASTE(KEY)}\u0003glm-5`],
    ])("stops taking text at a Ctrl-C %s", async (_c, read) => {
      // Alone, ink takes it as the quit key. Inside text it quits nothing, and what follows it
      // is not taken as the key either.
      const { saved, landed, leaked } = await keyAfter(read);

      expect(saved?.secretValue).toBe(KEY);
      expect(focusedOn(landed, "API key")).toBe(true);
      expect(leaked).toEqual([]);
    });

    it.each([
      ["typed", `${KEY}\u0004glm-5`],
      ["right after a paste closes", `${PASTE(KEY)}\u0004glm-5`],
    ])("does nothing at a Ctrl-D %s, as it does alone", async (_c, read) => {
      // Ctrl-D ends the CLI's prompt; this form binds nothing to it. The cursor does not move,
      // so what follows it was typed into the key field, and it goes there.
      const { saved, landed, leaked } = await keyAfter(read);

      expect(saved?.secretValue).toBe(`${KEY}glm-5`);
      expect(focusedOn(landed, "API key")).toBe(true);
      expect(leaked).toEqual([]);
    });

    it("moves on at a line feed alone, as at an Enter", async () => {
      // ink names a lone LF "enter" but hands useInput no flag for it, so the App's own keys
      // never saw it; the key field's reader does, and it is an Enter here as at the prompt.
      const { saved, landed } = await keyAfter(KEY, "\n");

      expect(saved?.secretValue).toBe(KEY);
      expect(focusedOn(landed, "Model")).toBe(true);
    });
  });

  /**
   * A paste dropped whole because it began in the read that moved the cursor (round 4), to its
   * end marker and no further - however the terminal and ink split what comes in between.
   */
  describe("a paste being dropped", () => {
    const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

    async function methodStep() {
      const instance = render(<App initialScreen="use" />);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      return instance;
    }

    async function filledTo(label: string) {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, label);
      return instance;
    }

    async function submit(instance: Instance) {
      const { addApiProfile } = await import("../lib/service.js");
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added") || f.includes("\u2718"));
      return vi.mocked(addApiProfile).mock.calls[0]?.[0];
    }

    const row = (instance: Instance, label: string) =>
      (instance.lastFrame() ?? "").split("\n").find((line) => line.includes(label)) ?? "";

    it("goes on dropping a second paste that starts in the read the first one ended in", async () => {
      // The first paste's end was taken after the rest of the read, and the second paste's start,
      // in that same rest, did not cancel it: the drop ended under the second paste, and its tail
      // went to the field the cursor had landed on. Twenty characters, short of the key check.
      const instance = await filledTo("API key");
      await press(instance, KEY);

      await type(instance, `${DOWN}${PASTE("AAAA")}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, KEY.slice(20, 40));
      await type(instance, "\u001b[201~");

      expect(focusedOn(instance.lastFrame() ?? "", "Model")).toBe(true);
      expect(row(instance, "Model")).not.toContain("[201~");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      expect(await submit(instance)).toEqual(expect.objectContaining({ secretValue: KEY, env: {} }));
      instance.unmount();
    });

    it("drops the second paste before the key field's reader hears any of it", async () => {
      // On the key field round 5's lost-start rule would refuse the tail instead; the drop is
      // what keeps the tail from reaching the field at all.
      const instance = await filledTo("Auth");

      await type(instance, `${DOWN}${PASTE("AAAA")}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, `${KEY.slice(20)}\u001b[201~`);

      expect(row(instance, "API key")).toContain("type or paste the key");
      expect(instance.lastFrame()).not.toContain(LOST_PASTE_START);
      expect(await submit(instance)).toBeUndefined();
      instance.unmount();
    });

    it("drops a paste that starts in the read that opens the form", async () => {
      // The Enter on the method step and a paste together. The form had not been drawn, so
      // nothing that watches the form's input was listening yet, and the paste's tail landed in
      // Name - end marker and all.
      const instance = await methodStep();

      await type(instance, `${ENTER}\u001b[200~${KEY.slice(0, 20)}`);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
      await type(instance, KEY.slice(20, 40));
      await type(instance, "\u001b[201~");

      expect(row(instance, "Name")).not.toContain("[201~");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      await press(instance, "gateway");
      expect(row(instance, "Name")).toContain("gateway");
      instance.unmount();
    });

    it("ends the drop at an end marker split after its ESC, without leaving the form", async () => {
      // ink hands the ESC over alone once a turn passes with nothing after it; the rest of the
      // marker arrives as text. Taken as Esc, it left the form and threw the key away.
      const instance = await filledTo("Endpoint");

      await type(instance, `${DOWN}${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, "\u001b");
      await type(instance, "[201~");

      expect(focusedOn(instance.lastFrame() ?? "", "API key")).toBe(true);
      // The Esc was held with the message; the paste has ended, and so has the message.
      expect(instance.lastFrame()).not.toContain(PASTE_SKIPPED);
      await press(instance, KEY);
      expect((await submit(instance))?.secretValue).toBe(KEY);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("ends the drop at an end marker split inside its CSI", async () => {
      // `ESC [20` handed over on its own, then `1~` as text: neither is the marker, and the drop
      // went on eating what was typed until the cursor moved.
      const instance = await filledTo("Auth");

      await type(instance, `${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await type(instance, "\u001b[20");
      await type(instance, "1~");
      await press(instance, KEY);

      expect((await submit(instance))?.secretValue).toBe(KEY);
      instance.unmount();
    });

    it("takes a newline ink hands over alone inside a dropped paste as pasted, not as an Enter", async () => {
      // A multi-line paste split at its line break: the Enter moved the cursor, which ended the
      // drop, and the rest of the paste went into Model.
      const instance = await filledTo("Auth");

      await type(instance, `${DOWN}\u001b[200~line-one`);
      await type(instance, "\r");
      await type(instance, `${KEY.slice(0, 20)}\u001b[201~`);

      expect(focusedOn(instance.lastFrame() ?? "", "API key")).toBe(true);
      expect(row(instance, "Model")).not.toContain("[201~");
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("says what is being skipped, and how to stop it, when typing goes nowhere", async () => {
      // A dropped paste whose end never comes eats everything typed until the cursor moves. That
      // is safe, and it was silent.
      const instance = await filledTo("Endpoint");

      await type(instance, `${DOWN}${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, "x");
      const told = instance.lastFrame() ?? "";

      expect(told).toContain(PASTE_SKIPPED);
      expect(focusedOn(told, "API key")).toBe(true);
      await press(instance, DOWN);
      expect(instance.lastFrame()).not.toContain(PASTE_SKIPPED);
      await press(instance, "glm-5");
      expect(row(instance, "Model")).toContain("glm-5");
      instance.unmount();
    });

    it("takes the message down when the paste's end does arrive", async () => {
      const instance = await filledTo("Endpoint");

      await type(instance, `${DOWN}${DOWN}\u001b[200~${KEY.slice(0, 20)}`);
      await press(instance, KEY.slice(20, 40));
      expect(instance.lastFrame()).toContain(PASTE_SKIPPED);
      await press(instance, "\u001b[201~");

      expect(instance.lastFrame()).not.toContain(PASTE_SKIPPED);
      await press(instance, KEY);
      expect((await submit(instance))?.secretValue).toBe(KEY);
      instance.unmount();
    });
  });

  /**
   * A bracketed paste into a field that draws what it holds.
   *
   * The TextInput behind the field hears the paste as three events of one read - the opening
   * bracket, the text, the closing bracket - and answers each from the same stale value, so the
   * last one won: the field read `[201~`. It only showed when some other program had left the
   * terminal bracketing pastes; with the form turning that on itself (Ruling 94), it is every
   * paste. The form's listener reads such a paste instead, as the key field's reader does.
   */
  describe("a bracketed paste into a text field", () => {
    const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;
    const row = (instance: Instance, label: string) =>
      (instance.lastFrame() ?? "").split("\n").find((line) => line.includes(label)) ?? "";

    it("takes each field's paste whole, with no bracket in it, and saves what was pasted", async () => {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();

      await type(instance, PASTE("gateway"));
      await moveTo(instance, "Endpoint");
      await type(instance, PASTE("https://gateway.example.com"));
      await moveTo(instance, "API key");
      await type(instance, PASTE(KEY));
      await moveTo(instance, "Model");
      await type(instance, PASTE("glm-5"));

      expect(row(instance, "Name")).toContain("gateway");
      expect(row(instance, "Model")).toContain("glm-5");
      expect(instance.lastFrame()).not.toContain("[20");
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));
      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gateway",
          baseUrl: "https://gateway.example.com",
          env: { ANTHROPIC_MODEL: "glm-5" },
          secretValue: KEY,
        }),
      );
      instance.unmount();
    });

    it("adds a paste to what the field already holds, and takes one split across two reads", async () => {
      const instance = await openApiForm();
      await moveTo(instance, "Endpoint");

      await type(instance, "https://");
      await type(instance, "\u001b[200~gateway.exa");
      await type(instance, "mple.com\u001b[201~");

      expect(row(instance, "Endpoint")).toContain("https://gateway.example.com");
      expect(instance.lastFrame()).not.toContain("[20");
      instance.unmount();
    });

    it("puts a paste where the cursor was moved to inside the field, and goes on typing after it", async () => {
      // #20: the cursor was the text input's own, out of the listener's sight, so a paste went
      // in at the end whatever the arrows had done.
      const LEFT = "\u001b[D";
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");

      await press(instance, "https://gateway.com");
      for (let step = 0; step < 4; step++) await type(instance, LEFT);
      await type(instance, PASTE(".exampl"));
      await type(instance, "e");

      expect(row(instance, "Endpoint")).toContain("https://gateway.example.com");
      await moveTo(instance, "API key");
      await type(instance, PASTE(KEY));
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));
      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://gateway.example.com" }),
      );
      instance.unmount();
    });

    it("holds the cursor on the field while its paste is open, and says how to get out", async () => {
      // A newline ink hands over alone inside the paste is pasted text, as on the key field.
      const instance = await openApiForm();
      await moveTo(instance, "Endpoint");

      await type(instance, "\u001b[200~https://gateway");
      await press(instance, ENTER);
      const held = instance.lastFrame() ?? "";
      await type(instance, ".example.com\u001b[201~");

      expect(focusedOn(held, "Endpoint")).toBe(true);
      expect(held).toContain(UNFINISHED_PASTE);
      expect(row(instance, "Endpoint")).toContain("https://gateway.example.com");
      expect(instance.lastFrame()).not.toContain(UNFINISHED_PASTE);
      instance.unmount();
    });

    it("holds an Esc while the paste is open, and closes it on an end marker split after its ESC", async () => {
      const instance = await openApiForm();
      await moveTo(instance, "Model");

      await type(instance, "\u001b[200~glm-5");
      await type(instance, "\u001b");
      await type(instance, "[201~");

      expect(instance.lastFrame()).toContain("Create profile");
      expect(row(instance, "Model")).toContain("glm-5");
      expect(row(instance, "Model")).not.toContain("[201~");
      instance.unmount();
    });

    it("lets ctrl-u give up a paste whose end never comes, and puts nothing in the field for it", async () => {
      // The way out the held cursor's message names. Nothing of the paste, and not the `u`
      // a TextInput would have typed for ctrl-u.
      const instance = await openApiForm();
      await moveTo(instance, "Model");

      await type(instance, "\u001b[200~glm-5");
      await type(instance, "\u0015");
      await press(instance, "x");

      expect(row(instance, "Model")).toContain("x");
      expect(row(instance, "Model")).not.toContain("glm");
      expect(row(instance, "Model")).not.toContain("u");
      instance.unmount();
    });

    it("masks a key pasted into the Model row, and says where it goes", async () => {
      const instance = await openApiForm();
      await moveTo(instance, "Model");

      await type(instance, PASTE(KEY));

      expect(row(instance, "Model")).toContain(MASK);
      expect(instance.lastFrame()).toContain(MISPLACED_KEY);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });
  });

  /**
   * Ruling 94: the form turns bracketed paste on while it is open, and off on every way out.
   *
   * An unbracketed paste split across two reads, whose first read also carried the arrow onto
   * the key field, stored its tail: the arrow's read drops the head, and the tail looks like
   * typing. With the terminal bracketing the paste, its start marks it as a paste, and the drop
   * or the lost-start rule takes it. The mode belongs to the user's terminal, so it is switched
   * off exactly once on every way out, and only a terminal is switched at all.
   */
  describe("bracketed paste while the form is open", () => {
    const ON = BRACKETED_PASTE_ON;
    const OFF = BRACKETED_PASTE_OFF;
    const exitHooks = () => process.listeners("exit").filter((hook) => hook.name === "turnBracketedPasteOff");

    async function onForm(options: { tty?: boolean; exitOnCtrlC?: boolean } = { tty: true }) {
      const instance = renderAt(<App initialScreen="use" />, 100, options);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      expect(instance.modes).toEqual([]);
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
      expect(instance.modes).toEqual(options.tty ? [ON] : []);
      return instance;
    }

    async function filled(instance: WatchedInstance) {
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await press(instance, KEY);
      await moveTo(instance, "Create profile");
    }

    it("turns it off when Esc leaves the form, and on again only when the form is back", async () => {
      const instance = await onForm();

      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      expect(instance.modes).toEqual([ON, OFF]);
      expect(exitHooks()).toEqual([]);
      await moveTo(instance, "API endpoint");
      expect(instance.modes).toEqual([ON, OFF]);
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));
      expect(instance.modes).toEqual([ON, OFF, ON]);
      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => !f.includes("Choose how to add"));
      instance.unmount();

      expect(instance.modes).toEqual([ON, OFF, ON, OFF]);
    });

    it("turns it off when the profile is saved", async () => {
      const instance = await onForm();
      await filled(instance);

      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));
      instance.unmount();

      expect(instance.modes).toEqual([ON, OFF]);
    });

    it("turns it off when the save fails, and leaves it on while a refused submit keeps the form", async () => {
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockRejectedValueOnce(new Error("the endpoint said no"));
      const instance = await onForm();

      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes(KEY_REQUIRED));
      expect(instance.modes).toEqual([ON]);
      await filled(instance);
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("the endpoint said no"));
      instance.unmount();

      expect(instance.modes).toEqual([ON, OFF]);
    });

    it("turns it off when the App is unmounted with the form open", async () => {
      const instance = await onForm();

      instance.unmount();

      expect(instance.modes).toEqual([ON, OFF]);
      expect(exitHooks()).toEqual([]);
    });

    it("turns it off when ctrl-c quits with the form open", async () => {
      const instance = await onForm({ tty: true, exitOnCtrlC: true });

      instance.stdin.write("\u0003");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(instance.modes).toEqual([ON, OFF]);
      instance.unmount();
      expect(instance.modes).toEqual([ON, OFF]);
    });

    it("turns it off from the process's exit hook if the App never unmounts, and only once", async () => {
      // A crash, or anything that ends the process without React unmounting, must not leave the
      // user's terminal wrapping every paste in brackets.
      const instance = await onForm();
      const hooks = exitHooks();

      expect(hooks).toHaveLength(1);
      (hooks[0] as () => void)();
      expect(instance.modes).toEqual([ON, OFF]);
      expect(exitHooks()).toEqual([]);
      instance.unmount();
      expect(instance.modes).toEqual([ON, OFF]);
    });

    it.each([
      "SIGTERM",
      "SIGHUP",
    ] as const)("turns it off once on %s, lets go of the signal, and raises it again so it still ends the process", async (signal) => {
      const instance = await onForm();
      const handlers = () =>
        process.listeners(signal).filter((listener) => listener.name === "turnBracketedPasteOffAndDie");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      // The POSIX branch on every runner; the Windows one is pinned by the test below.
      const realPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        expect(handlers()).toHaveLength(1);
        (handlers()[0] as (signal: NodeJS.Signals) => void)(signal);

        expect(instance.modes).toEqual([ON, OFF]);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith(process.pid, signal);
        expect(handlers()).toEqual([]);
        expect(exitHooks()).toEqual([]);
        instance.unmount();
        expect(instance.modes).toEqual([ON, OFF]);
      } finally {
        Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
        kill.mockRestore();
        instance.unmount();
      }
    });

    // Windows raises only SIGINT, SIGTERM and SIGKILL: libuv's kill answers SIGHUP with ENOSYS,
    // and a throw inside a signal listener is an uncaught exception in a closing console.
    it.each([
      ["raises SIGINT in place of SIGHUP", (signal: string) => signal !== "SIGINT", undefined],
      ["exits with the signal's status when raising fails anyway", () => true, 129],
    ] as const)("on Windows, %s", async (_label, killThrows, status) => {
      const instance = await onForm();
      const realPlatform = process.platform;
      const handler = process
        .listeners("SIGHUP")
        .find((listener) => listener.name === "turnBracketedPasteOffAndDie") as (signal: NodeJS.Signals) => void;
      const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (killThrows(String(signal))) throw Object.assign(new Error("kill ENOSYS"), { code: "ENOSYS" });
        return true;
      });
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      try {
        expect(() => handler("SIGHUP")).not.toThrow();

        expect(instance.modes).toEqual([ON, OFF]);
        expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
        if (status === undefined) expect(exit).not.toHaveBeenCalled();
        else expect(exit).toHaveBeenCalledWith(status);
      } finally {
        Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
        kill.mockRestore();
        exit.mockRestore();
        instance.unmount();
      }
    });

    it("lets go of both signals when the form closes", async () => {
      const instance = await onForm();

      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));

      for (const signal of ["SIGTERM", "SIGHUP"] as const) {
        expect(process.listeners(signal).filter((listener) => listener.name === "turnBracketedPasteOffAndDie")).toEqual(
          [],
        );
      }
      instance.unmount();
    });

    it("switches nothing on an output that is not a terminal", async () => {
      const instance = await onForm({ tty: false });

      await press(instance, ESC);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
      instance.unmount();

      expect(instance.modes).toEqual([]);
      expect(exitHooks()).toEqual([]);
    });
  });

  /**
   * Ruling 88's second layer, end to end: a field that draws what it holds never draws a key,
   * whichever way the key got there.
   */
  describe("a key in a field that draws what it holds", () => {
    it("masks one pasted into the model row, says where it goes, and clears it on the first erase", async () => {
      const instance = await openApiForm();
      await moveTo(instance, "Model");

      await press(instance, KEY);
      const masked = await waitForFrame(instance.lastFrame, (f) => f.includes(MISPLACED_KEY));

      expect(masked.split("\n").find((line) => line.includes("Model"))).toContain(MASK);
      // Not one character at a time back into view: erasing the key from its end would draw
      // its head once what was left stopped looking like one.
      await press(instance, "\u007f");

      expect(instance.lastFrame()).not.toContain(MASK);
      expect(instance.lastFrame()).not.toContain(MISPLACED_KEY);
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });

    it("takes a key in ANTHROPIC_CUSTOM_HEADERS, masked, without refusing it", async () => {
      // The decision: a header carrying a key is what the variable is for. It is masked because
      // every output path hides it; it is not refused because it is not in the wrong place.
      const { addApiProfile } = await import("../lib/service.js");
      vi.mocked(addApiProfile).mockClear();
      const header = `x-api-key: ${KEY}`;
      const instance = await openApiForm();
      await press(instance, "gateway");
      await moveTo(instance, "Endpoint");
      await press(instance, "https://gateway.example.com");
      await moveTo(instance, "API key");
      await press(instance, KEY);
      await moveTo(instance, "Advanced");
      await press(instance, "a");
      await moveTo(instance, "Custom headers");
      await press(instance, header);

      expect(instance.lastFrame()).not.toContain(MISPLACED_KEY);
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (f) => f.includes("Added claude:gateway"));

      expect(vi.mocked(addApiProfile)).toHaveBeenCalledWith(
        expect.objectContaining({ env: { ANTHROPIC_CUSTOM_HEADERS: header }, secretValue: KEY }),
      );
      expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
      instance.unmount();
    });
  });

  /**
   * The panel cuts an error to one line, and what it cuts is the end - which is where the way
   * out was. Each message the key field shows is checked whole, on screen, at three widths.
   */
  describe.each([80, 100, 120])("what the key field says, at %i columns", (columns) => {
    async function formAt() {
      const instance = renderAt(<App initialScreen="use" />, columns);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
      await press(instance, "a");
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
      await moveTo(instance, "API endpoint");
      await press(instance, ENTER);
      await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
      return instance;
    }

    it("shows the unfinished-paste message whole", async () => {
      const instance = await formAt();
      await moveTo(instance, "API key");
      await type(instance, "\u001b[200~abc");
      await press(instance, DOWN);

      expect(await waitForFrame(instance.lastFrame, (f) => f.includes(UNFINISHED_PASTE))).toContain("ctrl-u");
      instance.unmount();
    });

    it("shows the unreadable-input message whole", async () => {
      const instance = await formAt();
      await moveTo(instance, "API key");
      await type(instance, `\u001b]${"x".repeat(5000)}`);

      await waitForFrame(instance.lastFrame, (f) => f.includes(UNREADABLE_KEY_INPUT));
      instance.unmount();
    });

    it("shows the paste-skipped message whole", async () => {
      const instance = await formAt();
      await moveTo(instance, "Endpoint");
      await type(instance, `${DOWN}${DOWN}\u001b[200~abc`);
      await press(instance, "x");

      await waitForFrame(instance.lastFrame, (f) => f.includes(PASTE_SKIPPED));
      instance.unmount();
    });

    it("shows the lost-start message whole", async () => {
      const instance = await formAt();
      await moveTo(instance, "API key");
      await type(instance, "abc\u001b[201~");

      await waitForFrame(instance.lastFrame, (f) => f.includes(LOST_PASTE_START));
      instance.unmount();
    });

    it("shows the missing-key and misplaced-key messages whole", async () => {
      const instance = await formAt();
      await press(instance, KEY);
      await waitForFrame(instance.lastFrame, (f) => f.includes(MISPLACED_KEY));
      await moveTo(instance, "Create profile");
      await press(instance, ENTER);

      await waitForFrame(instance.lastFrame, (f) => f.includes(KEY_REQUIRED) && f.includes(MISPLACED_KEY));
      instance.unmount();
    });
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
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
    instance.unmount();
  });

  it("refuses a key typed into the name field, at the field, and draws a mask in its place", async () => {
    const instance = await openApiForm();

    await press(instance, KEY);
    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes(MISPLACED_KEY));

    // The name field used to draw what was typed into it, key included, and clear it only on
    // the way out. It draws the key field's mask now, as every field that shows what it holds
    // does for a key.
    expect(frame.split("\n").find((line) => line.includes("Name"))).toContain(MASK);

    // And it does not outlive the step: leaving the form takes a key-shaped name with it,
    // the same way it takes the key.
    await press(instance, ESC);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Choose how to add"));
    await moveTo(instance, "API endpoint");
    await press(instance, ENTER);
    const back = await waitForFrame(instance.lastFrame, (f) => f.includes("Create profile"));

    expect(back).not.toContain(MASK);
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
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
    expect(frame).toContain(KEY_REQUIRED);
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

  it("flushes an unfinished CSI as an event of its own when nothing follows it in time", async () => {
    // What makes an event's end authoritative for the key field (Ruling 87): ink holds an
    // unfinished CSI only until a `setImmediate` passes, then hands it over as it is. The
    // pin above writes both halves in one turn; this one lets the turn pass between them.
    const { instance, events } = probe();
    await settle();
    instance.stdin.write("\u001b[");
    await settle();
    instance.stdin.write("12;40R");
    await settle();

    expect(events).toEqual(["\u001b[", "12;40R"]);
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

  // doctor's result carries an API profile's label under `label`, with `email` empty.
  it("names an API profile by its label", async () => {
    const { doctorProfiles } = await import("../lib/service.js");
    vi.mocked(doctorProfiles).mockResolvedValueOnce([
      {
        name: "claude:glm",
        kind: "api",
        email: "",
        label: "gpu-box",
        configDir: "/Users/test/.claude-glm",
        isPrimary: false,
        healthy: true,
        issues: [],
      },
    ]);
    const { lastFrame } = render(<App initialScreen="doctor" />);
    const frame = await waitForFrame(lastFrame, (f) => f.includes("claude:glm"));

    expect(frame.split("gpu-box").length - 1).toBe(2);
  });
});

describe("App after a re-login", () => {
  it("shows why when reloading the dashboard afterwards fails", async () => {
    const { listProfiles, loginProfile } = await import("../lib/service.js");
    vi.mocked(listProfiles)
      .mockResolvedValueOnce([WORK])
      .mockRejectedValueOnce(new Error("profiles.json is unreadable"));
    vi.mocked(loginProfile).mockResolvedValueOnce({
      status: "ok",
      profile: { tool: "claude", configDir: WORK.configDir, email: WORK.email },
    });

    await withTerminalHandOver(async () => {
      const { lastFrame, stdin } = render(<App initialScreen="use" />);
      const frame = () => lastFrame() ?? "";
      await until(() => frame().includes("claude:work"));
      await pressUntil(stdin, "l", () => frame().includes(OVERLAY));
      await pressUntil(stdin, "y", () => !frame().includes(OVERLAY));

      await until(() => frame().includes("profiles.json is unreadable"));
    });
  });
});

const WORK = {
  name: "claude:work",
  tool: "claude" as const,
  email: "work@example.com",
  configDir: "/h/.claude-work",
  isPrimary: false,
  isActive: true,
  today: { cost: 0, inputTokens: 0, outputTokens: 0 },
  week: { cost: 0, inputTokens: 0, outputTokens: 0 },
  month: { cost: 0, inputTokens: 0, outputTokens: 0 },
  total: { cost: 0, inputTokens: 0, outputTokens: 0 },
};

const OVERLAY = 'Re-login "claude:work"';

/** Polls rather than sleeping a fixed time, so a slow runner waits instead of failing. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the TUI to render");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Ink subscribes to input only after it renders, so a key sent the moment a frame appears
 * can be dropped. Resends until `landed` holds; every key used here is a no-op on repeat.
 */
async function pressUntil(stdin: { write: (data: string) => void }, key: string, landed: () => boolean): Promise<void> {
  const started = Date.now();
  for (;;) {
    stdin.write(key);
    for (let i = 0; i < 10; i++) {
      if (landed()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (Date.now() - started > 3000) throw new Error(`key ${JSON.stringify(key)} never took effect`);
  }
}

/**
 * Signing in hands the terminal to the child by clearing the real stdout and switching
 * the real stdin's mode. Keeps both out of the test run and restores them afterwards.
 */
async function withTerminalHandOver(run: () => Promise<void>): Promise<void> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const wasRaw = process.stdin.isRaw;
  try {
    await run();
  } finally {
    write.mockRestore();
    process.stdin.setRawMode?.(Boolean(wasRaw));
    process.stdin.pause();
  }
}
