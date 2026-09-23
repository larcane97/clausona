import { describe, expect, it } from "vitest";
import { type ApiHealthInput, countIssues, evaluateApiHealth, evaluateSymlinkHealth } from "../core/doctor.js";
import type {
  ApiEndpoint,
  DoctorIssue,
  DoctorProfileResult,
  Profile,
  ProfileListItem,
  QuotaSnapshot,
} from "../types.js";
import { stripAnsi } from "./cli-style.js";
import {
  doctorSeverity,
  doctorSummary,
  fitModel,
  fitQuotaValue,
  formatAge,
  formatModel,
  formatQuotaInline,
  formatQuotaPercent,
  formatResetIn,
  formatResetShort,
  LIST_MIN_WIDTH,
  pickLayout,
  quotaBar,
  quotaNotes,
  quotaSeverity,
  renderDoctor,
  renderList,
} from "./format.js";

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return { state: "ok", fetchedAt: 0, ...overrides };
}

describe("formatQuotaPercent", () => {
  it("rounds to a whole percent", () => {
    expect(formatQuotaPercent({ usedPercent: 44.6, resetsAt: null })).toBe("45%");
  });

  it("renders an em dash when the window is absent", () => {
    expect(formatQuotaPercent(undefined)).toBe("—");
  });
});

describe("formatResetIn", () => {
  const now = new Date("2026-09-04T00:00:00Z");

  it("formats sub-hour, hour, and multi-day gaps", () => {
    expect(formatResetIn("2026-09-04T00:42:00Z", now)).toBe("42m");
    expect(formatResetIn("2026-09-04T02:10:00Z", now)).toBe("2h 10m");
    expect(formatResetIn("2026-09-04T05:00:00Z", now)).toBe("5h");
    expect(formatResetIn("2026-09-07T04:00:00Z", now)).toBe("3d 4h");
    expect(formatResetIn("2026-09-07T00:00:00Z", now)).toBe("3d");
  });

  it("collapses an elapsed window to `now`", () => {
    expect(formatResetIn("2026-09-03T23:00:00Z", now)).toBe("now");
  });

  it("handles a missing or unparseable timestamp", () => {
    expect(formatResetIn(null, now)).toBe("—");
    expect(formatResetIn("not a date", now)).toBe("—");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const at = (iso: string) => formatAge(Date.parse(iso), now);

  it("describes how long ago a reading was taken", () => {
    expect(at("2026-09-04T11:58:00Z")).toBe("2m ago");
    expect(at("2026-09-04T09:00:00Z")).toBe("3h ago");
    expect(at("2026-09-01T09:00:00Z")).toBe("3d ago");
  });

  it("collapses anything under a minute", () => {
    expect(at("2026-09-04T11:59:30Z")).toBe("just now");
  });
});

describe("formatQuotaInline", () => {
  it("joins the windows it has", () => {
    const quota = snapshot({
      session: { usedPercent: 61, resetsAt: null },
      weekly: { usedPercent: 100, resetsAt: null },
    });

    expect(formatQuotaInline(quota)).toBe("5h 61% | 7d 100%");
  });

  it("omits a window the plan does not report", () => {
    expect(formatQuotaInline(snapshot({ weekly: { usedPercent: 4, resetsAt: null } }))).toBe("7d 4%");
  });

  it("flags a reading that is not current", () => {
    const quota = snapshot({ state: "cooldown", weekly: { usedPercent: 4, resetsAt: null } });

    expect(formatQuotaInline(quota)).toBe("7d 4% (cooldown)");
  });

  it("falls back to the bare state when there are no numbers", () => {
    expect(formatQuotaInline(snapshot({ state: "expired" }))).toBe("expired");
    expect(formatQuotaInline(undefined)).toBe("");
  });
});

describe("quotaSeverity", () => {
  it("grades on the most-consumed window", () => {
    const peak = (session: number, weekly: number) =>
      quotaSeverity(
        snapshot({
          session: { usedPercent: session, resetsAt: null },
          weekly: { usedPercent: weekly, resetsAt: null },
        }),
      );

    expect(peak(5, 46)).toBe("healthy");
    expect(peak(5, 77)).toBe("warning");
    expect(peak(100, 46)).toBe("error");
  });

  it("stays neutral when the reading is not live", () => {
    expect(quotaSeverity(snapshot({ state: "cooldown", weekly: { usedPercent: 100, resetsAt: null } }))).toBe("muted");
    expect(quotaSeverity(undefined)).toBe("muted");
  });
});

describe("quotaNotes", () => {
  const item = (quota?: QuotaSnapshot) => ({ quota }) as ProfileListItem;

  it("emits one note per distinct problem", () => {
    const notes = quotaNotes([
      item(snapshot()),
      item(snapshot({ state: "expired" })),
      item(snapshot({ state: "expired" })),
      item(snapshot({ state: "missing" })),
    ]);

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^expired: /);
    expect(notes[1]).toMatch(/^missing: /);
  });

  it("is silent when everything is current", () => {
    expect(quotaNotes([item(snapshot()), item(undefined)])).toEqual([]);
  });
});

describe("formatResetShort", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const at = (iso: string) => formatResetShort(iso, now);

  it("collapses to a single unit for table cells", () => {
    expect(at("2026-09-04T00:42:00Z")).toBe("42m");
    expect(at("2026-09-04T02:10:00Z")).toBe("2h");
    expect(at("2026-09-07T04:00:00Z")).toBe("3d");
  });

  it("never rounds a live window down to zero", () => {
    expect(at("2026-09-04T00:00:30Z")).toBe("1m");
    expect(at("2026-09-03T23:00:00Z")).toBe("now");
  });

  it("is empty when there is nothing to report", () => {
    expect(formatResetShort(null, now)).toBe("");
    expect(formatResetShort("nope", now)).toBe("");
  });
});

