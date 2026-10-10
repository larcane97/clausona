import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../commands.js";
import { stripAnsi } from "../lib/cli-style.js";
import { LEFT_ALONE, REFUSAL_CODES, REFUSALS } from "./actions.js";
import { KEEP_OPERATIONS } from "./apply.js";
import {
  CHANGE_JSON_KEYS,
  type ExtensionsCommand,
  extensionsHelp,
  PLAN_JSON_KEYS,
  REFUSED_JSON_KEYS,
  runExtensionsCommand,
  SUBS,
  UNCHANGED_JSON_KEYS,
  UNDO_JSON_KEYS,
  withJsonErrors,
} from "./cli.js";
import { hookWhen } from "./describe.js";
import { ERROR_KINDS, ExitError } from "./exit-error.js";
import { CLEANUP_GRACE_DAYS, CLEANUP_UNUSED_DAYS } from "./inventory.js";
import { SCOPE_LABEL, type ScopeId } from "./scopes.js";
import { TestHome } from "./test-home.js";

/**
 * docs/extensions.md and the README's Extensions section, kept in step with the code: every
 * scope label, tag, `--scope` value, row key form, JSON field, refusal and error kind the CLI
 * has is in the docs, in its words, and in the tables that list them.
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

/** Each table under `### <title>`, up to the next heading, as the backticked names in its first column. */
function tableNamesEach(doc: string, title: string): string[][] {
  const tables: string[][] = [];
  let current: string[] | undefined;
  for (const line of section(doc, title)) {
    if (!line.startsWith("|")) current = undefined;
    else if (current === undefined) {
      // The header row starts a table.
      current = [];
      tables.push(current);
    } else if (!/^\|[-| ]+\|$/.test(line)) {
      // The first cell: a name holds no pipe, escaped or not.
      const name = code(line.split("|")[1]?.trim());
      if (name !== undefined) current.push(name);
    }
  }
  return tables;
}

