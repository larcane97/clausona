import { describe, expect, it, vi } from "vitest";

import type { DiscoveredAccount, DoctorProfileResult, ProfileListItem } from "../types.js";

/**
 * The screens in a terminal of a given height. Once ink's frame is as tall as the terminal, ink
 * clears the terminal, scrollback included, and writes the whole frame again on every render: a
 * taller frame loses its top - the title, the list's cursor - for good, and one as tall flickers on
 * every key. So every frame here must be at most `rows - 2` lines, as the Extensions screen keeps
 * its own (#179, #180, #182).
 */

const NONE = { cost: 0, inputTokens: 0, outputTokens: 0 };

function profiles(count: number): ProfileListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    name: i === 0 ? "claude:main" : i === 1 ? "claude:work" : `claude:p${String(i).padStart(2, "0")}`,
    tool: "claude",
    // Long, so that the re-login question's line about it wraps.
    email: i === 1 ? "jaewon.someone.with.a.long.address@example-company.com" : `user${i}@example.com`,
    configDir: i === 0 ? "/Users/test/.claude" : `/Users/test/.claude-p${i}`,
    isPrimary: i === 0,
    // The one with the findings, so the dashboard shows them too.
    isActive: i === 1,
    today: NONE,
    week: NONE,
    month: NONE,
    total: NONE,
  }));
}

/** `claude:work`'s findings: `count` files that replaced their shared link, as doctor reports them. */
function doctorFor(list: ProfileListItem[], count: number): DoctorProfileResult[] {
  return list.map((p) => ({
    name: p.name,
    email: p.email,
    configDir: p.configDir,
    isPrimary: p.isPrimary,
    healthy: true,
    issues:
      p.name === "claude:work"
        ? Array.from({ length: count }, (_, i) => ({
            kind: "local_override" as const,
            severity: "warning" as const,
            message: `notes-${String(i + 1).padStart(2, "0")}.json replaced an expected shared link`,
          }))
        : [],
  }));
}

/** Accounts Init and Add find: `count` Claude config directories, the first the primary. */
function accounts(count: number): DiscoveredAccount[] {
  return Array.from({ length: count }, (_, i) => ({
    tool: "claude",
    configDir: `/Users/test/.claude-found${String(i).padStart(2, "0")}`,
    email: `found${i}@example.com`,
    isPrimary: i === 0,
    jsonPath: `/Users/test/.claude-found${i}/.claude.json`,
    keychainService: "unused",
  }));
}

const state = { profiles: profiles(3), doctor: doctorFor(profiles(3), 15), accounts: accounts(3) };

function given(count: number, findings: number) {
  state.profiles = profiles(count);
  state.doctor = doctorFor(state.profiles, findings);
  state.accounts = accounts(count);
}

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({
    accounts: state.accounts,
    profileNames: Object.fromEntries(state.accounts.map((a, i) => [a.configDir, `claude:found${i}`])),
    defaultProfile: "claude:found0",
  })),
}));

vi.mock("../lib/service", async (importOriginal) => ({
  defaultAuthScheme: (await importOriginal<typeof import("../lib/service.js")>()).defaultAuthScheme,
  listProfiles: vi.fn(async () => state.profiles),
  doctorProfiles: vi.fn(async () => state.doctor),
  fetchProfileQuotas: vi.fn(async () => ({})),
  loginProfile: vi.fn(),
  registryProblem: vi.fn(async () => null),
  repairProfile: vi.fn(async () => ({ repaired: 0 })),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => state.accounts),
}));

vi.setConfig({ testTimeout: 15_000 });

import { stripAnsi } from "../lib/cli-style.js";
import { App } from "./App.js";
import { CURSOR, DOWN, ENTER, press, renderAt, type, waitForFrame } from "./test-drive.js";

const lines = (frame: string | undefined) => stripAnsi(frame ?? "").split("\n");

/** Every frame the screen drew from `from` on is at most `rows - 2` lines, and has the title. */
function expectFits(frames: string[], from: number, rows: number, title: string) {
  for (const frame of frames.slice(from)) {
    const drawn = lines(frame);
    expect(drawn.length, drawn.join("\n")).toBeLessThanOrEqual(rows - 2);
    expect(drawn.join("\n")).toContain(`CLAUSONA   │ ${title}`);
  }
}