describe("pickLayout", () => {
  it("keeps every column when the terminal is wide", () => {
    expect(pickLayout(true, 200).keys).toEqual(["profile", "account", "session", "weekly", "cost", "input", "output"]);
  });

  it("drops token counts before cost, and cost before quota", () => {
    expect(pickLayout(true, 104).keys).not.toContain("output");
    expect(pickLayout(true, 104).keys).toContain("cost");

    const narrow = pickLayout(true, 80).keys;
    expect(narrow).not.toContain("cost");
    expect(narrow).toEqual(["profile", "account", "session", "weekly"]);
  });

  it("gives up reset times before it gives up the quota columns", () => {
    expect(pickLayout(true, 78).reset).toBe(true);
    expect(pickLayout(true, 70).reset).toBe(false);
    expect(pickLayout(true, 70).keys).toContain("session");
  });

  it("shrinks the name and account columns as a last resort", () => {
    const tiny = pickLayout(true, 40);
    expect(tiny.profileWidth).toBeLessThan(20);
    expect(tiny.accountWidth).toBeLessThan(32);
    expect(tiny.keys).toContain("weekly");
  });

  it("keeps the pre-quota layout when quota is not shown", () => {
    expect(pickLayout(false, 200).keys).toEqual(["profile", "account", "cost", "input", "output"]);
  });
});

