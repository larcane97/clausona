import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInventory } from "../../extensions/inventory.js";
import { writesFor } from "../../extensions/load.js";
import { TestHome } from "../../extensions/test-home.js";
import { stripAnsi } from "../../lib/cli-style.js";
import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../test-timeouts.js";
import {
  DOWN,
  ENTER,
  ESC,
  focusedOn,
  type Instance,
  press,
  renderAt,
  type,
  typeSlowly,
  waitForFrame,
} from "../test-drive.js";
import { windowsOnScreen } from "../test-frames.js";
import { ExtensionsScreen } from "./ExtensionsScreen.js";

vi.setConfig({ testTimeout: 20_000 });

/**
 * How long a key that plans a change in a project may take to draw what it led to. The plan asks
 * git what it tracks and what it ignores (planChecked), which on a busy machine takes seconds
 * where every other step here takes milliseconds: up to git-tracked.ts's 5 s for each of its two
 * git runs in a row, then the redraw. A case with such a step takes SPAWNING_TEST_TIMEOUT_MS.
 */
const PLAN_STEP_MS = 15_000;

const DAY = 86_400_000;
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const UP = "\u001B[A";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const TAB = "\t";
const SPACE = " ";
const SETTINGS = {
  enabledPlugins: { "kit@m": true },
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
};

/** The test's own git runs: not told where a repo is by a hook's environment (spawn leaves undefined out). */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

const hasGit = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

const homes: TestHome[] = [];
const instances: Instance[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  for (const home of homes.splice(0)) home.dispose();
});

/**
 * plan.test.ts's fixture, with no broken settings file: two Claude accounts (default has opened
 * app and web, work only app, where it has turned github off) and a Codex one. Global eli5,
 * old-one, a link notes and a broken link lost; app's deploy-check; web's web-only; the Cloud
 * pdf; github (default's with a secret) and figma in both accounts.
 */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    oauthAccount: { organizationUuid: "org", accountUuid: "one" },
    projects: { [app]: {}, [web]: {} },
    mcpServers: { github: { command: "gh", env: { GITHUB_TOKEN: KEY } }, figma: { command: "figma" } },
  });
  h.claude("work", ".claude-work", {
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: { github: { command: "gh" }, figma: { command: "figma" } },
  });
  h.codex(
    "personal",
    ".codex",
    `[projects.'${app}']\ntrust_level = "trusted"\n\n[projects.'${web}']\ntrust_level = "untrusted"\n\n[mcp_servers.docs]\ncommand = "docs"\n`,
  );
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill(".agents/skills", "eli5");
  h.skill("repos/app/.agents/skills", "app-lint");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".claude/skills/synced/org_one", "pdf");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  h.link(h.path("gone", "lost"), ".claude/skills/lost");
  const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
  h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
  h.write(".claude/settings.json", SETTINGS);
  h.write("repos/app/.mcp.json", { mcpServers: { "docs-search": { command: "ds" } } });
  return { h, app, web };
}

/**
 * The screen on `h`, seen from `app`, reading the files again on each load, 200 days on (every
 * skill is old enough to be unused), writing on a clock of its own.
 */
function mount(h: TestHome, app: string, columns: number, rows: number, options: { writes?: boolean } = {}) {
  let at = Date.UTC(2026, 9, 10, 4, 36, 48);
  const clock = () => {
    at += 1000;
    return at;
  };
  const load = () => loadInventory(h.inventoryOptions(app, h.path("managed-settings.json")));
  const later = () => Date.now() + 200 * DAY;
  const writes = options.writes === false ? undefined : writesFor(h.home, { now: clock });
  const instance = renderAt(
    <ExtensionsScreen load={load} onExit={vi.fn()} now={later} {...(writes ? { writes } : {})} />,
    columns,
    { rows },
  );
  instances.push(instance);
  return instance;
}

/** Waits for a frame whose text, colours aside, passes `check`, and returns that text. */
async function seen(instance: Instance, check: (text: string) => boolean, timeout?: number): Promise<string> {
  return stripAnsi(await waitForFrame(instance.lastFrame, (frame) => check(stripAnsi(frame)), timeout));
}

