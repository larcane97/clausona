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
 * scope label, tag, `--scope` value and JSON field the CLI has is in the docs, in its words.
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

/** The tags, verbatim (the plan's Global Constraints). */
const TAGS = [
  "off",
  "off here",
  "off in N of M accounts",
  "unused",
  "broken link",
  "pending approval",
  "hidden by Project copy",
  "hidden by Global copy",
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
];

const CANDIDATE_KEYS = ["id", "tool", "scope", "project", "account"];

/**
 * The rows of the table under `### <title>` whose first cell is one backticked name: that name,
 * and the second cell's text.
 */
function tableRows(doc: string, title: string): [name: string, text: string][] {
  const lines = doc.split("\n");
  const start = lines.indexOf(`### ${title}`);
  if (start < 0) throw new Error(`no heading "### ${title}"`);
  const rows: [string, string][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const row = /^\| `([^`]+)` \|(.*)$/.exec(line);
    // A cell ends at a pipe that is not escaped, as in `claude\|codex`.
    if (row) rows.push([row[1] ?? "", (row[2] ?? "").split(/(?<!\\)\|/)[0]?.trim() ?? ""]);
  }
  return rows;
}

const tableNames = (doc: string, title: string) => tableRows(doc, title).map(([name]) => name);

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

/** The `--scope` values an ls help page lists. */
function scopeValues(command: ExtensionsCommand): string[] {
  const help = stripAnsi(extensionsHelp(command, "ls"));
  const list = /--scope <scope>\s+([\s\S]*?)\n\s+--tool/.exec(help)?.[1] ?? "";
  return list
    .split("|")
    .map((value) => value.replace("(default)", "").trim())
    .filter(Boolean);
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

/**
 * Something of every shape a JSON item can take: a server two accounts define (a row of
 * copies), a linked skill, a plugin and its skill, a hook, and an eli5 that Claude and Codex
 * both load here.
 */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const server = { github: { command: "npx", args: ["gh-mcp"], env: { GITHUB_TOKEN: "x" } } };
  h.claude("personal", ".claude", { projects: { [app]: {} }, mcpServers: server });
  h.claude("work", ".claude-work", { projects: { [app]: { disabledMcpServers: ["github"] } }, mcpServers: server });
  h.skill(".claude/skills", "eli5");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
  h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
  h.write(".claude/settings.json", {
    enabledPlugins: { "kit@m": true },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-done" }] }] },
  });
  h.codex("personal", ".codex");
  h.skill(".agents/skills", "eli5");
  const run = (command: ExtensionsCommand, args: string[]) =>
    runExtensionsCommand(command, args, { homeDir: h.home, cwd: app, registry: h.registry });
  return { run };
}

describe("docs/extensions.md", () => {
  it("names every scope label, for both tools, and every tag verbatim", () => {
    for (const id of SCOPE_IDS) {
      expect(DOC).toContain(SCOPE_LABEL[id]("claude"));
      expect(DOC).toContain(SCOPE_LABEL[id]("codex"));
    }
    for (const tag of TAGS) expect(DOC).toContain(`\`${tag}\``);
  });

  it("states the not-used rule with its constants", () => {
    expect(DOC).toContain(`${CLEANUP_UNUSED_DAYS} days`);
    expect(DOC).toContain(`${CLEANUP_GRACE_DAYS} days`);
  });

  it("lists every --scope value of every command", () => {
    for (const command of COMMANDS) {
      const values = scopeValues(command);
      expect(values.length).toBeGreaterThan(5);
      for (const value of values) expect(DOC).toContain(`\`${value}\``);
    }
  });

  it("has a JSON section whose tables list the envelope and item keys the CLI writes, in order", async () => {
    expect(DOC).toMatch(/^## JSON$/m);
    expect(tableNames(DOC, "The envelope")).toEqual(ENVELOPE_KEYS);
    expect(tableNames(DOC, "Item fields")).toEqual(ITEM_KEYS);

    const { run } = seed();
    const items: Record<string, unknown>[] = [];
    for (const command of COMMANDS) {
      const out = JSON.parse(await run(command, ["ls", "--scope", "all", "--json"]));
      expect(Object.keys(out)).toEqual(ENVELOPE_KEYS);
      items.push(...out.items);
    }
    // Each item writes some of the keys, in the documented order, and between them every key.
    for (const item of items) expect(inOrder(Object.keys(item), ITEM_KEYS), Object.keys(item).join(",")).toBe(true);
    expect([...new Set(items.flatMap((item) => Object.keys(item)))].sort()).toEqual([...ITEM_KEYS].sort());
  });

  it("documents what show --json adds, and the ambiguous error", async () => {
    const { run } = seed();
    const shown = JSON.parse(await run("skills", ["show", "eli5", "--tool", "claude", "--json"]));
    expect(Object.keys(shown).at(-1)).toBe("details");
    for (const key of ["details", "label", "text", "tone"]) expect(DOC).toContain(`\`${key}\``);

    const error = await run("skills", ["show", "eli5", "--json"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(error instanceof ExitError) || error.stdout === undefined) throw new Error("expected an ambiguous name");
    const body = JSON.parse(error.stdout);
    expect(Object.keys(body)).toEqual(["error", "candidates"]);
    expect(Object.keys(body.candidates[0])).toEqual(CANDIDATE_KEYS);
    expect(DOC).toContain('"error": "ambiguous"');
    for (const key of ["candidates", ...CANDIDATE_KEYS]) expect(DOC).toContain(`\`${key}\``);
  });

  it("says each hook event in the words the CLI and the screen use", () => {
    const rows = tableRows(DOC, "Hook events");
    expect(rows.length).toBeGreaterThan(10);
    for (const [name, words] of rows) {
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