describe("a profile's findings, in the terminal's height (#179)", () => {
  for (const [columns, rows] of [
    [80, 24],
    [100, 30],
    [120, 40],
  ] as const) {
    it(`keep Profiles inside ${columns}×${rows}, its selected row in view`, async () => {
      given(3, 15);
      const app = renderAt(<App initialScreen="use" />, columns, { rows });
      await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Health"));
      const from = app.frames.length - 1;
      await press(app, DOWN);
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes(`${CURSOR}  claude:work`));
      app.unmount();

      expectFits(app.frames, from, rows, "Profiles");
      expect(lines(frame).some((line) => line.includes(`${CURSOR}  claude:work`))).toBe(true);
    });
  }

  for (const [columns, rows] of [
    [80, 30],
    [120, 40],
  ] as const) {
    it(`keep the dashboard inside ${columns}×${rows}, and count the findings left out`, async () => {
      given(3, 15);
      const app = renderAt(<App initialScreen="dashboard" />, columns, { rows });
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Health") && f.includes("Profiles"));
      app.unmount();

      expectFits([frame], 0, rows, "Dashboard");
      const shown = lines(frame).filter((line) => line.includes("➔")).length;
      expect(shown).toBeLessThan(15);
      expect(lines(frame).join("\n")).toContain(`… ${15 - shown} more in Health check`);
    });
  }

  it("keep Profiles inside the terminal with the remove question open under them", async () => {
    given(3, 15);
    const app = renderAt(<App initialScreen="use" />, 80, { rows: 30 });
    await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Health"));
    await press(app, DOWN);
    const from = app.frames.length;
    await press(app, "d");
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes('Remove "claude:work"?'));
    app.unmount();

    expectFits(app.frames, from, 30, "Profiles");
    expect(lines(frame).join("\n")).toContain("y confirm");
  });

  for (const columns of [50, 60, 80, 120]) {
    it(`keep Profiles inside the terminal with each question open under them, ${columns} wide`, async () => {
      for (const [down, key, asks] of [
        [0, "d", "Cannot remove the primary profile."],
        [1, "d", 'Remove "claude:work"?'],
        [1, "l", 'Re-login "claude:work"?'],
        [1, "s", 'Change sessions for "claude:work"?'],
      ] as const) {
        given(3, 15);
        const app = renderAt(<App initialScreen="use" />, columns, { rows: 30 });
        await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Health"));
        for (let i = 0; i < down; i++) await press(app, DOWN);
        const from = app.frames.length;
        await press(app, key);
        await waitForFrame(app.lastFrame, (f) =>
          stripAnsi(f)
            .replace(/[\s│]+/g, " ")
            .includes(asks.slice(0, 12)),
        );
        app.unmount();

        expectFits(app.frames, from, 30, "Profiles");
      }
    });
  }

  it("draws everything as before when the terminal gives no height", async () => {
    given(3, 15);
    const app = renderAt(<App initialScreen="use" />, 120);
    await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Health"));
    await press(app, DOWN);
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes("notes-15.json"));
    app.unmount();

    expect(lines(frame).filter((line) => line.includes("➔"))).toHaveLength(15);
  });
});

/** Every frame from `from` on at most `rows - 2` lines; the last one titled `title`. */
function expectInside(frames: string[], from: number, rows: number, title: string) {
  for (const frame of frames.slice(from)) {
    const drawn = lines(frame);
    expect(drawn.length, drawn.join("\n")).toBeLessThanOrEqual(rows - 2);
  }
  expect(lines(frames.at(-1)).join("\n")).toContain(`CLAUSONA   │ ${title}`);
}

/** The count a `↑ N more` or `↓ N more` line in `frame` says, or 0. */
const more = (frame: string | undefined, arrow: "↑" | "↓") =>
  Number(
    lines(frame)
      .join("\n")
      .match(new RegExp(`${arrow} (\\d+) more`))?.[1] ?? 0,
  );

const SIZES = [
  [80, 24],
  [100, 30],
  [120, 40],
] as const;

