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
