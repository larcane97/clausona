import { describe, expect, it } from "vitest";
import { countIssues } from "../core/doctor.js";
import type { DoctorProfileResult, ProfileListItem, QuotaSnapshot } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import {
  doctorSummary,
  fitQuotaValue,
  formatAge,
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

  // addApiProfile and `config --label` both refuse a blank label, so only a hand-edited
  // profiles.json gets here. An empty cell reads as a rendering bug; a dash reads as
  // "nothing to show", which is what every other empty cell in this table says.
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
  const warning = { kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" } as const;

  it("reports a profile that has only warnings as working, with the warnings shown", () => {
    const out = stripAnsi(renderDoctor([result([warning])]));

    // The profile runs. Rendering it as broken would be the same false alarm the
    // subscription-only checks used to raise on every API profile.
    expect(out).toContain("1 warning");
    expect(out).not.toContain("issue");
    expect(out).toContain("a key sits in the env map");
    expect(out).not.toContain("clausona repair");
    expect(out).not.toContain("clausona login");
  });

  it("leads with what is actually broken when a profile has both", () => {
    const out = stripAnsi(renderDoctor([result([{ kind: "broken_symlink", message: "a link dangles" }, warning])]));

    expect(out).toContain("1 issue, 1 warning");
    expect(out).toContain("clausona repair claude:work");
  });

  it("marks the warning line itself, so a mixed list can be read at a glance", () => {
    const lines = stripAnsi(renderDoctor([result([{ kind: "broken_symlink", message: "a link dangles" }, warning])]))
      .split("\n")
      .filter((line) => line.includes("dangles") || line.includes("env map"));

    expect(lines[0]).not.toContain("⚠");
    expect(lines[1]).toContain("⚠");
  });

  it("still says healthy when there is nothing at all", () => {
    expect(stripAnsi(renderDoctor([result([])]))).toContain("healthy");
  });
});

describe("renderDoctor next-step hint", () => {
  it("suggests repair for issues repair can resolve", () => {
    const out = stripAnsi(renderDoctor([result([{ kind: "stale_symlink", message: "x" }])]));

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

  it.each([
    "missing_api_secret",
    "invalid_api_config",
    "shared_api_key_helper",
    "plaintext_env_secret",
  ] as const)("suggests neither for %s, which carries its own fix", (kind) => {
    // repair rebuilds shared links and login signs a subscription in. An API profile has
    // neither problem: what it needs is in the message, and offering a command that
    // reports success and changes nothing is worse than offering none.
    const out = stripAnsi(renderDoctor([result([{ kind, message: "x" }])]));

    expect(out).not.toContain("clausona repair");
    expect(out).not.toContain("clausona login");
  });

  it("does not suggest repair for a profile whose config directory is gone", () => {
    // Every shared-link finding there is a consequence of the missing directory, and
    // repair symlinks into a directory it does not create - it fails with ENOENT.
    const out = stripAnsi(
      renderDoctor([
        result([
          { kind: "missing_config_dir", message: "config directory ~/.claude-glm is missing" },
          { kind: "missing_shared_link", message: "commands/ is shared in primary but missing here" },
        ]),
      ]),
    );

    expect(out).not.toContain("clausona repair");
    expect(out).toContain("config directory ~/.claude-glm is missing");
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
