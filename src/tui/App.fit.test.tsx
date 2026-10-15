import { describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, ProfileListItem } from "../types.js";

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

const state = { profiles: profiles(3), doctor: doctorFor(profiles(3), 15) };

function given(count: number, findings: number) {
  state.profiles = profiles(count);
  state.doctor = doctorFor(state.profiles, findings);
}

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
  discoverAccounts: vi.fn(async () => []),
}));

vi.setConfig({ testTimeout: 15_000 });

import { stripAnsi } from "../lib/cli-style.js";
import { App } from "./App.js";
import { CURSOR, DOWN, press, renderAt, waitForFrame } from "./test-drive.js";

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
