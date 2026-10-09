import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../commands.js";
import { stripAnsi } from "../lib/cli-style.js";
import { type ExtensionsCommand, extensionsHelp, runExtensionsCommand } from "./cli.js";
import { hookWhen } from "./describe.js";
import { ExitError } from "./exit-error.js";
import { CLEANUP_GRACE_DAYS, CLEANUP_UNUSED_DAYS } from "./inventory.js";
import { SCOPE_LABEL, type ScopeId } from "./scopes.js";
import { TestHome } from "./test-home.js";

/**
 * docs/extensions.md and the README's Extensions section, kept in step with the code: every
 * scope label, tag, `--scope` value, row key form and JSON field the CLI has is in the docs, in
 * its words, and in the tables that list them.
 */

/** A file of the repo, or "" when it is missing, so each case says what it lacks. */
function read(rel: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  } catch {
    return "";
  }
}
const DOC = read("../../docs/extensions.md");
const README = read("../../README.md");

const COMMANDS: readonly ExtensionsCommand[] = ["skills", "mcp", "hooks"];
const SCOPE_IDS = Object.keys(SCOPE_LABEL) as ScopeId[];

const DAY = 86_400_000;
/** 200 days after the seed's files were made: every own skill never used is unused. */
const NOW = Date.now() + 200 * DAY;

/** The tags, verbatim (the plan's Global Constraints), most important first, as tagsOf orders them. */
const TAGS = [
  "broken link",
  "off",
  "off here",
  "off in N of M accounts",
  "pending approval",
  "hidden by Project copy",
  "hidden by Global copy",
  "hidden by Parent folders copy",
  "unused",
];

/** The keys `ls --json` writes, in order. */
const ENVELOPE_KEYS = ["version", "command", "project", "scope", "tools", "items", "warnings"];

/** Every key a JSON v1 item can have, in the order jsonItem writes them. */
const ITEM_KEYS = [
  "id",
  "kind",
  "tool",
  "name",
  "scope",
  "from",
  "project",
  "plugin",
  "accounts",
  "state",
  "stateByAccount",
  "usage",
  "tags",
  "file",
  "copies",
  "description",
  "alsoIn",
  "link",
  "summary",
  "contains",
];

const CANDIDATE_KEYS = ["id", "tool", "scope", "project", "account"];

/** The table under `### <title>`: its header's cells and each body row's, split at pipes that are not escaped. */
function table(doc: string, title: string): { header: string[]; rows: string[][] } {
  const lines = doc.split("\n");
  const start = lines.indexOf(`### ${title}`);
  if (start < 0) throw new Error(`no heading "### ${title}"`);
  const found: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.startsWith("|") || /^\|[-| ]+\|$/.test(line)) continue;
    found.push(
      line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
  }
  const [header = [], ...rows] = found;
  return { header, rows };
}

/** A cell that is one backticked name, without its backticks. */
const code = (cell: string | undefined) => /^`([^`]+)`$/.exec(cell ?? "")?.[1];

/** The backticked names in the first column of the table under `### <title>`, in order. */
const tableNames = (doc: string, title: string) =>
  table(doc, title)
    .rows.map((row) => code(row[0]))
    .filter((name): name is string => name !== undefined);

