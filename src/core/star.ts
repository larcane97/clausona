/**
 * A star for clausona on GitHub: the dashboard's one-time question, and the star itself.
 *
 * The question is asked once, three days after the dashboard first opened, so it reaches people
 * who have used clausona for a while. Whether it has been asked lives in ~/.clausona/notices.json.
 * The star is given only when the user asks for it: through gh when it is signed in, and
 * otherwise by opening the repository's page, where the user presses Star themselves.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { spawnCommand } from "./process.js";

export const STAR_REPO = "larcane97/clausona";
export const STAR_URL = `https://github.com/${STAR_REPO}`;

const ASK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 5_000;

// ─── The one-time question ───────────────────────────────────────────

export type NoticesDeps = { path: string; now: () => number; env: NodeJS.ProcessEnv };

type Notices = Record<string, unknown> & { firstDashboardAt?: unknown; starAsked?: unknown };

export function noticesPath(clausonaDir: string = path.join(homedir(), ".clausona")): string {
  return path.join(clausonaDir, "notices.json");
}

function defaultNoticesDeps(): NoticesDeps {
  return { path: noticesPath(), now: Date.now, env: process.env };
}

/** The record, `{}` when there is none yet, or null when the file is there but cannot be read as one. */
async function readNotices(filePath: string): Promise<Notices | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Notices) : null;
  } catch {
    return null;
  }
}

/** Written aside and renamed into place, so a reader never sees half a file. */
async function writeNotices(filePath: string, notices: Notices): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(notices, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** CI as most runners set it; `false` and `0` are how a user says it is not. */
function onCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

/**
 * Whether the dashboard should ask for a star now: true once, ever. The first call notes the
 * day; the first call three days or more after it records the asking and answers true, so a
 * dashboard closed with the question open is not asked again. Anything that stops the record
 * from being read or written answers false, so the question is never asked twice.
 */
export async function claimStarPrompt(deps: NoticesDeps = defaultNoticesDeps()): Promise<boolean> {
  if (onCi(deps.env)) return false;
  const notices = await readNotices(deps.path);
  if (!notices || notices.starAsked === true) return false;
  const now = deps.now();
  const first = typeof notices.firstDashboardAt === "string" ? Date.parse(notices.firstDashboardAt) : Number.NaN;
  try {
    if (Number.isNaN(first)) {
      await writeNotices(deps.path, { ...notices, firstDashboardAt: new Date(now).toISOString() });
      return false;
    }
    if (now - first < ASK_AFTER_MS) return false;
    await writeNotices(deps.path, { ...notices, starAsked: true });
    return true;
  } catch {
    return false;
  }
}

/** Notes that the user has been to the star already, so the dashboard does not ask. Never throws. */
export async function recordStarAsked(deps: NoticesDeps = defaultNoticesDeps()): Promise<void> {
  try {
    const notices = (await readNotices(deps.path)) ?? {};
    if (notices.starAsked === true) return;
    await writeNotices(deps.path, { ...notices, starAsked: true });
  } catch {
    // Only the question's record: a star given without it is still given.
  }
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
