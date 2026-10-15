import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { STAR_URL, type StarOutcome } from "../core/star.js";

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({ accounts: [], profileNames: {}, defaultProfile: "default" })),
}));

// The same service stand-in as App.test.tsx, so the dashboard loads as it does there.
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

import { listProfiles } from "../lib/service.js";
import { App } from "./App.js";
import { DOWN, ENTER, ESC, focusedOn, moveTo, press, renderAt, waitForFrame } from "./test-drive.js";

const RIGHT = "\u001B[C";

function fakeStar(
  options: { ask?: boolean; outcome?: StarOutcome; give?: (signal?: AbortSignal) => Promise<StarOutcome> } = {},
) {
  const give = vi.fn(
    options.give ?? (async (): Promise<StarOutcome> => options.outcome ?? { kind: "starred", login: "octocat" }),
  );
  const record = vi.fn(async () => {});
  const claimPrompt = vi.fn(async () => options.ask ?? false);
  return { star: { give, record, claimPrompt }, give, record, claimPrompt };
}

const dashboard = (frame: string) => frame.includes("Dashboard") && frame.includes("Quit");
const asking = (frame: string) => frame.includes("Enjoying clausona?");
/** The popup once it takes an answer: its key hints show then. */
const answerable = (frame: string) => asking(frame) && frame.includes("enter select");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the dashboard's Star on GitHub", () => {
  it("is listed above Quit, and stars from there", async () => {
    const { star, give, record } = fakeStar();
    const instance = render(<App initialScreen="dashboard" star={star} />);

    const frame = await waitForFrame(instance.lastFrame, dashboard);
    expect(frame).toContain("Help others find clausona");
    expect(frame.indexOf("★ Star on GitHub")).toBeGreaterThan(frame.indexOf("Health check"));
    expect(frame.indexOf("★ Star on GitHub")).toBeLessThan(frame.indexOf("Quit"));

    await moveTo(instance, "Star on GitHub");
    await press(instance, ENTER);

    await waitForFrame(instance.lastFrame, (f) => f.includes("Starred larcane97/clausona as @octocat. Thank you!"));
    expect(give).toHaveBeenCalledTimes(1);
    // Pressed here, the popup never asks afterwards.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("says where the page opened, or the address", async () => {
    for (const [outcome, said] of [
      [{ kind: "opened", url: STAR_URL }, "Opened github.com/larcane97/clausona. Press Star there. Thank you!"],
      [{ kind: "manual", url: STAR_URL }, `Star clausona at ${STAR_URL}`],
    ] as const) {
      const { star } = fakeStar({ outcome });
      const instance = render(<App initialScreen="dashboard" star={star} />);
      await waitForFrame(instance.lastFrame, dashboard);
      await moveTo(instance, "Star on GitHub");
      await press(instance, ENTER);

      await waitForFrame(instance.lastFrame, (f) => f.includes(said));
      instance.unmount();
    }
  });

  it("stars once for an Enter pressed again while the first is under way", async () => {
    let finish: (outcome: StarOutcome) => void = () => {};
    const { star, give } = fakeStar({
      give: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, dashboard);
    await moveTo(instance, "Star on GitHub");
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Starring clausona"));
    instance.stdin.write(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 50));

    finish({ kind: "starred", login: null });
    await waitForFrame(instance.lastFrame, (f) => f.includes("Starred larcane97/clausona. Thank you!"));
    expect(give).toHaveBeenCalledTimes(1);
  });

  it("is not there without a way to star", async () => {
    const instance = render(<App initialScreen="dashboard" />);

    const frame = await waitForFrame(instance.lastFrame, dashboard);
    expect(frame).not.toContain("Star on GitHub");
  });
});

