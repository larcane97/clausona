import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { UpdateOffer, Updater } from "../core/update.js";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({ accounts: [], profileNames: {}, defaultProfile: "default" })),
}));

// The same service stand-in as App.test.tsx, so the dashboard and Profiles screens load as they do there.
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

vi.setConfig({ testTimeout: 15_000 });

import { reinstallCommand } from "../core/update.js";
import { App } from "./App.js";
import { DOWN, ENTER, ESC, focusedOn, type Instance, press, renderAt, type, waitForFrame } from "./test-drive.js";

const UP = "\u001B[A";

const OFFER: UpdateOffer = {
  current: "0.3.0-beta",
  latest: "0.3.1-beta",
  tag: "v0.3.1-beta",
  target: "/home/u/.local/share/clausona/index.js",
};

function fakeUpdater(options: { offer?: UpdateOffer | null; install?: Updater["install"] } = {}) {
  const find = vi.fn(async () => (options.offer === undefined ? OFFER : options.offer));
  const install = vi.fn(options.install ?? (async () => {}));
  return { updater: { find, install } satisfies Updater, find, install };
}

const offered = (frame: string) => frame.includes("v0.3.1-beta available") && frame.includes("Update");

/** From the dashboard with the offer on screen: up to Update, Enter, and the question. */
async function openConfirm(instance: Instance) {
  await waitForFrame(instance.lastFrame, offered);
  await press(instance, UP);
  expect(focusedOn(instance.lastFrame() ?? "", "Update")).toBe(true);
  await press(instance, ENTER);
  await waitForFrame(instance.lastFrame, (f) => f.includes("(Y/n)"));
}