/** The section headings' anchors, as GitHub makes them. */
const anchors = (doc: string) =>
  doc
    .split("\n")
    .filter((line) => /^#{1,4} /.test(line))
    .map((line) =>
      line
        .replace(/^#+ /, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replace(/ /g, "-"),
    );

/**
 * A refusal's words as the Refusals table writes them: each `{x}` as `<x>`, a few under a
 * shorter name. The table puts commands and placeholders in backticks, which `plain` drops.
 */
const PLACEHOLDER: Record<string, string> = {
  "~file": "file",
  "project name": "project",
  "Claude Code|Codex": "tool",
  Tool: "tool",
  "Scope label": "scope",
  a: "id",
  b: "other id",
};
const placeheld = (text: string) => text.replace(/\{([^{}]+)\}/g, (_, key: string) => `<${PLACEHOLDER[key] ?? key}>`);
const plain = (cells: string[]) => cells.join(" ").replaceAll("`", "");

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
  // The managed settings are the home's own, so the test never reads this machine's. `terminal`
  // runs it as if on one, answering yes.
  const run = (command: ExtensionsCommand, args: string[], terminal = false) =>
    runExtensionsCommand(command, args, {
      homeDir: h.home,
      cwd: app,
      registry: h.registry,
      now: NOW,
      managedSettings: h.path("managed-settings.json"),
      ...(terminal ? { interactive: true, confirm: async () => true, print: () => {} } : {}),
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
      ["0", "Done, or nothing to do"],
      ["1", "Not found, refused, changed since it was read, locked, conflict, failed, or nothing to undo"],
      [
        "2",
        "Bad usage, an unknown option or command, an ambiguous name, or a change without --yes where it can't ask: no terminal, or --json",
      ],
    ]);
    const { run } = seed();
    await expect(run("skills", ["ls"])).resolves.toMatch(/^\d+ skills · /);
    await expect(run("skills", ["rm", "old-one", "--dry-run"])).resolves.toContain("Dry run: nothing changed.");
    await expect(run("skills", ["off", "old-one", "--everywhere", "--yes"])).resolves.toContain("Nothing to do.");
    expect((await failure(run("skills", ["show", "nope"]))).code).toBe(1);
    expect((await failure(run("skills", ["rm", "pdf", "--yes"]))).code).toBe(1);
    expect((await failure(run("skills", ["undo", "--yes"]))).code).toBe(1);
    expect((await failure(run("skills", ["ls", "--scope", "nope"]))).code).toBe(2);
    expect((await failure(run("skills", ["show", "eli5"]))).code).toBe(2);
    expect((await failure(run("skills", ["rm", "old-one"]))).code).toBe(2);
    expect((await failure(run("skills", ["rm", "old-one", "--json"], true))).code).toBe(2);
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
    // Like every --json failure it has a message; the name given comes before the candidates.
    expect(Object.keys(body)).toEqual(["version", "error", "message", "name", "candidates"]);
    expect(Object.keys(body.candidates[0])).toEqual(CANDIDATE_KEYS);
    expect(DOC).toContain('{\n  "version": 1,\n  "error": "ambiguous",\n  "message": ');
    for (const key of ["message", "name", "candidates", ...CANDIDATE_KEYS]) expect(DOC).toContain(`\`${key}\``);
  });

  it("has a Changing things section, in the contents, with each of its parts", () => {
    expect(DOC).toContain("- [Changing things](#changing-things)");
    const lines = DOC.split("\n");
    const start = lines.indexOf("## Changing things");
    const end = lines.indexOf("## JSON");
    expect(start).toBeGreaterThan(lines.indexOf("## CLI reference"));
    expect(end).toBeGreaterThan(start);
    const parts = [
      "Off and on",
      "What each change writes",
      "Visibility",
      "Delete",
      "Confirm, backups and undo",
      "Refusals",
    ];
    const at = parts.map((part) => lines.indexOf(`### ${part}`));
    expect(at.every((i) => i > start && i < end)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("lists every refusal in the Refusals table, in REFUSAL_CODES order, in its words", () => {
    expect(tableNames(DOC, "Refusals")).toEqual([...REFUSAL_CODES]);
    const rows = table(DOC, "Refusals").rows;
    for (const code of REFUSAL_CODES) {
      const text = plain(rows.find((row) => row[0] === `\`${code}\``) ?? []);
      const { reason, keys, flags } = REFUSALS[code];
      // A reason and its hints are one text, or one per tool where the tools differ: each is there.
      for (const words of [reason, keys, flags]) {
        if (words === undefined) continue;
        const texts = typeof words === "string" ? [words] : [words.claude, words.codex];
        for (const one of texts) expect(text, code).toContain(placeheld(one));
      }
    }
  });

  it("lists the keys a plan, a change, a refusal, an unchanged row and an undo write, in order", async () => {
    expect(tableNamesEach(DOC, "Plans and results")).toEqual([
      PLAN_JSON_KEYS,
      CHANGE_JSON_KEYS,
      REFUSED_JSON_KEYS,
      UNCHANGED_JSON_KEYS,
    ]);
    expect(tableNames(DOC, "Plans and results")).toEqual([
      ...PLAN_JSON_KEYS,
      ...CHANGE_JSON_KEYS,
      ...REFUSED_JSON_KEYS,
      ...UNCHANGED_JSON_KEYS,
    ]);
    expect(tableNames(DOC, "Undo")).toEqual(UNDO_JSON_KEYS);
    // The reasons undo leaves a file alone for, by code and in its words.
    const undo = section(DOC, "Undo").join("\n");
    for (const [reason, words] of Object.entries(LEFT_ALONE)) {
      expect(undo).toContain(`\`${reason}\``);
      expect(undo).toContain(words);
    }

    const { run } = seed();
    // pdf is a Cloud skill, so the dry run has a refusal too.
    const plan = JSON.parse(await run("skills", ["rm", "old-one", "pdf", "--dry-run", "--json"]));
    expect(inOrder(Object.keys(plan), [...PLAN_JSON_KEYS]), Object.keys(plan).join(",")).toBe(true);
    expect(plan.changes).toHaveLength(1);
    expect(plan.refused).toHaveLength(1);
    for (const change of plan.changes) expect(inOrder(Object.keys(change), [...CHANGE_JSON_KEYS])).toBe(true);
    for (const refused of plan.refused) expect(inOrder(Object.keys(refused), [...REFUSED_JSON_KEYS])).toBe(true);
    const already = JSON.parse(await run("skills", ["off", "old-one", "--everywhere", "--dry-run", "--json"]));
    expect(already.unchanged).toHaveLength(1);
    for (const row of already.unchanged) expect(inOrder(Object.keys(row), [...UNCHANGED_JSON_KEYS])).toBe(true);
  });

  it("lists every error kind with its exit code, and the keys an error object has", async () => {
    const { header, rows } = table(DOC, "Errors");
    expect(header).toEqual(["Kind", "Exit code", "When"]);
    expect(tableNames(DOC, "Errors")).toEqual([...ERROR_KINDS]);
    for (const row of rows) {
      const kind = code(row[0]);
      expect(row[1], kind).toBe(kind === "usage" || kind === "ambiguous" ? "2" : "1");
    }
    const errors = section(DOC, "Errors").join("\n");
    expect(errors).toContain('{\n  "version": 1,\n  "error": "refused",\n  "message": ');
    for (const key of ["refused", "operation", "done", "total", "file", "restored", "skipped", "name"]) {
      expect(errors).toContain(`\`${key}\``);
    }

    const { run } = seed();
    const args = ["rm", "old-one", "pdf", "--yes", "--json"];
    const body = JSON.parse((await failure(withJsonErrors(args, () => run("skills", args)))).stdout ?? "");
    expect(Object.keys(body)).toEqual(["version", "error", "message", "refused"]);
    expect(body.error).toBe("refused");
  });

  it("names where backups and the copies clausona keeps go, how many it keeps, and the agent's commands", () => {
    for (const text of [
      "csn skills ls --scope unused --tool claude --json",
      "csn skills rm --id '<id>' --id '<id>' --dry-run --json",
      "csn skills rm --id '<id>' --id '<id>' --yes",
      "csn skills undo --yes",
      "~/.clausona/backups/extensions/",
      "~/.clausona/extensions/stash/",
      "manifest.json",
      `last ${KEEP_OPERATIONS}`,
    ]) {
      expect(DOC).toContain(text);
    }
  });

  it("has the keys that change things in the screen's Keys table", () => {
    expect(tableNames(DOC, "Keys")).toEqual(expect.arrayContaining(["space", "g", "d", "x", "u", "v"]));
  });

  it("never says stash in its prose: only in code and in the folder's path", () => {
    let fenced = false;
    const prose: string[] = [];
    for (const line of DOC.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      else if (!fenced && !line.includes(".clausona/extensions/stash")) prose.push(line.replace(/`[^`]*`/g, ""));
    }
    expect(prose.filter((line) => /\bstash/i.test(line))).toEqual([]);
  });

  it("has a heading for every place in it the help pages link to", () => {
    const linked = new Set(
      COMMANDS.flatMap((command) =>
        [undefined, ...SUBS[command]].flatMap((sub) =>
          [...stripAnsi(extensionsHelp(command, sub)).matchAll(/docs\/extensions\.md#([a-z0-9-]+)/g)].map(
            (match) => match[1] ?? "",
          ),
        ),
      ),
    );
    expect(linked).toContain("changing-things");
    expect(anchors(DOC)).toEqual(expect.arrayContaining([...linked]));
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
    expect(README).toContain("csn skills rm old-one --dry-run");
  });

  it("lists skills, mcp and hooks in Commands with the main help's subcommands and words", async () => {
    const help = stripAnsi(await runCommand("help", []));
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const command of COMMANDS) {
      const [, subs = "", words = ""] = new RegExp(`^\\s+${command} (ls\\|\\S+)\\s+(.+)$`, "m").exec(help) ?? [];
      // The help lists the subcommands that change things too.
      expect(subs.split("|"), command).toEqual(expect.arrayContaining(["ls", "show", "off", "on", "rm"]));
      // In the README's table a pipe in a cell is escaped.
      const cell = literal(`\`clausona ${command} ${subs.replaceAll("|", "\\|")}\``);
      expect(README).toMatch(new RegExp(`^\\| ${cell}\\s+\\| ${literal(words)}\\s+\\|$`, "m"));
    }
  });
});
