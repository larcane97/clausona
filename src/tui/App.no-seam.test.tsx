import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

/**
 * The key field when ink's input events are out of reach: `useStdin` with no emitter.
 *
 * ink's own App always provides one, so no `render()` can get here - which is why these
 * refusals went untested, and why deleting either of them left the suite green. A host that
 * renders its own StdinContext can, and the field there has no reader it would trust: it
 * refuses where the key would have been typed, and again at the save, and points at the CLI.
 * Its own file because the mock replaces `ink` for everything in it.
 */
vi.mock("ink", async (importOriginal) => {
  const real = await importOriginal<typeof import("ink")>();
  return { ...real, useStdin: () => ({ ...real.useStdin(), internal_eventEmitter: undefined }) };
});

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({ accounts: [], profileNames: {}, defaultProfile: "default" })),
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
  doctorProfiles: vi.fn(async () => []),
  fetchProfileQuotas: vi.fn(async () => ({})),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => []),
  addApiProfile: vi.fn(async () => ({ name: "gateway", configDir: "/Users/test/.claude-gateway" })),
}));

import { App } from "./App.js";
import { NO_RAW_KEY_INPUT } from "./api-form.js";
import { ENTER, type Instance, moveTo, press, renderAt, type, waitForFrame } from "./test-drive.js";

async function openApiForm(instance: Instance) {
  await waitForFrame(instance.lastFrame, (frame) => frame.includes("default"));
  await press(instance, "a");
  await waitForFrame(instance.lastFrame, (frame) => frame.includes("Choose how to add"));
  await moveTo(instance, "API endpoint");
  await press(instance, ENTER);
  await waitForFrame(instance.lastFrame, (frame) => frame.includes("Create profile"));
}

describe("the key field with no input events to read", () => {
  it("says so at the field, takes nothing typed, and refuses the save", async () => {
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockClear();
    const instance = render(<App initialScreen="use" />);
    await openApiForm(instance);
    await press(instance, "gateway");
    await moveTo(instance, "Endpoint");
    await press(instance, "https://gateway.example.com");
    await moveTo(instance, "API key");

    await waitForFrame(instance.lastFrame, (f) => f.includes(NO_RAW_KEY_INPUT));
    await type(instance, "sk-typed-anyway");
    expect(instance.lastFrame()).toContain("type or paste the key");

    await moveTo(instance, "Create profile");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes(NO_RAW_KEY_INPUT) && f.includes("Create profile"));
    expect(vi.mocked(addApiProfile)).not.toHaveBeenCalled();
    instance.unmount();
  });

  it("refuses the save on its own, not only because the field is empty", async () => {
    // The save's refusal and the field's are separate branches; with the field's message
    // cleared by leaving and coming back, the save's is the only one left to say it.
    const { addApiProfile } = await import("../lib/service.js");
    vi.mocked(addApiProfile).mockClear();
    const instance = render(<App initialScreen="use" />);
    await openApiForm(instance);
    await moveTo(instance, "Create profile");
    await press(instance, ENTER);

    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("Enter a profile name."));
    expect(
      frame
        .split("\n")
        .filter((line) => line.includes("✘"))
        .join("\n"),
    ).toContain(NO_RAW_KEY_INPUT);
    expect(vi.mocked(addApiProfile)).not.toHaveBeenCalled();
    instance.unmount();
  });

  it.each([80, 100, 120])("shows the way out whole at %i columns", async (columns) => {
    const instance = renderAt(<App initialScreen="use" />, columns);
    await openApiForm(instance);
    await moveTo(instance, "API key");

    await waitForFrame(instance.lastFrame, (f) => f.includes(NO_RAW_KEY_INPUT));
    instance.unmount();
  });
});
