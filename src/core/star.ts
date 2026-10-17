/**
 * A star for clausona on GitHub: the one-time question, and the star itself.
 *
 * The question is asked once, three days after clausona was first used - the dashboard opened, or
 * a command run in a terminal - so it reaches people who have used clausona for a while. The
 * dashboard and the shell (after-command.ts) share whether it has been asked, in
 * ~/.clausona/notices.json: asked in one, it is never asked in the other. The star is given only
 * when the user asks for it: through gh when it is signed in, and otherwise by opening the
 * repository's page, where the user presses Star themselves.
 */

import {
  changeNotices,
  defaultNoticesDeps,
  type Notices,
  type NoticesDeps,
  onCi,
  readNotices,
  timeIn,
} from "./notices.js";
import { spawnCommand } from "./process.js";

export const STAR_REPO = "larcane97/clausona";
export const STAR_URL = `https://github.com/${STAR_REPO}`;

/**
 * How long a question is on screen before it takes an answer: keys typed a moment after it
 * appears were meant for what was there before. The dashboard's popup and the shell's questions
 * both wait this long.
 */
export const STAR_POPUP_GRACE_MS = 700;

const ASK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 5_000;

// ─── The one-time question ───────────────────────────────────────────

/**
 * The first day of use, or NaN before one is noted. A clausona that asked only on the dashboard
 * noted it as `firstDashboardAt`; the earlier of the two counts.
 */
function firstUse(notices: Notices): number {
  const days = [timeIn(notices, "firstUsedAt"), timeIn(notices, "firstDashboardAt")].filter((t) => !Number.isNaN(t));
  return days.length === 0 ? Number.NaN : Math.min(...days);
}

/** `notices` with `now` noted as the first day of use, unless one is noted already. */
export function withFirstUse(notices: Notices, now: number): Notices {
  return Number.isNaN(firstUse(notices)) ? { ...notices, firstUsedAt: new Date(now).toISOString() } : notices;
}

/**
 * Whether to ask for a star now: true once, ever. The first call notes the day; the first call
 * three days or more after it records the asking and answers true, so a question left unanswered
 * - the dashboard closed, the terminal shut - is not asked again. Anything that stops the record
 * from being read or written answers false, so the question is never asked twice.
 */
export async function claimStarPrompt(deps: NoticesDeps = defaultNoticesDeps()): Promise<boolean> {
  if (onCi(deps.env)) return false;
  const now = deps.now();
  /** What to write now, if anything: the first day, or the asking. */
  const next = (notices: Notices): Notices | null => {
    if (notices.starAsked === true) return null;
    if (Number.isNaN(firstUse(notices))) return withFirstUse(notices, now);
    return now - firstUse(notices) < ASK_AFTER_MS ? null : { ...notices, starAsked: true };
  };
  // Read without the lock first: most runs have nothing to write, and take none.
  const seen = await readNotices(deps.path);
  if (!seen || !next(seen)) return false;
  let asking = false;
  const written = await changeNotices(deps.path, (notices) => {
    const changed = next(notices);
    asking = changed?.starAsked === true;
    return changed;
  });
  return asking && written;
}

/**
 * Notes that the user has been to the star already, so neither the dashboard nor the shell asks.
 * Only the question's record: a star given without it is still given, so it never throws.
 */
export async function recordStarAsked(deps: NoticesDeps = defaultNoticesDeps()): Promise<void> {
  await changeNotices(deps.path, (notices) => (notices.starAsked === true ? null : { ...notices, starAsked: true }), {
    unreadable: {},
  });
}

// ─── The star ────────────────────────────────────────────────────────

export type RunOptions = {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Whether its output is read. A browser opener's is not: see `runCommand`. */
  output: boolean;
  signal?: AbortSignal;
};

/**
 * How a command ended: its exit code and output, with code null when it ran out of time; null
 * when it could not be started or was called off.
 */
export type RunCommand = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<{ code: number | null; stdout: string } | null>;

export type StarDeps = { run: RunCommand; platform: NodeJS.Platform; env: NodeJS.ProcessEnv };

export type StarOutcome =
  | { kind: "starred"; login: string | null }
  | { kind: "opened"; url: string }
  | { kind: "manual"; url: string };

/**
 * Runs a command with nothing reaching the terminal, which the TUI is drawn on. A command whose
 * output is not read gets none to hold: xdg-open can hand its stdout to the browser it starts, and
 * a pipe held open by the browser kept clausona from exiting until the browser closed. One still
 * running when its time is up is killed when its output is read (gh); an opener is left to run,
 * since it can be waiting on the browser, and unreferenced so clausona can exit without it.
 */
export const runCommand: RunCommand = (command, args, { env, timeoutMs, output, signal }) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    let stdout = "";
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, args, {
        env,
        stdio: ["ignore", output ? "pipe" : "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const settle = (result: { code: number | null; stdout: string } | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      child.kill();
      settle(null);
    };
    const timer = setTimeout(() => {
      if (output) child.kill();
      child.stdout?.destroy();
      child.unref();
      settle({ code: null, stdout });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle({ code, stdout }));
  });

function defaultStarDeps(): StarDeps {
  return { run: runCommand, platform: process.platform, env: process.env };
}

/**
 * The command that opens `url` in the user's browser, or null where none would open one they can
 * see: over SSH it opens on the far machine, and on Linux with no display xdg-open falls back to a
 * text browser, which would draw over the TUI.
 */
function browserCommand(url: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is a cmd builtin that reads `&` in a URL as its own; this hands the URL over whole.
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return { command: "xdg-open", args: [url] };
  return null;
}

/**
 * Stars clausona as the account gh is signed in to on github.com. Without gh, or signed out, it
 * opens the repository's page instead, and where no browser can be opened it gives the address.
 * Called off through `signal` - the TUI quit while it ran - it stops, and never opens a browser.
 */
export async function giveStar(deps: StarDeps = defaultStarDeps(), signal?: AbortSignal): Promise<StarOutcome> {
  const ghOptions = {
    env: { ...deps.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    timeoutMs: GH_TIMEOUT_MS,
    output: true,
    signal,
  };
  const gh = ["api", "--hostname", "github.com"];
  const put = await deps.run("gh", [...gh, "--method", "PUT", `/user/starred/${STAR_REPO}`, "--silent"], ghOptions);
  if (put?.code === 0) {
    const user = await deps.run("gh", [...gh, "user", "--jq", ".login"], ghOptions);
    const login = user?.code === 0 ? user.stdout.trim() : "";
    return { kind: "starred", login: login === "" ? null : login };
  }

  const browser = signal?.aborted ? null : browserCommand(STAR_URL, deps.platform, deps.env);
  if (browser) {
    const opened = await deps.run(browser.command, browser.args, {
      env: deps.env,
      timeoutMs: OPEN_TIMEOUT_MS,
      output: false,
      signal,
    });
    // Still running when its time is up: xdg-open can wait on the browser it started.
    if (opened && (opened.code === 0 || opened.code === null)) return { kind: "opened", url: STAR_URL };
  }
  return { kind: "manual", url: STAR_URL };
}
