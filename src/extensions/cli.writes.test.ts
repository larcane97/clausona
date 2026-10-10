import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireDirLock } from "../core/dir-lock.js";
import { stripAnsi } from "../lib/cli-style.js";
import { leakedWindows } from "../test-leaks.js";
import { type WriteEnv, writeEnvFor } from "./apply.js";
import {
  CHANGE_JSON_KEYS,
  type ExtensionsCommand,
  PLAN_JSON_KEYS,
  REFUSED_JSON_KEYS,
  runExtensionsCommand,
  UNCHANGED_JSON_KEYS,
  UNDO_JSON_KEYS,
  withJsonErrors,
} from "./cli.js";
import { ExitError } from "./exit-error.js";
import { tilde } from "./present.js";
import { TestHome } from "./test-home.js";

const DAY = 86_400_000;
/** 200 days after the fixture's files were made: every skill but eli5 is unused. */
const NOW = Date.now() + 200 * DAY;
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

/** The test's own git runs: not told where a repo is by a hook's environment (spawn leaves undefined out). */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

const hasGit = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

const homes: TestHome[] = [];
/** Every output of every run - results, messages and JSON - for the secret net. */
const outputs: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
  const seen = outputs.splice(0);
  expect(leakedWindows(seen, KEY)).toEqual([]);
});

/**
 * cli.test.ts's fixture, plus a second Claude account and figma in both: default (which has
 * opened app and web) and work (app only). A global eli5 (used yesterday), old-one and a link
 * notes; app's own eli5 and deploy-check; web's web-only; the Cloud pdf; Codex's eli5. github
 * (with a secret) is default's, figma both accounts'; two Stop hooks in user settings.
 */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    oauthAccount: { organizationUuid: "org", accountUuid: "one" },
    projects: { [app]: { mcpServers: { "pg-dev": { command: "pg", env: { PGPASSWORD: KEY } } } }, [web]: {} },
    mcpServers: {
      github: { command: "npx", args: ["gh-mcp", "--api-key", KEY], env: { GITHUB_TOKEN: KEY } },
      figma: { command: "figma" },
    },
    skillUsage: { eli5: { usageCount: 4, lastUsedAt: NOW - DAY } },
  });
  h.claude("work", ".claude-work", { projects: { [app]: {} }, mcpServers: { figma: { command: "figma" } } });
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "eli5");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".claude/skills/synced/org_one", "pdf");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  h.codex("personal", ".codex", `[projects.'${app}']\ntrust_level = "trusted"\n\n[mcp_servers.exa]\ncommand = "npx"\n`);
  h.skill(".agents/skills", "eli5");
  h.write(".claude/settings.json", {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "notify-a" },
            { type: "command", command: "notify-b" },
          ],
        },
      ],
    },
  });
  return { h, app, web };
}

type RunOptions = { interactive?: boolean; confirm?: (question: string) => Promise<boolean>; columns?: number };

/** Runs in `cwd` of `h`, as commands.ts does - JSON errors with --json - on a clock of its own. */
function cli(h: TestHome, cwd: string, more: Pick<WriteEnv, "lockWaitMs"> = {}) {
  let at = Date.UTC(2026, 9, 10, 4, 36, 48);
  const writeEnv: WriteEnv = {
    ...writeEnvFor(h.home, () => {
      at += 1000;
      return at;
    }),
    ...more,
  };
  const printed: string[] = [];
  const run = async (command: ExtensionsCommand, args: string[], options: RunOptions = {}): Promise<string> => {
    try {
      const text = await withJsonErrors(args, () =>
        runExtensionsCommand(command, args, {
          homeDir: h.home,
          cwd,
          registry: h.registry,
          now: NOW,
          columns: options.columns ?? 200,
          managedSettings: h.path("managed-settings.json"),
          interactive: options.interactive ?? false,
          ...(options.confirm ? { confirm: options.confirm } : {}),
          writeEnv,
          print: (text) => {
            printed.push(text);
            outputs.push(text);
          },
        }),
      );
      outputs.push(text);
      return text;
    } catch (error) {
      if (error instanceof ExitError) outputs.push(error.message, error.stdout ?? "");
      throw error;
    }
  };
  return { run, printed };
}

/** What a rejected run threw, for a look at its code, kind, message and stdout. */
async function failure(promise: Promise<string>): Promise<ExitError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ExitError)) throw new Error(`expected an ExitError, got ${String(error)}`);
  return error;
}

const read = (file: string) => readFileSync(file, "utf8");
const json = (file: string) => JSON.parse(read(file));
/** Whether every key is one of `order`, and in that order. */
const inOrder = (keys: string[], order: readonly string[]) =>
  keys.every((key, at) => order.includes(key) && (at === 0 || order.indexOf(keys[at - 1] ?? "") < order.indexOf(key)));