describe("renderList width", () => {
  const item = (name: string, quota?: QuotaSnapshot): ProfileListItem => ({
    name,
    tool: "claude",
    email: `${name}@example.com`,
    configDir: `/home/u/.claude-${name}`,
    isPrimary: false,
    isActive: false,
    quota,
    today: { cost: 0, inputTokens: 0, outputTokens: 0 },
    week: { cost: 1, inputTokens: 10, outputTokens: 5 },
    month: { cost: 1, inputTokens: 10, outputTokens: 5 },
    total: { cost: 1, inputTokens: 10, outputTokens: 5 },
  });

  const visibleWidth = (line: string) => stripAnsi(line).length;

  it("never emits a line wider than the terminal", () => {
    const items = [
      item("a-very-long-profile-name-indeed", snapshot({ session: { usedPercent: 5, resetsAt: null } })),
      item("short", snapshot({ weekly: { usedPercent: 100, resetsAt: "2030-01-01T00:00:00Z" } })),
    ];

    for (const width of [LIST_MIN_WIDTH, 60, 70, 78, 80, 90, 100, 104, 120, 200]) {
      const lines = renderList(items, { width }).split("\n");
      const over = lines.filter((line) => visibleWidth(line) > width);
      expect(over, `width ${width} overflowed: ${JSON.stringify(over)}`).toEqual([]);
    }
  });

  it("falls back to the narrowest layout below the guaranteed width", () => {
    // Nothing left to drop: keeping the profile name readable beats fitting.
    expect(LIST_MIN_WIDTH).toBeLessThanOrEqual(60);
    expect(pickLayout(true, 20)).toEqual(pickLayout(true, LIST_MIN_WIDTH - 1));
  });

  it("shows the reset time alongside the percentage when there is room", () => {
    // Half past, so the single-unit flooring cannot land on the neighbouring hour
    // while the test runs.
    const resetsAt = new Date(Date.now() + 3.5 * 3600_000).toISOString();
    const out = stripAnsi(
      renderList([item("work", snapshot({ session: { usedPercent: 42, resetsAt } }))], { width: 200 }),
    );

    expect(out).toContain("42% 3h");
  });

  it("drops the codex footnote once no spend column is left to explain", () => {
    const codex = {
      ...item("cdx"),
      tool: "codex" as const,
      quota: snapshot({ weekly: { usedPercent: 3, resetsAt: null } }),
    };

    expect(stripAnsi(renderList([codex], { width: 200 }))).toContain("not available for codex");
    expect(stripAnsi(renderList([codex], { width: 80 }))).not.toContain("not available for codex");
  });
});

/**
 * The MODEL column. It is shown only once some profile pins a model - as the quota columns
 * are shown only once a quota was fetched - and it gives way before anything the table
 * already had to give way late: the quota pair and its reset times. So the property that
 * matters is checked at every width rather than at a few.
 */
