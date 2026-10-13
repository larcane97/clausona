import { expect, it, vi } from "vitest";

import type { Registry } from "../../types.js";
import type { RoutesScreenDeps } from "./routes-deps.js";

/**
 * Where the route form draws the text cursor: the one character in inverse, on the focused
 * field's text, or on the first character of an empty pattern field's example. Every other route
 * form test reads the frame without its styling, where the cursor is not to be seen, so a change
 * that lost it passed them all.
 *
 * chalk is level 0 under a plain `vitest run`, so this file sets FORCE_COLOR before the modules
 * load and imports them dynamically (doctor-colour.test.tsx says why).
 */
process.env.FORCE_COLOR = "3";

const INVERSE = "\u001b[7m";
const inverse = (text: string) => `${INVERSE}${text}\u001b[27m`;
const TAB = "\t";
const LEFT = "\u001B[D";

const REGISTRY: Registry = {
  version: 2,
  primarySources: { claude: "/home/u/.claude" },
  activeProfiles: { claude: "claude:team" },
  profiles: {
    "claude:team": { tool: "claude", configDir: "/home/u/.claude-team", email: "team@example.com", isPrimary: true },
    "claude:work": { tool: "claude", configDir: "/home/u/.claude-work", email: "work@example.com" },
  },
};

it("draws the cursor inverse on the character it is on, and on an empty pattern field's example", async () => {
  const { render } = await import("ink-testing-library");
  const { stripAnsi } = await import("../../lib/cli-style.js");
  const { focusedOn, press, waitForFrame } = await import("../test-drive.js");
  const { formAccounts, RouteForm } = await import("./RouteForm.js");
  const deps = {
    loadRegistry: vi.fn(async () => REGISTRY),
    registryProblem: vi.fn(async () => null),
    readRoutes: vi.fn(async () => ({ version: 1 as const, routes: {} })),
    updateRoutes: vi.fn(async () => {
      throw new Error("nothing here saves");
    }),
    collectQuotas: vi.fn(async () => ({})),
    readPicks: vi.fn(async () => ({})),
    clock: () => 0,
  } satisfies RoutesScreenDeps;
  const instance = render(
    <RouteForm
      mode="new"
      accounts={formAccounts(REGISTRY)}
      quotas={{}}
      lastPicked={{}}
      registry={REGISTRY}
      deps={deps}
      now={0}
      onDone={() => {}}
    />,
  );
  /** The line carrying `label`, its styling kept. */
  const rawRow = (label: string) =>
    (instance.lastFrame() ?? "").split("\n").find((line) => stripAnsi(line).includes(label)) ?? "";
  await waitForFrame(instance.lastFrame, (frame) => stripAnsi(frame).includes("Name"));

  // An empty field: on the cell the first key goes in.
  expect(rawRow("Name")).toContain(inverse(" "));
  await press(instance, "daily");
  // At the end of the text: on the cell after it.
  expect(rawRow("Name")).toContain(`daily${inverse(" ")}`);
  await press(instance, LEFT);
  await press(instance, LEFT);
  expect(rawRow("Name")).toContain(`dai${inverse("l")}y`);
  // Not focused, an empty pattern field draws its example with no cursor on it.
  expect(rawRow("Patterns")).not.toContain(INVERSE);

  for (let step = 0; step < 5 && !focusedOn(stripAnsi(instance.lastFrame() ?? ""), "from"); step++) {
    await press(instance, TAB);
  }
  // On the example's first character, where the first key typed goes; the field left draws none.
  const patterns = rawRow("Patterns");
  expect(patterns).toContain(inverse("a"));
  expect(stripAnsi(patterns.slice(patterns.indexOf(INVERSE)))).toMatch(/^adds matches, e\.g\./);
  expect(rawRow("Name")).not.toContain(INVERSE);
  instance.unmount();
});
