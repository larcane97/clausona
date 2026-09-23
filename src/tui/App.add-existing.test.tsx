import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({ accounts: [], profileNames: {}, defaultProfile: "default" })),
}));

vi.mock("../lib/service", () => {
  const usage = { cost: 0, inputTokens: 0, outputTokens: 0 };
  const profile = (name: string, isPrimary: boolean) => ({
    name,
    tool: name.startsWith("codex:") ? ("codex" as const) : ("claude" as const),
    email: `${name.replace(":", "-")}@example.com`,
    configDir: `/h/.${name.replace(":", "-")}`,
    isPrimary,
    isActive: isPrimary,
    today: usage,
    week: usage,
    month: usage,
    total: usage,
  });
  return {
    listProfiles: vi.fn(async () => [
      profile("claude:default", true),
      profile("claude:work", false),
      profile("codex:team", false),
    ]),
    doctorProfiles: vi.fn(async () => []),
    fetchProfileQuotas: vi.fn(async () => ({})),
    discoverAccounts: vi.fn(async () => []),
    addProfile: vi.fn(async () => {
      throw new Error("addProfile should not be reached for a registered name");
    }),
  };
});

import { App } from "./App.js";

afterEach(cleanup);

const DOWN = "\u001B[B";
const ENTER = "\r";

async function until(check: () => boolean, describe: () => string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the TUI:\n${describe()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Walks Profiles → add → "Login as new account" → tool → name, and submits `name`. */
async function submitLoginName(tool: "claude" | "codex", name: string) {
  const { stdin, lastFrame } = render(<App initialScreen="use" />);
  const frame = () => lastFrame() ?? "";
  // The input handler reads the state of the last render and is re-subscribed in an effect
  // after the frame is written, so each key waits for its frame and then for effects to run.
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const step = async (keys: string, expected: string) => {
    const before = frame();
    stdin.write(keys);
    await until(
      () => frame() !== before && frame().includes(expected),
      () => `after ${JSON.stringify(keys)}, expected "${expected}" in:\n${frame()}`,
    );
    await settle();
  };

  await until(
    () => frame().includes("claude:work"),
    () => frame(),
  );
  await settle();
  await step("a", "Choose how to add");
  await step(DOWN, "Choose how to add");
  await step(ENTER, "Choose tool");
  if (tool === "codex") await step(DOWN, "Choose tool");
  await step(ENTER, "Login as new account");
  await step(name, name);
  await step(ENTER, "already exists");
  return frame();
}

describe("App login-as-new-account step for a registered name", () => {
  // Distinct names per tool, so the codex case only passes if the codex id is the one checked.
  it.each([
    ["claude", "work"],
    ["codex", "team"],
  ] as const)("points a %s profile at the re-login key", async (tool, name) => {
    const frame = await submitLoginName(tool, name);
    expect(frame).toContain(`Profile "${name}" already exists. Press l on it in Profiles to re-login`);
  });

  it("does not point the primary at re-login, which the Profiles screen does not offer for it", async () => {
    const frame = await submitLoginName("claude", "default");
    expect(frame).toContain('Profile "default" already exists');
    expect(frame).not.toContain("re-login");
  });
});
