import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

import { spawnCommand } from "./process.js";

/**
 * How long the look at a daemon's control socket gets. A listening socket takes the connection
 * at once and a missing one is refused at once; this is Claude Code's own limit for the same
 * look (2.1.299).
 */
const CHECK_TIMEOUT_MS = 1_000;

/** What the look uses, for tests: the platform, the folder in place of /tmp, the user id, and how long it gets. */
export type DaemonCheck = {
  platform?: NodeJS.Platform;
  tmpRoot?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Windows: the PowerShell that reads a process's command line, and how long it gets. */
  powershell?: string;
  processTimeoutMs?: number;
};

/**
 * How long PowerShell gets to say what a process's command line is. It takes a second or two to
 * start on an idle machine; as long as the Codex look gets, for a busy one.
 */
const PROCESS_TIMEOUT_MS = 10_000;

/**
 * Claude Code's daemon, as its command line reads: Claude Code started with `daemon run`
 * (2.1.299 spawns `<claude> daemon run --origin ...`), whether it is the native claude.exe or
 * node running the npm package's cli.js.
 */
const DAEMON_COMMAND = /claude.*\sdaemon\s+run(?:\s|$)/i;

/** What `command` printed, or null when it failed, ran out of time, or could not be started. */
function outputOf(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}

/**
 * Whether process `pid` is Claude Code's daemon, by its command line, which PowerShell reads.
 * False when the process is another program, or gone; null when the look could not tell -
 * PowerShell failed, or the command line is not shown, as for another user's process.
 */
async function isClaudeDaemon(pid: number, check: DaemonCheck): Promise<boolean | null> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const powershell =
    check.powershell ?? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { 'cmd:' + $p.CommandLine } else { 'none' }`;
  const output = await outputOf(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    check.processTimeoutMs ?? PROCESS_TIMEOUT_MS,
  );
  const answer = output?.trim();
  if (answer === "none") return false;
  if (!answer?.startsWith("cmd:") || answer === "cmd:") return null;
  return DAEMON_COMMAND.test(answer.slice("cmd:".length));
}

/**
 * What the look found: the daemon of the config dir running (with its pid where the look reads
 * one), none, or no answer.
 */
export type DaemonLook = { running: true; pid?: number } | { running: false } | { running: null };

/**
 * Where Claude Code's background daemon for `configDir` takes connections on macOS and Linux, as
 * Claude Code 2.1.299 derives it: `/tmp/cc-daemon-<uid>/<hash>/control.sock` (under `$PREFIX/tmp`
 * in Termux), the hash being the first 8 hex digits of the SHA-256 of the config dir's resolved
 * path. It is the profile's own whatever its `daemon/` links to.
 */
export function claudeDaemonControlPath(configDir: string, check: DaemonCheck = {}): string {
  const env = check.env ?? process.env;
  const tmpRoot = check.tmpRoot ?? (env.TERMUX_VERSION && env.PREFIX ? path.join(env.PREFIX, "tmp") : "/tmp");
  const uid = check.uid ?? process.getuid?.() ?? 0;
  // As Claude Code spells the dir it hashes: CLAUDE_CONFIG_DIR as clausona sets it, NFC, resolved.
  const hash = createHash("sha256")
    .update(path.resolve(configDir.normalize("NFC")))
    .digest("hex")
    .slice(0, 8);
  return path.join(tmpRoot, `cc-daemon-${uid}`, hash, "control.sock");
}

/** What connecting says when nothing listens there: no daemon. */
const NOTHING_LISTENING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ENOTDIR", "ENAMETOOLONG"]);

/** Whether `inner` is `outer` or lies inside it. */
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + path.sep);

/**
 * The pid in `configDir`'s own `daemon.lock`, where it names a running process: the lock Claude
 * Code's daemon takes for its config dir (`{pid, version, startedAt, ...}`), written by a rename.
 * A link to another dir's lock - a symbolic link, or a hard link, which Windows makes in place of
 * one - is that dir's, not the profile's.
 */
async function ownLockHolder(configDir: string): Promise<number | undefined> {
  const lock = path.join(configDir, "daemon.lock");
  const stats = await lstat(lock).catch(() => null);
  if (!stats?.isFile() || stats.nlink !== 1) return undefined;
  let pid: unknown;
  try {
    pid = (JSON.parse(await readFile(lock, "utf8")) as { pid?: unknown } | null)?.pid;
  } catch {
    return undefined;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // Another user's process: running, only not this user's to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/**
 * Whether Claude Code's background daemon for `configDir` is running. Nothing is looked at
 * through the profile's `daemon/` link: what that reaches is another config dir's.
 *
 * On Windows the daemon's pipe is named by `daemon/pipe.key`, which through the link is the
 * primary's, so the pipe cannot say whose daemon answers it. There the look reads the profile's
 * own `daemon.lock` instead: a file of the profile's naming a running process whose command line
 * is Claude Code's daemon, or one PowerShell cannot show.
 *
 * Elsewhere it connects to the control socket, and closes the connection as soon as it is made,
 * sending nothing. A socket folder reached through the link is passed over. No answer in time, or
 * an error that is neither a connection nor a refusal, is no answer.
 */
export async function claudeDaemonRunning(configDir: string, check: DaemonCheck = {}): Promise<DaemonLook> {
  if ((check.platform ?? process.platform) === "win32") {
    const pid = await ownLockHolder(configDir);
    if (pid === undefined) return { running: false };
    // Windows hands a dead daemon's pid to the next process soon after: the lock's pid counts
    // only while it is Claude Code's daemon, or while the look cannot tell.
    return (await isClaudeDaemon(pid, check)) === false ? { running: false } : { running: true, pid };
  }
  const target = claudeDaemonControlPath(configDir, check);
  const daemonDir = path.join(configDir, "daemon");
  if ((await lstat(daemonDir).catch(() => null))?.isSymbolicLink()) {
    const [reached, socketDir] = await Promise.all([
      realpath(daemonDir).catch(() => null),
      realpath(path.dirname(target)).catch(() => null),
    ]);
    if (reached && socketDir && within(socketDir, reached)) return { running: false };
  }
  return new Promise((resolve) => {
    const socket = connect(target);
    const done = (look: DaemonLook) => {
      socket.destroy();
      resolve(look);
    };
    socket.setTimeout(check.timeoutMs ?? CHECK_TIMEOUT_MS, () => done({ running: null }));
    socket.once("connect", () => done({ running: true }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(NOTHING_LISTENING.has(error.code ?? "") ? { running: false } : { running: null }),
    );
  });
}
