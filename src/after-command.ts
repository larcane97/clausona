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
  checkLatestTag,
  currentInstallTarget,
  performUpdate,
  recordLatestTag,
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

/** A question nobody answers in this long is a no: a shell function or script run from a terminal waits on it. */
const ANSWER_MS = 10_000;
/** The check made on a yes, which someone is waiting on: as long as `clausona update` gives it. */
const YES_CHECK_TIMEOUT_MS = 15_000;

/** Ctrl+C and Ctrl+D: raw mode hands them over as input, where they would otherwise stop the program. */
const INTERRUPTS = ["\u0003", "\u0004"];

/**
 * The first key pressed once `graceMs` has passed since the question appeared, or null when the
 * input ends or `timeoutMs` passes first. One key answers: the terminal is in raw mode while it
 * waits, and back as it was on every way out. Keys typed before the question, waiting in stdin,
 * arrive at once and are dropped with whatever else comes in the grace: they were meant for what
 * was there before. Ctrl+C and Ctrl+D are not dropped: they answer at once, whenever they come.
 */
export function readKey(
  input: KeyInput,
  options: { graceMs: number; timeoutMs: number; now: () => number },
): Promise<string | null> {
  return new Promise((resolve) => {
    const shownAt = options.now();
    const wasRaw = input.isRaw === true;
    let settled = false;
    const finish = (key: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      const text = String(chunk);
      const interrupt = INTERRUPTS.find((key) => text.includes(key));
      if (interrupt) {
        finish(interrupt);
        return;
      }
      if (options.now() - shownAt < options.graceMs) return;
      // An escape sequence - an arrow, say - is one key; anything else, its first character.
      finish(text.startsWith(ESC) ? text : text.slice(0, 1));
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), options.timeoutMs);
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

/**
 * What the questions need from outside. `target` and `input` are looked up only when a question is
 * shown: most runs show none, and need neither the installed copy found nor stdin opened.
 */
export type AfterCommandDeps = {
  notices: NoticesDeps;
  current: string;
  /** The installed bundle to replace, or `null` when the installer did not put this one there. */
  target: () => string | null;
  platform: NodeJS.Platform;
  input: () => KeyInput;
  output: Writer;
  errors: Writer;
  graceMs: number;
  /** How long a question waits for an answer before it counts as a no. */
  answerMs: number;
  /** Starts the day's check in the background, without waiting for it. */
  startCheck: () => void;
  /** The latest release's tag, asked again on a yes; null when GitHub cannot be reached. */
  checkLatest: () => Promise<string | null>;
  install: (tag: string, target: string) => Promise<void>;
  give: () => Promise<StarOutcome>;
  /** Whether the command's output ends with a blank line of its own, as `csn list`'s does. */
  separated?: boolean;
};

export function defaultAfterCommandDeps(): AfterCommandDeps {
  return {
    notices: defaultNoticesDeps(),
    current: __CLAUSONA_VERSION__,
    target: currentInstallTarget,
    platform: process.platform,
    input: () => process.stdin,
    output: process.stdout,
    errors: process.stderr,
    graceMs: STAR_POPUP_GRACE_MS,
    answerMs: ANSWER_MS,
    startCheck: () => startUpdateCheck(),
    checkLatest: () => checkLatestTag({ timeoutMs: YES_CHECK_TIMEOUT_MS }),
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
    const now = deps.notices.now();
    const notices = (await readNotices(deps.notices.path)) ?? (await startOver(deps.notices, now));
    if (!notices) return;
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

/**
 * A record that cannot be read, replaced by a new one, or null when it cannot be. What it held is
 * lost, whether the star was asked among it, so the new one says it was: asked twice is worse than
 * never. Left as it was, it kept every command from asking anything again.
 */
async function startOver(deps: NoticesDeps, now: number): Promise<Notices | null> {
  const fresh: Notices = { starAsked: true, firstUsedAt: new Date(now).toISOString() };
  // `fresh` itself reaches the change only while the file still cannot be read; a record another
  // process wrote meanwhile is kept.
  await changeNotices(deps.path, (current) => (current === fresh ? fresh : null), { unreadable: fresh });
  return readNotices(deps.path);
}

/** Yes to the update; every other key is a no, so a command typed into the question never installs. */
const YES = new Set(["y", "Y", "\r", "\n"]);

/** One blank line between the command's output and what follows it. */
function gap(deps: AfterCommandDeps): string {
  return deps.separated ? "" : "\n";
}

async function offerUpdate(tag: string, deps: AfterCommandDeps): Promise<void> {
  const latest = `v${versionOfTag(tag)}`;
  const { output } = deps;
  const available = `${gap(deps)}  ${accent("⬆")} ${dim("clausona")} ${accent(latest)} ${dim("is available (you have")} ${accent(`v${deps.current}`)}${dim(")")}\n`;
  // A copy the installer did not put in place cannot replace itself: what to run instead, held as a no
  // is. The command has a line of its own, to copy whole.
  const target = deps.target();
  if (!target) {
    output.write(`${available}    ${dim("To update, run:")}\n    ${accent(reinstallCommand(deps.platform))}\n`);
    await skipUpdate(deps.notices);
    return;
  }

  output.write(`${available}  ${dim("Update now? (Y/n)")} `);
  const key = await readKey(deps.input(), { graceMs: deps.graceMs, timeoutMs: deps.answerMs, now: deps.notices.now });
  const yes = key !== null && YES.has(key);
  output.write(`${yes ? "y" : "n"}\n`);
  if (!yes) {
    await skipUpdate(deps.notices);
    output.write(`${dim(`    Skipped. Run ${accent("clausona update")} when you're ready.`)}\n`);
    return;
  }

  // `clausona update --yes`. It asks GitHub again, since what the last check learned can be a day
  // old, and installs the offered release only when GitHub cannot be reached.
  try {
    const result = await runUpdateCommand(["--yes"], {
      current: deps.current,
      target,
      platform: deps.platform,
      interactive: true,
      checkLatest: async () => {
        const latestTag = await deps.checkLatest();
        if (latestTag) await recordLatestTag(deps.notices, latestTag);
        return latestTag ?? tag;
      },
      confirm: async () => true,
      install: deps.install,
      skip: async () => {},
    });
    output.write(`${result}\n`);
  } catch (error) {
    // Asked again on every command, a failure that lasts - an install directory clausona cannot
    // write - would fail on every command. It is held as a no is.
    await skipUpdate(deps.notices);
    deps.errors.write(
      `  ${fail} ${error instanceof Error ? error.message : String(error)}\n` +
        `${dim(`    Run ${accent("clausona update")} to try again.`)}\n`,
    );
  }
}

/** Claimed before it is shown, so it is asked once whatever happens to the answer. Only y stars. */
async function askForStar(deps: AfterCommandDeps): Promise<void> {
  const { output } = deps;
  output.write(
    `${gap(deps)}  ${accent("★")} ${dim("Was clausona helpful? A star on GitHub helps others find it.")}\n` +
      `  ${dim("Star it now? (y/N)")} `,
  );
  const key = await readKey(deps.input(), { graceMs: deps.graceMs, timeoutMs: deps.answerMs, now: deps.notices.now });
  const yes = key === "y" || key === "Y";
  output.write(`${yes ? "y" : "n"}\n`);
  if (!yes) return;
  output.write(`${await runStarCommand([], { give: deps.give, record: () => recordStarAsked(deps.notices) })}\n`);
}
