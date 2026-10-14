import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeDaemonControlPath, claudeDaemonRunning } from "./claude-daemon.js";

const temps: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch folder in place of /tmp, short enough that a socket path under it fits in sun_path
 * (104 bytes on macOS, whose temp folder alone takes about half of that).
 */
function scratchTmp(): string {
  const base = tmpdir().length > 40 && process.platform !== "win32" ? "/tmp" : tmpdir();
  const dir = mkdtempSync(path.join(base, "cd-"));
  temps.push(dir);
  return dir;
}

/** A stand-in for a running daemon: something listening on `socketPath`. */
async function listenOn(socketPath: string): Promise<Server> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = createServer((connection) => connection.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

const hash8 = (dir: string) => createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8);

// POSIX paths: on Windows the path module would turn both sides into backslashes, and the case
// would check nothing.
describe.skipIf(process.platform === "win32")("claudeDaemonControlPath", () => {
  it("is the control socket under /tmp/cc-daemon-<uid>/, by a hash of the config dir", () => {
    const dir = "/home/u/.claude-work";
    expect(claudeDaemonControlPath(dir, { uid: 1000, env: {} })).toBe(`/tmp/cc-daemon-1000/${hash8(dir)}/control.sock`);
  });

  it("hashes the dir as resolved, so a trailing separator is the same daemon", () => {
    const check = { uid: 501, env: {} };
    expect(claudeDaemonControlPath("/Users/u/.claude-work/", check)).toBe(
      claudeDaemonControlPath("/Users/u/.claude-work", check),
    );
  });

  it("is under $PREFIX/tmp in Termux", () => {
    const env = { TERMUX_VERSION: "0.118", PREFIX: "/data/data/com.termux/files/usr" };
    expect(claudeDaemonControlPath("/h/.claude-work", { uid: 10123, env })).toBe(
      `/data/data/com.termux/files/usr/tmp/cc-daemon-10123/${hash8("/h/.claude-work")}/control.sock`,
    );
  });
});

describe.skipIf(process.platform === "win32")("claudeDaemonRunning on macOS and Linux", () => {
  it("finds the daemon while something listens on the dir's control socket", async () => {
    const tmpRoot = scratchTmp();
    const dir = "/Users/u/.claude-work";
    await listenOn(claudeDaemonControlPath(dir, { tmpRoot }));

    expect(await claudeDaemonRunning(dir, { tmpRoot })).toEqual({ running: true });
    // Another config dir's daemon is not this one's.
    expect(await claudeDaemonRunning("/Users/u/.claude-other", { tmpRoot })).toEqual({ running: false });
  });

  it("finds none once the daemon has stopped, even with its socket file left behind", async () => {
    const tmpRoot = scratchTmp();
    const dir = "/Users/u/.claude-work";
    const socketPath = claudeDaemonControlPath(dir, { tmpRoot });
    expect(await claudeDaemonRunning(dir, { tmpRoot })).toEqual({ running: false });

    await listenOn(socketPath);
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    writeFileSync(socketPath, "");
    expect(await claudeDaemonRunning(dir, { tmpRoot })).toEqual({ running: false });
  });

  it("never looks through the profile's daemon/ link", async () => {
    // The socket's folder lies inside the folder the profile's daemon/ link leads to: what
    // listens there is reached through the link, the primary's, not the profile's.
    const root = scratchTmp();
    const primaryDaemon = path.join(root, "p", "daemon");
    const profile = path.join(root, "w");
    mkdirSync(primaryDaemon, { recursive: true });
    mkdirSync(profile);
    symlinkSync(primaryDaemon, path.join(profile, "daemon"));
    const tmpRoot = path.join(primaryDaemon, "t");
    await listenOn(claudeDaemonControlPath(profile, { tmpRoot }));

    expect(await claudeDaemonRunning(profile, { tmpRoot })).toEqual({ running: false });
  });
});

describe("claudeDaemonRunning on Windows", () => {
  const win32 = { platform: "win32" as const };
  /** A config dir whose daemon.lock holds `lock`, as Claude Code writes it. */
  function profileWithLock(lock: unknown): string {
    const dir = scratchTmp();
    writeFileSync(path.join(dir, "daemon.lock"), typeof lock === "string" ? lock : JSON.stringify(lock));
    return dir;
  }

  it("finds the daemon by the profile's own daemon.lock naming a live pid", async () => {
    const dir = profileWithLock({ pid: process.pid, version: "2.1.299", startedAt: 1 });
    expect(await claudeDaemonRunning(dir, win32)).toEqual({ running: true, pid: process.pid });
  });

  it("finds none without a lock, with one naming a pid that is gone, or with one it cannot read", async () => {
    expect(await claudeDaemonRunning(scratchTmp(), win32)).toEqual({ running: false });
    const gone = profileWithLock({ pid: 2_000_000_000 });
    expect(await claudeDaemonRunning(gone, win32)).toEqual({ running: false });
    expect(await claudeDaemonRunning(profileWithLock("{ not json"), win32)).toEqual({ running: false });
    expect(await claudeDaemonRunning(profileWithLock({ pid: "1" }), win32)).toEqual({ running: false });
  });

  it("does not take a lock linked from another config dir for the profile's own", async () => {
    const primary = profileWithLock({ pid: process.pid });
    const hardLinked = scratchTmp();
    linkSync(path.join(primary, "daemon.lock"), path.join(hardLinked, "daemon.lock"));
    expect(await claudeDaemonRunning(hardLinked, win32)).toEqual({ running: false });
  });

  it.skipIf(process.platform === "win32")("does not take a symbolic link to another dir's lock either", async () => {
    const primary = profileWithLock({ pid: process.pid });
    const linked = scratchTmp();
    symlinkSync(path.join(primary, "daemon.lock"), path.join(linked, "daemon.lock"));
    expect(await claudeDaemonRunning(linked, win32)).toEqual({ running: false });
  });
});