describe("lists of every profile or account, in the terminal's height (#180)", () => {
  for (const [columns, rows] of SIZES) {
    it(`Profiles keeps 30 profiles inside ${columns}×${rows}, the cursor in view to the last`, async () => {
      given(30, 15);
      const app = renderAt(<App initialScreen="use" />, columns, { rows });
      await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Account"));
      expect(more(app.lastFrame(), "↓")).toBeGreaterThan(0);
      for (let i = 0; i < 29; i++) await press(app, DOWN);
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes(`${CURSOR}  claude:p29`));
      app.unmount();

      expectInside(app.frames, 0, rows, "Profiles");
      expect(more(frame, "↑")).toBeGreaterThan(0);
      expect(more(frame, "↓")).toBe(0);
    });

    it(`Health check keeps 30 profiles and 15 findings inside ${columns}×${rows}`, async () => {
      given(30, 15);
      const app = renderAt(<App initialScreen="doctor" />, columns, { rows });
      await waitForFrame(app.lastFrame, (f) => f.includes("Health Check") && f.includes("claude:main"));
      await press(app, DOWN);
      const findings = await waitForFrame(app.lastFrame, (f) => f.includes("➔ notes-01"));
      for (let i = 0; i < 28; i++) await press(app, DOWN);
      const last = await waitForFrame(app.lastFrame, (f) => f.includes(`${CURSOR}  claude:p29`));
      app.unmount();

      expectInside(app.frames, 0, rows, "Health Check");
      // The findings that fit, and the count of the rest - cut at the pane's edge when it is narrow.
      const shown = lines(findings).filter((line) => line.includes("➔")).length;
      if (shown < 15) expect(lines(findings).join("\n")).toContain(`… ${15 - shown} more · csn`);
      expect(more(last, "↓")).toBe(0);
    });

    it(`Usage keeps 30 profiles inside ${columns}×${rows}, and ↑↓ scroll them to the last`, async () => {
      given(30, 0);
      const app = renderAt(<App initialScreen="usage" />, columns, { rows });
      const first = await waitForFrame(app.lastFrame, (f) => f.includes("Total"));
      expect(lines(first).join("\n")).toContain("↑↓ scroll");
      // More than it takes: a key past the end changes nothing, so none is waited on.
      for (let i = 0; i < 30; i++) await type(app, DOWN);
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes("claude:p29"));
      app.unmount();

      expectInside(app.frames, 0, rows, "Usage");
      expect(more(frame, "↓")).toBe(0);
      expect(lines(frame).join("\n")).toContain("Total");
    });

    it(`Add keeps 30 discovered accounts inside ${columns}×${rows}`, async () => {
      given(30, 0);
      const app = renderAt(<App initialScreen="use" />, columns, { rows });
      await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile"));
      await press(app, "a");
      await waitForFrame(app.lastFrame, (f) => f.includes("Discover accounts"));
      await press(app, ENTER);
      await waitForFrame(app.lastFrame, (f) => f.includes("Select accounts to register"));
      for (let i = 0; i < 29; i++) await press(app, DOWN);
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes("found29@example.com"));
      app.unmount();

      expectInside(app.frames, 0, rows, "Add Profile");
      expect(more(frame, "↓")).toBe(0);
    });
  }
});

describe("Init's accounts, in the terminal's height (#180)", () => {
  // From 100×30: below that its name form, which has no list, is taller than the terminal.
  for (const [columns, rows] of SIZES.filter(([, height]) => height >= 30)) {
    it(`Init keeps 30 accounts inside ${columns}×${rows}, choosing and reviewing them`, async () => {
      given(30, 0);
      const app = renderAt(<App initialScreen="init" />, columns, { rows });
      await waitForFrame(app.lastFrame, (f) => f.includes("Select accounts"));
      for (let i = 0; i < 29; i++) await press(app, DOWN);
      await waitForFrame(app.lastFrame, (f) => f.includes("found29@example.com"));
      // Select all, accept each suggested name, keep the default: on to the review.
      await press(app, ENTER);
      for (let i = 0; i < 30; i++) await press(app, ENTER);
      await waitForFrame(app.lastFrame, (f) => f.includes("Choose the default profile"));
      for (let i = 0; i < 29; i++) await press(app, DOWN);
      await waitForFrame(app.lastFrame, (f) => f.includes(`${CURSOR}  claude:found29`));
      await press(app, ENTER);
      const review = await waitForFrame(app.lastFrame, (f) => f.includes("Review before applying"));
      expect(lines(review).join("\n")).toContain("↑↓ scroll");
      for (let i = 0; i < 30; i++) await type(app, DOWN);
      const end = await waitForFrame(app.lastFrame, (f) => f.includes("found29@example.com"));
      app.unmount();

      expectInside(app.frames, 0, rows, "Initialize");
      expect(more(end, "↓")).toBe(0);
    });
  }
});

describe("the fixed layout in a short terminal (#182)", () => {
  for (const [columns, rows] of [
    [80, 24],
    [100, 30],
  ] as const) {
    it(`keeps the dashboard's title and menu inside ${columns}×${rows}`, async () => {
      given(1, 0);
      state.profiles[0].isActive = true;
      const app = renderAt(<App initialScreen="dashboard" />, columns, { rows });
      const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Health") && f.includes("Profiles"));
      app.unmount();

      expectInside(app.frames, 0, rows, "Dashboard");
      expect(lines(frame).some((line) => line.includes(`${CURSOR}  Profiles`))).toBe(true);
    });

    it(`keeps Profiles and Usage inside ${columns}×${rows} with one profile`, async () => {
      for (const [screen, title, ready] of [
        ["use", "Profiles", "Account"],
        ["usage", "Usage", "Total"],
      ] as const) {
        given(1, 0);
        const app = renderAt(<App initialScreen={screen} />, columns, { rows });
        await waitForFrame(app.lastFrame, (f) => f.includes(ready));
        app.unmount();

        expectInside(app.frames, 0, rows, title);
      }
    });
  }
});
