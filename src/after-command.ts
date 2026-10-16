/**
 * The one question a command may ask after its output: whether to update clausona, or, once ever,
 * whether to star it. Only after a command that worked, in a terminal someone can answer from, and
 * never more than one a run - the update first, the star on a later command.
 *
 * The update is offered from what the last check learned, kept in ~/.clausona/notices.json, so no
 * command waits on GitHub. Once a day a command starts the check in the background
 * (`clausona _update-check`, detached), and the commands after it offer what it found.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

import { runStarCommand, runUpdateCommand } from "./commands.js";
import {
  changeNotices,
  defaultNoticesDeps,
  type Notices,
  type NoticesDeps,
  onCi,
  readNotices,
} from "./core/notices.js";
import {
  claimStarPrompt,
  giveStar,
  recordStarAsked,
  STAR_POPUP_GRACE_MS,
  type StarOutcome,
  withFirstUse,
} from "./core/star.js";
import {
  cachedUpdateTag,
  currentInstallTarget,
  performUpdate,
  reinstallCommand,
  skipUpdate,
  updateCheckDue,
  versionOfTag,
} from "./core/update.js";
import { accent, dim, fail } from "./lib/cli-style.js";

/**
 * Commands nothing is asked after: help and the version, the ones that are already about
 * updating, starring or uninstalling, one whose output a shell reads, and those that start an
 * agent. `_`-prefixed commands are the hooks' and are never asked after either.
 */
const NEVER_AFTER = new Set([
  "help",
  "-h",
  "--help",
  "version",
  "-v",
  "--version",
  "update",
  "star",
  "uninstall",
  "shell-init",
  "run",
  "claude",
  "codex",
]);

/** Whether a command that has just finished may ask: see the top of this file. */
export function mayAsk(
  command: string,
  args: string[],
  context: { stdinTTY: boolean; stdoutTTY: boolean; env: NodeJS.ProcessEnv; exitCode?: number | string | null },
): boolean {
  if (command.startsWith("_") || NEVER_AFTER.has(command)) return false;
  if (args.some((arg) => arg === "--json" || arg === "--help" || arg === "-h")) return false;
  // Bare `route` is its help, or the TUI's Routes screen; `route help` is its help.
  if (command === "route" && (args[0] === undefined || args[0] === "help")) return false;
  if (Number(context.exitCode ?? 0) !== 0) return false;
  return context.stdinTTY && context.stdoutTTY && !onCi(context.env);
}

export type KeyInput = NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?(mode: boolean): unknown };
type Writer = { write(chunk: string): unknown };

const ESC = "\u001b";

/**
 * The first key `accept` takes, pressed once `graceMs` has passed since the question appeared, or
 * null when the input ends first. One key answers: the terminal is in raw mode while it waits, and
 * back as it was on every way out. Keys typed before the question, waiting in stdin, arrive at once
 * and are dropped with whatever else comes in the grace: they were meant for what was there before.
 */
export function readKey(
  input: KeyInput,
  options: { graceMs: number; now: () => number; accept: (key: string) => boolean },
): Promise<string | null> {
  return new Promise((resolve) => {
    const shownAt = options.now();
    const wasRaw = input.isRaw === true;
    let settled = false;
    const finish = (key: string | null) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // The terminal is gone.
      }
      input.pause();
      resolve(key);
    };
    const onData = (chunk: Buffer | string) => {
      if (options.now() - shownAt < options.graceMs) return;
      const text = String(chunk);
      // An escape sequence - an arrow, say - is one key; anything else, its first character.
      const key = text.startsWith(ESC) ? text : text.slice(0, 1);
      if (options.accept(key)) finish(key);
    };
    const onEnd = () => finish(null);
    try {
      input.setRawMode?.(true);
    } catch {
      // Then the key comes with an Enter after it, and the first character still answers.
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
    input.resume();
  });
}

export type AfterCommandDeps = {
  notices: NoticesDeps;
  current: string;
  /** The installed bundle to replace, or `null` when the installer did not put this one there. */
  target: string | null;
  platform: NodeJS.Platform;
  input: KeyInput;
  output: Writer;
  errors: Writer;
  graceMs: number;
  /** Starts the day's check in the background, without waiting for it. */
  startCheck: () => void;
  install: (tag: string, target: string) => Promise<void>;
  give: () => Promise<StarOutcome>;
  /** Whether the command's output ends with a blank line of its own, as `csn list`'s does. */
  separated?: boolean;
};

export function defaultAfterCommandDeps(): AfterCommandDeps {
  return {
    notices: defaultNoticesDeps(),
    current: __CLAUSONA_VERSION__,
    target: currentInstallTarget(),
    platform: process.platform,
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
    graceMs: STAR_POPUP_GRACE_MS,
    startCheck: () => startUpdateCheck(),
    install: (tag, target) => performUpdate({ tag, target }),
    give: () => giveStar(),
  };
}

