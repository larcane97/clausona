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
});