describe("the dashboard's update", () => {
  it("shows a newer release in the header and above Profiles, and leaves the cursor on Profiles", async () => {
    const { updater, find } = fakeUpdater();
    const instance = render(<App initialScreen="dashboard" updater={updater} />);

    const frame = await waitForFrame(instance.lastFrame, offered);
    expect(frame).toContain("v0.3.0-beta → v0.3.1-beta");
    expect(frame.indexOf("⬆ Update")).toBeLessThan(frame.indexOf("Profiles"));
    expect(focusedOn(frame, "Profiles")).toBe(true);

    // Enter out of habit opens Profiles; coming back lands on Profiles again, with no second check.
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => !f.includes("Dashboard") && f.includes("Profiles"));
    await press(instance, ESC);
    const back = await waitForFrame(instance.lastFrame, offered);
    expect(focusedOn(back, "Profiles")).toBe(true);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("keeps the cursor where it was when the check answers late", async () => {
    let answer: (offer: UpdateOffer | null) => void = () => {};
    const updater: Updater = {
      find: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      install: vi.fn(async () => {}),
    };
    const instance = render(<App initialScreen="dashboard" updater={updater} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Dashboard") && f.includes("Usage"));
    await press(instance, DOWN);
    expect(focusedOn(instance.lastFrame() ?? "", "Usage")).toBe(true);

    answer(OFFER);

    const frame = await waitForFrame(instance.lastFrame, offered);
    expect(focusedOn(frame, "Usage")).toBe(true);
  });

  it.each([
    ["n", "n"],
    ["esc", ESC],
  ])("cancels on %s without installing or quitting", async (_name, key) => {
    const { updater, install } = fakeUpdater();
    const instance = render(<App initialScreen="dashboard" updater={updater} />);
    await openConfirm(instance);

    await press(instance, key);

    const frame = await waitForFrame(instance.lastFrame, (f) => !f.includes("(Y/n)"));
    expect(frame).toContain("Dashboard");
    expect(frame).not.toContain("Press ESC again");
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    ["enter", ENTER],
    ["y", "y"],
  ])("installs on %s and hands over to the new version", async (_name, key) => {
    const { updater, install } = fakeUpdater();
    const onRestart = vi.fn();
    const instance = render(<App initialScreen="dashboard" updater={updater} onRestart={onRestart} />);
    await openConfirm(instance);

    // `type`, not `press`: this install finishes in the same turn, so the App exits before the
    // spinner is painted and the key redraws nothing.
    await type(instance, key);

    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledWith(OFFER));
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(OFFER, expect.any(AbortSignal));
  });

  it("installs once however fast Enter is pressed", async () => {
    let finish: () => void = () => {};
    const install = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onRestart = vi.fn();
    const instance = render(
      <App initialScreen="dashboard" updater={{ find: async () => OFFER, install }} onRestart={onRestart} />,
    );
    await openConfirm(instance);

    // Two Enters inside one tick are both answered from the frame with the question on it.
    instance.stdin.write(ENTER);
    instance.stdin.write(ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Updating to v0.3.1-beta"));
    await type(instance, ENTER);

    expect(install).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1));
  });

  // Enter then n, typed fast, arrive in one read and are both answered from the question's frame.
  // Without the guard, the n closed the panel while the install ran on, and its exit later pulled
  // the user out of whatever screen they had moved to. Ink holds a lone ESC until the next turn,
  // so ESC is answered from the frame after; it is here so that stays true.
  it.each([
    ["n", "n"],
    ["esc", ESC],
  ])("keeps the install on screen when %s follows Enter in the same read", async (_name, key) => {
    let finish: () => void = () => {};
    const install = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onRestart = vi.fn();
    const instance = render(
      <App initialScreen="dashboard" updater={{ find: async () => OFFER, install }} onRestart={onRestart} />,
    );
    await openConfirm(instance);

    instance.stdin.write(ENTER);
    instance.stdin.write(key);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Updating to v0.3.1-beta"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(instance.lastFrame()).toContain("Updating to v0.3.1-beta");
    expect(install).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1));
  });

  // Ctrl+C, which ink answers itself by unmounting the App: the install must stop with it, not
  // swap the new bundle in after csn has gone.
  it("stops an install still running when the App goes away", async () => {
    let signal: AbortSignal | undefined;
    const install = vi.fn((_offer: UpdateOffer, given?: AbortSignal) => {
      signal = given;
      return new Promise<void>(() => {});
    });
    const onRestart = vi.fn();
    const instance = render(
      <App initialScreen="dashboard" updater={{ find: async () => OFFER, install }} onRestart={onRestart} />,
    );
    await openConfirm(instance);
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Updating to v0.3.1-beta"));
    expect(signal?.aborted).toBe(false);

    instance.unmount();

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("stops the check when the App goes away before GitHub answers", async () => {
    let signal: AbortSignal | undefined;
    const updater: Updater = {
      find: (given) => {
        signal = given;
        return new Promise(() => {});
      },
      install: vi.fn(async () => {}),
    };
    const instance = render(<App initialScreen="dashboard" updater={updater} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Dashboard") && f.includes("Usage"));
    expect(signal?.aborted).toBe(false);

    instance.unmount();

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("shows a failed install in full, and keeps Update to try again", async () => {
    const { updater } = fakeUpdater({
      install: async () => {
        throw new Error("The download of v0.3.1-beta does not match its published checksum.");
      },
    });
    const onRestart = vi.fn();
    const instance = render(<App initialScreen="dashboard" updater={updater} onRestart={onRestart} />);
    await openConfirm(instance);

    await press(instance, ENTER);

    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("Update failed"));
    expect(frame).toContain("does not match its published checksum");
    expect(onRestart).not.toHaveBeenCalled();
    await press(instance, ESC);
    const after = await waitForFrame(instance.lastFrame, (f) => !f.includes("Update failed"));
    expect(after).toContain("⬆ Update");
  });

  it("points a copy the installer did not make at the installer, without asking", async () => {
    const { updater, install } = fakeUpdater({ offer: { ...OFFER, target: null } });
    // Wide enough that the installer line is drawn on one row, as a person would copy it.
    const instance = renderAt(<App initialScreen="dashboard" updater={updater} />, 160);
    await waitForFrame(instance.lastFrame, offered);
    await press(instance, UP);
    await press(instance, ENTER);

    const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("not installed by the installer"));
    expect(frame).toContain(reinstallCommand(process.platform));
    expect(frame).not.toContain("(Y/n)");
    expect(install).not.toHaveBeenCalled();
    instance.unmount();
  });

  it("shows nothing when there is no newer release", async () => {
    const { updater, find } = fakeUpdater({ offer: null });
    const instance = render(<App initialScreen="dashboard" updater={updater} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Dashboard") && f.includes("Usage"));
    await vi.waitFor(() => expect(find).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("⬆");
    expect(frame).not.toContain("available");
  });
});
