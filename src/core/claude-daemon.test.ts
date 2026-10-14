import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if (!socketPath.startsWith("\\\\.\\pipe\\")) mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = createServer((connection) => connection.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

const hash8 = (dir: string) => createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 8);

describe("claudeDaemonControlPath", () => {
  it("is the control socket under /tmp/cc-daemon-<uid>/, by a hash of the config dir", async () => {
    const dir = "/home/u/.claude-work";
    expect(await claudeDaemonControlPath(dir, { platform: "linux", uid: 1000, env: {} })).toBe(
      path.join("/tmp", "cc-daemon-1000", hash8(dir), "control.sock"),
    );
  });

  it("hashes the dir as resolved, so a trailing separator is the same daemon", async () => {
    const check = { platform: "darwin" as const, uid: 501, env: {} };
    expect(await claudeDaemonControlPath("/Users/u/.claude-work/", check)).toBe(
      await claudeDaemonControlPath("/Users/u/.claude-work", check),
    );
  });

  it("is under $PREFIX/tmp in Termux", async () => {
    const env = { TERMUX_VERSION: "0.118", PREFIX: "/data/data/com.termux/files/usr" };
    expect(await claudeDaemonControlPath("/h/.claude-work", { platform: "linux", uid: 10123, env })).toBe(
      path.join("/data/data/com.termux/files/usr/tmp", "cc-daemon-10123", hash8("/h/.claude-work"), "control.sock"),
    );
  });

  it("is the pipe named by daemon/pipe.key on Windows, and nothing without one", async () => {
    const dir = scratchTmp();
    expect(await claudeDaemonControlPath(dir, { platform: "win32" })).toBeNull();
    mkdirSync(path.join(dir, "daemon"));
    writeFileSync(path.join(dir, "daemon", "pipe.key"), "not a nonce\n");
    expect(await claudeDaemonControlPath(dir, { platform: "win32" })).toBeNull();
    writeFileSync(path.join(dir, "daemon", "pipe.key"), "0a1b2c3d4e5f6a7b\n");
    expect(await claudeDaemonControlPath(dir, { platform: "win32" })).toBe(
      "\\\\.\\pipe\\cc-daemon-0a1b2c3d4e5f6a7b-control",
    );
  });
});

describe.skipIf(process.platform === "win32")("claudeDaemonRunning", () => {
  it("is true while something listens on the dir's control socket", async () => {
    const tmpRoot = scratchTmp();
    const dir = "/Users/u/.claude-work";
    const socketPath = await claudeDaemonControlPath(dir, { tmpRoot });
    await listenOn(socketPath ?? "");

    expect(await claudeDaemonRunning(dir, { tmpRoot })).toBe(true);
    // Another config dir's daemon is not this one's.
    expect(await claudeDaemonRunning("/Users/u/.claude-other", { tmpRoot })).toBe(false);
  });

  it("is false once the daemon has stopped, even with its socket file left behind", async () => {
    const tmpRoot = scratchTmp();
    const dir = "/Users/u/.claude-work";
    const socketPath = (await claudeDaemonControlPath(dir, { tmpRoot })) ?? "";
    expect(await claudeDaemonRunning(dir, { tmpRoot })).toBe(false);

    await listenOn(socketPath);
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    writeFileSync(socketPath, "");
    expect(await claudeDaemonRunning(dir, { tmpRoot })).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("claudeDaemonRunning on Windows", () => {
  it("is true while something listens on the pipe daemon/pipe.key names", async () => {
    const dir = scratchTmp();
    mkdirSync(path.join(dir, "daemon"));
    const nonce = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    writeFileSync(path.join(dir, "daemon", "pipe.key"), nonce);
    expect(await claudeDaemonRunning(dir)).toBe(false);

    await listenOn(`\\\\.\\pipe\\cc-daemon-${nonce}-control`);
    expect(await claudeDaemonRunning(dir)).toBe(true);
  });
});
