import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ProfileListItem } from "../types.js";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({
    accounts: [],
    profileNames: {},
    defaultProfile: "default",
  })),
}));

vi.mock("../lib/service", () => ({
  addProfile: vi.fn(),
  discoverAccounts: vi.fn(async () => []),
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

const noUsage = { cost: 0, inputTokens: 0, outputTokens: 0 };

// Re-login is offered only for a non-primary profile, and the list opens on the first one.
const workProfile: ProfileListItem = {
  name: "claude:work",
  tool: "claude",
  email: "work@example.com",
  configDir: "/Users/test/.claude-work",
  isPrimary: false,
  isActive: true,
  today: noUsage,
  week: noUsage,
  month: noUsage,
  total: noUsage,
};

// Logging in suspends the TUI through the real process streams rather than Ink's, so keep
// it from clearing the terminal running the tests or flipping its raw mode, and record the
// raw mode calls instead. Works whether or not the test process has a TTY stdin.
function stubTerminal() {
  const stdin = process.stdin;
  const ownSetRawMode = Object.getOwnPropertyDescriptor(stdin, "setRawMode");
  const setRawMode = vi.fn();
  Object.defineProperty(stdin, "setRawMode", { value: setRawMode, configurable: true, writable: true });
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    vi.spyOn(stdin, "pause").mockImplementation(() => stdin),
    vi.spyOn(stdin, "resume").mockImplementation(() => stdin),
  ];
  return {
    setRawMode,
    restore() {
      if (ownSetRawMode) Object.defineProperty(stdin, "setRawMode", ownSetRawMode);
      else Reflect.deleteProperty(stdin, "setRawMode");
      for (const spy of spies) spy.mockRestore();
    },
  };
}

// Waits for the frame to change after a keypress, so the next key reaches the updated screen.
async function press(instance: ReturnType<typeof render>, input: string) {
  const before = instance.lastFrame();
  instance.stdin.write(input);
  await vi.waitFor(() => expect(instance.lastFrame()).not.toBe(before));
}

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

  it("comes back with the error after a failed re-login (#27)", async () => {
    const terminal = stubTerminal();
    const { listProfiles, loginProfile } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([workProfile]);
    vi.mocked(loginProfile).mockRejectedValueOnce(new Error("claude login failed."));
    const instance = render(<App initialScreen="use" />);
    try {
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("claude:work"));
      await press(instance, "l");
      expect(instance.lastFrame()).toContain("Re-login");
      instance.stdin.write("y");
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("claude login failed."));
      expect(instance.lastFrame()).toContain("Profiles");
      expect(terminal.setRawMode).toHaveBeenLastCalledWith(true);
    } finally {
      instance.unmount();
      terminal.restore();
    }
  });

  it("comes back with the error after a failed add via login (#27)", async () => {
    const terminal = stubTerminal();
    const { addProfile } = await import("../lib/service.js");
    vi.mocked(addProfile).mockRejectedValueOnce(new Error("claude login failed."));
    const instance = render(<App initialScreen="use" />);
    try {
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("default@example.com"));
      await press(instance, "a");
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("Choose how to add"));
      await press(instance, "\u001B[B"); // down to "Login as new account"
      await press(instance, "\r");
      expect(instance.lastFrame()).toContain("Choose tool");
      await press(instance, "\r"); // claude
      await press(instance, "work2");
      instance.stdin.write("\r");
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("claude login failed."));
      expect(instance.lastFrame()).toContain("Add Profile");
      expect(terminal.setRawMode).toHaveBeenLastCalledWith(true);
    } finally {
      instance.unmount();
      terminal.restore();
    }
  });

  it("leaves keys typed during a login to the login, not the TUI (#27)", async () => {
    const terminal = stubTerminal();
    const { listProfiles, loginProfile } = await import("../lib/service.js");
    vi.mocked(listProfiles).mockResolvedValueOnce([workProfile]);
    let loginStarted = false;
    let failLogin: (error: Error) => void = () => {};
    vi.mocked(loginProfile).mockImplementationOnce(() => {
      loginStarted = true;
      return new Promise<never>((_, reject) => {
        failLogin = reject;
      });
    });
    const instance = render(<App initialScreen="use" />);
    try {
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("claude:work"));
      await press(instance, "l");
      instance.stdin.write("y");
      await vi.waitFor(() => expect(loginStarted).toBe(true));
      // "a" opens the add flow on this screen; while the login owns the terminal it must not.
      instance.stdin.write("a");
      await new Promise((resolve) => setTimeout(resolve, 50));
      failLogin(new Error("claude login failed."));
      await vi.waitFor(() => expect(instance.lastFrame()).toContain("claude login failed."));
      expect(instance.lastFrame()).not.toContain("Add Profile");
    } finally {
      instance.unmount();
      terminal.restore();
    }
  });
});
