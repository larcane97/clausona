import { describe, expect, it, vi } from "vitest";

import type { DiscoveredAccount, DoctorProfileResult, ProfileListItem, UsageSummary } from "../types.js";

/**
 * How the screens hold up when what they show is longer than the room it is given: profile
 * names past the fourteen columns the Usage table had, token counts past ten billion, config
 * paths and messages longer than a panel is wide. Each case here rendered as two values run
 * together, or as a name that was simply not on screen.
 */

const usage = (cost: number, inputTokens: number, outputTokens: number): UsageSummary => ({
  cost,
  inputTokens,
  outputTokens,
});

function profile(
  name: string,
  email: string,
  spend: UsageSummary,
  extra: Partial<ProfileListItem> = {},
): ProfileListItem {
  return {
    name,
    tool: name.startsWith("codex:") ? "codex" : "claude",
    email,
    configDir: `/Users/test/.${name.replace(":", "-")}`,
    isPrimary: false,
    isActive: false,
    today: spend,
    week: spend,
    month: spend,
    total: spend,
    ...extra,
  };
}

const NONE = usage(0, 0, 0);

const PROFILES: ProfileListItem[] = [
  profile("claude:default", "a@example.com", usage(30068.38, 70_959_950, 136_038_742), {
    isPrimary: true,
    configDir: "/Users/test/.claude",
  }),
  profile("claude:personal", "personal.account@example.com", NONE),
  profile("codex:company-workspace", "company@example.com", NONE, { isActive: true }),
  profile(
    "claude:jaewon-yanolja-team",
    "jaewon.someone@example-company.com",
    usage(1111593.89, 80_951_966, 368_296_625),
  ),
  profile("claude:glm-flash", "glm@example.com", usage(20909.24, 12_158_463_108, 13_769_226)),
];

const ISSUE = "/Users/test/.claude-jaewon-yanolja-team/.last-update-result.json replaced an expected shared link";

const DOCTOR: DoctorProfileResult[] = PROFILES.map((p) => ({
  name: p.name,
  email: p.email,
  configDir: p.configDir,
  isPrimary: p.isPrimary,
  healthy: true,
  issues:
    p.name === "claude:jaewon-yanolja-team" ? [{ kind: "local_override", severity: "warning", message: ISSUE }] : [],
}));

const FOUND: Omit<DiscoveredAccount, "jsonPath" | "keychainService">[] = [
  { tool: "claude", configDir: "/Users/test/.claude", email: "a@example.com", isPrimary: true },
  {
    tool: "claude",
    configDir: "/Users/test/.claude-jaewon-yanolja-team",
    email: "jaewon.someone.with.a.long.address@example-company.com",
    isPrimary: false,
  },
  { tool: "codex", configDir: "/Users/test/.codex-company", email: "company@example.com", isPrimary: false },
];
const ACCOUNTS: DiscoveredAccount[] = FOUND.map((account) => ({
  ...account,
  jsonPath: `${account.configDir}/.claude.json`,
  keychainService: "unused",
}));

const NAMES: Record<string, string> = {
  "/Users/test/.claude": "claude:default",
  "/Users/test/.claude-jaewon-yanolja-team": "claude:jaewon-yanolja-team",
  "/Users/test/.codex-company": "codex:company-workspace",
};

vi.mock("../commands", () => ({
  bootstrapInitFromCurrentState: vi.fn(async () => ({
    accounts: ACCOUNTS,
    profileNames: NAMES,
    defaultProfile: "claude:default",
  })),
}));

vi.mock("../lib/service", async (importOriginal) => ({
  defaultAuthScheme: (await importOriginal<typeof import("../lib/service.js")>()).defaultAuthScheme,
  listProfiles: vi.fn(async () => PROFILES),
  doctorProfiles: vi.fn(async () => DOCTOR),
  fetchProfileQuotas: vi.fn(async () => ({})),
  loginProfile: vi.fn(),
  registryProblem: vi.fn(async () => null),
  repairProfile: vi.fn(async () => ({ repaired: 0 })),
  initializeRegistry: vi.fn(async () => ({})),
  setActiveProfileByName: vi.fn(async () => ({})),
  discoverAccounts: vi.fn(async () => []),
  addApiProfile: vi.fn(async () => ({ name: "gateway", configDir: "/Users/test/.claude-gateway" })),
}));

