import { describe, expect, it } from "vitest";

import { runCommand } from "./commands.js";
import { stripAnsi } from "./lib/cli-style.js";

describe("skills, mcp and hooks commands", () => {
  it("refuse an unknown option before reading anything", async () => {
    await expect(runCommand("skills", ["ls", "--bogus"])).rejects.toThrow("Unknown option: --bogus");
    await expect(runCommand("mcp", ["ls", "--project=x", "--nope"])).rejects.toThrow("Unknown option: --nope");
  });

  it.each(["skills", "mcp", "hooks"])("%s --help fits in 100 columns and names stateByAccount", async (command) => {
    const help = stripAnsi(await runCommand(command, ["--help"]));
    expect(help).toContain(`clausona ${command} ls [--json]`);
    expect(help).toContain("stateByAccount");
    for (const line of help.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("are in the main help", async () => {
    const help = await runCommand("help", []);
    expect(help).toContain("skills ls");
    expect(help).toContain("mcp ls");
    expect(help).toContain("hooks ls");
  });
});
