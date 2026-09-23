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
    const work = {
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
    // Once for the initial load, once for the refresh after signing in.
    vi.mocked(listProfiles).mockResolvedValueOnce([work]).mockResolvedValueOnce([work]);
    vi.mocked(loginProfile).mockResolvedValueOnce({
      profile: { tool: "claude", configDir: work.configDir, email: work.email },
      signedInAs: "other@example.com",
      accountMismatch: true,
    });

    // Signing in hands the terminal over by clearing the real stdout; keep that out of the test output.
    const clear = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { lastFrame, stdin } = render(<App initialScreen="use" />);
    await new Promise((r) => setTimeout(r, 100));
    stdin.write("l");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("y");
    await new Promise((r) => setTimeout(r, 300));
    clear.mockRestore();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("other@example.com");
    expect(frame).not.toContain("Re-login completed");
  });
});