type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => Pick<ChildProcess, "unref"> & { on(event: "error", listener: () => void): unknown };

/**
 * Starts `clausona _update-check` on its own: detached, with no terminal and nothing to say, and
 * not waited for, so the command that starts it exits as soon as it is done. Its answer is for the
 * commands after this one.
 */
export function startUpdateCheck(
  options: { spawn?: SpawnLike; execPath?: string; entry?: string | undefined } = {},
): void {
  const { spawn = nodeSpawn, execPath = process.execPath, entry = process.argv[1] } = options;
  if (!entry) return;
  try {
    const child = spawn(execPath, [entry, "_update-check"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Tomorrow's command tries again.
  }
}

/**
 * Asks the run's one question, if one is due. The day's check is started first, when due, and the
 * first day of use noted: the star counts from it. An update the last check found is offered
 * before the star is even claimed, so a run that offers it leaves the star for a later command.
 * Nothing here fails the command: every error ends it quietly.
 */
export async function askAfterCommand(deps: AfterCommandDeps = defaultAfterCommandDeps()): Promise<void> {
  try {
    const notices = await readNotices(deps.notices.path);
    if (!notices) return;
    const now = deps.notices.now();
    const note = (current: Notices) => {
      const due = updateCheckDue(current, now);
      return withFirstUse(due ? { ...current, updateCheckedAt: new Date(now).toISOString() } : current, now);
    };
    // Read once without the lock, which only a run with something to note takes.
    if (note(notices) !== notices) {
      let due = false;
      const noted = await changeNotices(deps.notices.path, (current) => {
        due = updateCheckDue(current, now);
        const next = note(current);
        return next === current ? null : next;
      });
      if (due && noted) deps.startCheck();
    }

    const tag = cachedUpdateTag(notices, deps.current, now);
    if (tag) {
      await offerUpdate(tag, deps);
      return;
    }
    if (await claimStarPrompt(deps.notices)) await askForStar(deps);
  } catch {
    // A question is never worth failing the command it follows.
  }
}

const UPDATE_KEYS = new Set(["y", "Y", "\r", "\n", "n", "N", "\u0003", "\u0004", ESC]);

/** One blank line between the command's output and what follows it. */
function gap(deps: AfterCommandDeps): string {
  return deps.separated ? "" : "\n";
}

async function offerUpdate(tag: string, deps: AfterCommandDeps): Promise<void> {
  const latest = `v${versionOfTag(tag)}`;
  const { output } = deps;
  // A copy the installer did not put in place cannot replace itself: what to run instead, held as a no is.
  if (!deps.target) {
    output.write(
      `${gap(deps)}  ${dim(`⬆ clausona ${latest} is available. To update, run: ${reinstallCommand(deps.platform)}`)}\n`,
    );
    await skipUpdate(deps.notices);
    return;
  }

  output.write(
    `${gap(deps)}  ${accent("⬆")} ${dim("clausona")} ${accent(latest)} ${dim("is available (you have")} ${accent(`v${deps.current}`)}${dim(")")}\n` +
      `  ${dim("Update now? (Y/n)")} `,
  );
  const key = await readKey(deps.input, {
    graceMs: deps.graceMs,
    now: deps.notices.now,
    accept: (k) => UPDATE_KEYS.has(k),
  });
  const yes = key !== null && "yY\r\n".includes(key);
  output.write(`${yes ? "y" : "n"}\n`);
  if (!yes) {
    await skipUpdate(deps.notices);
    output.write(`${dim(`    Skipped. Run ${accent("clausona update")} when you're ready.`)}\n`);
    return;
  }

  // `clausona update --yes`, for the release offered: the check it would make is the one just read.
  try {
    const result = await runUpdateCommand(["--yes"], {
      current: deps.current,
      target: deps.target,
      platform: deps.platform,
      interactive: true,
      checkLatest: async () => tag,
      confirm: async () => true,
      install: deps.install,
    });
    output.write(`${result}\n`);
  } catch (error) {
    deps.errors.write(`  ${fail} ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Claimed before it is shown, so it is asked once whatever happens to the answer. Only y stars. */
async function askForStar(deps: AfterCommandDeps): Promise<void> {
  const { output } = deps;
  output.write(
    `${gap(deps)}  ${accent("★")} ${dim("Was clausona helpful? A star on GitHub helps others find it.")}\n` +
      `  ${dim("Star it now? (y/N)")} `,
  );
  const key = await readKey(deps.input, { graceMs: deps.graceMs, now: deps.notices.now, accept: () => true });
  const yes = key === "y" || key === "Y";
  output.write(`${yes ? "y" : "n"}\n`);
  if (!yes) return;
  output.write(`${await runStarCommand([], { give: deps.give, record: () => recordStarAsked(deps.notices) })}\n`);
}
