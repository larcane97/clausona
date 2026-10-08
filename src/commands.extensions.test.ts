import { describe, expect, it } from "vitest";

import { runCommand } from "./commands.js";

describe("skills, mcp and hooks commands", () => {
  it("refuse an unknown option before reading anything", async () => {
    await expect(runCommand("skills", ["ls", "--bogus"])).rejects.toThrow("Unknown option: --bogus");
    await expect(runCommand("mcp", ["ls", "--project=x", "--nope"])).rejects.toThrow("Unknown option: --nope");
  });

  it("are in the main help", async () => {
    const help = await runCommand("help", []);
    expect(help).toContain("skills ls");
    expect(help).toContain("mcp ls");
    expect(help).toContain("hooks ls");
  });
});