describe("renderList with a model", () => {
  const zero = { cost: 0, inputTokens: 0, outputTokens: 0 };
  const row = (name: string, extra: Partial<ProfileListItem> = {}): ProfileListItem => ({
    name,
    tool: "claude",
    email: `${name}@example.com`,
    configDir: `/home/u/.claude-${name}`,
    isPrimary: false,
    isActive: false,
    quota: snapshot({ session: { usedPercent: 6, resetsAt: "2030-01-01T00:00:00Z" } }),
    today: zero,
    week: { cost: 1, inputTokens: 10, outputTokens: 5 },
    month: zero,
    total: zero,
    ...extra,
  });
  const pinned = row("gw", { model: "z-ai/glm-5.3" });
  const unpinned = row("work");
  const lineFor = (out: string, name: string) => out.split("\n").find((line) => line.includes(name)) ?? "";

  it("puts the model beside the account when there is room", () => {
    const out = stripAnsi(renderList([unpinned, pinned], { width: 200 }));

    expect(out.split("\n")[3]).toMatch(/^ {4}PROFILE +ACCOUNT +MODEL +5H +7D +COST +INPUT +OUTPUT/);
    expect(lineFor(out, "gw@example.com")).toMatch(/gw@example\.com +z-ai\/glm-5\.3 +6%/);
    // A profile that pins none says so the way every other empty cell here does.
    expect(lineFor(out, "work@example.com")).toMatch(/work@example\.com +— +6%/);
  });

  it("leaves the table exactly as it was when no profile pins a model", () => {
    const labels: Record<string, string> = { profile: "PROFILE", account: "ACCOUNT", session: "5H", weekly: "7D" };
    for (const width of [60, 80, 104, 120, 200]) {
      const header = stripAnsi(renderList([unpinned], { width })).split("\n")[3];
      // The headings the table had before there was a model column, and nothing else.
      const before = pickLayout(true, width).keys.map((key) => labels[key] ?? key.toUpperCase());
      expect(header.trim().split(/\s+/), `width ${width}`).toEqual(before);
    }
    // And literally, at the width the byte-for-byte pins below use.
    expect(stripAnsi(renderList([unpinned], { width: 120 })).split("\n")[3]).toBe(
      "    PROFILE             ACCOUNT                         5H         7D         COST        INPUT         OUTPUT    ",
    );
  });

  it("never costs the quota columns or their reset times, at any width", () => {
    for (let width = 20; width <= 220; width++) {
      const without = pickLayout(true, width, false);
      const withModel = pickLayout(true, width, true);
      for (const key of ["session", "weekly"] as const) {
        expect(withModel.keys.includes(key), `${key} at ${width}`).toBe(without.keys.includes(key));
      }
      expect(withModel.reset, `reset at ${width}`).toBe(without.reset);
      expect(withModel.profileWidth, `profile at ${width}`).toBe(without.profileWidth);
    }
  });

  it("gives way before the quota columns do, rather than squeezing them", () => {
    expect(pickLayout(true, 200, true).keys).toEqual([
      "profile",
      "account",
      "model",
      "session",
      "weekly",
      "cost",
      "input",
      "output",
    ]);
    expect(pickLayout(true, 80, true).keys).toEqual(["profile", "account", "session", "weekly"]);
  });

  it("keeps the model over token counts and cost when only one of them fits", () => {
    // `clausona usage` has the spend in full; nothing else lists every profile's model.
    const keys = pickLayout(true, 120, true).keys;
    expect(keys).toContain("model");
    expect(keys).not.toContain("output");
  });

  it("does the same without quota columns", () => {
    expect(pickLayout(false, 200, true).keys).toEqual(["profile", "account", "model", "cost", "input", "output"]);
    for (let width = 20; width <= 220; width++) {
      const withModel = pickLayout(false, width, true);
      expect(withModel.profileWidth, `profile at ${width}`).toBe(pickLayout(false, width, false).profileWidth);
    }
  });

  it("never emits a line wider than the terminal", () => {
    const long = row("long", { model: "openrouter/deepseek/deepseek-v4.1-flash-preview-2026" });
    for (let width = LIST_MIN_WIDTH; width <= 220; width++) {
      const over = renderList([unpinned, pinned, long], { width })
        .split("\n")
        .filter((line) => stripAnsi(line).length > width);
      expect(over, `width ${width}`).toEqual([]);
    }
  });

  it("cuts a long model id from the middle, keeping the variant at the end", () => {
    const long = row("long", { model: "openrouter/deepseek/deepseek-v4.1-flash-preview-2026" });
    const out = stripAnsi(renderList([long], { width: 200 }));

    // 23 characters with the ellipsis: one column short of the width, as every cell here is.
    expect(lineFor(out, "long@example.com")).toContain("long@example.com                openrou…sh-preview-2026 6%");
  });

  // The pair this is for: the same model on one gateway, flash and not. Cut from the end,
  // both read `openrouter/z-ai/glm-5.…`.
  it("keeps two ids that differ only at the end apart", () => {
    const flash = row("flash", { model: "openrouter/z-ai/glm-5.3-flash" });
    const air = row("air", { model: "openrouter/z-ai/glm-5.3-air" });
    const out = stripAnsi(renderList([flash, air], { width: 200 }));

    expect(lineFor(out, "flash@example.com")).toContain("glm-5.3-flash");
    expect(lineFor(out, "air@example.com")).toContain("glm-5.3-air");
  });

  it("does not move the guaranteed minimum width", () => {
    expect(LIST_MIN_WIDTH).toBe(54);
  });
});

describe("formatModel", () => {
  it("is the id as stored, or a dash when none is pinned", () => {
    expect(formatModel("z-ai/glm-5.3")).toBe("z-ai/glm-5.3");
    expect(formatModel(undefined)).toBe("—");
  });
});

/**
 * The one rule for cutting a model id to a width, used by `list` and the preview alike. The
 * end of an id is what tells one variant from another - `-flash`, `-air`, a date - and the
 * start says which gateway; the middle is the part two ids share. So the middle goes.
 */