const RULE_M =
  "This changes files, and there is no terminal to confirm on. Add --yes to go ahead, or --dry-run to see the plan.";

describe("skills off", () => {
  it("prints the plan with --dry-run, and writes nothing, not even ~/.clausona", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const local = path.join(app, ".claude", "settings.local.json");
    const text = stripAnsi(await run("skills", ["off", "eli5", "--tool", "claude", "--dry-run"]));
    expect(text).toContain("Turn off eli5 in this project?");
    expect(text).toContain(tilde(local, h.home));
    expect(text).toContain("skillOverrides.eli5 → off");
    expect(text).toContain(`Backup: ${tilde(h.path(".clausona", "backups", "extensions"), h.home)}${path.sep}`);
    expect(text).toContain("Dry run: nothing changed.");
    expect(existsSync(local)).toBe(false);
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("prints the plan as JSON with --dry-run --json, its keys in order and no fingerprint", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const out = await run("skills", ["off", "eli5", "--tool", "claude", "--dry-run", "--json"]);
    const plan = JSON.parse(out);
    expect(Object.keys(plan)).toEqual([
      "version",
      "command",
      "verb",
      "everywhere",
      "dryRun",
      "question",
      "changes",
      "unchanged",
      "refused",
      "notes",
      "backupRoot",
    ]);
    expect(inOrder(Object.keys(plan), PLAN_JSON_KEYS)).toBe(true);
    expect(plan).toMatchObject({ version: 1, command: "skills", verb: "off", everywhere: false, dryRun: true });
    expect(plan.backupRoot).toBe(h.path(".clausona", "backups", "extensions"));
    expect(Object.keys(plan.changes[0])).toEqual([...CHANGE_JSON_KEYS]);
    expect(plan.changes[0]).toEqual({
      file: path.join(app, ".claude", "settings.local.json"),
      change: "create",
      what: "skillOverrides.eli5 → off",
      account: null,
      note: null,
      tracked: false,
      rows: ["skill:claude:global:-:eli5"],
    });
    expect(out).not.toContain("expect");
    expect(out).not.toContain("hash");
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("refuses to change files without a terminal unless --yes, as bad usage", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["off", "eli5", "--tool", "claude"]));
    expect(error).toMatchObject({ code: 2, kind: "usage", message: RULE_M });
    const asJson = await failure(run("skills", ["off", "eli5", "--tool", "claude", "--json"]));
    expect(asJson.code).toBe(2);
    expect(JSON.parse(asJson.stdout ?? "")).toEqual({ version: 1, error: "usage", message: RULE_M });
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("applies with --yes, naming the backup and the undo", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const text = stripAnsi(await run("skills", ["off", "eli5", "--tool", "claude", "--yes"]));
    expect(text).toContain("✔ Turned off eli5 in this project");
    expect(text).toContain(`Backup: ${tilde(h.path(".clausona", "backups", "extensions"), h.home)}${path.sep}2`);
    expect(text).toContain("Undo: clausona skills undo");
    expect(json(path.join(app, ".claude", "settings.local.json")).skillOverrides).toEqual({ eli5: "off" });
  });

  it("says what it did as JSON with --yes --json, with the operation", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const out = JSON.parse(await run("skills", ["off", "eli5", "--tool", "claude", "-y", "--json"]));
    expect(inOrder(Object.keys(out), PLAN_JSON_KEYS)).toBe(true);
    expect(out).toMatchObject({ dryRun: false, applied: true });
    expect(Object.keys(out.operation)).toEqual(["id", "backup"]);
    expect(out.operation.backup).toBe(path.join(h.path(".clausona", "backups", "extensions"), out.operation.id));
  });

  it("asks on a terminal, and does nothing when the answer is no", async () => {
    const { h, app } = seed();
    const { run, printed } = cli(h, app);
    const local = path.join(app, ".claude", "settings.local.json");
    const asked: string[] = [];
    const no = await run("skills", ["off", "eli5", "--tool", "claude"], {
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return false;
      },
    });
    expect(stripAnsi(no)).toBe("  Cancelled. Nothing changed.");
    expect(asked).toEqual(["  Apply? (y/N) "]);
    expect(stripAnsi(printed.join("\n"))).toContain("Turn off eli5 in this project?");
    expect(existsSync(local)).toBe(false);
    const yes = await run("skills", ["off", "eli5", "--tool", "claude"], {
      interactive: true,
      confirm: async () => true,
    });
    expect(stripAnsi(yes)).toContain("✔ Turned off eli5 in this project");
    expect(json(local).skillOverrides).toEqual({ eli5: "off" });
  });

  it("takes --yes or --dry-run with --json, even on a terminal, rather than mix text and JSON", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const asked: string[] = [];
    const terminal: RunOptions = {
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    };
    const message = "With --json, add --yes to go ahead, or --dry-run to see the plan.";
    const error = await failure(run("skills", ["off", "eli5", "--tool", "claude", "--json"], terminal));
    expect(error).toMatchObject({ code: 2, kind: "usage", message });
    expect(JSON.parse(error.stdout ?? "")).toEqual({ version: 1, error: "usage", message });
    expect(existsSync(h.path(".clausona"))).toBe(false);
    await run("skills", ["off", "eli5", "--tool", "claude", "--yes"]);
    expect(await failure(run("skills", ["undo", "--json"], terminal))).toMatchObject({ code: 2, message });
    expect(asked).toEqual([]);
    expect(existsSync(path.join(app, ".claude", "settings.local.json"))).toBe(true);
  });

  it("cuts a long path from its middle to fit, and keeps what changes whole", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const sep = path.sep;
    // At 72 the cut lands on a separator short of the room it has: the gap stays two spaces.
    for (const columns of [70, 72]) {
      const text = stripAnsi(await run("skills", ["visibility", "eli5", "name-only", "--dry-run"], { columns }));
      for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
      expect(text).toContain(`      ~${sep}…${sep}.claude${sep}settings.local.json  skillOverrides.eli5 → name-only\n`);
    }
  });

  it("says nothing is to do when it is off already, and exits 0", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    await run("skills", ["off", "eli5", "--tool", "claude", "--yes"]);
    const again = stripAnsi(await run("skills", ["off", "eli5", "--tool", "claude", "--scope", "global", "--yes"]));
    expect(again.split("\n")[0]).toBe("  Nothing to do.");
    expect(again).toMatch(/^ {4}eli5 {2}\S/m);
    const asJson = JSON.parse(await run("skills", ["off", "eli5", "--tool", "claude", "--scope", "global", "--json"]));
    expect(asJson).toMatchObject({ dryRun: false, applied: false, changes: [] });
    expect(Object.keys(asJson.unchanged[0])).toEqual([...UNCHANGED_JSON_KEYS]);
  });

  it("calls a name Claude and Codex both load ambiguous, with the name in its JSON", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["off", "eli5", "--yes"]));
    expect(error).toMatchObject({ code: 2, kind: "ambiguous" });
    expect(error.message.split("\n")[0]).toBe("2 skills are named 'eli5':");
    const asJson = await failure(run("skills", ["off", "eli5", "--yes", "--json"]));
    expect(asJson.code).toBe(2);
    const body = JSON.parse(asJson.stdout ?? "");
    expect(body).toMatchObject({ version: 1, error: "ambiguous", name: "eli5" });
    expect(body.candidates).toHaveLength(2);
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("needs a name or an --id, and takes the flags of a change only", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    expect(await failure(run("skills", ["off"]))).toMatchObject({
      code: 2,
      kind: "usage",
      message: "off needs a name or --id <id>. Run clausona skills off --help.",
    });
    expect(await failure(run("skills", ["rm", "old-one", "--everywhere"]))).toMatchObject({
      code: 2,
      message: "rm deletes the thing itself: leave out --everywhere.",
    });
    expect(await failure(run("skills", ["ls", "--dry-run"]))).toMatchObject({ code: 2 });
    expect((await failure(run("skills", ["ls", "--dry-run"]))).message).toContain("--dry-run");
    expect((await failure(run("skills", ["show", "eli5", "--yes"]))).message).toContain("--yes");
    expect((await failure(run("skills", ["ls", "--everywhere"]))).message).toContain("--everywhere");
    expect((await failure(run("skills", ["undo", "--tracked"]))).message).toContain("--tracked");
    expect((await failure(run("skills", ["show", "eli5", "--id", "a", "--id", "b"]))).code).toBe(2);
    expect(await failure(run("skills", ["undo", "eli5"]))).toMatchObject({ code: 2 });
    expect(await failure(run("skills", ["undo", "--scope", "global"]))).toMatchObject({ code: 2 });
    expect(await failure(run("skills", ["nope"]))).toMatchObject({
      code: 2,
      kind: "usage",
      message:
        "Unknown subcommand 'nope'. clausona skills takes ls, show, off, on, visibility, rm or undo. Run clausona skills --help.",
    });
  });

  it("refuses a name nothing has as not found", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["off", "nope", "--yes", "--json"]));
    expect(error.code).toBe(1);
    expect(JSON.parse(error.stdout ?? "")).toEqual({
      version: 1,
      error: "not-found",
      message: "No skill named 'nope'.",
    });
  });
});

