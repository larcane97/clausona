import { describe, expect, it } from "vitest";

import { runCommand } from "./commands.js";
import { EXTENSIONS_FLAGS, SUBS } from "./extensions/cli.js";
import { ExitError } from "./extensions/exit-error.js";
import { stripAnsi } from "./lib/cli-style.js";

const COMMANDS = ["skills", "mcp", "hooks"] as const;
/** Each command's pages: the overview, then one per subcommand it takes. */
const PAGES = COMMANDS.flatMap((command) => ["", ...SUBS[command]].map((sub) => ({ command, sub })));

/** The lines of a page's section, from its heading to the blank line after it. */
function sectionLines(help: string, title: string): string[] {
  const lines = help.split("\n");
  const at = lines.findIndex((line) => line.trim() === title || line.trim().startsWith(`${title} `));
  if (at < 0) return [];
  const end = lines.findIndex((line, i) => i > at && line.trim() === "");
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

describe("skills, mcp and hooks commands", () => {
  it("refuse an unknown option before reading anything, as bad usage", async () => {
    await expect(runCommand("skills", ["ls", "--bogus"])).rejects.toThrow("Unknown option: --bogus");
    await expect(runCommand("mcp", ["ls", "--project=x", "--nope"])).rejects.toThrow("Unknown option: --nope");
    await expect(runCommand("hooks", ["ls", "--filter", "off"])).rejects.toMatchObject({ code: 2 });
    await expect(runCommand("skills", ["ls", "--all-projects"])).rejects.toMatchObject({ code: 2 });
  });

  it("say an unknown option as one JSON object on stdout with --json (#103)", async () => {
    const error = await runCommand("skills", ["ls", "--bogus", "--json"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).code).toBe(2);
    expect(JSON.parse((error as ExitError).stdout ?? "")).toEqual({
      version: 1,
      error: "usage",
      message: "Unknown option: --bogus\nRun `clausona skills --help` for usage.",
    });
  });

  it("take the flags of a change", async () => {
    const changes = ["--everywhere", "--dry-run", "--yes", "-y", "--tracked"];
    expect(EXTENSIONS_FLAGS).toEqual(expect.arrayContaining(changes));
    // Each passes the option check: the unknown option after it is the one named. Nothing is read.
    for (const flag of changes) {
      for (const command of COMMANDS) {
        await expect(runCommand(command, ["off", flag, "--bogus"])).rejects.toThrow(/^Unknown option: --bogus\n/);
      }
    }
  });

  it.each(PAGES)("$command $sub --help is in 100 columns, pointing to the docs", async ({ command, sub }) => {
    const help = stripAnsi(await runCommand(command, [...(sub ? [sub] : []), "--help"]));
    for (const line of help.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(help).toContain("docs/extensions.md");
    if (sub) {
      const title = sub === "off" || sub === "on" ? "off | on" : sub;
      expect(help.split("\n")[1]).toContain(`clausona ${command} ${title} — `);
      expect(sectionLines(help, "EXAMPLES").filter((line) => line.startsWith("    clausona "))).toHaveLength(3);
      expect(help).toContain("EXIT CODES");
    } else {
      expect(help).toContain(`clausona ${command} — `);
      // The overview lists every subcommand the command takes.
      const listed = sectionLines(help, "SUBCOMMANDS").flatMap(
        (line) => line.trim().split(/ {2,}/)[0]?.split(", ") ?? [],
      );
      expect(listed).toEqual([...SUBS[command]]);
    }
  });

  it("point to the recipes for agents from the overview and the rm page", async () => {
    const recipes = "https://github.com/larcane97/clausona/blob/main/docs/extensions.md#recipes-for-agents";
    for (const command of COMMANDS) {
      for (const args of [["--help"], ["rm", "--help"]]) {
        expect(stripAnsi(await runCommand(command, args)), `${command} ${args.join(" ")}`).toContain(`  ${recipes}\n`);
      }
    }
  });

  it("give off and on one page", async () => {
    for (const command of COMMANDS) {
      expect(await runCommand(command, ["off", "--help"])).toBe(await runCommand(command, ["on", "--help"]));
    }
  });

  it("spell out a change's options on its page", async () => {
    const page = async (command: string, sub: string) => stripAnsi(await runCommand(command, [sub, "--help"]));
    const off = await page("skills", "off");
    expect(off).toContain("--everywhere      In every project: your user settings (Codex: its config.toml)\n");
    expect(off).toContain(
      '--id <id>         An exact id, the "id" field of ls --json, instead of a name (repeatable)\n',
    );
    expect(off).toContain("--yes, -y         Do not ask first. Needed when there is no terminal\n");
    expect(off).toContain(
      "  EXIT CODES   0 done, or nothing to do · 1 refused, changed meanwhile or failed · 2 bad usage,\n" +
        "               several matches, or no terminal without --yes\n",
    );
    expect(off).toContain("docs/extensions.md#changing-things");
    expect(await page("skills", "rm")).toContain(
      "--tracked         Delete it even if git tracks it, which changes the repo\n",
    );
    expect(await page("skills", "visibility")).not.toContain("--tool <tool>");
    // A change's page says where an id goes there; ls and show keep theirs.
    const here = 'An id is the "id" field of ls --json. Pass it back as it is, to --id here or as the name.';
    expect(off).toContain(here);
    expect(await page("hooks", "rm")).toContain(here);
    expect(await page("skills", "ls")).toContain("Pass it back as it is, to show --id or as the name.");
    // Hooks are off or on everywhere: the overview offers no --everywhere, as the off | on page.
    expect(stripAnsi(await runCommand("hooks", ["--help"]))).not.toContain("--everywhere");
    expect(await page("hooks", "off")).not.toContain("--everywhere");
    expect(await page("mcp", "off")).toContain("--account <name>  Only this Claude account (repeatable)\n");
    expect(await page("hooks", "undo")).toContain("clausona hooks undo — Put back what the last hooks change changed");
    expect(await page("mcp", "undo")).toContain(
      "  EXIT CODES   0 put back · 1 nothing to undo, or a file changed since · 2 bad usage or no terminal\n" +
        "               without --yes\n",
    );
  });

  it("spell out every scope a command takes, on its ls page", async () => {
    const ls = async (command: string) => stripAnsi(await runCommand(command, ["ls", "--help"]));
    expect(await ls("skills")).toContain(
      "--scope <scope>   loaded (default) | project | global | cloud | plugins | builtin | other\n" +
        "                      | unused | all",
    );
    expect(await ls("mcp")).toContain(
      "--account <name>  Only this Claude account (repeatable): in Loaded, the rows that\n" +
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
    expect(help).toMatch(/skills ls\|show\|off\|on\|rm\s+Skills each project loads; turn them off or delete them/);
    expect(help).toMatch(/mcp ls\|show\|off\|on\|rm\s+MCP servers each project loads; turn them off or delete them/);
    expect(help).toMatch(/hooks ls\|show\|off\|on\|rm\s+Hooks each project runs; turn them off or delete them/);
  });
});