/** The lines of the section under `### <title>`, up to the next heading. */
function section(doc: string, title: string): string[] {
  const lines = doc.split("\n");
  const start = lines.indexOf(`### ${title}`);
  if (start < 0) throw new Error(`no heading "### ${title}"`);
  const end = lines.findIndex((line, at) => at > start && line.startsWith("#"));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Whether `keys` appear in `order` in the same order, any of them left out. */
function inOrder(keys: string[], order: string[]): boolean {
  let at = 0;
  for (const key of keys) {
    at = order.indexOf(key, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** A tag in the words the docs give it: a count of accounts as `N of M`. */
const tagWord = (tag: string) => tag.replace(/^off in \d+ of \d+ accounts$/, "off in N of M accounts");

/** The `--scope` values an ls help page lists. */
function scopeValues(command: ExtensionsCommand): string[] {
  const help = stripAnsi(extensionsHelp(command, "ls"));
  const list = /--scope <scope>\s+([\s\S]*?)\n\s+--tool/.exec(help)?.[1] ?? "";
  return list
    .split("|")
    .map((value) => value.replace("(default)", "").trim())
    .filter(Boolean);
}

/** A documented key form as a pattern: its `<placeholders>` as what each one can be. */
function keyPattern(form: string): RegExp {
  const parts: Record<string, string> = {
    "<account or local>": "(?:account|local)",
    "<project or ->": "(?:-|.+)",
    "<install scope>": "(?:user|project|local)",
    "<plugin id>": "[^:@]+@[^:]+",
    "<kind>": "(?:skill|mcp|hook)",
    "<name>": ".+",
  };
  const source = form
    .split(/(<[^>]+>)/)
    .map((piece) => {
      if (!piece.startsWith("<")) return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const part = parts[piece];
      if (part === undefined) throw new Error(`no pattern for ${piece}`);
      return part;
    })
    .join("");
  return new RegExp(`^${source}$`);
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

/**
 * Something of every shape the docs describe, seen from repos/team/app, 200 days on:
 * - a server two accounts define, off in one (a row of copies), and a Cloud skill both have;
 * - a working link and a broken one, a skill off in user settings and one off in the project's;
 * - a Project eli5 a Global one hides; a `.mcp.json` server pending approval, hidden by the
 *   project's copy in the folder above, and one hidden by a nearer parent folder's;
 * - a plugin and its skill, a hook, and an eli5 that Claude and Codex both load here.
 */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/team/app");
  const server = { github: { command: "npx", args: ["gh-mcp"], env: { GITHUB_TOKEN: "x" } } };
  h.claude("personal", ".claude", {
    oauthAccount: { organizationUuid: "org", accountUuid: "one" },
    projects: { [app]: {} },
    mcpServers: server,
  });
  h.claude("work", ".claude-work", {
    oauthAccount: { organizationUuid: "org", accountUuid: "two" },
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: server,
  });
  h.skill(".claude/skills/synced/org_one", "pdf");
  h.skill(".claude/skills/synced/org_two", "pdf");
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  h.link(h.path("gone", "lost"), ".claude/skills/lost");
  h.skill("repos/team/app/.claude/skills", "eli5");
  h.skill("repos/team/app/.claude/skills", "deploy-check");
  h.write("repos/team/app/.claude/settings.local.json", { skillOverrides: { "deploy-check": "off" } });
  h.write("repos/team/app/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" } } });
  h.write("repos/team/.mcp.json", { mcpServers: { docs: { command: "docs-mcp" }, wiki: { command: "wiki-mcp" } } });
  h.write("repos/.mcp.json", { mcpServers: { wiki: { command: "wiki-mcp" } } });
  const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
  h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
  h.write(".claude/settings.json", {
    enabledPlugins: { "kit@m": true },
    skillOverrides: { "old-one": "off" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-done" }] }] },
  });
  h.codex("personal", ".codex");
  h.skill(".agents/skills", "eli5");
  // The managed settings are the home's own, so the test never reads this machine's.
  const run = (command: ExtensionsCommand, args: string[]) =>
    runExtensionsCommand(command, args, {
      homeDir: h.home,
      cwd: app,
      registry: h.registry,
      now: NOW,
      managedSettings: h.path("managed-settings.json"),
    });
  /** Every item `ls --json` writes: `all` has every place's rows but the plugins, which `plugins` lists. */
  const items = async () => {
    const found: Record<string, unknown>[] = [];
    for (const command of COMMANDS) {
      for (const scope of ["all", "plugins"]) {
        const out = JSON.parse(await run(command, ["ls", "--scope", scope, "--json"]));
        expect(Object.keys(out)).toEqual(ENVELOPE_KEYS);
        found.push(...out.items);
      }
    }
    return found;
  };
  return { run, items };
}

/** What a rejected run threw. */
async function failure(promise: Promise<string>): Promise<ExitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ExitError)) throw new Error(`expected an ExitError, got ${String(error)}`);
  return error;
}