describe("fitModel", () => {
  it("leaves an id that fits exactly as it is", () => {
    expect(fitModel("openrouter/z-ai/glm-5.3", 23)).toBe("openrouter/z-ai/glm-5.3");
    expect(fitModel(undefined, 23)).toBe("—");
  });

  it("cuts from the middle, giving the end twice the room of the start", () => {
    expect(fitModel("openrouter/z-ai/glm-5.3-flash", 23)).toBe("openrou…i/glm-5.3-flash");
    expect(fitModel("openrouter/z-ai/glm-5.3-flash", 23)).toHaveLength(23);
    expect(fitModel("openrouter/z-ai/glm-5.3-flash", 10)).toBe("ope…-flash");
  });

  it("never exceeds the width it is given", () => {
    const id = "openrouter/deepseek/deepseek-v4.1-flash-preview-2026";
    for (let width = 0; width <= id.length + 2; width++) {
      expect(fitModel(id, width).length, `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("is only an ellipsis at a width of one, and nothing at zero", () => {
    expect(fitModel("openrouter/z-ai/glm-5.3-flash", 1)).toBe("…");
    expect(fitModel("openrouter/z-ai/glm-5.3-flash", 0)).toBe("");
  });
});

describe("renderList with API profiles", () => {
  const zero = { cost: 0, inputTokens: 0, outputTokens: 0 };

  const subscription: ProfileListItem = {
    name: "claude:work",
    tool: "claude",
    email: "you@example.com",
    configDir: "/home/u/.claude-work",
    isPrimary: false,
    isActive: true,
    today: zero,
    week: { cost: 12.5, inputTokens: 1234, outputTokens: 567 },
    month: zero,
    total: zero,
    quota: snapshot({ session: { usedPercent: 6, resetsAt: null }, weekly: { usedPercent: 41, resetsAt: null } }),
  };

  const api: ProfileListItem = {
    name: "claude:glm",
    tool: "claude",
    kind: "api",
    email: "",
    label: "gpu-box",
    configDir: "/home/u/.claude-glm",
    isPrimary: false,
    isActive: false,
    today: zero,
    week: zero,
    month: zero,
    total: zero,
  };

  const render = (items: ProfileListItem[]) => stripAnsi(renderList(items, { width: 120 }));
  const rowFor = (out: string, name: string) => out.split("\n").find((line) => line.includes(name)) ?? "";

  it("shows the label in the account column for an API profile", () => {
    expect(rowFor(render([subscription, api]), "claude:glm")).toBe(
      "    claude:glm          gpu-box                         —          —          —           —             —",
    );
  });

  // Pinned rather than matched loosely: the account column is shared with every
  // subscription profile, so a change made for API profiles must not move a single
  // column of the output a subscription user already reads.
  it("leaves a subscription row and the header exactly as they were", () => {
    const lines = render([subscription, api]).split("\n");

    expect(lines[3]).toBe(
      "    PROFILE             ACCOUNT                         5H         7D         COST        INPUT         OUTPUT    ",
    );
    expect(rowFor(lines.join("\n"), "claude:work")).toBe(
      "  ▸ claude:work         you@example.com                 6%         41%        $12.50      1,234         567",
    );
  });

  it("does not render a quota state or a quota footnote for an API profile", () => {
    const out = render([subscription, api]);

    expect(rowFor(out, "claude:glm")).not.toMatch(/missing|expired|error|cooldown/);
    expect(out).not.toContain("no stored credential");
  });

  // addApiProfile and `config --label` both refuse a blank label - one rule, checkLabel,
  // pinned for each in src/commands.api.test.ts - so only a hand-edited profiles.json gets
  // here. An empty cell reads as a rendering bug; a dash reads as "nothing to show", which
  // is what every other empty cell in this table says.
  it("falls back to a dash when a profile carries neither label nor email", () => {
    expect(rowFor(render([subscription, { ...api, label: "  " }]), "claude:glm")).toBe(
      "    claude:glm          —                               —          —          —           —             —",
    );
  });
});

describe("quotaBar", () => {
  it("fills proportionally and always spans ten cells", () => {
    expect(quotaBar(0)).toBe("░░░░░░░░░░");
    expect(quotaBar(50)).toBe("█████░░░░░");
    expect(quotaBar(100)).toBe("██████████");
  });

  it("clamps nonsense input", () => {
    expect(quotaBar(-20)).toHaveLength(10);
    expect(quotaBar(420)).toBe("██████████");
  });
});

describe("fitQuotaValue", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  const window = { usedPercent: 26, resetsAt: "2026-09-04T12:59:00Z" };

  it("sheds the gauge, then the wording, then the reset time as space runs out", () => {
    expect(fitQuotaValue(window, 40, now)).toBe("███░░░░░░░  26%  resets in 12h 59m");
    expect(fitQuotaValue(window, 30, now)).toBe(" 26%  resets in 12h 59m");
    expect(fitQuotaValue(window, 20, now)).toBe("███░░░░░░░  26% 12h");
    expect(fitQuotaValue(window, 10, now)).toBe(" 26% 12h");
    expect(fitQuotaValue(window, 5, now)).toBe(" 26%");
  });

  it("never exceeds the budget once the percentage alone fits", () => {
    for (let width = 4; width <= 60; width += 1) {
      expect(fitQuotaValue(window, width, now).length).toBeLessThanOrEqual(Math.max(width, 4));
    }
  });

  it("omits reset wording entirely when the window reports no reset", () => {
    const noReset = { usedPercent: 0, resetsAt: null };

    expect(fitQuotaValue(noReset, 40, now)).toBe("░░░░░░░░░░   0%");
    expect(fitQuotaValue(noReset, 5, now)).toBe("  0%");
  });
});

/**
 * Issues built by the function that builds them in production, keyed by kind.
 *
 * Not paraphrases. A fixture that shortens a message is a fixture that can pass while the
 * real message says the opposite: the config-directory test below asserted no "clausona
 * repair" appeared while its own shortened `missing_shared_link` message had the real
 * suffix - "run 'clausona repair'" - deleted from it.
 */
const API_ENDPOINT: ApiEndpoint = {
  baseUrl: "http://gpu-box:30000",
  authScheme: "bearer",
  secret: { source: "keychain" },
};

const API_PROFILE: Profile = {
  tool: "claude",
  kind: "api",
  configDir: "/home/u/.claude-glm",
  email: "",
  label: "gpu-box",
  api: API_ENDPOINT,
};

const API_ISSUE_INPUTS = {
  missing_config_dir: { profile: API_PROFILE, configDirExists: false },
  missing_api_secret: { profile: API_PROFILE, secret: { ok: false, error: "no stored secret" } },
  invalid_api_config: { profile: { ...API_PROFILE, api: { ...API_ENDPOINT, baseUrl: "" } } },
  shared_api_key_helper: { profile: API_PROFILE, settings: { apiKeyHelper: "op read op://vault/key" } },
  settings_env_override: { profile: API_PROFILE, settings: { env: { ANTHROPIC_BASE_URL: "http://localhost:1" } } },
  env_overrides_endpoint: { profile: { ...API_PROFILE, env: { ANTHROPIC_BASE_URL: "http://localhost:1" } } },
  plaintext_env_secret: {
    profile: { ...API_PROFILE, env: { ANTHROPIC_API_KEY: "sk-plain" } },
    credentialEnvKeys: ["ANTHROPIC_API_KEY"],
  },
} satisfies Record<string, Omit<ApiHealthInput, "id">>;

/**
 * The three credential messages and this one are written inline in `doctorProfiles`, so no
 * function can be asked for them here. Their real text is pinned end to end instead, by the
 * byte-identity tests in src/lib/doctor-api.integration.test.ts, which assert the whole
 * rendered report for a profile carrying all three.
 */
const STALE_SYMLINK_MESSAGE = "projects is symlinked to primary but should not be shared";

function realApiIssue(kind: keyof typeof API_ISSUE_INPUTS): DoctorIssue {
  const issue = evaluateApiHealth({ id: "claude:work", ...API_ISSUE_INPUTS[kind] }).find((i) => i.kind === kind);
  if (!issue) throw new Error(`evaluateApiHealth produced no ${kind}`);
  return issue;
}

function result(issues: DoctorProfileResult["issues"]): DoctorProfileResult {
  return {
    name: "claude:work",
    email: "work@example.com",
    configDir: "/h/.claude-work",
    isPrimary: false,
    // What doctorProfiles computes: a warning leaves the profile healthy.
    healthy: countIssues(issues).errors === 0,
    issues,
  };
}

describe("doctorSeverity", () => {
  const warning = { kind: "plaintext_env_secret", message: "x", severity: "warning" } as const;

  it("grades a result the way every surface has to grade it", () => {
    // Written out by hand in two places, this rule disagreed with itself: the doctor list
    // coloured a profile reading "2 warnings" emerald, while the preview panel for the same
    // profile went amber. Ordinary render assertions never saw it - chalk is level 0 under
    // `vitest run` - so the rule is pinned here and the colours in
    // src/tui/doctor-colour.test.tsx, which forces chalk on.
    expect(doctorSeverity([])).toBe("healthy");
    expect(doctorSeverity([warning])).toBe("warning");
    expect(doctorSeverity([{ kind: "broken_symlink", message: "x" }])).toBe("error");
    expect(doctorSeverity([warning, { kind: "broken_symlink", message: "x" }])).toBe("error");
  });
});

describe("doctorSummary", () => {
  it("names what a profile has", () => {
    expect(doctorSummary([])).toBe("healthy");
    expect(doctorSummary([{ kind: "broken_symlink", message: "x" }])).toBe("1 issue");
    expect(
      doctorSummary([
        { kind: "broken_symlink", message: "x" },
        { kind: "stale_symlink", message: "y" },
      ]),
    ).toBe("2 issues");
    expect(doctorSummary([{ kind: "plaintext_env_secret", message: "x", severity: "warning" }])).toBe("1 warning");
    expect(
      doctorSummary([
        { kind: "broken_symlink", message: "x" },
        { kind: "plaintext_env_secret", message: "y", severity: "warning" },
      ]),
    ).toBe("1 issue, 1 warning");
  });
});

describe("renderDoctor severity", () => {
  // Both real: an assertion that a word is absent is only as strong as the text it is
  // absent from.
  const warning = realApiIssue("plaintext_env_secret");
  const brokenLink = evaluateSymlinkHealth({
    isPrimary: false,
    items: [
      { name: "commands", isSharedLink: true, pointsToPrimary: true, targetExists: false, existsInPrimary: true },
    ],
  })[0];

  it("reports a profile that has only warnings as working, with the warnings shown", () => {
    const out = stripAnsi(renderDoctor([result([warning])]));

    // The profile runs. Rendering it as broken would be the same false alarm the
    // subscription-only checks used to raise on every API profile.
    expect(out).toContain("1 warning");
    expect(out).not.toContain("issue");
    expect(out).toContain(warning.message);
    expect(out).not.toContain("clausona repair");
    expect(out).not.toContain("clausona login");
  });

  it("leads with what is actually broken when a profile has both", () => {
    const out = stripAnsi(renderDoctor([result([brokenLink, warning])]));

    expect(out).toContain("1 issue, 1 warning");
    expect(out).toContain("clausona repair claude:work");
  });

  it("marks the warning line itself, so a mixed list can be read at a glance", () => {
    const lines = stripAnsi(renderDoctor([result([brokenLink, warning])]))
      .split("\n")
      .filter((line) => line.includes(brokenLink.message) || line.includes(warning.message));

    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("⚠");
    expect(lines[1]).toContain("⚠");
  });

  it("still says healthy when there is nothing at all", () => {
    expect(stripAnsi(renderDoctor([result([])]))).toContain("healthy");
  });
});

describe("renderDoctor next-step hint", () => {
  it("suggests repair for issues repair can resolve", () => {
    const out = stripAnsi(renderDoctor([result([{ kind: "stale_symlink", message: STALE_SYMLINK_MESSAGE }])]));

    expect(out).toContain("clausona repair claude:work");
    expect(out).not.toContain("clausona login");
  });

  it("suggests login instead when the profile only needs credentials", () => {
    // repair rebuilds links and merges session state; it cannot produce a credential,
    // so pointing at it here sends the user to a command that changes nothing.
    const out = stripAnsi(renderDoctor([result([{ kind: "missing_oauth", message: "x" }])]));

    expect(out).toContain("clausona login claude:work");
    expect(out).not.toContain("clausona repair");
  });

  it("suggests login for a missing keychain item", () => {
    const out = stripAnsi(renderDoctor([result([{ kind: "missing_keychain", message: "x" }])]));

    expect(out).toContain("clausona login claude:work");
    expect(out).not.toContain("clausona repair");
  });

  it("suggests login for an unreadable account file", () => {
    const out = stripAnsi(renderDoctor([result([{ kind: "missing_json", message: "x" }])]));

    expect(out).toContain("clausona login claude:work");
    expect(out).not.toContain("clausona repair");
  });

  it("suggests both when the profile has both classes of issue", () => {
    const out = stripAnsi(
      renderDoctor([
        result([
          { kind: "missing_oauth", message: "x" },
          { kind: "broken_symlink", message: "y" },
        ]),
      ]),
    );

    expect(out).toContain("clausona repair claude:work");
    expect(out).toContain("clausona login claude:work");
  });

  it("suggests nothing for a healthy profile", () => {
    const out = stripAnsi(renderDoctor([result([])]));

    expect(out).toContain("healthy");
    expect(out).not.toContain("clausona repair");
    expect(out).not.toContain("clausona login");
  });

  it.each(
    Object.keys(API_ISSUE_INPUTS) as (keyof typeof API_ISSUE_INPUTS)[],
  )("suggests neither for %s, which carries its own fix", (kind) => {
    // repair rebuilds shared links and login signs a subscription in. An API profile has
    // neither problem: what it needs is in the message, and offering a command that
    // reports success and changes nothing is worse than offering none.
    const out = stripAnsi(renderDoctor([result([realApiIssue(kind)])]));

    // The footer's wording: missing_config_dir's own message names repair, as the step after
    // the directory is made again.
    expect(out).not.toContain("Run clausona repair");
    expect(out).not.toContain("clausona login");
  });

  it("does not suggest repair for a profile whose config directory is gone", () => {
    // repair symlinks into a directory it does not create; in this state it fails with
    // ENOENT. doctorProfiles no longer emits the shared-link findings alongside this one
    // for that reason, so the real report is this issue by itself.
    const out = stripAnsi(renderDoctor([result([realApiIssue("missing_config_dir")])]));

    expect(out).not.toContain("Run clausona repair");
    expect(out).toContain("config directory /home/u/.claude-glm is missing");
  });

  it("keeps the footer off even if a shared-link finding reached it anyway", () => {
    // The renderer's own guard, checked against the message `evaluateSymlinkHealth` really
    // produces rather than a paraphrase of it. That message ends in "run 'clausona repair'"
    // - which is why this asserts the absence of the suggestion FOOTER, in its exact
    // wording, and the body-level promise is pinned end to end in
    // src/lib/doctor-api.integration.test.ts where the finding is not produced at all.
    const sharedLink = evaluateSymlinkHealth({ isPrimary: false, items: [], missingSharedDirs: ["commands"] })[0];
    const out = stripAnsi(renderDoctor([result([realApiIssue("missing_config_dir"), sharedLink])]));

    expect(sharedLink.message).toContain("clausona repair");
    expect(out).not.toContain("Run clausona repair claude:work");
  });

  it("still suggests repair when an API profile's shared links are broken too", () => {
    const out = stripAnsi(
      renderDoctor([
        result([
          { kind: "missing_api_secret", message: "x" },
          { kind: "broken_symlink", message: "y" },
        ]),
      ]),
    );

    expect(out).toContain("clausona repair claude:work");
    expect(out).not.toContain("clausona login");
  });
});