describe("skills rm", () => {
  it("refuses a Cloud skill, saying what to do instead, in text and JSON", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["rm", "pdf", "--yes"]));
    expect(error).toMatchObject({ code: 1, kind: "refused" });
    expect(error.message).toContain("Nothing changed: 1 of 1 can't be deleted.");
    expect(error.message).toContain("pdf  It comes back from claude.ai. Turn it off instead: clausona skills off pdf.");
    const asJson = await failure(run("skills", ["rm", "pdf", "--yes", "--json"]));
    const body = JSON.parse(asJson.stdout ?? "");
    expect(Object.keys(body)).toEqual(["version", "error", "message", "refused"]);
    expect(body.error).toBe("refused");
    expect(Object.keys(body.refused[0])).toEqual([...REFUSED_JSON_KEYS]);
    expect(body.refused[0]).toMatchObject({ name: "pdf", code: "cloud-delete" });
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it("lists a refusal in the dry run, and exits 0", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const text = stripAnsi(await run("skills", ["rm", "old-one", "pdf", "--dry-run"]));
    expect(text).toContain("It comes back from claude.ai.");
    expect(text).toContain(tilde(h.path(".claude", "skills", "old-one"), h.home));
    const plan = JSON.parse(await run("skills", ["rm", "old-one", "pdf", "--dry-run", "--json"]));
    expect(plan.refused.map((r: { code: string }) => r.code)).toEqual(["cloud-delete"]);
    expect(plan.changes).toHaveLength(1);
  });

  it("changes nothing when any one of the rows is refused (rule C)", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["rm", "old-one", "pdf", "--yes"]));
    expect(error).toMatchObject({ code: 1, kind: "refused" });
    expect(error.message.split("\n")[0]).toBe("Nothing changed: 1 of 2 can't be deleted.");
    expect(existsSync(h.path(".claude", "skills", "old-one"))).toBe(true);
    expect(existsSync(h.path(".clausona"))).toBe(false);
  });

  it.skipIf(!hasGit)("refuses a skill git tracks unless --tracked", async () => {
    const { h, app } = seed();
    git(app, ["init", "-q"]);
    git(app, ["add", path.join(".claude", "skills", "deploy-check", "SKILL.md")]);
    const { run } = cli(h, app);
    const error = await failure(run("skills", ["rm", "deploy-check", "--yes"]));
    expect(error).toMatchObject({ code: 1, kind: "refused" });
    expect(error.message).toContain("Add --tracked to go ahead");
    expect(existsSync(path.join(app, ".claude", "skills", "deploy-check"))).toBe(true);
    const text = stripAnsi(await run("skills", ["rm", "deploy-check", "--tracked", "--yes"]));
    expect(text).toContain("✔ Deleted deploy-check");
    expect(existsSync(path.join(app, ".claude", "skills", "deploy-check"))).toBe(false);
  });

  it("deletes the rows several --ids name; a link goes and its target stays", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const listed = JSON.parse(await run("skills", ["ls", "--scope", "global", "--tool", "claude", "--json"]));
    const idOf = (name: string) => listed.items.find((i: { name: string }) => i.name === name).id;
    const dry = stripAnsi(await run("skills", ["rm", "--id", idOf("old-one"), "--id", idOf("notes"), "--dry-run"]));
    expect(dry).toContain("Delete 2 skills?");
    expect(dry).toMatch(/notes +link only, target kept$/m);
    const text = stripAnsi(await run("skills", ["rm", "--id", idOf("old-one"), "--id", idOf("notes"), "--yes"]));
    expect(text).toContain("✔ Deleted 2 skills");
    expect(existsSync(h.path(".claude", "skills", "old-one"))).toBe(false);
    expect(existsSync(h.path(".claude", "skills", "notes"))).toBe(false);
    expect(existsSync(h.path("shared", "notes", "SKILL.md"))).toBe(true);
  });
});

