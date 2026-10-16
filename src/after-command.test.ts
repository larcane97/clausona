import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AfterCommandDeps, askAfterCommand, mayAsk, startUpdateCheck } from "./after-command.js";
import { STAR_URL, type StarOutcome } from "./core/star.js";
import { reinstallCommand } from "./core/update.js";
import { stripAnsi } from "./lib/cli-style.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-10T09:00:00.000Z");
const at = (time: number) => new Date(time).toISOString();
const GRACE = 700;
const TAG = "v0.12.0-beta";

/** A terminal's stdin: raw mode is recorded, and keys are written to it. */
class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  modes: boolean[] = [];
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
}

class Sink {
  text = "";
  write(chunk: string) {
    this.text += chunk;
    return true;
  }
  get plain() {
    return stripAnsi(this.text);
  }
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clausona-after-"));
  file = path.join(dir, "notices.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const seed = (notices: Record<string, unknown>) => writeFileSync(file, JSON.stringify(notices));
const stored = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** One command's run: a clausona at 0.11.0-beta that the installer put in place, at `clock.now`. */
function setup(overrides: Partial<AfterCommandDeps> = {}, startAt = START) {
  const clock = { now: startAt };
  const input = new FakeTty();
  const output = new Sink();
  const errors = new Sink();
  const startCheck = vi.fn(() => {});
  const install = vi.fn(async (_tag: string, _target: string) => {});
  const give = vi.fn(async (): Promise<StarOutcome> => ({ kind: "starred", login: "octocat" }));
  const deps: AfterCommandDeps = {
    notices: { path: file, now: () => clock.now, env: {} },
    current: "0.11.0-beta",
    target: "/home/u/.local/share/clausona/index.js",
    platform: "linux",
    input,
    output,
    errors,
    graceMs: GRACE,
    startCheck,
    install,
    give,
    ...overrides,
  };
  return { deps, clock, input, output, errors, startCheck, install, give };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error("timed out waiting");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Waits for the question, lets the grace pass, and answers it with `key`. */
async function answer(run: ReturnType<typeof setup>, question: string, key: string) {
  await until(() => run.output.plain.includes(question));
  run.clock.now += GRACE;
  run.input.write(key);
  await tick();
}

const updateDue = { updateCheckedAt: at(START - HOUR), latestTag: TAG, firstUsedAt: at(START - DAY) };

describe("mayAsk", () => {
  const terminal = { stdinTTY: true, stdoutTTY: true, env: {} };

  it.each([
    ["list", []],
    ["list", ["--no-quota"]],
    ["current", []],
    ["use", ["work"]],
    ["doctor", []],
    ["route", ["list"]],
    ["skills", ["ls"]],
    ["add", ["claude:work"]],
    ["config", ["work", "--label", "Work"]],
  ])("asks after %s %j in a terminal", (command, args) => {
    expect(mayAsk(command, args, terminal)).toBe(true);
  });

  it.each([
    ["update", []],
    ["star", []],
    ["uninstall", []],
    ["help", []],
    ["-h", []],
    ["--help", []],
    ["version", []],
    ["-v", []],
    ["--version", []],
    ["shell-init", []],
    ["run", []],
    ["claude", []],
    ["codex", []],
    ["_launch", ["claude"]],
    ["_shell-env", ["claude"]],
    ["_update-check", []],
    ["list", ["--help"]],
    ["add", ["-h"]],
    ["route", []],
    ["route", ["help"]],
    ["route", ["--help"]],
    ["route", ["add", "--help"]],
    ["list", ["--json"]],
    ["skills", ["ls", "--json"]],
    ["route", ["pick", "main", "--json"]],
  ])("never asks after %s %j", (command, args) => {
    expect(mayAsk(command, args, terminal)).toBe(false);
  });

  it("asks only where someone can answer: stdin and stdout both a terminal, not on CI", () => {
    expect(mayAsk("list", [], { ...terminal, stdinTTY: false })).toBe(false);
    expect(mayAsk("list", [], { ...terminal, stdoutTTY: false })).toBe(false);
    expect(mayAsk("list", [], { ...terminal, env: { CI: "true" } })).toBe(false);
    expect(mayAsk("list", [], { ...terminal, env: { CI: "false" } })).toBe(true);
  });

  it("never asks after a command that failed", () => {
    expect(mayAsk("list", [], { ...terminal, exitCode: 1 })).toBe(false);
    expect(mayAsk("list", [], { ...terminal, exitCode: 0 })).toBe(true);
  });
});

describe("the update question", () => {
  it("asks for the release the last check learned, and a y updates as clausona update --yes does", async () => {
    seed(updateDue);
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "y");
    await done;

    expect(run.output.plain.split("\n")).toEqual([
      "",
      "  ⬆ clausona v0.12.0-beta is available (you have v0.11.0-beta)",
      "  Update now? (Y/n) y",
      "  ✔ Updated v0.11.0-beta → v0.12.0-beta",
      "    Open a new shell to load its shell hook.",
      "",
    ]);
    expect(run.install).toHaveBeenCalledWith(TAG, "/home/u/.local/share/clausona/index.js");
    // A day has not passed since the last check.
    expect(run.startCheck).not.toHaveBeenCalled();
    expect(run.input.modes).toEqual([true, false]);
  });

  // `csn list` ends its output with a blank line of its own; `csn use` does not.
  it("leaves one blank line above it, after output that ends with one", async () => {
    seed(updateDue);
    const run = setup({ separated: true });

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "n");
    await done;

    expect(run.output.plain.startsWith("  ⬆ clausona v0.12.0-beta")).toBe(true);
  });

  it("takes Enter as a yes", async () => {
    seed(updateDue);
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "\r");
    await done;

    expect(run.output.plain).toContain("Update now? (Y/n) y\n");
    expect(run.install).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["n", "n"],
    ["N", "N"],
    ["Ctrl+C", "\u0003"],
  ])("skips on %s, and does not ask again for seven days, whatever is released meanwhile", async (_name, key) => {
    seed(updateDue);
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", key);
    await done;

    expect(run.output.plain.split("\n").slice(2)).toEqual([
      "  Update now? (Y/n) n",
      "    Skipped. Run clausona update when you're ready.",
      "",
    ]);
    expect(run.install).not.toHaveBeenCalled();
    expect(run.input.modes).toEqual([true, false]);
    // Noted when it was answered.
    expect(stored().updateSkippedAt).toBe(at(START + GRACE));

    // A newer release six days on: still not asked.
    seed({ ...stored(), latestTag: "v0.13.0-beta", starAsked: true });
    const later = setup({}, START + GRACE + 6 * DAY);
    await askAfterCommand(later.deps);
    expect(later.output.text).toBe("");

    const after = setup({}, START + GRACE + 7 * DAY);
    const asked = askAfterCommand(after.deps);
    await answer(after, "(Y/n)", "n");
    await asked;
    expect(after.output.plain).toContain("clausona v0.13.0-beta is available");
  });

  it("does not take keys typed before it appeared, or in its first 700 ms", async () => {
    seed(updateDue);
    const run = setup();
    // Typed while the command ran: waiting in stdin when the question starts reading.
    run.input.write("y");

    const done = askAfterCommand(run.deps);
    await until(() => run.output.plain.includes("(Y/n)"));
    await tick();
    run.clock.now += GRACE - 1;
    run.input.write("\r");
    await tick();
    expect(run.output.plain).not.toContain("(Y/n) y");

    run.clock.now += 1;
    run.input.write("n");
    await done;

    expect(run.output.plain).toContain("(Y/n) n");
    expect(run.install).not.toHaveBeenCalled();
  });

  it("waits through keys that are not an answer", async () => {
    seed(updateDue);
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "x");
    run.input.write("\u001b[A");
    await tick();
    expect(run.output.plain).not.toMatch(/\(Y\/n\) ./);
    run.input.write("n");
    await done;

    expect(run.output.plain).toContain("(Y/n) n");
  });

