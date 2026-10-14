import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

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
};

/**
 * Where Claude Code's background daemon for `configDir` takes connections, as Claude Code 2.1.299
 * derives it. On macOS and Linux it is `/tmp/cc-daemon-<uid>/<hash>/control.sock` (under
 * `$PREFIX/tmp` in Termux), the hash being the first 8 hex digits of the SHA-256 of the config
 * dir's resolved path; so it is the profile's own whatever its `daemon/` links to. On Windows it is
 * the pipe `\\.\pipe\cc-daemon-<nonce>-control`, the nonce read from `daemon/pipe.key` in the
 * config dir: through a link, the primary's. Null on Windows when there is no nonce yet, which no
 * daemon has run without.
 */
export async function claudeDaemonControlPath(configDir: string, check: DaemonCheck = {}): Promise<string | null> {
  const platform = check.platform ?? process.platform;
  if (platform === "win32") {
    const nonce = await readFile(path.join(configDir, "daemon", "pipe.key"), "utf8").then(
      (text) => text.trim(),
      () => "",
    );
    return /^[a-f0-9]{16}$/.test(nonce) ? `\\\\.\\pipe\\cc-daemon-${nonce}-control` : null;
  }
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

/**
 * Whether Claude Code's background daemon for `configDir` is running: something takes a
 * connection on its control socket. Null when the look could not tell - no answer in time, or an
 * error that is neither a connection nor a refusal. Nothing is sent: the connection is closed as
 * soon as it is made.
 */
export async function claudeDaemonRunning(configDir: string, check: DaemonCheck = {}): Promise<boolean | null> {
  const target = await claudeDaemonControlPath(configDir, check);
  if (target === null) return false;
  return new Promise((resolve) => {
    const socket = connect(target);
    const done = (answer: boolean | null) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(check.timeoutMs ?? CHECK_TIMEOUT_MS, () => done(null));
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(NOTHING_LISTENING.has(error.code ?? "") ? false : null),
    );
  });
}
