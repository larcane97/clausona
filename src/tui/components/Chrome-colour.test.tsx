import { expect, it } from "vitest";

/**
 * How Chrome paints the line above the hints. A message there is muted, as the hints are; a
 * question waits for a key, so it is drawn as text and bold - in the muted grey, `Remove route
 * main? (y/N)` was the only change on screen after `d` and easy to miss.
 *
 * chalk is level 0 under a plain `vitest run`, so this file sets FORCE_COLOR before the modules
 * load and imports them dynamically (doctor-colour.test.tsx says why).
 */
process.env.FORCE_COLOR = "3";

/** The 24-bit foreground sequence chalk emits for a hex from the theme. */
function ansiFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `\u001b[38;2;${r};${g};${b}m`;
}

async function lineOf(props: { footer?: string; question?: string }, text: string): Promise<string> {
  const { render } = await import("ink-testing-library");
  const { Chrome } = await import("./Chrome.js");
  const frame = render(<Chrome title="Routes" hints={[{ keys: "esc", action: "back" }]} {...props} />).lastFrame();
  const line = (frame ?? "").split("\n").find((each) => each.includes(text));
  if (!line) throw new Error(`no line with '${text}' in the frame`);
  return line;
}

it("draws a question above the hints in bold text, not in the hints' grey", async () => {
  const { color } = await import("../theme.js");
  const line = await lineOf({ question: "Remove route main? (y/N)" }, "Remove route main?");
  expect(line).toContain(ansiFor(color.text));
  expect(line).toContain("\u001b[1m");
  expect(line).not.toContain(ansiFor(color.muted));
});

it("keeps a message there muted", async () => {
  const { color } = await import("../theme.js");
  const line = await lineOf({ footer: "Reading quota again…" }, "Reading quota again");
  expect(line).toContain(ansiFor(color.muted));
  expect(line).not.toContain("\u001b[1m");
});
