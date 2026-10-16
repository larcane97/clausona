#!/usr/bin/env node
// Runs the tmux-fleet skill's workers in tmux windows. tmux cannot tell what an agent in a pane is
// doing, so each worker reports it: a Claude Code worker through hooks given with --settings, a
// Codex worker by ringing the terminal bell, which a hook on its window records. Both append to
// .fleet-events.jsonl in the worker's worktree, and `wait` reads that file.
// Every command prints JSON on stdout, except `read`, which prints the screen. Errors go to
// stderr, with exit status 1.
import { execFileSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `usage: tmux-fleet.mjs <command>
  status
  start --name <name> --label <label> --worktree <path> --tool claude|codex -- <profile> [tool args...]
  start --name <name> --handover [--label <label>] --tool claude|codex -- <profile> [tool args...]
  send --name <name> (--text <line> | --keys <key>...)
  read --name <name> [--lines <n>]
  wait --name <name> [--name <name>...] [--timeout <s>] [--quiet <s>]
  retire --name <name>
  record --worktree <path> --source claude|bell`;

class CliError extends Error {}

const HELPER = fileURLToPath(import.meta.url);
const EVENTS = ".fleet-events.jsonl";
const WAITED = ".fleet-wait.json";
const SETTINGS = ".fleet-claude.json";
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const CLAUDE_HOOKS = ["UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"];
const CODEX_ARGS = [
  "-c",
  "tui.notifications=true",
  "-c",
  "tui.notification_method=bel",
  "-c",
  "tui.notification_condition=always",
];
// Events that need the main session's attention.
const WAKE = new Set(["stopped", "failed", "blocked", "ended", "bell"]);
// Events after which a worker should be working, so a long silence means something is wrong.
const WORKING = new Set(["sent", "working"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmux(args) {
  try {
    // -u: without a UTF-8 locale, tmux prints every non-ASCII character as "_", which would
    // garble labels and worktree paths read back from it.
    return execFileSync("tmux", ["-u", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(
      /\n$/,
      "",
    );
  } catch (err) {
    throw new CliError(`tmux ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** One word for the shell the worker's pane runs: sh, bash, zsh or fish. */
function shellWord(arg) {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function positiveNumber(text, flag) {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${flag} must be a positive number`);
  return n;
}

function findOnPath(command) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, command);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

function requireTmux() {
  if (!process.env.TMUX) {
    throw new CliError(
      "not inside tmux (TMUX is unset): start this session in a tmux pane. In Codex, a [shell_environment_policy] " +
        'with inherit = "core" or "none" hides TMUX too: start Codex again with -c shell_environment_policy.inherit=all',
    );
  }
}

/** The pane this session runs in, as a -t target, or nothing for tmux's own idea of "current". */
function here() {
  return process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
}

function workers() {
  const format = ["#{window_id}", "#{@fleet-name}", "#{@fleet-pane}", "#{@fleet-worktree}", "#{@fleet-tool}"];
  return tmux(["list-windows", "-a", "-F", `${format.join("\t")}\t#{window_activity}`])
    .split("\n")
    .map((line) => {
      const [window, name, pane, worktree, tool, activity] = line.split("\t");
      return { window, name, pane, worktree, tool, activity: Number(activity) };
    })
    .filter((w) => w.name);
}

function worker(name) {
  const found = workers().find((w) => w.name === name);
  if (!found) throw new CliError(`no tmux-fleet worker named ${name}`);
  return found;
}

function livePanes() {
  const live = new Set();
  for (const line of tmux(["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"]).split("\n")) {
    const [id, dead] = line.split(" ");
    if (dead === "0") live.add(id);
  }
  return live;
}

// The event log holds one JSON object per line. A hook may still be writing the last line, so
// only lines that end in a newline count.
function readEvents(worktree) {
  let text;
  try {
    text = readFileSync(path.join(worktree, EVENTS), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  lines.pop();
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { event: "unreadable" };
    }
  });
}

function appendEvent(worktree, event, message) {
  const line = { at: Date.now(), event };
  if (message !== undefined && message !== null && message !== "") {
    line.message = (typeof message === "string" ? message : JSON.stringify(message)).slice(0, 4000);
  }
  appendFileSync(path.join(worktree, EVENTS), `${JSON.stringify(line)}\n`);
}

/** What the worker is doing after `events`: the last event, skipping an idle notice that adds nothing. */
function stateOf(events) {
  let state;
  for (const { event } of events) {
    if (event === "unreadable") continue;
    if (event === "idle" && !(state === "blocked" || WORKING.has(state))) continue;
    state = event;
  }
  return state;
}

// Claude Code sends its idle notice a minute after every turn. It matters only when the turn did
// not end with an event of its own: a permission prompt the user turned down with Esc, or a line
// the worker never took up.
function isWake(events, i) {
  const { event } = events[i];
  if (WAKE.has(event)) return true;
  if (event !== "idle") return false;
  const before = stateOf(events.slice(0, i));
  return before === "blocked" || WORKING.has(before);
}

function readWaited(worktree) {
  try {
    const saved = JSON.parse(readFileSync(path.join(worktree, WAITED), "utf8"));
    return { delivered: Number(saved.delivered) || 0, quietAt: Number(saved.quietAt) || 0 };
  } catch {
    return { delivered: 0, quietAt: 0 };
  }
}

function writeWaited(worktree, waited) {
  writeFileSync(path.join(worktree, WAITED), `${JSON.stringify(waited)}\n`);
}

function hasWake(worktree) {
  const events = readEvents(worktree);
  const { delivered } = readWaited(worktree);
  for (let i = delivered; i < events.length; i++) if (isWake(events, i)) return true;
  return false;
}

function status() {
  const version = tmux(["-V"]);
  const m = /(\d+)\.(\d+)/.exec(version);
  if (m && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 2))) {
    throw new CliError(`${version} is too old: tmux-fleet needs tmux 3.2 or newer`);
  }
  const session = tmux(["display-message", "-p", ...here(), "#{session_name}"]);
  const local = tmux(["show-options", "-v", "-t", session, "bell-action"]);
  const bellAction = local || tmux(["show-options", "-gv", "bell-action"]);
  const clausona = findOnPath("clausona");
  if (!clausona) throw new CliError("clausona is not on PATH: install it first");
  const warnings = [];
  if (bellAction === "none") {
    warnings.push(
      "bell-action is none, so tmux runs no bell hook and a Codex worker is noticed only when it has been quiet for --quiet seconds",
    );
  }
  return { ok: true, tmux: version.replace(/^tmux /, ""), session, bellAction, clausona, warnings };
}

function excludeFleetFiles(worktree) {
  const common = path.resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"]));
  const file = path.join(common, "info", "exclude");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // no exclude file yet
  }
  if (text.split(/\r?\n/).includes("/.fleet-*")) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/.fleet-*\n`);
}

function recordCommand(worktree, source, quote) {
  return [process.execPath, HELPER, "record", "--worktree", worktree, "--source", source].map(quote).join(" ");
}

// Claude Code runs every hook of every settings source, so these come on top of the shared
// settings.json and leave it untouched.
function writeClaudeSettings(worktree) {
  const entry = [{ hooks: [{ type: "command", command: recordCommand(worktree, "claude", shellWord) }] }];
  const file = path.join(worktree, SETTINGS);
  writeFileSync(
    file,
    `${JSON.stringify({ hooks: Object.fromEntries(CLAUDE_HOOKS.map((e) => [e, entry])) }, null, 2)}\n`,
  );
  return file;
}

// The hook is a tmux command, so the shell command goes in tmux single quotes, where nothing is
// expanded, and each path in shell double quotes. run-shell expands #{...} formats, so a literal
// # is doubled.
function bellHook(worktree) {
  const dq = (s) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;
  const command = recordCommand(worktree, "bell", dq);
  if (command.includes("'"))
    throw new CliError(`a path holds a single quote, which a tmux hook cannot carry: ${command}`);
  return `run-shell -b '${command.replaceAll("#", "##")}'`;
}

function setWindow(window, values) {
  for (const [key, value] of Object.entries(values)) tmux(["set-option", "-w", "-t", window, key, value]);
}

function start(v, rest) {
  if (!NAME.test(v.name ?? "")) {
    throw new CliError(
      "--name must be lowercase letters, digits, - or _, start with a letter, and be 32 characters at most",
    );
  }
  if (v.tool !== "claude" && v.tool !== "codex") throw new CliError("--tool must be claude or codex");
  const [profile, ...toolArgs] = rest;
  if (!profile) throw new CliError(`give the profile after --\n${USAGE}`);
  const existing = workers().find((w) => w.name === v.name);
  let worktree;
  if (v.handover) {
    if (!existing) throw new CliError(`no tmux-fleet worker named ${v.name} to hand over from`);
    worktree = existing.worktree;
  } else {
    if (existing) throw new CliError(`a worker named ${v.name} already exists, in window ${existing.window}`);
    if (v.worktree === undefined || v.label === undefined) throw new CliError("start needs --worktree and --label");
    worktree = realpathSync(v.worktree);
  }
  if (git(worktree, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    throw new CliError(`${worktree} is not a git worktree`);
  excludeFleetFiles(worktree);

  const args = ["run", profile, "--", ...toolArgs];
  if (v.tool === "claude") args.push("--settings", writeClaudeSettings(worktree));
  else args.push(...CODEX_ARGS);

  let window;
  let pane;
  if (existing) {
    window = existing.window;
    pane = tmux(["split-window", "-d", "-v", "-t", existing.pane, "-c", worktree, "-P", "-F", "#{pane_id}"]);
    if (v.label !== undefined) tmux(["rename-window", "-t", window, v.label]);
  } else {
    const session = tmux(["display-message", "-p", ...here(), "#{session_id}"]);
    // -n also turns automatic-rename off, so the label stays while the agent sets its titles.
    [window, pane] = tmux([
      "new-window",
      "-d",
      "-t",
      `${session}:`,
      "-n",
      v.label,
      "-c",
      worktree,
      "-P",
      "-F",
      "#{window_id} #{pane_id}",
    ]).split(" ");
  }
  setWindow(window, { "@fleet-name": v.name, "@fleet-worktree": worktree, "@fleet-pane": pane, "@fleet-tool": v.tool });
  if (v.tool === "codex") {
    setWindow(window, { "monitor-bell": "on" });
    tmux(["set-hook", "-w", "-t", window, "alert-bell", bellHook(worktree)]);
  } else if (existing) {
    tmux(["set-hook", "-uw", "-t", window, "alert-bell"]);
  }

  // Typed into the window's shell, as a person would: tmux holds the keys until the shell reads
  // them, so a slow shell start-up does not swallow the line.
  const command = ["clausona", ...args].map(shellWord).join(" ");
  tmux(["send-keys", "-t", pane, "-l", command]);
  tmux(["send-keys", "-t", pane, "Enter"]);
  return {
    name: v.name,
    window,
    pane,
    worktree,
    tool: v.tool,
    command,
    ...(existing ? { replaces: existing.pane } : {}),
  };
}

async function send(v, keys) {
  const w = worker(v.name);
  if (v.text !== undefined && v.keys) throw new CliError("pass --text or --keys, not both");
  if (v.keys) {
    if (keys.length === 0) throw new CliError("give the keys after --keys, for example: --keys Down Enter");
    tmux(["send-keys", "-t", w.pane, ...keys]);
    return { name: w.name, pane: w.pane, sent: "keys" };
  }
  if (v.text === undefined) throw new CliError("pass --text or --keys");
  if (keys.length > 0) throw new CliError("send --text takes one line; quote it");
  if (v.text.startsWith("-")) throw new CliError('the line starts with "-": start it with a word');
  if (/[\r\n]/.test(v.text))
    throw new CliError("the line holds a line break: send one line, and put the rest in a file");
  // Typed into a permission prompt, a line's letters and digits would answer it.
  if (stateOf(readEvents(w.worktree)) === "blocked") {
    throw new CliError(
      `${w.name} waits at a permission prompt or a question: read its screen first. Leave a permission prompt to the user, and answer a question with --keys`,
    );
  }
  appendEvent(w.worktree, "sent");
  tmux(["send-keys", "-t", w.pane, "-l", v.text]);
  // Codex takes text followed at once by Enter as a paste and keeps the Enter in its composer.
  await sleep(1000);
  tmux(["send-keys", "-t", w.pane, "Enter"]);
  return { name: w.name, pane: w.pane, sent: "text" };
}

function read(v) {
  const w = worker(v.name);
  const lines = Math.floor(positiveNumber(v.lines ?? "120", "--lines"));
  const screen = tmux(["capture-pane", "-p", "-J", "-t", w.pane, "-S", `-${lines}`]).replace(/\s+$/, "");
  return `${screen.split("\n").slice(-lines).join("\n")}\n`;
}

async function wait(names, { timeout, quiet }) {
  const started = Date.now();
  for (;;) {
    const all = workers();
    const live = livePanes();
    for (const name of names) {
      const w = all.find((x) => x.name === name);
      if (!w || !live.has(w.pane)) return { event: "gone", name };
      if (hasWake(w.worktree)) {
        // A turn often ends with a few events at once (Codex's bell and its final redraw, a
        // prompt answered just before the stop): let them land, and report them as one.
        await sleep(1500);
        const events = readEvents(w.worktree);
        const waited = readWaited(w.worktree);
        let last;
        for (let i = waited.delivered; i < events.length; i++) if (isWake(events, i)) last = events[i];
        writeWaited(w.worktree, { ...waited, delivered: events.length });
        return {
          event: last.event,
          name,
          at: new Date(last.at).toISOString(),
          ...(last.message ? { message: last.message } : {}),
        };
      }
      // A worker that should be working but has printed nothing for `quiet` seconds may sit at a
      // prompt no event reported. Its spinner and timer redraw every second while it works.
      if (WORKING.has(stateOf(readEvents(w.worktree)))) {
        const silent = Date.now() / 1000 - w.activity;
        const waited = readWaited(w.worktree);
        if (w.activity > 0 && silent >= quiet && waited.quietAt !== w.activity) {
          writeWaited(w.worktree, { ...waited, quietAt: w.activity });
          return { event: "quiet", name, silentSeconds: Math.floor(silent) };
        }
      }
    }
    if (Date.now() - started >= timeout * 1000) return { event: "timeout", names };
    await sleep(1000);
  }
}

function retire(v) {
  const w = worker(v.name);
  const wt = w.worktree;
  const keep = (why) => new CliError(`${w.name} is kept: ${why}`);
  const changes = git(wt, ["status", "--porcelain"]);
  if (changes) throw keep(`its worktree has changes:\n${changes}`);
  let upstream;
  try {
    upstream = git(wt, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    throw keep("its branch was never pushed: it has no upstream");
  }
  const ahead = git(wt, ["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead !== "0") throw keep(`${ahead} commit(s) are not pushed to ${upstream}`);
  const branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const common = path.resolve(wt, git(wt, ["rev-parse", "--git-common-dir"]));
  // Never --force: git refuses a worktree that holds changes, the last guard for the work.
  try {
    execFileSync("git", [`--git-dir=${common}`, "worktree", "remove", wt], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw keep(`git worktree remove refused: ${String(err.stderr || err.message).trim()}`);
  }
  if (existsSync(wt)) throw new CliError(`git removed the worktree, but ${wt} is still there`);
  if (tmux(["display-message", "-p", "-t", w.window, "#{@fleet-name}"]) === w.name)
    tmux(["kill-window", "-t", w.window]);
  return { name: w.name, worktree: wt, branch, removed: true };
}

function claudeEvent(hook) {
  switch (hook.hook_event_name) {
    case "UserPromptSubmit":
      return ["working"];
    case "Stop":
      return ["stopped", hook.last_assistant_message];
    case "StopFailure":
      return ["failed", hook.error ?? hook.error_details ?? hook.last_assistant_message];
    case "Notification":
      if (hook.notification_type === "permission_prompt" || hook.notification_type === "elicitation_dialog") {
        return ["blocked", hook.message];
      }
      return hook.notification_type === "idle_prompt" ? ["idle"] : undefined;
    case "SessionEnd":
      return ["ended", hook.reason];
    default:
      return undefined;
  }
}

// Run by the hooks. It must never fail or print: Claude Code shows a hook's errors to the
// worker, and the worker's own work matters more than this record.
function record(v) {
  try {
    if (!v.worktree || !existsSync(v.worktree)) return;
    if (v.source === "bell") {
      appendEvent(v.worktree, "bell");
    } else if (v.source === "claude") {
      const found = claudeEvent(JSON.parse(readFileSync(0, "utf8")));
      if (found) appendEvent(v.worktree, ...found);
    }
  } catch {
    // nothing to record
  }
}

const str = { type: "string" };
const COMMANDS = {
  status: { run: () => status() },
  start: {
    options: { name: str, label: str, worktree: str, tool: str, handover: { type: "boolean" } },
    passthrough: true,
    run: (v, _p, extra) => start(v, extra),
  },
  send: {
    options: { name: str, text: str, keys: { type: "boolean" } },
    required: ["name"],
    positionals: true,
    run: (v, keys) => send(v, keys),
  },
  read: { options: { name: str, lines: str }, required: ["name"], run: (v) => read(v), plain: true },
  wait: {
    options: { name: { type: "string", multiple: true }, timeout: str, quiet: str },
    required: ["name"],
    run: (v) =>
      wait(v.name, {
        timeout: positiveNumber(v.timeout ?? "1800", "--timeout"),
        quiet: positiveNumber(v.quiet ?? "180", "--quiet"),
      }),
  },
  retire: { options: { name: str }, required: ["name"], run: (v) => retire(v) },
  record: { options: { worktree: str, source: str }, run: (v) => record(v), silent: true },
};

async function main(argv) {
  const command = COMMANDS[argv[0]];
  if (!command) throw new CliError(USAGE);
  let rest = argv.slice(1);
  let extra = [];
  const dashdash = rest.indexOf("--");
  if (dashdash >= 0) {
    if (!command.passthrough) throw new CliError(`${argv[0]} takes nothing after --\n${USAGE}`);
    extra = rest.slice(dashdash + 1);
    rest = rest.slice(0, dashdash);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: command.options ?? {}, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError(`${err.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0 && !command.positionals) throw new CliError(`${argv[0]} takes no arguments\n${USAGE}`);
  for (const key of command.required ?? []) {
    if (values[key] === undefined) throw new CliError(`${argv[0]}: --${key} is required`);
  }
  // The hooks run `record` inside the worker, which needs no tmux of its own.
  if (!command.silent) requireTmux();
  return { result: await command.run(values, positionals, extra), command };
}

main(process.argv.slice(2)).then(
  ({ result, command }) => {
    if (command.silent) return;
    if (command.plain) process.stdout.write(result);
    else process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);
  },
  (err) => {
    const text = err instanceof CliError ? err.message : String(err?.stack ?? err);
    process.stderr.write(`tmux-fleet: ${text}\n`);
    process.exitCode = 1;
  },
);