describe("docs/extensions.md", () => {
  it("names every scope label, for both tools", () => {
    for (const id of SCOPE_IDS) {
      expect(DOC).toContain(SCOPE_LABEL[id]("claude"));
      expect(DOC).toContain(SCOPE_LABEL[id]("codex"));
    }
  });

  it("lists every tag in the Tags table, in the order tagsOf gives them, and no other", async () => {
    expect(tableNames(DOC, "Tags")).toEqual(TAGS);
    const { items } = seed();
    const tags = (await items()).map((item) => (item.tags as string[]).map(tagWord));
    // The seed has every tag, and each row's tags keep the documented order.
    expect([...new Set(tags.flat())].sort()).toEqual([...TAGS].sort());
    for (const list of tags) expect(inOrder(list, TAGS), list.join(", ")).toBe(true);
  });

  it("states the not-used rule with its constants", () => {
    expect(DOC).toContain(`${CLEANUP_UNUSED_DAYS} days`);
    expect(DOC).toContain(`${CLEANUP_GRACE_DAYS} days`);
  });

  it("lists in the Scope values table every --scope value of every command, and no other", () => {
    const { header, rows } = table(DOC, "Scope values");
    const values = (command: ExtensionsCommand) =>
      rows.filter((row) => row[header.indexOf(command)] === "✓").map((row) => code(row[0]));
    for (const command of COMMANDS) {
      expect(scopeValues(command).length).toBeGreaterThan(5);
      expect(values(command)).toEqual(scopeValues(command));
    }
    const every = new Set(COMMANDS.flatMap(scopeValues));
    expect(new Set(tableNames(DOC, "Scope values"))).toEqual(every);
  });

  it("says the show tiers in the order show looks", () => {
    const tiers = section(DOC, "show")
      .join("\n")
      .split(/\n(?=\d\. )/)
      .filter((part) => /^\d\. /.test(part))
      .map((part) => part.split("\n\n")[0]?.replace(/\s+/g, " ") ?? "");
    expect(tiers).toHaveLength(3);
    const label = (id: ScopeId, tool: "claude" | "codex" = "claude") => SCOPE_LABEL[id](tool);
    expect(tiers[0]).toBe(`1. Rows in ${label("loaded")}.`);
    // The second tier is every place but Other projects, in the scope list's order.
    const second = tiers[1] ?? "";
    const places = ["project", "parents", "global", "cloud", "plugins", "builtin", "managed"] as ScopeId[];
    const at = [...places.map((id) => second.indexOf(label(id))), second.indexOf(label("builtin", "codex"))];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at.slice(0, -1)).toEqual([...at.slice(0, -1)].sort((a, b) => a - b));
    expect(second).not.toContain(label("other"));
    expect(tiers[2]).toBe(`3. If none match: rows in ${label("other")}.`);
  });

  it("gives the row key forms the CLI writes", async () => {
    const forms = table(DOC, "Ids and row keys").rows.map((row) => code(row[1]) ?? "");
    expect(forms).toHaveLength(4);
    const patterns = forms.map(keyPattern);
    const { items } = seed();
    const ids = (await items()).filter((item) => "copies" in item).map((item) => String(item.id));
    // Each form is one the seed writes, and every row of copies has a key of one of the forms.
    for (const [i, pattern] of patterns.entries()) {
      expect(
        ids.some((id) => pattern.test(id)),
        forms[i],
      ).toBe(true);
    }
    for (const id of ids)
      expect(
        patterns.some((pattern) => pattern.test(id)),
        id,
      ).toBe(true);
  });

  it("gives the exit codes the CLI exits with", async () => {
    expect(table(DOC, "Output, errors and exit codes").rows).toEqual([
      ["0", "OK"],
      ["1", "Not found, or another failure, such as clausona not set up yet"],
      ["2", "Bad usage, an unknown option, or an ambiguous name"],
    ]);
    const { run } = seed();
    await expect(run("skills", ["ls"])).resolves.toMatch(/^\d+ skills · /);
    expect((await failure(run("skills", ["show", "nope"]))).code).toBe(1);
    expect((await failure(run("skills", ["ls", "--scope", "nope"]))).code).toBe(2);
    expect((await failure(run("skills", ["show", "eli5"]))).code).toBe(2);
  });

  it("has a JSON section whose tables list the envelope and item keys the CLI writes, in order", async () => {
    expect(DOC).toMatch(/^## JSON$/m);
    expect(tableNames(DOC, "The envelope")).toEqual(ENVELOPE_KEYS);
    expect(tableNames(DOC, "Item fields")).toEqual(ITEM_KEYS);
    const { items } = seed();
    const found = await items();
    // Each item writes some of the keys, in the documented order, and between them every key.
    for (const item of found) expect(inOrder(Object.keys(item), ITEM_KEYS), Object.keys(item).join(",")).toBe(true);
    expect([...new Set(found.flatMap((item) => Object.keys(item)))].sort()).toEqual([...ITEM_KEYS].sort());
  });

  it("documents what show --json adds, and the ambiguous error", async () => {
    const { run } = seed();
    const shown = JSON.parse(await run("skills", ["show", "eli5", "--tool", "claude", "--json"]));
    expect(Object.keys(shown)[0]).toBe("version");
    expect(Object.keys(shown).at(-1)).toBe("details");
    for (const key of ["details", "label", "text", "tone"]) expect(DOC).toContain(`\`${key}\``);

    const error = await failure(run("skills", ["show", "eli5", "--json"]));
    const body = JSON.parse(error.stdout ?? "");
    expect(Object.keys(body)).toEqual(["version", "error", "candidates"]);
    expect(Object.keys(body.candidates[0])).toEqual(CANDIDATE_KEYS);
    expect(DOC).toContain('{\n  "version": 1,\n  "error": "ambiguous",');
    for (const key of ["candidates", ...CANDIDATE_KEYS]) expect(DOC).toContain(`\`${key}\``);
  });

  it("says each hook event in the words the CLI and the screen use", () => {
    const rows = table(DOC, "Hook events").rows;
    expect(rows.length).toBeGreaterThan(10);
    for (const [name = "", words] of rows.map((row) => [code(row[0]), row[1]])) {
      const hook = { id: `hook:claude:global:-:${name}`, kind: "hook" as const, name };
      expect(hookWhen({ ...hook, location: { tool: "claude", scope: "global", file: "settings.json" } })).toBe(words);
    }
  });
});

describe("README", () => {
  it("has an Extensions section between API profiles and Commands, linking the docs", () => {
    const at = (heading: string) => README.indexOf(`\n## ${heading}\n`);
    expect(at("API profiles")).toBeGreaterThan(0);
    expect(at("Extensions")).toBeGreaterThan(at("API profiles"));
    expect(at("Commands")).toBeGreaterThan(at("Extensions"));
    expect(README).toContain("docs/extensions.md");
    expect(README).toContain("csn skills ls --scope project");
    expect(README).toContain("csn skills ls --scope unused --tool claude");
  });

  it("lists skills, mcp and hooks in Commands with the main help's words", async () => {
    const help = stripAnsi(await runCommand("help", []));
    for (const command of COMMANDS) {
      const words = new RegExp(`^\\s+${command} ls\\|show\\s+(.+)$`, "m").exec(help)?.[1];
      expect(words).toBeDefined();
      expect(README).toMatch(new RegExp(`^\\| \`clausona ${command} ls\\\\\\|show\`\\s+\\| ${words}\\s+\\|$`, "m"));
    }
  });
});
