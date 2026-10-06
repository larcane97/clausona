import path from "node:path";

/**
 * The longest path, in bytes, a Unix domain socket can be bound at: `sun_path` less the NUL
 * that ends it - 104 bytes on macOS and the BSDs, 108 on Linux. Undefined on Windows, where
 * the tools talk over named pipes instead, which have no such limit.
 */
export function socketPathLimit(platform: NodeJS.Platform): number | undefined {
  if (platform === "win32") return undefined;
  return platform === "linux" || platform === "android" ? 107 : 103;
}

/** A socket path a directory makes too long to bind. */
export type OverlongSocketPath = {
  /** The socket's full path. */
  socketPath: string;
  /** Its length in bytes, which is what `sun_path` counts - not characters. */
  bytes: number;
  limit: number;
  /** The longest the directory itself can be, in bytes, for this socket to fit. */
  dirLimit: number;
};

/**
 * Whether a socket bound at `socket`, relative to `dir`, would not fit in `sun_path`.
 *
 * `dir` should already be resolved with realpath: the socket is bound at the full path the
 * directory resolves to, and a symlinked home - macOS's /tmp is /private/tmp - can be longer
 * than the name it was given by. A socket path that does not fit makes `bind` fail ("path
 * must be shorter than SUN_LEN"), and the tool carries on without it.
 */
export function overlongSocketPath(
  dir: string,
  socket: string,
  platform: NodeJS.Platform,
): OverlongSocketPath | undefined {
  const limit = socketPathLimit(platform);
  if (limit === undefined) return undefined;
  const socketPath = path.posix.join(dir, socket);
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes <= limit) return undefined;
  return { socketPath, bytes, limit, dirLimit: limit - Buffer.byteLength(`/${socket}`, "utf8") };
}