  it("says why an update failed, and leaves the command's exit code alone", async () => {
    seed(updateDue);
    const run = setup({
      install: async () => {
        throw new Error("Could not download clausona v0.12.0-beta: HTTP 404");
      },
    });
    const before = process.exitCode;

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "y");
    await done;

    expect(run.errors.plain).toBe("  ✘ Could not download clausona v0.12.0-beta: HTTP 404\n");
    expect(run.output.plain).not.toContain("Updated");
    expect(process.exitCode).toBe(before);
  });

  it("gives the installer's command instead of asking when this copy cannot replace itself, and holds it seven days", async () => {
    seed(updateDue);
    const run = setup({ target: null, platform: "darwin" });

    await askAfterCommand(run.deps);

    expect(run.output.plain).toBe(
      `\n  ⬆ clausona v0.12.0-beta is available. To update, run: ${reinstallCommand("darwin")}\n`,
    );
    expect(run.input.modes).toEqual([]);
    expect(stored().updateSkippedAt).toBe(at(START));

    seed({ ...stored(), starAsked: true });
    const later = setup({ target: null }, START + 6 * DAY);
    await askAfterCommand(later.deps);
    expect(later.output.text).toBe("");
  });

  it("starts the day's check in the background, at most once a day, and asks from what it learned", async () => {
    const first = setup();
    await askAfterCommand(first.deps);
    expect(first.startCheck).toHaveBeenCalledTimes(1);
    expect(first.output.text).toBe("");
    expect(stored().updateCheckedAt).toBe(at(START));

    const again = setup({}, START + 23 * HOUR);
    await askAfterCommand(again.deps);
    expect(again.startCheck).not.toHaveBeenCalled();

    // What the background check wrote, for the next command to ask from.
    seed({ ...stored(), latestTag: TAG });
    const next = setup({}, START + 24 * HOUR);
    const asked = askAfterCommand(next.deps);
    await answer(next, "(Y/n)", "n");
    await asked;
    expect(next.startCheck).toHaveBeenCalledTimes(1);
    expect(next.output.plain).toContain("clausona v0.12.0-beta is available (you have v0.11.0-beta)");
  });

  it("asks nothing for a release that is not newer", async () => {
    seed({ ...updateDue, latestTag: "v0.11.0-beta", starAsked: true });
    const run = setup();

    await askAfterCommand(run.deps);
    expect(run.output.text).toBe("");
  });
});