describe("skills visibility", () => {
  it("sets the level here, and takes one of the four levels as the last word", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const text = stripAnsi(await run("skills", ["visibility", "eli5", "name-only", "--yes"]));
    expect(text).toContain("✔ eli5 shows as name only in this project");
    expect(json(path.join(app, ".claude", "settings.local.json")).skillOverrides).toEqual({ eli5: "name-only" });
    const plan = JSON.parse(await run("skills", ["visibility", "eli5", "on", "--everywhere", "--dry-run", "--json"]));
    expect(plan).toMatchObject({ verb: "visibility", everywhere: true, level: "on" });
    expect(inOrder(Object.keys(plan), PLAN_JSON_KEYS)).toBe(true);
    expect(await failure(run("skills", ["visibility", "eli5", "loud"]))).toMatchObject({
      code: 2,
      message: "visibility takes on, name-only, user-invocable-only or off.",
    });
    expect(await failure(run("skills", ["visibility", "eli5", "old-one", "off"]))).toMatchObject({ code: 2 });
    // A name first, then the level.
    const needsName = "visibility needs a name or --id <id>, then the level. Run clausona skills visibility --help.";
    expect(await failure(run("skills", ["visibility"]))).toMatchObject({ code: 2, kind: "usage", message: needsName });
    expect(await failure(run("skills", ["visibility", "on"]))).toMatchObject({ code: 2, message: needsName });
    expect(await failure(run("mcp", ["visibility", "github"]))).toMatchObject({
      code: 2,
      message:
        "Unknown subcommand 'visibility'. clausona mcp takes ls, show, off, on, rm or undo. Run clausona mcp --help.",
    });
  });
});

