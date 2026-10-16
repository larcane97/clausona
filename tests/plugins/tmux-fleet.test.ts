import { type ChildProcess, execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../src/test-timeouts.js";

// Every case starts a tmux server, a git repo and the helper as processes of their own.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

// The helper ships inside the plugin and runs straight from Node, so it is tested the way the
// skill runs it: as a child process, inside a real tmux server of the case's own.
const SCRIPT = path.resolve("plugins/tmux-fleet/skills/tmux-fleet/scripts/tmux-fleet.mjs");
// tmux does not run natively on Windows, and a Linux machine may lack it.
const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;

let dir: string;
let sock: string;
let fake: string;
let repo: string;
let trees: string;
let env: Record<string, string>;
const running = new Set<ChildProcess>();

type Result = { code: number; stdout: string; stderr: string };

function run(args: string[], extra: Record<string, string | undefined> = {}): Promise<Result> {
  const childEnv: Record<string, string> = { ...env };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: childEnv, timeout: SPAWN_TIMEOUT_MS },
      (err, stdout, stderr) => {
        running.delete(child);
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      },
    );
    running.add(child);
  });
}

async function json(args: string[]): Promise<any> {
  const r = await run(args);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

function tmx(...args: string[]): string {
  return execFileSync("tmux", ["-u", "-S", sock, ...args], { encoding: "utf8", env, timeout: SPAWN_TIMEOUT_MS }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: SPAWN_TIMEOUT_MS }).trim();
}

function addWorktree(name: string): string {
  const wt = path.join(trees, name);
  git(repo, "worktree", "add", "-q", "-b", `fleet/${name}`, wt);
  return wt;
}

function commit(wt: string, file: string): void {
  writeFileSync(path.join(wt, file), `${file}\n`);
  git(wt, "add", file);
  git(wt, "commit", "-qm", `add ${file}`);
}