describe("the star question", () => {
  it("is asked three days after the first command, once, and recorded before it shows", async () => {
    seed({ updateCheckedAt: at(START) });
    const first = setup();
    await askAfterCommand(first.deps);
    expect(first.output.text).toBe("");
    expect(stored().firstUsedAt).toBe(at(START));

    const early = setup({}, START + 3 * DAY - 1);
    await askAfterCommand(early.deps);
    expect(early.output.text).toBe("");

    const run = setup({}, START + 3 * DAY);
    const done = askAfterCommand(run.deps);
    await until(() => run.output.plain.includes("(y/N)"));
    expect(stored().starAsked).toBe(true);
    await answer(run, "(y/N)", "n");
    await done;

    expect(run.output.plain.split("\n")).toEqual([
      "",
      "  ★ Was clausona helpful? A star on GitHub helps others find it.",
      "  Star it now? (y/N) n",
      "",
    ]);
    expect(run.give).not.toHaveBeenCalled();

    const later = setup({}, START + 30 * DAY);
    await askAfterCommand(later.deps);
    expect(later.output.text).toBe("");
  });

  it("counts from the day the dashboard first opened", async () => {
    seed({ updateCheckedAt: at(START), firstDashboardAt: at(START - 3 * DAY) });
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(y/N)", "n");
    await done;
    expect(run.output.plain).toContain("Star it now? (y/N) n");
  });

  it("is not asked once the dashboard has asked", async () => {
    seed({ updateCheckedAt: at(START), firstDashboardAt: at(START - 30 * DAY), starAsked: true });
    const run = setup();

    await askAfterCommand(run.deps);
    expect(run.output.text).toBe("");
  });

  it("stars on y, and says what clausona star says", async () => {
    for (const [outcome, said] of [
      [{ kind: "starred", login: "octocat" }, ["  ✔ Starred larcane97/clausona as @octocat. Thank you!"]],
      [
        { kind: "opened", url: STAR_URL },
        [`  ✔ Opened ${STAR_URL} in your browser`, "    Press Star at the top of the page. Thank you!"],
      ],
      [
        { kind: "manual", url: STAR_URL },
        [
          `  ★ Star clausona at ${STAR_URL}`,
          "    With gh signed in ('gh auth login'), clausona star stars it from here.",
        ],
      ],
    ] as const) {
      seed({ updateCheckedAt: at(START), firstUsedAt: at(START - 3 * DAY) });
      const run = setup({ give: async () => outcome });

      const done = askAfterCommand(run.deps);
      await answer(run, "(y/N)", "y");
      await done;

      expect(run.output.plain.split("\n").slice(2)).toEqual(["  Star it now? (y/N) y", ...said, ""]);
      expect(run.input.modes).toEqual([true, false]);
    }
  });

  it.each([
    ["Enter", "\r"],
    ["n", "n"],
    ["another key", "x"],
    ["an arrow", "\u001b[B"],
    ["Ctrl+C", "\u0003"],
  ])("stars nothing on %s", async (_name, key) => {
    seed({ updateCheckedAt: at(START), firstUsedAt: at(START - 3 * DAY) });
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(y/N)", key);
    await done;

    expect(run.give).not.toHaveBeenCalled();
    expect(run.output.plain.endsWith("Star it now? (y/N) n\n")).toBe(true);
    expect(run.input.modes).toEqual([true, false]);
  });

  it("does not take a y typed before it appeared, or in its first 700 ms", async () => {
    seed({ updateCheckedAt: at(START), firstUsedAt: at(START - 3 * DAY) });
    const run = setup();
    run.input.write("y");

    const done = askAfterCommand(run.deps);
    await until(() => run.output.plain.includes("(y/N)"));
    await tick();
    run.clock.now += GRACE - 1;
    run.input.write("y");
    await tick();
    expect(run.give).not.toHaveBeenCalled();

    run.clock.now += 1;
    run.input.write("\r");
    await done;
    expect(run.give).not.toHaveBeenCalled();
    expect(run.output.plain).toContain("(y/N) n");
  });

  it("counts a terminal that closes as a no, and restores it", async () => {
    seed({ updateCheckedAt: at(START), firstUsedAt: at(START - 3 * DAY) });
    const run = setup();

    const done = askAfterCommand(run.deps);
    await until(() => run.output.plain.includes("(y/N)"));
    run.input.end();
    await done;

    expect(run.give).not.toHaveBeenCalled();
    expect(run.input.modes).toEqual([true, false]);
  });
});