describe("skills visibility, a Claude skill's alone", () => {
  it("plans the Claude copy of a name both tools load, and takes no --tool", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    // Claude's and Codex's eli5 both load here: off calls it ambiguous, visibility does not.
    expect(await failure(run("skills", ["off", "eli5", "--dry-run"]))).toMatchObject({ code: 2, kind: "ambiguous" });
    const plan = JSON.parse(await run("skills", ["visibility", "eli5", "name-only", "--dry-run", "--json"]));
    expect(plan.changes.map((c: { rows: string[] }) => c.rows)).toEqual([["skill:claude:global:-:eli5"]]);
    for (const tool of ["codex", "claude"]) {
      expect(await failure(run("skills", ["visibility", "eli5", "on", "--tool", tool]))).toMatchObject({
        code: 2,
        kind: "usage",
        message: "visibility is for Claude skills only.",
      });
    }
    // Nothing narrowed it to Claude's but visibility itself, so no flag is named to leave out.
    expect(await failure(run("skills", ["visibility", "nope", "on"]))).toMatchObject({
      code: 1,
      message: "No skill named 'nope'.",
    });
  });
});

describe("mcp off and rm", () => {
  it("changes one account's file with --account, and refuses an account nobody has", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const defaultJson = read(h.path(".claude.json"));
    const plan = JSON.parse(
      await run("mcp", ["off", "figma", "--account", "work", "--tool", "claude", "--dry-run", "--json"]),
    );
    expect(plan.accounts).toEqual([
      { profile: "claude:default", chosen: false },
      { profile: "claude:work", chosen: true },
    ]);
    expect(plan.changes.map((c: { account: string }) => c.account)).toEqual(["claude:work"]);
    const text = stripAnsi(await run("mcp", ["off", "figma", "--account", "work", "--tool", "claude", "--yes"]));
    expect(text).toContain("✔ Turned off figma in this project, for work");
    const work = json(h.path(".claude-work", ".claude.json"));
    expect(work.projects[app].disabledMcpServers).toEqual(["figma"]);
    expect(read(h.path(".claude.json"))).toBe(defaultJson);
    expect(await failure(run("mcp", ["off", "figma", "--account", "nobody", "--yes"]))).toMatchObject({
      code: 2,
      kind: "usage",
    });
  });

  it("says the plan's notes after what it did, as the prompt and the dry run do", async () => {
    const { h, web } = seed();
    const { run } = cli(h, web);
    const note = "  Note:\n      work has not opened this project";
    expect(stripAnsi(await run("mcp", ["off", "figma", "--tool", "claude", "--dry-run"]))).toContain(note);
    const text = stripAnsi(await run("mcp", ["off", "figma", "--tool", "claude", "--yes"]));
    expect(text).toMatch(/^ {2}✔ Turned off figma in this project/);
    expect(text).toContain("Undo: clausona mcp undo");
    expect(text).toContain(note);
  });

  it("deletes only the copy clausona kept when --id names that copy", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    await run("mcp", ["off", "figma", "--everywhere", "--account", "work", "--tool", "claude", "--yes"]);
    expect(json(h.path(".claude-work", ".claude.json")).mcpServers).toEqual({});
    const listed = JSON.parse(await run("mcp", ["ls", "--scope", "global", "--tool", "claude", "--json"]));
    const figma = listed.items.find((i: { name: string }) => i.name === "figma");
    const kept = figma.copies.find((c: { id: string }) => c.id.includes(":stash-"));
    expect(kept.account).toBe("claude:work");
    const keptDir = h.path(".clausona", "extensions", "stash");
    expect(readdirSync(keptDir)).toHaveLength(1);
    const plan = JSON.parse(await run("mcp", ["rm", "--id", kept.id, "--dry-run", "--json"]));
    expect(plan.question).toBe("Delete figma?");
    // JSON names every file it touches; the text names clausona's own in words.
    expect(plan.changes.map((c: { file: string }) => path.dirname(c.file))).toEqual([keptDir]);
    const text = stripAnsi(await run("mcp", ["rm", "--id", kept.id, "--dry-run"]));
    expect(text).toMatch(/^ {6}the copy clausona kept {2}work$/m);
    expect(text).not.toContain("stash");
    await run("mcp", ["rm", "--id", kept.id, "--yes"]);
    expect(json(h.path(".claude.json")).mcpServers.figma).toEqual({ command: "figma" });
    expect(readdirSync(keptDir)).toEqual([]);
  });
});