vi.setConfig({ testTimeout: 15_000 });

import { stripAnsi } from "../lib/cli-style.js";
import { App } from "./App.js";
import { DOWN, ENTER, press, renderAt, waitForFrame } from "./test-drive.js";

const lines = (frame: string) => stripAnsi(frame).split("\n");

/** A table row's cells: the text between the panel's borders, split on runs of two or more spaces. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*│\s*/, "")
    .replace(/\s*│\s*$/, "")
    .split(/\s{2,}/);
}

describe("Usage", () => {
  async function table(columns: number) {
    const app = renderAt(<App initialScreen="usage" />, columns);
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Total"));
    app.unmount();
    const rows = lines(frame).filter((line) => /claude:|codex:|Total/.test(line));
    return Object.fromEntries(rows.map((row) => [cells(row)[0], cells(row)]));
  }

  it("keeps a name longer than the old fourteen columns whole, and apart from its cost", async () => {
    const rows = await table(100);

    expect(rows["claude:default"]).toEqual(["claude:default", "$30068.38", "70,959,950", "136,038,742"]);
    expect(rows["claude:personal"]).toEqual(["claude:personal", "—", "—", "—"]);
    expect(rows["claude:jaewon-yanolja-team"]?.[1]).toBe("$1111593.89");
  });

  it("keeps a count past ten billion apart from the column after it", async () => {
    const rows = await table(100);

    expect(rows["claude:glm-flash"]).toEqual(["claude:glm-flash", "$20909.24", "12,158,463,108", "13,769,226"]);
    expect(rows.Total?.slice(2)).toEqual(["12,310,375,024", "518,104,593"]);
  });

  // Between the two, a name is cut to make room for the numbers in full; below that, the
  // numbers take their short form so a name keeps its sixteen columns.
  it("cuts a long name with an ellipsis before it shortens any number", async () => {
    const rows = await table(72);

    expect(Object.values(rows).find((row) => row[0]?.startsWith("claude:jaewon"))).toEqual([
      "claude:jaewon-yanol…",
      "$1111593.89",
      "80,951,966",
      "368,296,625",
    ]);
  });

  it("puts the numbers in their short form once the name is down to its floor", async () => {
    const rows = await table(50);

    expect(Object.values(rows).find((row) => row[0]?.startsWith("claude:jaewon"))).toEqual([
      "claude:jaewon-ya…",
      "$1.1M",
      "81M",
      "368.3M",
    ]);
  });

  it("fits itself again when the terminal is resized", async () => {
    const app = renderAt(<App initialScreen="usage" />, 100);
    await waitForFrame(app.lastFrame, (f) => f.includes("136,038,742"));
    app.resize(60);
    const narrow = await waitForFrame(app.lastFrame, (f) => f.includes("136M"));
    app.resize(100);
    const wide = await waitForFrame(app.lastFrame, (f) => f.includes("136,038,742"));
    app.unmount();

    const row = (frame: string) => cells(lines(frame).find((line) => line.includes("claude:default")) ?? "");
    // Measured at 100 and never measured again, the counts were cut to `70,959,95`.
    expect(row(narrow)).toEqual(["claude:default", "$30.1K", "71M", "136M"]);
    expect(row(wide)).toEqual(["claude:default", "$30068.38", "70,959,950", "136,038,742"]);
  });

  it("never cuts a number to fit a narrow terminal: it shortens the name, then the numbers' form", async () => {
    const rows = await table(60);
    const all = Object.values(rows);

    // Every row still has four cells, none of them run into the next.
    for (const row of all) expect(row).toHaveLength(4);
    // A number is whole or in its short form - never a full number with its end cut off.
    for (const row of all) {
      for (const cell of row.slice(1)) expect(cell).toMatch(/^(—|\$?\d+(\.\d+)?[KMB]?|\$\d+\.\d\d|[\d,]+)$/);
    }
    expect(rows["claude:default"]?.slice(1)).toEqual(["$30.1K", "71M", "136M"]);
    // A name is whole, or cut with an ellipsis.
    const names = Object.keys(rows).filter((name) => name !== "Total");
    for (const name of names) {
      expect(
        PROFILES.some((p) => p.name === name || (name.endsWith("…") && p.name.startsWith(name.slice(0, -1)))),
      ).toBe(true);
    }
  });
});

