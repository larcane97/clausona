import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { Inventory } from "../extensions/model.js";

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
  registryProblem: vi.fn(async () => null),
  repairProfile: vi.fn(async () => ({ repaired: 0 })),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => []),
  addProfile: vi.fn(),
  addApiProfile: vi.fn(async () => ({ name: "gateway", configDir: "/Users/test/.claude-gateway" })),
}));

import { App } from "./App.js";
import { ENTER, ESC, focusedOn, moveTo, press, waitForFrame } from "./test-drive.js";

vi.setConfig({ testTimeout: 15_000 });

const inventory: Inventory = {
  items: [
    {
      id: "skill:claude:global:-:eli5",
      kind: "skill",
      name: "eli5",
      location: { tool: "claude", scope: "global", file: "/h/.claude/skills/eli5" },
    },
  ],
  projects: [],
  homeDir: "/h",
  claudeProfiles: ["claude:default"],
  facts: {
    claudeSkillOverrides: [],
    claudeEnabledPlugins: [],
    claudeMcpDisabled: [],
    claudeMcpjson: [],
    codexSkillConfig: [],
    codexMcpEnabled: [],
  },
  usage: {},
  hashes: {},
  warnings: [],
};

describe("Extensions from the dashboard", () => {
  it("opens on enter and comes back on esc", async () => {
    const load = vi.fn(async () => inventory);
    const instance = render(<App loadExtensions={load} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Extensions"));
    await moveTo(instance, "Extensions");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("eli5"));
    expect(load).toHaveBeenCalledTimes(1);
    await press(instance, ESC);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Dashboard"));
    instance.unmount();
  });

  it("leaves esc inside a view to the Extensions screen, and comes back clean", async () => {
    const instance = render(<App loadExtensions={async () => inventory} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Extensions"));
    // A dashboard message from before, which the way back must not bring back with it.
    await press(instance, ESC);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Press ESC again to quit"));
    await moveTo(instance, "Extensions");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("eli5"));

    // Esc while typing a search only ends the search: the App must not take it as a way back.
    await press(instance, "/");
    await waitForFrame(instance.lastFrame, (f) => f.includes("▏"));
    await press(instance, ESC);
    const after = await waitForFrame(instance.lastFrame, (f) => !f.includes("▏"));
    expect(after).toContain("eli5");
    expect(after).not.toContain("Dashboard");

    await press(instance, ESC);
    const back = await waitForFrame(instance.lastFrame, (f) => f.includes("Dashboard"));
    expect(focusedOn(back, "Profiles")).toBe(true);
    expect(back).not.toContain("Press ESC again to quit");
    instance.unmount();
  });
});
