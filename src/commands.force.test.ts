import { describe, expect, it } from "vitest";

import { runCommand } from "./commands.js";
import { stripAnsi } from "./lib/cli-style.js";

describe("--force on the commands that relink a profile", () => {
  it.each([
    "repair",
    "config",
    "init",
  ])("is described for Claude Code's daemon on %s --help, in 100 columns", async (command) => {
    const help = stripAnsi(await runCommand(command, ["--help"]));
    for (const line of help.split("\n")) expect(line.length, line).toBeLessThanOrEqual(100);
    const force = help.slice(help.indexOf("--force  "));
    expect(force).toMatch(/Codex, or Claude Code's background\s+(daemon, )?/);
  });

  it("says on repair --help how to stop the daemon instead", async () => {
    const help = stripAnsi(await runCommand("repair", ["--help"])).replace(/\s+/g, " ");
    expect(help).toContain("Stop it with `claude daemon stop` in that profile first, or pass --force.");
  });
});