describe("Profiles", () => {
  it("draws the preview in one border, not a border inside another", async () => {
    const app = renderAt(<App initialScreen="use" />, 80);
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile") && f.includes("Account"));
    app.unmount();

    // The list's panel and the preview's: two boxes on screen, not three.
    expect(stripAnsi(frame).match(/╭/g)).toHaveLength(2);
  });
});

describe("Health check", () => {
  async function onJaewon(columns: number) {
    const app = renderAt(<App initialScreen="doctor" />, columns);
    await waitForFrame(app.lastFrame, (f) => f.includes("Health Check") && f.includes("claude:default"));
    for (let i = 0; i < 3; i++) await press(app, DOWN);
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Issues"));
    app.unmount();
    return lines(frame);
  }

  it("keeps a space between an issue's arrow and a message longer than the panel", async () => {
    const issueLine = (await onJaewon(80)).find((line) => line.includes("➔"));

    expect(issueLine).toMatch(/➔ \/Users/);
  });

  it("keeps the severity icon apart from a name too long for the panel", async () => {
    const header = (await onJaewon(60)).find((line) => line.includes("◈"));

    expect(header).toMatch(/claude:jaewon\S*… ◈/);
  });
});

describe("Initialize review", () => {
  it("shows each name and account whole, whatever their length", async () => {
    const app = renderAt(<App initialScreen="init" />, 80);
    await waitForFrame(app.lastFrame, (f) => f.includes("Select accounts"));
    // Select all, accept each suggested name, keep the default.
    await press(app, ENTER);
    for (let i = 0; i < ACCOUNTS.length; i++) await press(app, ENTER);
    await press(app, ENTER);
    const frame = lines(await waitForFrame(app.lastFrame, (f) => f.includes("Review before applying")));
    app.unmount();

    for (const name of Object.values(NAMES)) expect(frame.some((line) => line.includes(name))).toBe(true);
    for (const account of ACCOUNTS) expect(frame.some((line) => line.includes(account.email))).toBe(true);
  });
});

describe("an unreadable registry", () => {
  it("keeps a space between the cross and a message longer than the line", async () => {
    const service = await import("../lib/service.js");
    vi.mocked(service.listProfiles).mockResolvedValueOnce([]);
    vi.mocked(service.registryProblem).mockResolvedValueOnce(
      "/Users/test/.clausona/profiles.json could not be parsed: Unexpected token } in JSON at position 1234",
    );
    const app = renderAt(<App initialScreen="dashboard" />, 60);
    const frame = await waitForFrame(app.lastFrame, (f) => f.includes("Cannot read profiles"));
    app.unmount();

    expect(lines(frame).find((line) => line.includes("✘"))).toMatch(/✘ \/Users/);
  });
});

describe("Import from path", () => {
  it("keeps the field's cursor and label whole beside a path longer than the line", async () => {
    const app = renderAt(<App initialScreen="use" />, 60);
    await waitForFrame(app.lastFrame, (f) => f.includes("Select a profile"));
    await press(app, "a");
    await waitForFrame(app.lastFrame, (f) => f.includes("Choose how to add"));
    await press(app, DOWN);
    await press(app, DOWN);
    await press(app, ENTER);
    await waitForFrame(app.lastFrame, (f) => f.includes("Enter the config directory path"));
    await press(app, "/Users/test/.claude-jaewon-yanolja-team-account-imported");
    const frame = lines(app.lastFrame() ?? "");
    app.unmount();

    expect(frame.find((line) => line.includes("Path"))).toMatch(/✦ Path: {2}\/Users/);
  });
});
