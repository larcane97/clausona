import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { DoctorProfileResult, ProfileListItem } from "../../types.js";
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