describe("an apply that stops", () => {
  it("names a copy clausona kept in words when it went before the delete got to it", async () => {
    const { h, app } = seed();
    const { run, printed } = cli(h, app);
    await run("mcp", ["off", "figma", "--everywhere", "--account", "work", "--tool", "claude", "--yes"]);
    const keptDir = h.path(".clausona", "extensions", "stash");
    const listed = JSON.parse(await run("mcp", ["ls", "--scope", "global", "--tool", "claude", "--json"]));
    const figma = listed.items.find((i: { name: string }) => i.name === "figma");
    const kept = figma.copies.find((c: { id: string }) => c.id.includes(":stash-"));
    const error = await failure(
      run("mcp", ["rm", "--id", kept.id], {
        interactive: true,
        confirm: async () => {
          for (const file of readdirSync(keptDir)) rmSync(path.join(keptDir, file));
          return true;
        },
      }),
    );
    expect(stripAnsi(printed.join("\n"))).toContain("the copy clausona kept");
    expect(error).toMatchObject({ code: 1, kind: "changed" });
    expect(error.message).toBe("The copy clausona kept changed since it was read. Run the command again.");
  });

  it("says why and how much was made, with the operation in its JSON", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app, { lockWaitMs: 300 });
    const workJson = h.path(".claude-work", ".claude.json");
    // Claude Code is saving work's file: default's change is made, work's is not.
    const release = await acquireDirLock(`${workJson}.lock`, { staleMs: 10_000, updateMs: 5_000 });
    if (!release) throw new Error("lock not taken");
    try {
      const error = await failure(run("mcp", ["off", "figma", "--tool", "claude", "--yes", "--json"]));
      expect(error).toMatchObject({ code: 1, kind: "locked" });
      expect(error.message).toBe(
        `Claude Code is saving ${tilde(workJson, h.home)}. Try again in a moment. ` +
          "1 of 2 changes were made; clausona mcp undo puts them back.",
      );
      const body = JSON.parse(error.stdout ?? "");
      expect(Object.keys(body)).toEqual(["version", "error", "message", "operation", "done", "total", "file"]);
      expect(body).toMatchObject({ version: 1, error: "locked", done: 1, total: 2, file: workJson });
      expect(body.operation.backup).toBe(path.join(h.path(".clausona", "backups", "extensions"), body.operation.id));
    } finally {
      await release();
    }
    expect(json(h.path(".claude.json")).projects[app].disabledMcpServers).toEqual(["figma"]);
    expect(json(workJson).projects[app].disabledMcpServers).toBeUndefined();
    // What was made goes back with undo.
    await run("mcp", ["undo", "--yes"]);
    expect(json(h.path(".claude.json")).projects[app].disabledMcpServers).toBeUndefined();
  });
});

describe("an apply whose changes are there already", () => {
  it("says there was nothing to do, offers no undo, and leaves undo the change before it", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    await run("mcp", ["off", "figma", "--account", "work", "--tool", "claude", "--yes"]);
    const backups = h.path(".clausona", "backups", "extensions");
    const before = readdirSync(backups);
    const text = stripAnsi(
      await run("mcp", ["off", "github", "--tool", "claude"], {
        interactive: true,
        confirm: async () => {
          // `/mcp disable github` in Claude Code, while the prompt waits.
          const value = json(h.path(".claude.json"));
          value.projects[app].disabledMcpServers = ["github"];
          h.write(".claude.json", value);
          return true;
        },
      }),
    );
    expect(text.split("\n")[0]).toBe("  Nothing to do.");
    expect(text).not.toContain("Undo");
    expect(readdirSync(backups)).toEqual(before);
    expect(stripAnsi(await run("mcp", ["undo", "--dry-run"]))).toContain(
      "Undo: Turned off figma in this project, for work?",
    );
  });
});

describe("hooks off and on", () => {
  it("calls two Stop hooks ambiguous, turns one off by --id and puts it back", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const settings = h.path(".claude", "settings.json");
    const error = await failure(run("hooks", ["off", "Stop", "--yes"]));
    expect(error).toMatchObject({ code: 2, kind: "ambiguous" });
    const listed = JSON.parse(await run("hooks", ["ls", "--json"]));
    const idOf = (command: string) =>
      listed.items.find((i: { summary: { command?: string } }) => i.summary.command === command).id;
    const text = stripAnsi(await run("hooks", ["off", "--id", idOf("notify-a"), "--yes"]));
    expect(text).toContain("✔ Turned off the Stop hook in every project");
    expect(read(settings)).not.toContain("notify-a");
    expect(read(settings)).toContain("notify-b");
    const after = JSON.parse(await run("hooks", ["ls", "--scope", "global", "--json"]));
    const off = after.items.find((i: { tags: string[] }) => i.tags.includes("off"));
    expect(off.tags).toEqual(["off"]);
    expect(off.id).toContain(":stash-");
    // --everywhere is taken, and changes nothing: hooks are off or on everywhere.
    const plan = JSON.parse(await run("hooks", ["on", "--id", off.id, "--everywhere", "--dry-run", "--json"]));
    expect(plan.everywhere).toBe(true);
    await run("hooks", ["on", "--id", off.id, "--yes"]);
    expect(read(settings)).toContain("notify-a");
  });
});

