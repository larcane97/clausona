import { describe, expect, it, vi } from "vitest";

import { runCommand, runStarCommand, type StarCommandDeps } from "./commands.js";
import { STAR_URL, type StarOutcome } from "./core/star.js";
import { stripAnsi } from "./lib/cli-style.js";

function setup(outcome: StarOutcome) {
  const give = vi.fn(async () => outcome);
  const record = vi.fn(async () => {});
  const deps: StarCommandDeps = { give, record };
  return { deps, give, record };
}

describe("clausona star", () => {
  it("says it starred, and as whom", async () => {
    const { deps, give, record } = setup({ kind: "starred", login: "octocat" });

    expect(stripAnsi(await runStarCommand([], deps))).toBe("  ✔ Starred larcane97/clausona as @octocat. Thank you!");
    expect(give).toHaveBeenCalledTimes(1);
    // The dashboard does not ask someone who has been here.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("leaves the account out when gh did not say it", async () => {
    const { deps } = setup({ kind: "starred", login: null });

    expect(stripAnsi(await runStarCommand([], deps))).toBe("  ✔ Starred larcane97/clausona. Thank you!");
  });

  it("says where to press Star when it opened the page", async () => {
    const { deps, record } = setup({ kind: "opened", url: STAR_URL });

    expect(stripAnsi(await runStarCommand([], deps)).split("\n")).toEqual([
      `  ✔ Opened ${STAR_URL} in your browser`,
      "    Press Star at the top of the page. Thank you!",
    ]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("gives the address, and how gh could star it from here, when nothing could be opened", async () => {
    const { deps, record } = setup({ kind: "manual", url: STAR_URL });

    expect(stripAnsi(await runStarCommand([], deps)).split("\n")).toEqual([
      `  ★ Star clausona at ${STAR_URL}`,
      "    With gh signed in ('gh auth login'), clausona star stars it from here.",
    ]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("takes no arguments", async () => {
    const { deps, give } = setup({ kind: "starred", login: null });

    await expect(runStarCommand(["now"], deps)).rejects.toThrow("clausona star takes no arguments.");
    expect(give).not.toHaveBeenCalled();
  });

  it("refuses an option it does not know", async () => {
    await expect(runCommand("star", ["--force"])).rejects.toThrow("--force");
  });

  it("has a help page, and a line in the command list", async () => {
    expect(stripAnsi(await runCommand("star", ["--help"]))).toContain("clausona star — Star clausona on GitHub");
    expect(stripAnsi(await runCommand("help", []))).toMatch(/star\s+Star clausona on GitHub/);
  });
});
