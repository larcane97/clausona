import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { DoctorProfileResult, ProfileListItem, SecretSource } from "../../types.js";
import { windowsOnScreen } from "../test-frames.js";
import { ProfilePreview } from "./ProfilePreview.js";

/**
 * The Health row, which is the only part of this panel the API-profile work touched.
 *
 * Text only. chalk is level 0 under a plain `vitest run`, so the frames here carry no ANSI
 * and the colour a surface picks is not visible to an assertion in this file - it is
 * asserted in src/tui/doctor-colour.test.tsx, which sets FORCE_COLOR before the modules
 * load. Both surfaces read `doctorSeverity` rather than writing the rule out, and
 * src/lib/format.test.ts pins the rule itself.
 */
const profile: ProfileListItem = {
  name: "claude:glm",
  tool: "claude",
  kind: "api",
  email: "",
  label: "gpu-box",
  configDir: "/h/.claude-glm",
  isPrimary: false,
  isActive: false,
  today: { cost: 0, inputTokens: 0, outputTokens: 0 },
  week: { cost: 0, inputTokens: 0, outputTokens: 0 },
  month: { cost: 0, inputTokens: 0, outputTokens: 0 },
  total: { cost: 0, inputTokens: 0, outputTokens: 0 },
};

function doctor(issues: DoctorProfileResult["issues"]): DoctorProfileResult {
  return {
    name: "claude:glm",
    email: "gpu-box",
    configDir: "/h/.claude-glm",
    isPrimary: false,
    healthy: !issues.some((issue) => issue.severity !== "warning"),
    issues,
  };
}

const frameFor = (result?: DoctorProfileResult) =>
  render(<ProfilePreview profile={profile} doctor={result} />).lastFrame() ?? "";

/** A subscription profile, for the rows that must not have changed for one. */
const subscription: ProfileListItem = {
  name: "claude:work",
  tool: "claude",
  email: "you@example.com",
  configDir: "/h/.claude-work",
  isPrimary: false,
  isActive: false,
  today: { cost: 0, inputTokens: 0, outputTokens: 0 },
  week: { cost: 0, inputTokens: 0, outputTokens: 0 },
  month: { cost: 0, inputTokens: 0, outputTokens: 0 },
  total: { cost: 0, inputTokens: 0, outputTokens: 0 },
};