describe("undo", () => {
  it("puts back the last change, then has nothing left to undo", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const local = path.join(app, ".claude", "settings.local.json");
    expect(await failure(run("skills", ["undo", "--dry-run"]))).toMatchObject({ code: 1, kind: "nothing-to-undo" });
    expect(existsSync(h.path(".clausona"))).toBe(false);
    await run("skills", ["off", "eli5", "--tool", "claude", "--yes"]);
    const dry = stripAnsi(await run("skills", ["undo", "--dry-run"]));
    expect(dry).toContain("Undo: Turned off eli5 in this project?");
    expect(dry).toContain(tilde(local, h.home));
    expect(existsSync(local)).toBe(true);
    const preview = JSON.parse(await run("skills", ["undo", "--dry-run", "--json"]));
    expect(inOrder(Object.keys(preview), UNDO_JSON_KEYS)).toBe(true);
    expect(preview).toMatchObject({ version: 1, command: "skills", verb: "undo", dryRun: true });
    expect(Object.keys(preview.operation)).toEqual(["id", "summary", "createdAt"]);
    expect(preview.files).toEqual([{ path: local, action: "remove" }]);
    expect(await failure(run("skills", ["undo"]))).toMatchObject({ code: 2, kind: "usage" });
    const asked: string[] = [];
    const no = await run("skills", ["undo"], {
      interactive: true,
      confirm: async (question) => {
        asked.push(question);
        return false;
      },
    });
    expect(stripAnsi(no)).toBe("  Cancelled. Nothing changed.");
    expect(asked).toEqual(["  Apply? (y/N) "]);
    expect(existsSync(local)).toBe(true);
    const text = stripAnsi(await run("skills", ["undo", "--yes"]));
    expect(text.split("\n")[0]).toBe("  ✔ Undid: Turned off eli5 in this project");
    // The change made the file, so undo took it away, as its preview said.
    expect(text).toContain(`${tilde(local, h.home)}  removed`);
    expect(text).not.toContain("put back");
    expect(existsSync(local)).toBe(false);
    const none = await failure(run("skills", ["undo", "--yes"]));
    expect(none).toMatchObject({ code: 1, kind: "nothing-to-undo", message: "Nothing to undo for skills." });
    // Each command undoes its own: an mcp change is not skills'.
    expect(await failure(run("mcp", ["undo", "--yes"]))).toMatchObject({ code: 1, kind: "nothing-to-undo" });
  });

  it("says what it put back as JSON, leaving clausona's own files out", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const listed = JSON.parse(await run("hooks", ["ls", "--json"]));
    const notifyA = listed.items.find((i: { summary: { command?: string } }) => i.summary.command === "notify-a");
    await run("hooks", ["off", "--id", notifyA.id, "--yes"]);
    const out = JSON.parse(await run("hooks", ["undo", "--yes", "--json"]));
    expect(Object.keys(out)).toEqual(["version", "command", "verb", "dryRun", "operation", "restored", "skipped"]);
    expect(inOrder(Object.keys(out), UNDO_JSON_KEYS)).toBe(true);
    expect(out).toMatchObject({ command: "hooks", verb: "undo", dryRun: false, skipped: [] });
    expect(out.restored).toEqual([h.path(".claude", "settings.json")]);
    expect(read(h.path(".claude", "settings.json"))).toContain("notify-a");
  });

  it("leaves a file that changed since alone, and says so", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const local = path.join(app, ".claude", "settings.local.json");
    await run("skills", ["off", "eli5", "--tool", "claude", "--yes"]);
    h.write(path.join("repos", "app", ".claude", "settings.local.json"), { skillOverrides: { eli5: "on" } });
    const error = await failure(run("skills", ["undo", "--yes", "--json"]));
    expect(error).toMatchObject({ code: 1, kind: "changed" });
    expect(error.message).toContain(`${tilde(local, h.home)}  changed since`);
    const body = JSON.parse(error.stdout ?? "");
    expect(Object.keys(body)).toEqual(["version", "error", "message", "operation", "restored", "skipped"]);
    expect(body).toMatchObject({ version: 1, error: "changed", restored: [] });
    expect(body.operation).toMatchObject({ summary: "Turned off eli5 in this project" });
    expect(Object.keys(body.operation)).toEqual(["id", "summary", "createdAt"]);
    expect(body.skipped).toEqual([{ file: local, reason: "changed" }]);
    expect(json(local).skillOverrides).toEqual({ eli5: "on" });
  });
});