describe("the dashboard's star popup", () => {
  it("does not open when it is not time to ask", async () => {
    const { star, claimPrompt } = fakeStar({ ask: false });
    const instance = render(<App initialScreen="dashboard" star={star} />);

    await waitForFrame(instance.lastFrame, dashboard);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.lastFrame()).not.toContain("Enjoying clausona?");
    expect(claimPrompt).toHaveBeenCalledTimes(1);
  });

  // The dashboard's list is shorter in a short terminal (#182): four rows down, the popup covered
  // the rule above the key hints and the hints that say how to answer it.
  for (const [columns, rows] of [
    [80, 24],
    [44, 22],
  ] as const) {
    it(`stays clear of the key hints in ${columns}×${rows}`, async () => {
      const { star } = fakeStar({ ask: true });
      const instance = renderAt(<App initialScreen="dashboard" star={star} />, columns, { rows });

      // Quit is below the menu's window here: the title says it is the dashboard.
      const frame = await waitForFrame(instance.lastFrame, (f) => f.includes("│ Dashboard") && answerable(f));
      instance.unmount();

      const lines = frame.split("\n");
      const hints = lines.findIndex((line) => line.includes("←→ choose"));
      // The popup's bottom edge, as wide as the popup: above the rule over the hints, not under it.
      const edge = lines.findIndex((line) => line.includes(`╰${"─".repeat(Math.min(52, columns - 4) - 2)}╯`));
      expect(lines.length).toBeLessThanOrEqual(rows - 2);
      expect(lines[hints]?.trimEnd()).toMatch(/←→ choose │ enter select │ esc not now$/);
      expect(lines[hints - 2]).toMatch(/^\s*─+\s*$/);
      expect(edge).toBeGreaterThan(0);
      expect(edge).toBeLessThan(hints - 2);
    });
  }

  it("opens over the dashboard on Star, takes the keys, and stars on Enter", async () => {
    const { star, give, claimPrompt } = fakeStar({ ask: true });
    const instance = render(<App initialScreen="dashboard" star={star} />);

    const frame = await waitForFrame(instance.lastFrame, (f) => dashboard(f) && answerable(f));
    expect(frame).toContain("A star on GitHub helps other people find it.");
    expect(frame).toContain("Not now");
    expect(frame).toContain("←→ choose");

    // The arrows choose in the popup; the dashboard's cursor stays where it was.
    await press(instance, RIGHT);
    await press(instance, RIGHT);
    instance.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await press(instance, ENTER);

    const done = await waitForFrame(instance.lastFrame, (f) => f.includes("as @octocat. Thank you!"));
    expect(done).toContain("Starred larcane97/clausona");
    expect(give).toHaveBeenCalledTimes(1);

    // Any key closes it.
    await press(instance, "x");
    const closed = await waitForFrame(instance.lastFrame, (f) => dashboard(f) && !f.includes("as @octocat"));
    expect(closed).not.toContain("Enjoying clausona?");
    expect(focusedOn(closed, "Profiles")).toBe(true);
    expect(claimPrompt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Not now", [RIGHT, ENTER]],
    ["esc", [ESC]],
  ])("closes on %s without starring or quitting", async (_name, keys) => {
    const { star, give } = fakeStar({ ask: true });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, answerable);

    for (const key of keys) await press(instance, key);

    const frame = await waitForFrame(instance.lastFrame, (f) => dashboard(f) && !asking(f));
    expect(frame).not.toContain("Press ESC again");
    expect(give).not.toHaveBeenCalled();
  });

  it("says in the popup where the page opened, or the address", async () => {
    for (const [outcome, said] of [
      [{ kind: "opened", url: STAR_URL }, "Press Star at the top of the page."],
      [{ kind: "manual", url: STAR_URL }, STAR_URL],
    ] as const) {
      const { star } = fakeStar({ ask: true, outcome });
      const instance = render(<App initialScreen="dashboard" star={star} />);
      await waitForFrame(instance.lastFrame, answerable);
      await press(instance, ENTER);

      await waitForFrame(instance.lastFrame, (f) => f.includes(said));
      instance.unmount();
    }
  });

  it("does not open under the Loading screen, where an Enter meant for the dashboard would star", async () => {
    const listed = vi.mocked(listProfiles).getMockImplementation();
    vi.mocked(listProfiles).mockImplementationOnce(async (...args) => {
      await sleep(300);
      return listed ? listed(...args) : [];
    });
    const { star, give } = fakeStar({ ask: true });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Reading clausona state"));

    instance.stdin.write(ENTER);
    let frame = await waitForFrame(instance.lastFrame, (f) => !f.includes("Reading clausona state"));
    expect(give).not.toHaveBeenCalled();

    // The Enter went to the dashboard; the popup waits for it to be back on screen.
    if (!dashboard(frame)) await press(instance, ESC);
    frame = await waitForFrame(instance.lastFrame, (f) => dashboard(f) && answerable(f));
    expect(give).not.toHaveBeenCalled();
  });

  it("takes no answer in the moment after it appears", async () => {
    const { star, give } = fakeStar({ ask: true });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, (f) => asking(f) && !f.includes("enter select"));

    instance.stdin.write(ENTER);
    await sleep(50);
    expect(give).not.toHaveBeenCalled();

    const frame = await waitForFrame(instance.lastFrame, answerable);
    expect(frame).toContain("[ ★ Star ]");
    expect(give).not.toHaveBeenCalled();
  });

  it("keeps starring when another key comes in the same read as the Enter", async () => {
    let finish: (outcome: StarOutcome) => void = () => {};
    const { star, give } = fakeStar({
      ask: true,
      give: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, answerable);

    await sleep(0);
    instance.stdin.write(ENTER);
    instance.stdin.write(ESC);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Starring clausona on GitHub"));
    await sleep(50);
    expect(instance.lastFrame()).toContain("Starring clausona on GitHub");

    finish({ kind: "starred", login: "octocat" });
    await waitForFrame(instance.lastFrame, (f) => f.includes("as @octocat. Thank you!"));
    expect(give).toHaveBeenCalledTimes(1);
  });

  it("calls off a star under way when the App goes, and records nothing", async () => {
    let seen: AbortSignal | undefined;
    const { star, record } = fakeStar({
      ask: true,
      give: (signal?: AbortSignal) => {
        seen = signal;
        return new Promise(() => {});
      },
    });
    const instance = render(<App initialScreen="dashboard" star={star} />);
    await waitForFrame(instance.lastFrame, answerable);
    await press(instance, ENTER);
    await waitForFrame(instance.lastFrame, (f) => f.includes("Starring clausona on GitHub"));

    instance.unmount();
    expect(seen?.aborted).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });
});
