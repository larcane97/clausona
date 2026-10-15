import { Text } from "ink";
import { describe, expect, it } from "vitest";

import { renderAt } from "../test-drive.js";
import { bodyRows, Chrome, chromeRows } from "./Chrome.js";

const HINTS = [
  { keys: "↑↓", action: "nav" },
  { keys: "enter", action: "switch" },
  { keys: "a", action: "add" },
  { keys: "d", action: "remove" },
  { keys: "l", action: "re-login" },
  { keys: "s", action: "sessions" },
  { keys: "esc", action: "back" },
];

// A screen gives its lists what Chrome leaves of the terminal, so the count has to be the lines
// Chrome draws, at every width and with every kind of footer.
describe("chromeRows", () => {
  const cases: Array<[string, Parameters<typeof chromeRows>[0]]> = [
    ["nothing below the body", {}],
    ["hints", { hints: HINTS }],
    ["a message and hints", { footer: "Switched to claude:work", hints: HINTS }],
    ["two message lines", { footer: ["one", "two"], hints: HINTS }],
    ["an empty message", { footer: "", hints: HINTS }],
    ["a question and hints", { question: "Remove route main? (y/N)", hints: HINTS }],
    ["a message alone", { footer: "Reading quota again…" }],
  ];

  for (const [name, props] of cases) {
    it(`is the lines Chrome draws around a body, with ${name}`, () => {
      for (const columns of [30, 44, 60, 80, 120]) {
        const app = renderAt(
          <Chrome title="Profiles" subtitle="Select a profile to manage" {...props}>
            <Text>body</Text>
          </Chrome>,
          columns,
        );
        const drawn = (app.lastFrame() ?? "").split("\n").length;
        app.unmount();
        expect(drawn - 1, `${columns} columns`).toBe(chromeRows(props, columns));
      }
    });
  }
});

describe("bodyRows", () => {
  it("leaves the body what Chrome and the spare lines leave of the terminal", () => {
    expect(bodyRows({ columns: 120, rows: 40 }, { hints: HINTS })).toBe(40 - 2 - chromeRows({ hints: HINTS }, 120));
  });

  it("says nothing when the terminal gives no height", () => {
    expect(bodyRows({ columns: 120 }, { hints: HINTS })).toBeUndefined();
  });
});