describe("one question a run", () => {
  it("asks the update when both are due, and leaves the star, unclaimed, for the next command", async () => {
    seed({ ...updateDue, firstUsedAt: at(START - 4 * DAY) });
    const run = setup();

    const done = askAfterCommand(run.deps);
    await answer(run, "(Y/n)", "n");
    await done;

    expect(run.output.plain).not.toContain("Star it now");
    expect(stored()).toEqual({ ...updateDue, firstUsedAt: at(START - 4 * DAY), updateSkippedAt: at(START + GRACE) });

    const next = setup({}, START + HOUR);
    const asked = askAfterCommand(next.deps);
    await answer(next, "(y/N)", "n");
    await asked;
    expect(next.output.plain).toContain("Was clausona helpful?");
    expect(next.output.plain).not.toContain("(Y/n)");
    expect(stored().starAsked).toBe(true);
  });

  it("counts the installer line as the run's notice too", async () => {
    seed({ ...updateDue, firstUsedAt: at(START - 4 * DAY) });
    const run = setup({ target: null });

    await askAfterCommand(run.deps);
    expect(run.output.plain).not.toContain("Star it now");
    expect(stored().starAsked).toBeUndefined();
  });
});

describe("askAfterCommand", () => {
  it("does nothing, and never throws, with a record it cannot read", async () => {
    writeFileSync(file, "{ not json");
    const run = setup();

    await expect(askAfterCommand(run.deps)).resolves.toBeUndefined();
    expect(run.output.text).toBe("");
    expect(run.startCheck).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("startUpdateCheck", () => {
  it("starts clausona _update-check on its own, with no terminal, and does not wait for it", () => {
    const unref = vi.fn();
    const on = vi.fn();
    const spawn = vi.fn(() => ({ unref, on }));

    startUpdateCheck({ spawn, execPath: "/usr/bin/node", entry: "/app/index.js" });

    expect(spawn).toHaveBeenCalledWith("/usr/bin/node", ["/app/index.js", "_update-check"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalled();
    // A spawn that fails reports it as an event; unheard, that would end the command with a crash.
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("starts nothing without an entry to run", () => {
    const spawn = vi.fn();

    startUpdateCheck({ spawn, execPath: "/usr/bin/node", entry: "" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
