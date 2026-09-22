import { render } from "ink-testing-library";
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    return lastFrame() ?? "";
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