/** The same endpoint, with the key read from wherever the caller says - as listProfiles hands it over. */
function apiProfile(secret: SecretSource = { source: "keychain" }): ProfileListItem {
  return {
    ...profile,
    api: { baseUrl: "https://gateway.example.com", authScheme: "bearer", secret },
    env: { ANTHROPIC_MODEL: "glm-4.6", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144" },
    model: "glm-4.6",
  };
}

const endpoint = apiProfile();

const panelFor = (item: ProfileListItem) => render(<ProfilePreview profile={item} />).lastFrame() ?? "";

describe("ProfilePreview for an API profile", () => {
  it("says what kind of profile it is", () => {
    expect(panelFor(endpoint)).toContain("API");
    expect(panelFor(subscription)).not.toMatch(/●\s+API/);
  });

  it("names the endpoint, the scheme, and the model", () => {
    const frame = panelFor(endpoint);

    expect(frame).toContain("https://gateway.example.com");
    expect(frame).toContain("bearer");
    expect(frame).toContain("glm-4.6");
  });

  it("counts the settings it carries beyond the model", () => {
    expect(panelFor(endpoint)).toContain("1 set");
  });

  it("titles it by its label, since an API profile has no account email", () => {
    expect(panelFor(endpoint)).toContain("gpu-box");
  });

  it("does not sit on a quota that nothing will ever fetch for it", () => {
    // `listProfiles` and `fetchProfileQuotas` both skip an API profile, so the quota rows
    // would read "loading…" for as long as the panel is open.
    expect(panelFor(endpoint)).not.toContain("loading");
    expect(panelFor(subscription)).toContain("loading");
  });

  it("shows its budget's use and its spend as last read, and nothing without a reading", () => {
    const budget = {
      usedPercent: 35,
      resetsAt: null,
      spentUsd: 7,
      limitUsd: 20,
      source: "budget" as const,
      per: "month" as const,
    };
    const read = render(
      <ProfilePreview profile={{ ...endpoint, quota: { state: "ok", fetchedAt: Date.now(), budget } }} />,
    ).lastFrame();
    expect(read).toMatch(/Budget\s+.*35%/);
    expect(read).toContain("$7.00 of $20/month (clausona budget)");
    const none = render(
      <ProfilePreview profile={{ ...endpoint, quota: { state: "error", fetchedAt: 0, noSpendReading: true } }} />,
    ).lastFrame();
    expect(none).not.toContain("Budget");
  });

  it('draws the ellipsis of "loading…", not its escape', () => {
    // A JSX attribute string keeps `\u2026` as the six characters it is written with.
    expect(panelFor(subscription)).toContain("loading…");
    expect(panelFor(subscription)).not.toContain("\\u2026");
  });

  it("leaves the panel standing for an API profile whose endpoint is missing", () => {
    // A hand-edited registry can carry `kind: "api"` with no block under it; the doctor
    // reports that, and the panel has nothing to say about it rather than throwing.
    expect(panelFor(profile)).toContain("claude:glm");
  });

  describe("the key row", () => {
    it("names the credential store, never a key", () => {
      expect(panelFor(endpoint)).toContain("keychain");
    });

    it("names the variable an env source reads", () => {
      const frame = panelFor(apiProfile({ source: "env", name: "GW_TOKEN" }));

      expect(frame).toContain("env:GW_TOKEN");
    });

    it("says only that a command source is a command, not what the command is", () => {
      // Unlike `config --show`, which is a deliberate read of one profile. This panel
      // paints whatever the cursor passes over, and a command line can carry a vault path
      // or an argument that is itself the secret.
      const frame = panelFor(apiProfile({ source: "command", run: "op read op://vault/key" }));

      expect(frame).toContain("command");
      expect(windowsOnScreen([frame], "op read op://vault/key")).toEqual([]);
    });
  });
});

/**
 * The model, which `list` shows too. Both read `ProfileListItem.model` - worked out once, in
 * listProfiles - and format it with `formatModel`, so the two cannot disagree about which
 * model a profile is on, or about what "none" looks like.
 */
describe("ProfilePreview model", () => {
  /** The value on the Model row, or undefined when the panel has no such row. */
  const modelRow = (item: ProfileListItem) =>
    panelFor(item)
      .split("\n")
      .find((line) => line.includes("Model"))
      ?.replace(/^.*Model\s+/, "")
      .replace(/[\s│]+$/, "");

  it("shows the model listProfiles worked out, not a second reading of the env map", () => {
    // A blank ANTHROPIC_MODEL pins nothing, and listProfiles says so by leaving `model` out.
    expect(modelRow({ ...endpoint, env: { ANTHROPIC_MODEL: "  " }, model: undefined })).toBe("—");
    expect(modelRow({ ...endpoint, env: {}, model: "glm-4.6" })).toBe("glm-4.6");
  });

  it("shows a subscription profile's model when it pins one", () => {
    expect(modelRow({ ...subscription, model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  // An API profile's model is in its endpoint section; the account block's row is for a
  // subscription profile only. Two rows would read as two models.
  it("shows an API profile's model once", () => {
    const rows = panelFor(endpoint)
      .split("\n")
      .filter((line) => line.includes("Model"));

    expect(rows).toHaveLength(1);
  });

  // Cut by the rule `list` uses, before ink would cut it from the end: the end of an id is
  // what tells `-flash` from `-air`.
  it("keeps the end of an id too long for the panel", () => {
    const frame =
      render(
        <Box width={32}>
          <ProfilePreview profile={{ ...endpoint, model: "openrouter/z-ai/glm-5.3-flash-preview-extended" }} />
        </Box>,
      ).lastFrame() ?? "";
    const row = frame
      .split("\n")
      .find((line) => line.includes("Model"))
      ?.replace(/^.*Model\s+/, "")
      .replace(/[\s│]+$/, "");

    // A panel 32 columns wide leaves its value 13: the start, the ellipsis, and the variant.
    expect(row).toBe("open…extended");
  });

  // listProfiles hands over `<hidden>` for an env map that is not a map; counting its keys
  // would count the characters of that.
  it("counts no settings for an env map that is not a map", () => {
    const frame = panelFor({ ...endpoint, env: "<hidden>" as unknown as Record<string, string>, model: undefined });

    expect(frame).not.toMatch(/\d+ set/);
  });

  it("has no model row for a subscription profile that pins none", () => {
    // For an endpoint a missing model is worth a dash; for an account it is the usual case,
    // and Claude Code picks the model itself.
    expect(modelRow(subscription)).toBeUndefined();
  });
});

describe("ProfilePreview health", () => {
  it("says healthy when there is nothing to report", () => {
    expect(frameFor(doctor([]))).toContain("healthy");
  });

  it("counts warnings as warnings rather than calling the profile healthy", () => {
    // The profile works, so it is `healthy: true` - but a row that only said "healthy"
    // would be the one place the warning never appears.
    const frame = frameFor(
      doctor([{ kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" }]),
    );

    expect(frame).toContain("1 warning");
    expect(frame).not.toMatch(/✔ healthy/);
    expect(frame).toContain("a key sits in the env map");
  });

  it("leads with the errors when a profile has both", () => {
    const frame = frameFor(
      doctor([
        { kind: "missing_api_secret", message: "no stored key" },
        { kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" },
      ]),
    );

    expect(frame).toContain("1 issue, 1 warning");
  });

  it("shows no health row at all until a doctor result arrives", () => {
    // The whole section is gated on the result, so the panel says nothing about health
    // rather than guessing at it.
    expect(frameFor(undefined)).not.toContain("Health");
  });
});

/** The panel `columns` wide, split into lines. */
const linesAt = (columns: number, item: ProfileListItem, result?: DoctorProfileResult) =>
  (
    render(
      <Box width={columns}>
        <ProfilePreview profile={item} doctor={result} />
      </Box>,
    ).lastFrame() ?? ""
  ).split("\n");

/** A row's value: what follows its label, without the panel's border. */
const rowValue = (line: string | undefined, label: string) =>
  line?.replace(new RegExp(`^.*${label}\\s+`), "").replace(/[\s│]+$/, "");

describe("ProfilePreview in a narrow panel", () => {
  const long: ProfileListItem = {
    ...subscription,
    email: "jaewon.someone@example-company.com",
    configDir: "/h/.claude-jaewon-yanolja-team",
  };

  // An address or a path has no space to wrap at, so ink broke it wherever the column ended:
  // `jaewon.someon` over `e@example-com` over `pany.com`.
  it("keeps the account and the config dir on one line each, with both of their ends", () => {
    const lines = linesAt(32, long);
    const account = lines.findIndex((line) => line.includes("Account"));

    expect(lines[account + 1]).toContain("Config");
    expect(rowValue(lines[account], "Account")).toMatch(/^jaewon.*….*\.com$/);
    expect(rowValue(lines[account + 1], "Config")).toMatch(/^\/h\/.*….*-team$/);
  });

  it("keeps a space between an issue's arrow and a message longer than the line", () => {
    const issue = {
      kind: "local_override",
      severity: "warning",
      message: "/h/.claude-work/.session-stats.json replaced a link",
    } as const;
    const arrow = linesAt(40, subscription, { ...doctor([issue]), name: "claude:work" }).find((line) =>
      line.includes("➔"),
    );

    expect(arrow).toMatch(/➔ \/h\//);
  });
});

describe("ProfilePreview quota", () => {
  // The profile list beside it says `signed out` on the row, as `csn list` does; the panel says it
  // in the same words, and what to run, as it already did for a lapsed sign-in.
  it("calls a profile with no stored credential signed out, as its row does", () => {
    const frame = panelFor({ ...subscription, quota: { state: "missing", fetchedAt: Date.now() } });

    expect(frame).toContain("signed out — clausona login");
  });

  // The row says `other account`; the panel says which.
  it("names the account another account's sign-in is", () => {
    const quota = { state: "other_account" as const, fetchedAt: Date.now(), signedInAs: "b@example.com" };
    const frame = panelFor({ ...subscription, quota });

    expect(frame).toContain("signed in as b@example.com — clausona login");
  });
});

/**
 * The panel in the lines a screen gives it. The screen gives what the terminal leaves, so that
 * its frame stays shorter than the terminal: ink redraws a frame as tall as the terminal whole,
 * and a taller one loses its top - the title and the selected row - for good (#179, #182).
 */
describe("ProfilePreview in the lines it has", () => {
  const findings = (count: number) =>
    ({
      ...doctor(
        Array.from({ length: count }, (_, i) => ({
          kind: "local_override" as const,
          severity: "warning" as const,
          message: `notes-${String(i + 1).padStart(2, "0")}.json replaced an expected shared link`,
        })),
      ),
      name: "claude:work",
    }) satisfies DoctorProfileResult;

  const panel = (columns: number, rows: number | undefined, result?: DoctorProfileResult) =>
    (
      render(
        <Box width={columns}>
          <ProfilePreview profile={subscription} doctor={result} rows={rows} />
        </Box>,
      ).lastFrame() ?? ""
    ).split("\n");

  it("draws everything as it always has when the lines are there", () => {
    expect(panel(60, 80, findings(3))).toEqual(panel(60, undefined, findings(3)));
  });

  it("keeps to the lines it is given, and says how many findings it leaves out", () => {
    for (const columns of [40, 60]) {
      for (let rows = 8; rows <= 60; rows++) {
        const lines = panel(columns, rows, findings(15));
        const shown = lines.filter((line) => line.includes("➔")).length;
        const more = lines.find((line) => /… \d+ more in Health check/.test(line));

        expect(lines.length, `${columns} columns, ${rows} rows`).toBeLessThanOrEqual(rows);
        // Short of every finding, the ones it draws are followed by the count of the rest. Cut at
        // its bottom edge it draws none, and the count may be what is cut.
        if (shown > 0 && shown < 15) expect(more, `${columns} columns, ${rows} rows`).toBeDefined();
        if (more) expect(more).toContain(`… ${15 - shown} more in Health check`);
      }
    }
  });

  it("gives up the blank lines between findings before it leaves any out", () => {
    const natural = panel(60, undefined, findings(15)).length;
    const lines = panel(60, natural - 1, findings(15));
    const arrows = lines.flatMap((line, at) => (line.includes("➔") ? [at] : []));

    expect(arrows).toHaveLength(15);
    expect(arrows.at(-1)).toBe(arrows[0] + 14);
  });

  it("gives up its usage section before its health row", () => {
    const lines = panel(60, 14, findings(0));

    expect(lines.some((line) => line.includes("Health"))).toBe(true);
    expect(lines.some((line) => line.includes("Today"))).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(14);
  });

  it("is cut at its bottom edge, its name still on top, when not even that fits", () => {
    const lines = panel(60, 7, findings(15));

    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain("claude:work");
    expect(lines.at(-1)).toMatch(/╰─+╯/);
  });
});