/** The key hints: the line that offers esc. */
function hintLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("esc ")) ?? "";
}

/** Walks the scope list down to `label`. */
async function scopeTo(instance: Instance, label: string) {
  for (let step = 0; step < 12; step++) {
    if (stripAnsi(instance.lastFrame() ?? "").includes(`▸ ${label}`)) return;
    await press(instance, DOWN);
  }
  throw new Error(`the list never reached '${label}'`);
}

/** Walks the table's cursor, down or up, to the row carrying `label`. */
async function rowTo(instance: Instance, label: string, key = DOWN) {
  for (let step = 0; step < 20; step++) {
    if (focusedOn(stripAnsi(instance.lastFrame() ?? ""), label)) return;
    await press(instance, key);
  }
  throw new Error(`the cursor never reached '${label}'`);
}

/** The screen read, a scope's table open and the cursor on `name`. */
async function openRow(instance: Instance, scope: string, name: string, kindKey?: string) {
  await seen(instance, (f) => f.includes("Read "));
  if (kindKey) {
    await press(instance, kindKey);
    await seen(instance, (f) => /▸ [^\n]*\(here\)/.test(f));
  }
  await scopeTo(instance, scope);
  await press(instance, RIGHT);
  await rowTo(instance, name);
}

/** The line a row's name is on. */
function rowLine(frame: string, name: string): string {
  return frame.split("\n").find((line) => new RegExp(`[✦◉ ] ${name} `).test(line)) ?? "";
}

/**
 * How many terminal lines a frame takes: ink's own count. The frame's last line is the Chrome's
 * bottom padding, which is empty, so the text ends in a line break.
 */
