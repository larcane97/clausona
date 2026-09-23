import { expect, it } from "vitest";

import type { DoctorProfileResult, ProfileListItem } from "../types.js";

/**
 * The one thing the other TUI tests cannot see: which colour a doctor result is painted.
 *
 * chalk is level 0 under a plain `vitest run`, so frames come back with no ANSI in them and
 * a colour mismatch is invisible to an assertion. With FORCE_COLOR set before the modules
 * load it is level 3 and the codes are in the frame, so this file sets it and imports
 * everything dynamically - static imports are hoisted above the assignment.
 *
 * The real guarantee is still structural: both surfaces call `doctorSeverity` rather than
 * writing the rule out, which is what stopped them grading the same profile differently.
 * This is the belt to that pair of braces, and it is what would have caught the list
 * painting a profile that reads "2 warnings" emerald green.
 */
process.env.FORCE_COLOR = "3";

/** The 24-bit foreground sequence chalk emits for a hex from the theme. */
function ansiFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
}

function doctorResult(issues: DoctorProfileResult["issues"]): DoctorProfileResult {
  return {
    name: "claude:glm",
    email: "gpu-box",
    configDir: "/h/.claude-glm",
    isPrimary: false,
    healthy: !issues.some((issue) => issue.severity !== "warning"),
    issues,
  };
}

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

const WARNING = { kind: "plaintext_env_secret", message: "a key sits in the env map", severity: "warning" } as const;
const ERROR = { kind: "missing_api_secret", message: "no stored key" } as const;

async function healthRow(issues: DoctorProfileResult["issues"]): Promise<string> {
  const { render } = await import("ink-testing-library");
  const { ProfilePreview } = await import("./components/ProfilePreview.js");
  const frame = render(<ProfilePreview profile={profile} doctor={doctorResult(issues)} />).lastFrame() ?? "";
  const row = frame.split("\n").find((line) => line.includes("Health"));
  if (!row) throw new Error("no Health row in the rendered panel");
  return row;
}

it("paints a profile with nothing to report emerald", async () => {
  const { color } = await import("./theme.js");

  expect(await healthRow([])).toContain(`${ansiFor(color.healthy)}✔ healthy`);
});

it("paints a warnings-only profile amber, not the emerald its `healthy` flag would suggest", async () => {
  const { color } = await import("./theme.js");
  const row = await healthRow([WARNING]);

  expect(row).toContain(`${ansiFor(color.warning)}◈ 1 warning`);
  expect(row).not.toContain(ansiFor(color.healthy));
});

it("paints a profile that is actually broken red", async () => {
  const { color } = await import("./theme.js");
  const row = await healthRow([ERROR, WARNING]);

  // The red variant existed and nothing used it: an error and a warning looked the same.
  expect(row).toContain(`${ansiFor(color.error)}◈ 1 issue, 1 warning`);
  expect(row).not.toContain(ansiFor(color.warning));
});
