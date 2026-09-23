import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

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
  loginProfile: vi.fn(),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
}));

import { App } from "./App.js";

describe("App", () => {
  it("renders the dashboard header", async () => {
    const instance = render(<App initialScreen="dashboard" />);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(instance.lastFrame()).toContain("clausona");
    expect(instance.lastFrame()).toContain("Dashboard");
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
    // Let async listProfiles resolve
    await new Promise((r) => setTimeout(r, 100));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude:work");
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
      await press(stdin, "l", () => frame().includes(OVERLAY));
      await press(stdin, "y", () => !frame().includes(OVERLAY));
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
      await press(stdin, "l", () => frame().includes(OVERLAY));
      await press(stdin, "y", () => !frame().includes(OVERLAY));
      await until(() => frame().includes("claude login failed."));
      await until(() => frame().includes("reloaded@example.com"));

      await press(stdin, "l", () => frame().includes(OVERLAY));
    });
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
      await press(stdin, "l", () => frame().includes(OVERLAY));
      await press(stdin, "y", () => !frame().includes(OVERLAY));

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
async function press(stdin: { write: (data: string) => void }, key: string, landed: () => boolean): Promise<void> {
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
