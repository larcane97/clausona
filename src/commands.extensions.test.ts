import { describe, expect, it } from "vitest";

import { runCommand } from "./commands.js";
import { stripAnsi } from "./lib/cli-style.js";

const COMMANDS = ["skills", "mcp", "hooks"] as const;
const PAGES = [
  { page: "the overview", sub: "" },
  { page: "the ls page", sub: "ls" },
  { page: "the show page", sub: "show" },
] as const;

describe("skills, mcp and hooks commands", () => {
  it("refuse an unknown option before reading anything, as bad usage", async () => {
    await expect(runCommand("skills", ["ls", "--bogus"])).rejects.toThrow("Unknown option: --bogus");
    await expect(runCommand("mcp", ["ls", "--project=x", "--nope"])).rejects.toThrow("Unknown option: --nope");
    await expect(runCommand("hooks", ["ls", "--filter", "off"])).rejects.toMatchObject({ code: 2 });
    await expect(runCommand("skills", ["ls", "--all-projects"])).rejects.toMatchObject({ code: 2 });
  });

  describe.each(COMMANDS)("%s --help", (command) => {
    it.each(PAGES)("is $page, in 100 columns, pointing to the docs", async ({ sub }) => {
      const help = stripAnsi(await runCommand(command, [...(sub ? [sub] : []), "--help"]));
      for (const line of help.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
      expect(help).toContain("docs/extensions.md");
      if (sub) {
        expect(help).toContain(`clausona ${command} ${sub} — `);
        expect(help).toContain("EXAMPLES");
        expect(help).toContain("EXIT CODES");
      } else {
        expect(help).toContain(`clausona ${command} — `);
        expect(help).toContain("SUBCOMMANDS");
      }
    });
  });

  it("spell out every scope a command takes, on its ls page", async () => {
    const ls = async (command: string) => stripAnsi(await runCommand(command, ["ls", "--help"]));
    expect(await ls("skills")).toContain(
      "--scope <scope>   loaded (default) | project | global | cloud | plugins | builtin | other\n" +
        "                      | unused | all",
    );
    expect(await ls("mcp")).toContain(
      "--account <name>  Only this Claude account (repeatable): in Loaded here, the rows that\n" +
        "                      load for it; in any other scope, the rows it has",
    );
    expect(await ls("hooks")).toMatch(
      /--scope <scope> {3}loaded \(default\) \| project \| global \| plugins \| managed/,
    );
  });

  it("spell out on the show page every scope ls takes", async () => {
    const page = async (command: string, sub: string) => stripAnsi(await runCommand(command, [sub, "--help"]));
    for (const command of ["skills", "mcp", "hooks"]) {
      const values = (help: string) =>
        (/--scope <scope>\s+([\s\S]*?)\n\s+--/.exec(help)?.[1] ?? "")
          .replace("Look in this scope only, to pick one copy:", "")
          .replace("(default)", "")
          .split("|")
          .map((value) => value.trim());
      expect(values(await page(command, "show"))).toEqual(values(await page(command, "ls")));
    }
    expect(await page("skills", "show")).toContain(
      "--scope <scope>   Look in this scope only, to pick one copy:\n" +
        "                      loaded | project | global | cloud | plugins | builtin | other | unused\n" +
        "                      | all",
    );
  });

  it("are in the main help", async () => {
    const help = stripAnsi(await runCommand("help", []));
    expect(help).toMatch(/skills ls\|show\s+Skills each project loads, by scope/);
    expect(help).toMatch(/mcp ls\|show\s+MCP servers each project loads, by scope/);
    expect(help).toMatch(/hooks ls\|show\s+Hooks each project runs, by scope/);
  });
});