async function until<T>(read: () => T | undefined, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The arguments the fake clausona in worktree `name` was started with, once it has started. */
function argvOf(name: string): Promise<string[]> {
  const file = path.join(fake, `argv.${name}`);
  return until(() => (existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : undefined), file);
}

async function startClaude(name: string): Promise<{ wt: string; settings: string; window: string; pane: string }> {
  const wt = addWorktree(name);
  const started = await json([
    "start",
    "--name",
    name,
    "--label",
    `${name} · work`,
    "--worktree",
    wt,
    "--tool",
    "claude",
    "--",
    "claude:work",
  ]);
  await argvOf(name);
  return { wt, settings: path.join(wt, ".fleet-claude.json"), window: started.window, pane: started.pane };
}

/** Runs the hook command Claude Code in `pane` would run for the payload's event, with the payload on stdin. */
function hook({ settings, pane }: { settings: string; pane: string }, payload: Record<string, unknown>): void {
  const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks;
  const event = String(payload.hook_event_name);
  for (const entry of hooks[event]) {
    for (const { command } of entry.hooks) {
      const r = spawnSync("/bin/sh", ["-c", command], {
        input: JSON.stringify(payload),
        // A hook inherits the worker's environment, where tmux names its pane.
        env: { ...env, TMUX_PANE: pane },
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  }
}

const stop = (message = "Done.\nFLEET_WORKER_DONE: ok") => ({
  hook_event_name: "Stop",
  last_assistant_message: message,
});
const notice = (type: string) => ({
  hook_event_name: "Notification",
  notification_type: type,
  message: `${type} text`,
});

function fleetWindows(): string[] {
  return tmx("list-windows", "-a", "-F", "#{@fleet-name}")
    .split("\n")
    .filter((name) => name !== "");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tf-")));
  sock = path.join(dir, "sock");
  fake = path.join(dir, "fake");
  repo = path.join(dir, "repo");
  // A space in every worktree path: the typed command line and the hook commands must quote it.
  trees = path.join(dir, "work trees");
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  for (const d of [fake, bin, home, trees]) mkdirSync(d, { recursive: true });
  // Stands in for clausona: logs its arguments, rings the bell when told to, then keeps the
  // pane busy as an agent would, echoing what it is sent.
  writeFileSync(
    path.join(bin, "clausona"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$FAKE_DIR/argv.$(basename "$PWD")"',
      "if [ -f \"$FAKE_DIR/bell\" ]; then sleep 1; printf '\\a'; fi",
      "exec cat",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const { TMUX: _t, TMUX_PANE: _p, ...outer } = process.env as Record<string, string>;
  env = {
    ...outer,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    FAKE_DIR: fake,
    ENV: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  git(dir, "init", "-q", "--bare", "remote.git");
  git(dir, "init", "-q", "-b", "main", "repo");
  commit(repo, "README.md");
  git(repo, "remote", "add", "origin", path.join(dir, "remote.git"));
  git(repo, "push", "-q", "-u", "origin", "main");
  // A plain, non-login sh in every pane: a login shell would read /etc/profile, which can
  // reorder PATH and hide the fake clausona.
  writeFileSync(path.join(dir, "tmux.conf"), 'set -g default-shell /bin/sh\nset -g default-command "/bin/sh"\n');
  execFileSync(
    "tmux",
    ["-S", sock, "-f", path.join(dir, "tmux.conf"), "new-session", "-d", "-s", "t", "-x", "200", "-y", "50"],
    {
      env,
      timeout: SPAWN_TIMEOUT_MS,
    },
  );
  env.TMUX = `${sock},${tmx("display", "-p", "#{pid}")},0`;
  env.TMUX_PANE = tmx("display", "-p", "-t", "t:", "#{pane_id}");
});

afterEach(async () => {
  await Promise.all(
    [...running].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  running.clear();
  spawnSync("tmux", ["-S", sock, "kill-server"], { timeout: SPAWN_TIMEOUT_MS });
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe.skipIf(!hasTmux)("tmux-fleet helper", () => {
  describe("status", () => {
    it("reports the session, the bell setting and clausona", async () => {
      const s = await json(["status"]);
      expect(s).toMatchObject({ ok: true, session: "t", bellAction: "any", warnings: [] });
      expect(s.clausona).toBe(path.join(dir, "bin", "clausona"));
    });

    it("warns when bell-action keeps a Codex worker's bell from the hook", async () => {
      // tmux runs the hook only for windows bell-action covers; a worker's window is in the background.
      for (const action of ["none", "current", "other"]) {
        tmx("set-option", "-g", "bell-action", action);
        const s = await json(["status"]);
        expect(s.bellAction).toBe(action);
        expect(s.warnings.join(" ")).toMatch(new RegExp(`bell-action is ${action}`));
      }
    });

    it("refuses to run outside tmux", async () => {
      const r = await run(["status"], { TMUX: undefined, TMUX_PANE: undefined });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not inside tmux/);
    });
  });

  describe("start", () => {
    it("starts a Claude Code worker in a labelled window, with hooks of its own", async () => {
      const wt = addWorktree("w1");
      const started = await json([
        "start",
        "--name",
        "w1",
        "--label",
        "docs · ds-flash",
        "--worktree",
        wt,
        "--tool",
        "claude",
        "--",
        "claude:ds-flash",
        "--permission-mode",
        "acceptEdits",
        "--append-system-prompt",
        "it's $HOME and `pwd`",
      ]);
      const settings = path.join(wt, ".fleet-claude.json");
      expect(await argvOf("w1")).toEqual([
        "run",
        "claude:ds-flash",
        "--",
        "--permission-mode",
        "acceptEdits",
        "--append-system-prompt",
        "it's $HOME and `pwd`",
        "--settings",
        settings,
      ]);
      expect(started).toMatchObject({ name: "w1", worktree: wt, tool: "claude" });
      expect(
        tmx(
          "display",
          "-p",
          "-t",
          started.window,
          "#{window_name}|#{@fleet-name}|#{@fleet-worktree}|#{@fleet-pane}|#{@fleet-tool}",
        ),
      ).toBe(`docs · ds-flash|w1|${wt}|${started.pane}|claude`);
      const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks;
      expect(Object.keys(hooks).sort()).toEqual([
        "Notification",
        "SessionEnd",
        "Stop",
        "StopFailure",
        "UserPromptSubmit",
      ]);
      expect(readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split("\n")).toContain("/.fleet-*");
      // The settings file and the event log never show up as changes.
      hook({ settings, pane: started.pane }, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      expect(git(wt, "status", "--porcelain")).toBe("");
    });

    it("refuses a name that is already in use", async () => {
      await startClaude("w1");
      const wt = addWorktree("w1b");
      const r = await run([
        "start",
        "--name",
        "w1",
        "--label",
        "x",
        "--worktree",
        wt,
        "--tool",
        "claude",
        "--",
        "claude:work",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/already/);
      expect(fleetWindows()).toEqual(["w1"]);
    });

    it("starts in a worktree whose path and label hold tmux formats", async () => {
      writeFileSync(path.join(fake, "bell"), "");
      const wt = path.join(trees, "fix #S #{pane_id}");
      git(repo, "worktree", "add", "-q", "-b", "fleet/fmt", wt);
      const started = await json([
        "start",
        "--name",
        "w1",
        "--label",
        "fix #S",
        "--worktree",
        wt,
        "--tool",
        "codex",
        "--",
        "codex:work",
      ]);
      expect(tmx("display", "-p", "-t", started.pane, "#{pane_current_path}")).toBe(wt);
      expect(tmx("display", "-p", "-t", started.window, "#{window_name}")).toBe("fix #S");
      await argvOf("fix #S #{pane_id}");
      // The bell hook carries the path through tmux's run-shell, which expands formats too.
      expect(await json(["wait", "--name", "w1", "--timeout", "20"])).toMatchObject({ event: "bell" });
    });

    it("refuses a folder inside a worktree, and a missing one, with a one-line error", async () => {
      const wt = addWorktree("w1");
      mkdirSync(path.join(wt, "sub"));
      for (const [folder, why] of [
        [path.join(wt, "sub"), /top folder/],
        [path.join(dir, "missing"), /no such folder/],
      ] as const) {
        const r = await run([
          "start",
          "--name",
          "w1",
          "--label",
          "x",
          "--worktree",
          folder,
          "--tool",
          "claude",
          "--",
          "claude:work",
        ]);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(why);
        expect(r.stderr.trim().split("\n")).toHaveLength(1);
      }
      expect(fleetWindows()).toEqual([]);
    });

    it("starts a Codex worker whose bell wakes a wait", async () => {
      writeFileSync(path.join(fake, "bell"), "");
      const wt = addWorktree("w2");
      await json([
        "start",
        "--name",
        "w2",
        "--label",
        "w2",
        "--worktree",
        wt,
        "--tool",
        "codex",
        "--",
        "codex:work",
        "-s",
        "workspace-write",
      ]);
      expect(await argvOf("w2")).toEqual([
        "run",
        "codex:work",
        "--",
        "-s",
        "workspace-write",
        "-c",
        "tui.notifications=true",
        "-c",
        "tui.notification_method=bel",
        "-c",
        "tui.notification_condition=always",
      ]);
      expect(await json(["wait", "--name", "w2", "--timeout", "20"])).toMatchObject({ event: "bell", name: "w2" });
    });

    it("hands a worker over to a new pane in its window", async () => {
      const first = await startClaude("w1");
      const second = await json([
        "start",
        "--name",
        "w1",
        "--handover",
        "--label",
        "w1 · codex",
        "--tool",
        "codex",
        "--",
        "codex:work",
      ]);
      expect(second).toMatchObject({
        name: "w1",
        window: first.window,
        worktree: first.wt,
        tool: "codex",
        replaces: first.pane,
      });
      expect(second.pane).not.toBe(first.pane);
      expect(tmx("display", "-p", "-t", first.window, "#{window_name}|#{@fleet-pane}|#{@fleet-tool}")).toBe(
        `w1 · codex|${second.pane}|codex`,
      );
      await until(
        () => (readFileSync(path.join(fake, "argv.w1"), "utf8").includes("codex:work") ? true : undefined),
        "codex start",
      );
    });
  });

  describe("wait", () => {
    it("wakes on a Stop hook with the last message, and not again for the same event", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, stop());
      const woke = await json(["wait", "--name", "w1", "--timeout", "10"]);
      expect(woke).toMatchObject({ event: "stopped", name: "w1" });
      expect(woke.message).toContain("FLEET_WORKER_DONE: ok");
      expect(await json(["wait", "--name", "w1", "--timeout", "2"])).toMatchObject({ event: "timeout" });
    });

    it("ignores the idle notice after a stop, but reports it after a prompt the user turned down", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, stop());
      expect((await json(["wait", "--name", "w1", "--timeout", "10"])).event).toBe("stopped");
      hook(w1, notice("idle_prompt"));
      expect((await json(["wait", "--name", "w1", "--timeout", "2"])).event).toBe("timeout");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "more" });
      hook(w1, notice("permission_prompt"));
      expect(await json(["wait", "--name", "w1", "--timeout", "10"])).toMatchObject({
        event: "blocked",
        message: "permission_prompt text",
      });
      // Turned down with Esc: no Stop comes, only the idle notice a minute later.
      hook(w1, notice("idle_prompt"));
      expect((await json(["wait", "--name", "w1", "--timeout", "10"])).event).toBe("idle");
    });

    it("turns a burst of events into one wake, reporting the latest", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, notice("permission_prompt"));
      hook(w1, stop());
      expect((await json(["wait", "--name", "w1", "--timeout", "10"])).event).toBe("stopped");
      expect((await json(["wait", "--name", "w1", "--timeout", "2"])).event).toBe("timeout");
    });

    it("reports a turn that failed", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, { hook_event_name: "StopFailure", error: "rate_limit" });
      expect(await json(["wait", "--name", "w1", "--timeout", "10"])).toMatchObject({
        event: "failed",
        message: "rate_limit",
      });
    });

    it("wakes once when a working worker goes quiet with no event", async () => {
      await startClaude("w1");
      await json(["send", "--name", "w1", "--text", "Read .fleet-brief.md in this folder and do what it says."]);
      expect((await json(["wait", "--name", "w1", "--quiet", "2", "--timeout", "15"])).event).toBe("quiet");
      expect((await json(["wait", "--name", "w1", "--quiet", "2", "--timeout", "3"])).event).toBe("timeout");
    });

    it("lets one of two waits on a worker report an event, while the other waits on", async () => {
      const w1 = await startClaude("w1");
      const first = run(["wait", "--name", "w1", "--timeout", "8"]);
      const second = run(["wait", "--name", "w1", "--timeout", "8"]);
      await new Promise((r) => setTimeout(r, 500));
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, stop());
      const results = await Promise.all([first, second]);
      for (const r of results) {
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
      }
      expect(results.map((r) => JSON.parse(r.stdout).event).sort()).toEqual(["stopped", "timeout"]);
    });

    it("ignores what the old pane reports after a hand-over", async () => {
      const w1 = await startClaude("w1");
      const next = await json(["start", "--name", "w1", "--handover", "--tool", "claude", "--", "claude:work"]);
      await json(["send", "--name", "w1", "--text", "Read .fleet-brief.md in this folder and do what it says."]);
      // Closing the old pane makes its Claude Code run SessionEnd.
      hook(w1, { hook_event_name: "SessionEnd", reason: "other" });
      expect((await json(["wait", "--name", "w1", "--timeout", "3"])).event).toBe("timeout");
      hook({ settings: w1.settings, pane: next.pane }, stop());
      expect((await json(["wait", "--name", "w1", "--timeout", "10"])).event).toBe("stopped");
    });

    it("ignores an idle notice that lands between a line and the turn it starts", async () => {
      const w1 = await startClaude("w1");
      await json(["send", "--name", "w1", "--text", "Read .fleet-brief.md in this folder and do what it says."]);
      hook(w1, notice("idle_prompt"));
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      expect((await json(["wait", "--name", "w1", "--timeout", "3"])).event).toBe("timeout");
    });

    it("reports a worker whose window is gone", async () => {
      const { window } = await startClaude("w1");
      tmx("kill-window", "-t", window);
      expect(await json(["wait", "--name", "w1", "--timeout", "10"])).toMatchObject({ event: "gone", name: "w1" });
    });

    it("returns for whichever of several workers needs attention", async () => {
      await startClaude("w1");
      const second = await startClaude("w2");
      hook(second, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(second, stop());
      expect(await json(["wait", "--name", "w1", "--name", "w2", "--timeout", "10"])).toMatchObject({
        event: "stopped",
        name: "w2",
      });
    });
  });

  describe("send and read", () => {
    it("types the line, then presses Enter after it", async () => {
      await startClaude("w1");
      const line = "Read .fleet-brief.md in this folder and do what it says.";
      expect(await json(["send", "--name", "w1", "--text", line])).toMatchObject({ name: "w1", sent: "text" });
      // The terminal echoes the typed line, and cat prints it again only once Enter arrives.
      await until(() => {
        const screen = execFileSync(process.execPath, [SCRIPT, "read", "--name", "w1"], { env, encoding: "utf8" });
        return screen.split(line).length - 1 >= 2 ? true : undefined;
      }, "the echoed line");
    });

    it("keeps a semicolon at the end of a line and of a label", async () => {
      const wt = addWorktree("w1");
      const started = await json([
        "start",
        "--name",
        "w1",
        "--label",
        "semi;",
        "--worktree",
        wt,
        "--tool",
        "claude",
        "--",
        "claude:work",
      ]);
      expect(tmx("display", "-p", "-t", started.window, "#{window_name}")).toBe("semi;");
      const line = "run tests; fix it;";
      await json(["send", "--name", "w1", "--text", line]);
      await until(() => {
        const screen = execFileSync(process.execPath, [SCRIPT, "read", "--name", "w1"], { env, encoding: "utf8" });
        return screen.split(line).length - 1 >= 2 ? true : undefined;
      }, "the echoed line");
    });

    it("refuses text once the worker's session has ended", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
      const r = await run(["send", "--name", "w1", "--text", "hello"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/ended/);
    });

    it("refuses a line that starts with a dash", async () => {
      await startClaude("w1");
      // parseArgs turns down `--text -p…` and points to this form.
      const r = await run(["send", "--name", "w1", "--text=-p hello"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/word/);
    });

    it("refuses text while the worker waits at a permission prompt, but sends keys", async () => {
      const w1 = await startClaude("w1");
      hook(w1, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      hook(w1, notice("permission_prompt"));
      const r = await run(["send", "--name", "w1", "--text", "yes do it"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/permission prompt/);
      expect(await json(["send", "--name", "w1", "--keys", "Escape"])).toMatchObject({ sent: "keys" });
    });
  });

  describe("retire", () => {
    it("keeps a worker whose worktree has an untracked file", async () => {
      const { wt } = await startClaude("w1");
      commit(wt, "a.txt");
      git(wt, "push", "-q", "-u", "origin", "HEAD");
      writeFileSync(path.join(wt, "notes.txt"), "draft\n");
      const r = await run(["retire", "--name", "w1"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/kept/);
      expect(existsSync(wt)).toBe(true);
      expect(fleetWindows()).toEqual(["w1"]);
    });

    it("keeps a worker whose branch has a commit that is not pushed", async () => {
      const { wt } = await startClaude("w1");
      commit(wt, "a.txt");
      git(wt, "push", "-q", "-u", "origin", "HEAD");
      commit(wt, "b.txt");
      const r = await run(["retire", "--name", "w1"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not pushed/);
      expect(existsSync(wt)).toBe(true);
      expect(fleetWindows()).toEqual(["w1"]);
    });

    it("keeps a worker whose branch was never pushed", async () => {
      const { wt } = await startClaude("w1");
      commit(wt, "a.txt");
      const r = await run(["retire", "--name", "w1"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/never pushed/);
      expect(existsSync(wt)).toBe(true);
    });

    it("removes a clean, pushed worker's worktree and window, and keeps its branch", async () => {
      const w1 = await startClaude("w1");
      const { wt } = w1;
      hook(w1, stop());
      commit(wt, "a.txt");
      git(wt, "push", "-q", "-u", "origin", "HEAD");
      expect(await json(["retire", "--name", "w1"])).toMatchObject({
        name: "w1",
        worktree: wt,
        branch: "fleet/w1",
        removed: true,
      });
      expect(existsSync(wt)).toBe(false);
      expect(fleetWindows()).toEqual([]);
      expect(git(repo, "branch", "--list", "fleet/w1")).toContain("fleet/w1");
    });
  });

  it("records nothing and never fails when a hook gets something it cannot read", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "record", "--worktree", path.join(dir, "missing"), "--source", "claude"],
      {
        input: "not json",
        env,
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});