describe("secrets", () => {
  it("never shows one, in a plan, a result, an undo or an error", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    // Each output goes into the net afterEach casts; these are the ones that name the servers with a secret.
    for (const json of [[], ["--json"]]) {
      await run("mcp", ["off", "github", "--dry-run", ...json]);
      await run("mcp", ["off", "github", "--everywhere", "--dry-run", ...json]);
      await run("mcp", ["rm", "github", "pg-dev", "--dry-run", ...json]);
      await failure(run("mcp", ["off", "github", "--account", "work", "--yes", ...json]));
    }
    await run("mcp", ["off", "github", "--everywhere", "--yes"]);
    await run("mcp", ["undo", "--dry-run"]);
    await run("mcp", ["undo", "--dry-run", "--json"]);
    await run("mcp", ["undo", "--yes", "--json"]);
    await run("mcp", ["rm", "pg-dev", "--yes", "--json"]);
    await run("mcp", ["undo", "--yes"]);
    expect(read(h.path(".claude.json"))).toContain("GITHUB_TOKEN");
  });
});

describe("undo, and what clausona kept aside", () => {
  /** notify-a turned off: taken out of user settings and kept by clausona. */
  async function turnedOff(h: TestHome, run: ReturnType<typeof cli>["run"]) {
    const listed = JSON.parse(await run("hooks", ["ls", "--json"]));
    const notifyA = listed.items.find((i: { summary: { command?: string } }) => i.summary.command === "notify-a");
    await run("hooks", ["off", "--id", notifyA.id, "--yes"]);
    return h.path(".claude", "settings.json");
  }

  it("names the user's file, never clausona's own, when a change since keeps it from going back", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const settings = await turnedOff(h, run);
    h.write(path.join(".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-c" }] }] },
    });
    const error = await failure(run("hooks", ["undo", "--yes", "--json"]));
    expect(error).toMatchObject({ code: 1, kind: "changed" });
    expect(error.message).toContain(`${tilde(settings, h.home)}  changed since`);
    expect(error.message).not.toContain(".clausona");
    const body = JSON.parse(error.stdout ?? "");
    expect(body.skipped).toEqual([{ file: settings, reason: "changed" }]);
    expect(error.stdout).not.toContain(".clausona");
  });

  it("still fails when only the copy clausona kept could not be dealt with, and says so without its path", async () => {
    const { h, app } = seed();
    const { run } = cli(h, app);
    const settings = await turnedOff(h, run);
    const keptDir = h.path(".clausona", "extensions", "stash");
    for (const file of readdirSync(keptDir)) rmSync(path.join(keptDir, file));
    const error = await failure(run("hooks", ["undo", "--yes", "--json"]));
    expect(error).toMatchObject({ code: 1, kind: "changed" });
    expect(stripAnsi(error.message)).toContain(`${tilde(settings, h.home)}  put back`);
    expect(stripAnsi(error.message)).toMatch(/^ {4}the copy clausona kept +is gone$/m);
    expect(error.message).not.toContain(".clausona");
    const body = JSON.parse(error.stdout ?? "");
    expect(body).toMatchObject({ restored: [settings], skipped: [] });
    expect(read(settings)).toContain("notify-a");
  });
});

describe("withJsonErrors", () => {
  it("is the run itself without --json", async () => {
    const thrown = new ExitError("bad", 2);
    await expect(withJsonErrors(["ls"], async () => "ok")).resolves.toBe("ok");
    await expect(withJsonErrors(["ls"], () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  it("makes any other error one JSON object, keeping its code", async () => {
    const usage = await failure(withJsonErrors(["--json"], () => Promise.reject(new ExitError("bad", 2))));
    expect(usage).toMatchObject({ code: 2, kind: undefined });
    expect(JSON.parse(usage.stdout ?? "")).toEqual({ version: 1, error: "usage", message: "bad" });
    const found = await failure(withJsonErrors(["--json"], () => Promise.reject(new ExitError("none", 1))));
    expect(JSON.parse(found.stdout ?? "")).toEqual({ version: 1, error: "not-found", message: "none" });
    const extra = new ExitError("stop", 1, undefined, "locked", { done: 1 });
    const locked = await failure(withJsonErrors(["--json"], () => Promise.reject(extra)));
    expect(JSON.parse(locked.stdout ?? "")).toEqual({ version: 1, error: "locked", message: "stop", done: 1 });
    const failed = await failure(withJsonErrors(["--json"], () => Promise.reject(new Error("boom"))));
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout ?? "")).toEqual({ version: 1, error: "failed", message: "boom" });
    const given = new ExitError("2 match", 2, '{"version":1}', "ambiguous");
    expect(await failure(withJsonErrors(["--json"], () => Promise.reject(given)))).toBe(given);
  });
});
