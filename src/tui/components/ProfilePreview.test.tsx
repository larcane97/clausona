import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { DoctorProfileResult, ProfileListItem, SecretSource } from "../../types.js";
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

/** The same endpoint, with the key read from wherever the caller says. */
function apiProfile(secret: SecretSource = { source: "keychain" }): ProfileListItem {
  return {
    ...profile,
    api: { baseUrl: "https://gateway.example.com", authScheme: "bearer", secret },
    env: { ANTHROPIC_MODEL: "glm-4.6", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144" },
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
      expect(frame).not.toContain("op://vault/key");
    });
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