function height(frame: string | undefined): number {
  return (frame ?? "").split("\n").length;
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const local = (app: string) => path.join(app, ".claude", "settings.local.json");

describe("ExtensionsScreen: writes", () => {
  it("turns a Global skill off here after a confirm, and says so", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, SPACE, PLAN_STEP_MS);
    const dialog = await seen(instance, (f) => f.includes("Turn off eli5 in this project?"), PLAN_STEP_MS);
    expect(dialog).toContain("skillOverrides.eli5 → off");
    expect(hintLine(dialog)).toContain("y apply");
    await press(instance, "y");
    const done = await seen(instance, (f) => f.includes("Turned off eli5 in this project · u to undo"));
    expect(rowLine(done, "eli5")).toContain("off here");
    expect(json(local(app)).skillOverrides).toEqual({ eli5: "off" });
  });

  it("changes nothing on n or esc", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    for (const key of ["n", ESC]) {
      await press(instance, SPACE, PLAN_STEP_MS);
      await seen(instance, (f) => f.includes("Turn off eli5 in this project?"), PLAN_STEP_MS);
      // ctrl+y and ctrl+n are not y and n.
      await type(instance, "\u0019");
      await type(instance, "\u000e");
      expect(stripAnsi(instance.lastFrame() ?? "")).toContain("Turn off eli5 in this project?");
      await press(instance, key);
      const after = await seen(instance, (f) => f.includes("Nothing changed."));
      expect(after).not.toContain("Turn off eli5 in this project?");
      expect(existsSync(local(app))).toBe(false);
    }
  });

  it("undoes the newest change on u, after a confirm", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, SPACE, PLAN_STEP_MS);
    await seen(instance, (f) => f.includes("Turn off eli5 in this project?"), PLAN_STEP_MS);
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned off eli5 in this project · u to undo"));
    await press(instance, "u");
    const dialog = await seen(instance, (f) => f.includes("Undo: Turned off eli5 in this project?"));
    expect(hintLine(dialog)).toContain("y undo");
    expect(dialog).toContain("Puts back what changed, unless it changed since.");
    await press(instance, "y");
    const undone = await seen(instance, (f) => f.includes("Undid: Turned off eli5 in this project"));
    expect(rowLine(undone, "eli5")).not.toContain("off here");
    expect(existsSync(local(app))).toBe(false);
  });

  it("says why a key cannot apply instead of asking", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Cloud", "pdf");
    await press(instance, "d");
    const frame = await seen(instance, (f) =>
      f.includes("It comes back from claude.ai. Press space to turn it off instead."),
    );
    expect(frame).not.toContain("Delete pdf?");
    expect(hintLine(frame)).not.toContain("y apply");
  });

  it("says in keys why a server a deny list keeps off cannot go back on", async () => {
    const { h, app } = seed();
    h.write(".claude/settings.json", { ...SETTINGS, deniedMcpServers: [{ serverName: "figma" }] });
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "figma", "2");
    await press(instance, SPACE);
    const frame = await seen(instance, (f) =>
      f.includes("deniedMcpServers in ~/.claude/settings.json keeps it from starting. Change it there."),
    );
    expect(frame).not.toContain("Turn on figma");
    expect(hintLine(frame)).not.toContain("y apply");
  });

  it("says in keys why a built-in skill cannot go back on under disableBundledSkills", async () => {
    const { h, app } = seed();
    h.write(".claude/settings.json", {
      ...SETTINGS,
      disableBundledSkills: true,
      skillOverrides: { "claude-api": "off" },
    });
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Built-in", "claude-api");
    await press(instance, SPACE);
    await seen(instance, (f) =>
      f
        .replace(/\n +/g, " ")
        .includes("disableBundledSkills in ~/.claude/settings.json turns off the skills that come with Claude Code."),
    );
  });

  it("lets the user pick the accounts an MCP server changes in", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    const work = h.path(".claude-work", ".claude.json");
    const workBefore = readFileSync(work, "utf8");
    await openRow(instance, "Global", "figma", "2");
    await press(instance, SPACE);
    const picker = await seen(instance, (f) => f.includes("◉ default") && f.includes("◉ work"));
    expect(picker).toContain("Turn off figma in this project, for default and work?");
    expect(hintLine(picker)).toContain("space pick");
    await press(instance, DOWN);
    await press(instance, SPACE);
    const one = await seen(instance, (f) => f.includes("○ work"));
    expect(one).toContain("Turn off figma in this project, for default?");
    expect(one).toContain("◉ default");
    // Neither account: nothing to apply, and the dialog stays for another pick.
    await press(instance, UP);
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("○ default") && f.includes("○ work"));
    await press(instance, "y");
    const none = await seen(instance, (f) => f.includes("Pick at least one account."));
    expect(none).toContain("○ default");
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("Turn off figma in this project, for default?"));
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned off figma in this project, for default · u to undo"));
    expect(json(h.path(".claude.json")).projects[app].disabledMcpServers).toEqual(["figma"]);
    expect(readFileSync(work, "utf8")).toBe(workBefore);
  });

  it("marks rows with x and deletes them together", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Not used in 90 days", "old-one");
    await press(instance, "x");
    await rowTo(instance, "lost", UP);
    await press(instance, "x");
    const marked = await seen(instance, (f) => f.includes("· 2 marked"));
    expect(rowLine(marked, "old-one")).toMatch(/◉ old-one/);
    await press(instance, "d");
    const dialog = await seen(instance, (f) => f.includes("Delete 2 skills?"));
    expect(dialog.split("\n").find((line) => line.includes(`skills${path.sep}lost`))).toContain(
      "link only, target kept",
    );
    await press(instance, "y");
    const done = await seen(instance, (f) => f.includes("Deleted 2 skills · u to undo"));
    expect(rowLine(done, "old-one")).toBe("");
    expect(rowLine(done, "lost")).toBe("");
    expect(done).not.toContain("marked");
    expect(existsSync(h.path(".claude", "skills", "old-one"))).toBe(false);
  });

  it("says what a .mcp.json server runs in the dialog where space approves it", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const { h, app } = seed();
    h.write("repos/app/.mcp.json", {
      mcpServers: { "docs-search": { command: "npx", args: ["docs-mcp", "--api-key", KEY] } },
    });
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Project", "docs-search", "2");
    // Pending approval, it does not run: its details offer on, and space in the table approves it.
    await press(instance, ENTER);
    const details = await seen(instance, (f) => f.includes("PROJECT › docs-search"));
    expect(lastPaneLine(details)).toBe("space on here · d delete");
    await press(instance, ESC);
    await seen(instance, (f) => focusedOn(f, "docs-search"));
    await press(instance, SPACE, PLAN_STEP_MS);
    const dialog = await seen(instance, (f) => f.includes("Turn on docs-search in this project?"), PLAN_STEP_MS);
    const lines = dialog.split("\n");
    const at = lines.findIndex((line) => line.includes("enabledMcpjsonServers + docs-search"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toContain("  runs npx docs-mcp --api-key <hidden>");
    expect(dialog).not.toContain(KEY);
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned on docs-search in this project · u to undo"));
    expect(json(local(app)).enabledMcpjsonServers).toEqual(["docs-search"]);
  });

  it("says in the dialog which links deleting a folder leaves broken", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const { h, app } = seed();
    h.skill("repos/app/.claude/skills", "gstack");
    for (const name of ["canary", "careful"]) {
      h.skill("repos/app/.claude/skills/gstack", name);
      h.link(`repos/app/.claude/skills/gstack/${name}`, `repos/app/.claude/skills/${name}`);
    }
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Project", "gstack");
    await press(instance, "d", PLAN_STEP_MS);
    const dialog = await seen(instance, (f) => f.includes("Delete gstack?"), PLAN_STEP_MS);
    expect(dialog.split("\n").find((line) => line.includes(`skills${path.sep}gstack`))).toContain(
      "breaks 2 links: canary, careful (add them to delete them too)",
    );
    expect(hintLine(dialog)).toContain("y apply");
  });

  it.skipIf(!hasGit)(
    "adds Claude Code's ignore line with a project's first settings.local.json, and keeps it when an account is picked",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const { h, app } = seed();
      rmSync(path.join(app, ".git"), { recursive: true, force: true });
      git(app, ["init", "-q"]);
      // Both accounts turned the .mcp.json server down: on clears both, and approves it here.
      const denied = { disabledMcpjsonServers: ["docs-search"] };
      h.claude("default", ".claude", { projects: { [app]: denied, [h.path("repos", "web")]: {} } });
      h.claude("work", ".claude-work", { projects: { [app]: denied } });
      const ignore = h.path(".config", "git", "ignore");
      const instance = mount(h, app, 140, 40);
      await openRow(instance, "Project", "docs-search", "2");
      await press(instance, SPACE, PLAN_STEP_MS);
      const dialog = await seen(instance, (f) => f.includes("◉ default") && f.includes("◉ work"), PLAN_STEP_MS);
      const ignoreLine = (frame: string) => frame.split("\n").find((line) => line.includes(`git${path.sep}ignore`));
      expect(ignoreLine(dialog)).toContain("adds **/.claude/settings.local.json  as Claude Code does");
      // Leaving an account out plans again: the line stays.
      await press(instance, DOWN);
      await press(instance, SPACE);
      const one = await seen(instance, (f) => f.includes("○ work"));
      expect(ignoreLine(one)).toContain("adds **/.claude/settings.local.json");
      await press(instance, "y");
      await seen(instance, (f) => f.includes("· u to undo"));
      expect(readFileSync(ignore, "utf8")).toBe("**/.claude/settings.local.json\n");
      expect(json(local(app)).enabledMcpjsonServers).toEqual(["docs-search"]);
    },
  );

  it.skipIf(!hasGit)(
    "warns that deleting a skill git tracks changes the repo, and turns it off instead on o",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const { h, app } = seed();
      rmSync(path.join(app, ".git"), { recursive: true, force: true });
      git(app, ["init", "-q"]);
      git(app, ["add", path.join(".claude", "skills", "deploy-check", "SKILL.md")]);
      const instance = mount(h, app, 140, 40);
      await openRow(instance, "Project", "deploy-check");
      await press(instance, "d", PLAN_STEP_MS);
      const dialog = await seen(instance, (f) => f.includes("Git tracks deploy-check in app"), PLAN_STEP_MS);
      expect(dialog).toContain("Git tracks deploy-check in app, so deleting changes the repo.");
      expect(hintLine(dialog)).toContain("o off instead");
      await press(instance, "o", PLAN_STEP_MS);
      await seen(instance, (f) => f.includes("Turn off deploy-check in this project?"), PLAN_STEP_MS);
      await press(instance, "y");
      await seen(instance, (f) => f.includes("Turned off deploy-check in this project · u to undo"));
      expect(json(local(app)).skillOverrides).toEqual({ "deploy-check": "off" });
      expect(existsSync(path.join(app, ".claude", "skills", "deploy-check"))).toBe(true);
      // Off instead, once it is off: nothing to do, and the status says why.
      await press(instance, "d", PLAN_STEP_MS);
      await seen(instance, (f) => f.includes("Git tracks deploy-check in app"), PLAN_STEP_MS);
      await press(instance, "o", PLAN_STEP_MS);
      await seen(instance, (f) => f.includes("Nothing to do: already off in this project."), PLAN_STEP_MS);
    },
  );

  it("ends a row's details with the keys that apply to it", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, ENTER);
    const eli5 = await seen(instance, (f) => f.includes("GLOBAL › eli5"));
    expect(lastPaneLine(eli5)).toBe("space off here · g off everywhere · d delete · v name only");
    expect(hintLine(eli5)).toContain("v visibility");
    await press(instance, ESC);
    await press(instance, "\u001B[D");
    await scopeTo(instance, "Cloud");
    await press(instance, RIGHT);
    await rowTo(instance, "pdf");
    await press(instance, ENTER);
    const pdf = await seen(instance, (f) => f.includes("CLOUD › pdf"));
    expect(lastPaneLine(pdf)).toBe("space off here · g off everywhere · v name only");
  });

  it("sets a skill's visibility here with v in its details", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("GLOBAL › eli5"));
    await press(instance, "v", PLAN_STEP_MS);
    await seen(instance, (f) => f.includes("Show eli5 as name only in this project?"), PLAN_STEP_MS);
    await press(instance, "y");
    const details = await seen(instance, (f) => f.includes("eli5 shows as name only in this project · u to undo"));
    expect(details).toContain(`Shows as  name only (this project's ${path.join(".claude", "settings.local.json")})`);
  });

  it("says where v works when pressed in the table", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, "v");
    await seen(instance, (f) => f.includes("v changes a Claude skill's visibility, in its details."));
  });

  it("asks for the table first when a write key is pressed in the scope list", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("Open the table first: →"));
  });

  it.each([
    [60, 24],
    [80, 24],
    [140, 40],
  ])("keeps every frame inside a %i by %i terminal with the dialog and the account picker open", async (columns, rows) => {
    const { h, app } = seed();
    const instance = mount(h, app, columns, rows);
    await openRow(instance, "Not used in 90 days", "old-one");
    await press(instance, "x");
    await rowTo(instance, "lost", UP);
    await press(instance, "x");
    await press(instance, "d");
    await seen(instance, (f) => f.includes("Delete 2 skills?"));
    await press(instance, "n");
    await seen(instance, (f) => f.includes("Nothing changed."));
    await press(instance, "2");
    await seen(instance, (f) => /▸ [^\n]*\(here\)/.test(f));
    await scopeTo(instance, "Global");
    await press(instance, RIGHT);
    await rowTo(instance, "figma");
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("◉ work"));
    for (const frame of instance.frames) {
      expect(height(frame)).toBeLessThanOrEqual(rows - 2);
      for (const line of stripAnsi(frame).split("\n")) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps the marked rows' keys, a long status and a refusal's end in sight at 60 by 24", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 60, 24);
    await openRow(instance, "Not used in 90 days", "old-one");
    await press(instance, "x");
    await rowTo(instance, "lost", UP);
    await press(instance, "x");
    const marked = hintLine(await seen(instance, (f) => f.includes("· 2 marked")));
    expect(marked).toContain("d delete");
    expect(marked).toContain("x mark");
    await press(instance, ESC);
    await press(instance, ESC);
    await press(instance, "2");
    await seen(instance, (f) => /▸ [^\n]*\(here\)/.test(f));
    await scopeTo(instance, "Global");
    await press(instance, RIGHT);
    await rowTo(instance, "figma");
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("◉ work"));
    await press(instance, "y");
    // Two lines for a status one cannot hold: its end, how to undo, is still there.
    const off = await seen(instance, (f) => /for default and work · u to undo/.test(f.replace(/\n +/g, " ")));
    expect(off.split("\n").filter((line) => /Turned off figma|u to undo/.test(line)).length).toBe(2);
    await press(instance, LEFT);
    await press(instance, "1");
    await seen(instance, (f) => /▸ [^\n]*\(here\)/.test(f));
    await scopeTo(instance, "Cloud");
    await press(instance, RIGHT);
    await rowTo(instance, "pdf");
    await press(instance, "d");
    await seen(instance, (f) => /Press space to turn it off\s+instead\./.test(f.replace(/\n +/g, " ")));
    for (const frame of instance.frames) {
      expect(height(frame)).toBeLessThanOrEqual(24 - 2);
      for (const line of stripAnsi(frame).split("\n")) expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps the apply's status when the row under the cursor goes", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "old-one");
    await press(instance, "d");
    await seen(instance, (f) => f.includes("Delete old-one?"));
    await press(instance, "y");
    const done = await seen(instance, (f) => f.includes("Deleted old-one · u to undo"));
    expect(done).not.toContain("That item is gone.");
    expect(rowLine(done, "old-one")).toBe("");
  });

  it("says changes are not available without the writes", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40, { writes: false });
    await openRow(instance, "Global", "eli5");
    expect(hintLine(stripAnsi(instance.lastFrame() ?? ""))).not.toContain("space on/off");
    await press(instance, "x");
    const marked = await seen(instance, (f) => f.includes("Changes are not available here."));
    expect(marked).not.toContain("marked");
    await press(instance, DOWN);
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("Changes are not available here."));
  });

  it("never shows a server's secret: its details, the dialog that turns it off everywhere, its status", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "github", "2");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("GLOBAL › github"));
    await press(instance, "g");
    await seen(instance, (f) => f.includes("Turn off github in every project"));
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned off github in every project"));
    // Its copies are clausona's now: d names them in words, never by their path.
    await press(instance, "d");
    const dialog = await seen(instance, (f) => f.includes("Delete github?"));
    expect(dialog).toContain("◉ default  the copy clausona kept");
    expect(dialog).toContain("◉ work     the copy clausona kept");
    await press(instance, "n");
    await seen(instance, (f) => f.includes("Nothing changed."));
    for (const frame of instance.frames) {
      expect(stripAnsi(frame)).not.toContain(path.join(".clausona", "extensions"));
      expect(stripAnsi(frame)).not.toContain("stash");
    }
    expect(windowsOnScreen(instance.frames, KEY)).toEqual([]);
  });

  it("names a copy clausona kept in words when a delete of it stops", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "github", "2");
    await press(instance, "g");
    await seen(instance, (f) => f.includes("Turn off github in every project"));
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned off github in every project"));
    await press(instance, "d");
    await seen(instance, (f) => f.includes("Delete github?"));
    // The kept copies go before y gets to them.
    const keptDir = h.path(".clausona", "extensions", "stash");
    for (const file of readdirSync(keptDir)) rmSync(path.join(keptDir, file));
    await press(instance, "y");
    await seen(instance, (f) => f.includes("The copy clausona kept changed since it was read. Press r and try again."));
    for (const frame of instance.frames) expect(stripAnsi(frame)).not.toContain("stash");
  });

  it("clears the marks on tab, 1 2 3, another scope and another project picked", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await seen(instance, (f) => f.includes("Read "));
    /** From the scope list: Global's table, eli5 marked. */
    const mark = async () => {
      await scopeTo(instance, "Global");
      await press(instance, RIGHT);
      await rowTo(instance, "eli5");
      await press(instance, "x");
      await seen(instance, (f) => f.includes("· 1 marked"));
    };
    /** Back in Global's table, with no marks. */
    const unmarked = async () => {
      await scopeTo(instance, "Global");
      await press(instance, RIGHT);
      expect(await seen(instance, (f) => f.includes("GLOBAL — ") && focusedOn(f, "eli5"))).not.toContain("marked");
      await press(instance, LEFT);
    };
    for (const keys of [
      [TAB, TAB],
      ["2", "1"],
      // The project below the one seen from: picking the one seen from changes nothing.
      ["p", DOWN, ENTER],
      [LEFT, DOWN, UP],
    ]) {
      await mark();
      for (const key of keys) await press(instance, key);
      await seen(instance, (f) => !f.includes("marked"));
      await unmarked();
    }
  });

  it("clears the marks with esc before the search, and leaves marks the search hides to the next esc", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "eli5");
    await press(instance, "x");
    await press(instance, "/");
    await typeSlowly(instance, "eli");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("/eli") && f.includes("· 1 marked"));
    await press(instance, ESC);
    const first = await seen(instance, (f) => !f.includes("marked"));
    expect(first).toContain("/eli");
    await press(instance, ESC);
    await seen(instance, (f) => !f.includes("/eli"));
    // A mark the search hides: esc ends the search, and the mark is there again.
    await rowTo(instance, "old-one");
    await press(instance, "x");
    await press(instance, "/");
    await typeSlowly(instance, "eli");
    await press(instance, ENTER);
    await seen(instance, (f) => f.includes("/eli") && !f.includes("marked"));
    await press(instance, ESC);
    const back = await seen(instance, (f) => !f.includes("/eli"));
    expect(back).toContain("· 1 marked");
  });

  it("says how many marked rows cannot change when none of them would", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await openRow(instance, "Global", "old-one");
    await press(instance, SPACE, PLAN_STEP_MS);
    await seen(instance, (f) => f.includes("Turn off old-one in this project?"), PLAN_STEP_MS);
    await press(instance, "y");
    await seen(instance, (f) => f.includes("Turned off old-one in this project · u to undo"));
    // old-one is off already, and lost's link leads nowhere.
    await press(instance, "x");
    await rowTo(instance, "lost", UP);
    await press(instance, "x");
    await seen(instance, (f) => f.includes("· 2 marked"));
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("1 can't: Its link leads nowhere. Press d to remove the link."));
  });
});

describe("ExtensionsScreen: writes from the MCP matrix", () => {
  /** The screen read, Claude's MCP tab, its matrix open: docs, docs-search, figma, github by default, work, Codex. */
  async function openMatrix(instance: Instance): Promise<string> {
    await seen(instance, (f) => f.includes("Read "));
    await press(instance, "2");
    await seen(instance, (f) => /▸ [^\n]*\(here\)/.test(f));
    await press(instance, "m");
    return seen(instance, (f) => f.includes("SERVER"));
  }

  /** The matrix's line for a server. */
  const serverLine = (frame: string, name: string) =>
    frame.split("\n").find((line) => new RegExp(`[✦ ] ${name} `).test(line)) ?? "";

  it("turns one account's server off in this project from its cell, and back on u", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    const defaultBefore = readFileSync(h.path(".claude.json"), "utf8");
    const work = () => json(h.path(".claude-work", ".claude.json")).projects[app].disabledMcpServers;
    const matrix = await openMatrix(instance);
    expect(hintLine(matrix)).toContain("space on/off");
    expect(hintLine(matrix)).toContain("u undo");
    // The cursor starts on the first cell; ↓ and → move it to work's figma.
    expect(matrix).toContain("[default]");
    await press(instance, DOWN);
    await press(instance, DOWN);
    await press(instance, RIGHT);
    const onWork = await seen(instance, (f) => f.includes("[work]"));
    expect(serverLine(onWork, "figma")).toMatch(/✦ figma +● +\[●\] +·/);
    await press(instance, SPACE);
    const dialog = await seen(instance, (f) => f.includes("Turn off figma in this project, for work?"));
    // The picker has the cell's account, and only it, chosen.
    expect(dialog).toContain("○ default");
    expect(dialog).toContain("◉ work");
    expect(dialog).toContain("disabledMcpServers + figma");
    await press(instance, "y");
    // The matrix again, from the files read again, the cursor on the same cell.
    const off = await seen(instance, (f) => f.includes("Turned off figma in this project, for work · u to undo"));
    expect(off).toContain("[work]");
    expect(serverLine(off, "figma")).toMatch(/✦ figma +● +\[○\] +·/);
    expect(work()).toEqual(["github", "figma"]);
    expect(readFileSync(h.path(".claude.json"), "utf8")).toBe(defaultBefore);
    await press(instance, "u");
    await seen(instance, (f) => f.includes("Undo: Turned off figma in this project, for work?"));
    await press(instance, "y");
    const undone = await seen(instance, (f) => f.includes("Undid: Turned off figma in this project, for work"));
    expect(serverLine(undone, "figma")).toMatch(/✦ figma +● +\[●\] +·/);
    expect(work()).toEqual(["github"]);
  });

  it("says why a cell can't change, as a row's refusal does, and opens no dialog", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40);
    await seen(instance, (f) => f.includes("Read "));
    // From web, which work has not opened and Codex does not trust.
    for (const key of ["p", DOWN, ENTER]) await press(instance, key);
    await seen(instance, (f) => f.includes(`Extensions │ ${path.join("~", "repos", "web")}`));
    await press(instance, "2");
    await press(instance, "m");
    await seen(instance, (f) => f.includes("SERVER"));
    await press(instance, DOWN);
    await press(instance, RIGHT);
    await seen(instance, (f) => f.includes("[work]") && /✦ figma/.test(f));
    await press(instance, SPACE);
    const opened = await seen(instance, (f) => f.includes("No account that has it has opened this project."));
    expect(opened).not.toContain("Turn off figma");
    await press(instance, RIGHT);
    await press(instance, UP);
    await seen(instance, (f) => f.includes("[Codex]") && /✦ docs/.test(f));
    await press(instance, SPACE);
    await seen(instance, (f) =>
      f.includes(
        "Codex does not trust this project, so it ignores its .codex folder. Trust the project in Codex first.",
      ),
    );
    // A cell with no server in it.
    await press(instance, LEFT);
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("work has no docs here."));
    expect(existsSync(local(h.path("repos", "web")))).toBe(false);
  });

  it("scrolls the accounts to keep the cursor's in sight", async () => {
    const { h, app } = seed();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) h.claude(`a${n}`, `.claude-a${n}`, { projects: { [app]: {} } });
    const instance = mount(h, app, 60, 24);
    const matrix = await openMatrix(instance);
    expect(matrix).toContain("→ ");
    for (let step = 0; step < 9; step++) await press(instance, RIGHT);
    const last = await seen(instance, (f) => f.includes("[Codex]"));
    const header = last.split("\n").find((line) => line.includes("SERVER")) ?? "";
    expect(header).toContain("←");
    expect(header).not.toContain("default");
    for (let step = 0; step < 9; step++) await press(instance, LEFT);
    const first = await seen(instance, (f) => f.includes("[default]"));
    expect(first.split("\n").find((line) => line.includes("SERVER"))).not.toContain("←");
  });

  it("offers no changes in the matrix without the writes", async () => {
    const { h, app } = seed();
    const instance = mount(h, app, 140, 40, { writes: false });
    const matrix = await openMatrix(instance);
    expect(hintLine(matrix)).not.toContain("space on/off");
    expect(hintLine(matrix)).not.toContain("u undo");
    await press(instance, SPACE);
    await seen(instance, (f) => f.includes("Changes are not available here."));
  });
});

/**
 * The details pane's last line: the right pane's lines from the details title on, up to the
 * last one that holds anything before the pane ends, which a blank row comes before.
 */
function lastPaneLine(frame: string): string {
  const lines = frame.split("\n");
  const start = lines.findIndex((line) => line.includes(" › "));
  const pane: string[] = [];
  for (const line of lines.slice(start)) {
    const divider = line.indexOf("│");
    if (divider < 0) break;
    pane.push(line.slice(divider + 1).trim());
  }
  const filled = pane.filter((text) => text !== "");
  // The row before the last is blank.
  expect(pane[pane.lastIndexOf(filled.at(-1) ?? "") - 1]).toBe("");
  return filled.at(-1) ?? "";
}
