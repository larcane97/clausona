import { execFileSync, spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import type { SecretSource } from "../types.js";
import { detectBackend, keychainItemFor, resolveSecret, secretStoreName, storeSecret } from "./secrets.js";
import { keychainStandIn, splitSecurityLine } from "./test-keychain.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUSONA_TEST_KEY;
  vi.unstubAllEnvs();
});

describe("keychainItemFor", () => {
  it("namespaces the item by profile id", () => {
    expect(keychainItemFor("claude:glm")).toBe("clausona-claude:glm");
  });
});

describe("detectBackend", () => {
  it("uses the Keychain on macOS", () => {
    expect(detectBackend("darwin")).toBe("keychain");
  });

  it("falls back to a file on Windows", () => {
    expect(detectBackend("win32")).toBe("file");
  });

  // The secret-tool probe it had failed on every real secret-tool, so Linux keys were in the
  // file all along; one that answered would have sent them to a Secret Service that may not
  // be running. A secret-tool that answers everything with success is first on PATH here.
  it.skipIf(process.platform === "win32")("keeps Linux keys in the file even where secret-tool answers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clausona-secret-tool-"));
    temps.push(dir);
    writeFileSync(path.join(dir, "secret-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);

    expect(detectBackend("linux")).toBe("file");
  });

  it("names the store doctor reports", () => {
    expect(secretStoreName("darwin")).toBe("the macOS Keychain");
    expect(secretStoreName("linux")).toBe("~/.clausona/secrets.json");
    expect(secretStoreName("win32")).toBe("~/.clausona/secrets.json");
  });
});

describe("resolveSecret", () => {
  it("reads an env source", async () => {
    process.env.CLAUSONA_TEST_KEY = "sk-from-env";
    await expect(resolveSecret("claude:x", { source: "env", name: "CLAUSONA_TEST_KEY" })).resolves.toBe("sk-from-env");
  });

  it("throws when the env source is unset", async () => {
    await expect(resolveSecret("claude:x", { source: "env", name: "CLAUSONA_TEST_KEY" })).rejects.toThrow(
      /CLAUSONA_TEST_KEY/,
    );
  });

  // The command runs in sh -c on macOS and Linux and in powershell -NoProfile -Command on
  // Windows, so each is written for its shell. PowerShell's own cmdlets there: -Command exits 1
  // for a native command that failed, whatever its code, so `node -e "process.exit(3)"` could
  // never report 3.
  const windows = process.platform === "win32";

  it("reads the first line of a command source", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const run = windows
      ? "Write-Output 'S3CRET'; Write-Output 'ignored'"
      : "node -e \"console.log('S3CRET'); console.log('ignored')\"";
    await expect(resolveSecret("claude:x", { source: "command", run })).resolves.toBe("S3CRET");
  });

  it("throws when the command fails", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const run = windows ? "exit 3" : 'node -e "process.exit(3)"';
    await expect(resolveSecret("claude:x", { source: "command", run })).rejects.toThrow(/exited with 3/);
  });

  // A vault waiting to be unlocked, or a CLI on a dead network: the command never answers. Once
  // the signal aborts, the shell and what it started are killed, and nothing waits on them.
  it.skipIf(windows)(
    "stops a command that never answers once its signal aborts, and kills what it started",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      // The shell's pid, then the pid of the sleep it starts, which outlives it unless killed.
      const run = 'echo $$ > "$CLAUSONA_TEST_PIDS"; sleep 30 & echo $! >> "$CLAUSONA_TEST_PIDS"; wait';
      const controller = new AbortController();
      const started = Date.now();
      const read = resolveSecret("claude:x", { source: "command", run }, undefined, { signal: controller.signal });
      // Aborted once the command is under way, both pids written.
      await vi.waitFor(() => expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(2), {
        timeout: 20_000,
      });
      controller.abort();
      await expect(read).rejects.toThrow("the key was not read in time");
      expect(Date.now() - started).toBeLessThan(25_000);
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const [shell, sleep] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
      await vi.waitFor(() => expect([alive(shell), alive(sleep)]).toEqual([false, false]), { timeout: 10_000 });
    },
  );

  // Started in a group of its own, it is out of reach of the terminal's Ctrl-C: clausona ending
  // ends it, and the signal goes on to end clausona as it would have.
  it.skipIf(windows)(
    "ends a key command it is waiting on when clausona is interrupted, and lets the signal take its course",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      const run = 'echo $$ > "$CLAUSONA_TEST_PIDS"; sleep 30 & echo $! >> "$CLAUSONA_TEST_PIDS"; wait';
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const others = process.listenerCount("SIGINT");
      const controller = new AbortController();
      // Settled when its group is killed: the key is not read.
      const read = resolveSecret("claude:x", { source: "command", run }, undefined, { signal: controller.signal }).then(
        () => "read",
        () => "not read",
      );
      await vi.waitFor(() => expect(readFileSync(pids, "utf8").trim().split("\n")).toHaveLength(2), {
        timeout: 20_000,
      });
      const [shell, sleep] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
      // The signal raised again on this process is caught here, or it would end the test run.
      const real = process.kill.bind(process);
      const raised: Array<string | number | undefined> = [];
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid !== process.pid) return real(pid, signal);
        raised.push(signal);
        return true;
      });
      try {
        (process.emit as (event: string, ...args: unknown[]) => boolean)("SIGINT", "SIGINT");
        await vi.waitFor(() => expect([alive(shell), alive(sleep)]).toEqual([false, false]), { timeout: 10_000 });
        // Its handlers are gone, and with no other handler the signal was raised again.
        expect(process.listenerCount("SIGINT")).toBe(others);
        expect(raised).toEqual(others === 0 ? ["SIGINT"] : []);
        expect(await read).toBe("not read");
      } finally {
        kill.mockRestore();
        controller.abort();
      }
    },
  );

  // Every API profile's key can be read at once: one set of handlers serves them all.
  it.skipIf(windows)(
    "puts on one set of signal handlers for many key commands at once, and takes it off after",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const counts = () => ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((event) => process.listenerCount(event));
      const before = counts();
      const warning = vi.spyOn(process, "emitWarning");
      // One signal given to every read, as a caller may: it gets one listener, not twelve.
      const controller = new AbortController();
      try {
        const reads = Array.from({ length: 12 }, () =>
          resolveSecret("claude:x", { source: "command", run: "sleep 30" }, undefined, {
            signal: controller.signal,
          }).catch(() => "not read"),
        );
        // Each started as it was asked for: one handler more for each event, not twelve.
        expect(counts()).toEqual(before.map((count) => count + 1));
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        controller.abort();
        expect(await Promise.all(reads)).toEqual(Array(12).fill("not read"));
        expect(counts()).toEqual(before);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        // Not a MaxListenersExceededWarning, on process or on the signal, nor any other.
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        controller.abort();
      }
    },
  );

  // Its pid, once it has exited, can be another process's: nothing is signalled then, even with a
  // job it left behind holding its output open, which the read no longer waits for.
  it.skipIf(windows)(
    "signals nothing once the command has exited, though a job it left keeps its output open",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      // The leader of the command's process group, which clausona started, then a job that ignores
      // the TERM its group gets once the command exits, and so outlives the command. The job writes
      // its pid once it ignores TERM, and the command exits only after that: exiting sooner, it could
      // have its group sent the TERM before the job ignored it.
      const run =
        'ps -o pgid= -p $$ > "$CLAUSONA_TEST_PIDS"; ' +
        'sh -c \'trap "" TERM; echo $$ >> "$CLAUSONA_TEST_PIDS"; exec sleep 600\' & ' +
        'while [ "$(wc -l < "$CLAUSONA_TEST_PIDS")" -lt 2 ]; do sleep 0.1; done; exit 0';
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const job = () => {
        try {
          return Number(readFileSync(pids, "utf8").trim().split("\n")[1] ?? 0);
        } catch {
          return 0;
        }
      };
      const controller = new AbortController();
      // Bounded here, so that a read that waits for the job fails rather than hangs.
      let bound: NodeJS.Timeout | undefined;
      const waited = new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error("the read waited for the job")), SPAWN_TIMEOUT_MS);
      });
      const kill = vi.spyOn(process, "kill");
      try {
        const read = resolveSecret("claude:x", { source: "command", run }, undefined, { signal: controller.signal });
        // Read once the command has exited, which printed nothing: neither the job nor the abort
        // is waited for.
        await expect(Promise.race([read, waited])).rejects.toThrow("secret command produced no output");
        const [leader] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
        expect(alive(leader)).toBe(false);
        controller.abort();
        // Only the checks above and below: no signal went to any pid.
        expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
        expect(job()).toBeGreaterThan(0);
        expect(alive(job())).toBe(true);
      } finally {
        clearTimeout(bound);
        kill.mockRestore();
        controller.abort();
        // The job is this test's own, by the pid it wrote, and was never seen to end.
        if (job() > 0 && alive(job())) process.kill(job(), "SIGKILL");
      }
    },
  );

  // An abort while the output is still being read after the command has exited: the command's pid
  // can be another process's by then, so nothing is signalled, and the job it left keeps running.
  it.skipIf(windows)(
    "signals nothing on an abort after the command has exited, while its output is still read",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      // As in the test above: the group's leader, then a job that ignores the group's TERM, and
      // holds the output open past the command's exit.
      const run =
        'ps -o pgid= -p $$ > "$CLAUSONA_TEST_PIDS"; ' +
        'sh -c \'trap "" TERM; echo $$ >> "$CLAUSONA_TEST_PIDS"; exec sleep 600\' & ' +
        'while [ "$(wc -l < "$CLAUSONA_TEST_PIDS")" -lt 2 ]; do sleep 0.1; done; exit 0';
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const written = () => {
        try {
          return readFileSync(pids, "utf8").trim().split("\n").map(Number);
        } catch {
          return [];
        }
      };
      // The drain's clock is a fake one, so the abort lands inside it; the wait for the command is
      // on the real one.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const kill = vi.spyOn(process, "kill");
      try {
        const read = resolveSecret("claude:x", { source: "command", run }, undefined, { signal: controller.signal });
        const started = Date.now();
        const exited = () => written().length === 2 && !alive(written()[0]);
        while (!exited() && Date.now() - started < 20_000) await sleep(50);
        // The leader is gone, so Node has seen it exit, and the drain has begun.
        expect(exited()).toBe(true);
        controller.abort();
        await expect(read).rejects.toThrow("the key was not read in time");
        // Only the checks above and below: no signal went to any pid.
        expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
        expect(alive(written()[1])).toBe(true);
      } finally {
        kill.mockRestore();
        controller.abort();
        vi.useRealTimers();
        // The job is this test's own, by the pid it wrote, and was never seen to end.
        const job = written()[1] ?? 0;
        if (job > 0 && alive(job)) process.kill(job, "SIGKILL");
      }
    },
  );

  // A job left in the command's group holds its output open: it is ended once the command exits,
  // and the key is read then, not when the reading's time is up.
  it.skipIf(windows)(
    "ends a job the command left running once it exits, and reads the key without waiting for it",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      const run = 'sleep 120 & echo $! > "$CLAUSONA_TEST_PIDS"; echo S3CRET';
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // The job's pid, as the command wrote it; 0 until then, which is never signalled.
      const written = () => {
        try {
          return Number(readFileSync(pids, "utf8").trim());
        } catch {
          return 0;
        }
      };
      // Longer than a reading allows, for a machine under load; the job outlasts it.
      const signal = AbortSignal.timeout(SPAWN_TIMEOUT_MS);
      // Once the job is seen gone, its pid can be another process's, and is not signalled.
      let ended = false;
      try {
        await expect(resolveSecret("claude:x", { source: "command", run }, undefined, { signal })).resolves.toBe(
          "S3CRET",
        );
        expect(written()).toBeGreaterThan(0);
        await vi.waitFor(() => expect(alive(written())).toBe(false), { timeout: 10_000 });
        ended = true;
      } finally {
        // The job is this test's own, by the pid it wrote.
        const job = written();
        if (!ended && job > 0 && alive(job)) process.kill(job, "SIGKILL");
      }
    },
  );

  // A key tool's agent (gpg-agent, ssh-agent) puts itself in a session of its own, and outlives
  // the command that started it, as it must.
  it.skipIf(windows)(
    "leaves running a helper the command started in a session of its own",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      // Node's detached spawn calls setsid, as an agent does when it starts.
      const helper =
        "const c = require('child_process').spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });" +
        " require('fs').writeFileSync(process.env.CLAUSONA_TEST_PIDS, String(c.pid)); c.unref();";
      const run = `node -e "${helper}"; echo S3CRET`;
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const written = () => {
        try {
          return Number(readFileSync(pids, "utf8").trim());
        } catch {
          return 0;
        }
      };
      const signal = AbortSignal.timeout(SPAWN_TIMEOUT_MS);
      try {
        await expect(resolveSecret("claude:x", { source: "command", run }, undefined, { signal })).resolves.toBe(
          "S3CRET",
        );
        expect(written()).toBeGreaterThan(0);
        expect(alive(written())).toBe(true);
      } finally {
        // The helper is this test's own, by the pid it wrote.
        const helperPid = written();
        if (helperPid > 0 && alive(helperPid)) process.kill(helperPid, "SIGKILL");
      }
    },
  );

  // A launch reads the key with no signal: the command keeps the terminal, in clausona's own
  // process group. A job it left holding the output does not hold up the launch, and is left
  // running, since nothing here can end it alone.
  it.skipIf(windows)(
    "reads a key at a launch once the command exits, though a job it left holds its output",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
      temps.push(dir);
      const pids = path.join(dir, "pids");
      vi.stubEnv("CLAUSONA_TEST_PIDS", pids);
      const run = 'sleep 600 & echo $! > "$CLAUSONA_TEST_PIDS"; echo KEY';
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const written = () => {
        try {
          return Number(readFileSync(pids, "utf8").trim());
        } catch {
          return 0;
        }
      };
      // Bounded here, so that a read that waits for the job fails rather than hangs.
      let bound: NodeJS.Timeout | undefined;
      const waited = new Promise<never>((_, reject) => {
        bound = setTimeout(() => reject(new Error("the read waited for the job")), SPAWN_TIMEOUT_MS);
      });
      try {
        await expect(Promise.race([resolveSecret("claude:x", { source: "command", run }), waited])).resolves.toBe(
          "KEY",
        );
        expect(written()).toBeGreaterThan(0);
        expect(alive(written())).toBe(true);
      } finally {
        clearTimeout(bound);
        // The job is this test's own, by the pid it wrote, and was never seen to end.
        const job = written();
        if (job > 0 && alive(job)) process.kill(job, "SIGKILL");
      }
    },
  );

  // A prompt for a PIN or a passphrase on /dev/tty works only for a process in the terminal's
  // foreground process group: a launch and doctor run the command in clausona's own.
  it.skipIf(windows)(
    "runs a key command that keeps the terminal in clausona's own process group",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const run = "ps -o pgid= -p $$";
      const own = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
      await expect(resolveSecret("claude:x", { source: "command", run })).resolves.toBe(own);
      await expect(resolveSecret("claude:x", { source: "command", run }, undefined, { limitMs: 60_000 })).resolves.toBe(
        own,
      );
    },
  );

  /**
   * doctor's check: a key read with a limit of 60 s on a fake clock, which is moved on once the
   * command `start` runs has written its pids to $CLAUSONA_TEST_PIDS, one a line, `count` of them,
   * its own first. `check` is given the read, the pids, the signals sent so far and a way to wait
   * on the real clock for every pid to end. The test's own bound, on the real clock, fails a read
   * that goes on past the limit rather than hanging. Whatever happens, nothing the command started
   * outlives the test: the fake clock is moved past the limit and its grace, and then each pid it
   * wrote that is still running, and was not seen to end, is killed.
   */
  async function atLimit(
    start: () => Promise<string>,
    check: (at: {
      read: Promise<string>;
      pids: number[];
      signals: () => unknown[];
      gone: () => Promise<boolean>;
    }) => Promise<void>,
    count = 1,
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-command-"));
    temps.push(dir);
    const file = path.join(dir, "pids");
    vi.stubEnv("CLAUSONA_TEST_PIDS", file);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const written = () => {
      try {
        return readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map(Number)
          .filter((pid) => pid > 0);
      } catch {
        return [];
      }
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unbound = new AbortController();
    const waited = sleep(SPAWN_TIMEOUT_MS, undefined, { signal: unbound.signal }).then(() => {
      throw new Error("the read went on past its limit");
    });
    waited.catch(() => {});
    const kill = vi.spyOn(process, "kill");
    let ended = false;
    try {
      const read = start();
      const started = Date.now();
      while (written().length < count && Date.now() - started < 20_000) await sleep(50);
      const pids = written();
      expect(pids).toHaveLength(count);
      await check({
        read: Promise.race([read, waited]),
        pids,
        // Only what was sent: alive() checks with 0.
        signals: () => kill.mock.calls.filter(([, signal]) => signal !== 0),
        gone: async () => {
          const since = Date.now();
          while (pids.some(alive) && Date.now() - since < 10_000) await sleep(50);
          ended = !pids.some(alive);
          return ended;
        },
      });
    } finally {
      unbound.abort();
      vi.advanceTimersByTime(60_000 + 2_000);
      kill.mockRestore();
      vi.useRealTimers();
      // What the command started is this test's own, by the pids it wrote, and was not seen to end.
      if (!ended) for (const pid of written()) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }

  /** A key command's read as `clausona doctor` makes it. */
  const doctorRead = (run: string) => () =>
    resolveSecret("claude:x", { source: "command", run }, undefined, { limitMs: 60_000 });

  // At doctor's limit the command is interrupted, as Ctrl-C would, so a prompt can turn the
  // terminal's echo back on: never its group, which is clausona's, and the key is not read.
  it.skipIf(windows)(
    "interrupts a key command that keeps the terminal once its limit passes, and sends nothing once it has ended",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      // Its own pid, which exec hands on to the sleep; SIGINT ends it.
      const run = 'echo $$ > "$CLAUSONA_TEST_PIDS"; exec sleep 600';
      await atLimit(doctorRead(run), async ({ read, pids: [pid], signals, gone }) => {
        vi.advanceTimersByTime(60_000);
        await expect(read).rejects.toThrow(/^secret command did not finish in 60 s - /);
        expect(signals()).toEqual([[pid, "SIGINT"]]);
        expect(await gone()).toBe(true);
        // Its grace passes with nothing more sent: it has exited.
        vi.advanceTimersByTime(2_000);
        expect(signals()).toEqual([[pid, "SIGINT"]]);
      });
    },
  );

  it.skipIf(windows)(
    "kills a key command that is still running once the grace after its interrupt passes",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      // One that ignores SIGINT, its pid written once it does.
      const run = 'trap "" INT; echo $$ > "$CLAUSONA_TEST_PIDS"; exec sleep 600';
      await atLimit(doctorRead(run), async ({ read, pids: [pid], signals, gone }) => {
        vi.advanceTimersByTime(60_000);
        await expect(read).rejects.toThrow(/^secret command did not finish in 60 s - /);
        expect(signals()).toEqual([[pid, "SIGINT"]]);
        vi.advanceTimersByTime(1_999);
        expect(signals()).toEqual([[pid, "SIGINT"]]);
        vi.advanceTimersByTime(1);
        expect(signals()).toEqual([
          [pid, "SIGINT"],
          [pid, "SIGKILL"],
        ]);
        expect(await gone()).toBe(true);
      });
    },
  );

  // A command that is not a single program - a pipeline, `cmd1; cmd2` - leaves its children in
  // clausona's own group, holding the prompt. At the limit they are ended with it, one by one.
  it.skipIf(windows)(
    "ends what a key command started along with it once its limit passes",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      // The shell, then the child it waits on; the `:` after it keeps the shell from exec'ing it.
      const run = 'echo $$ > "$CLAUSONA_TEST_PIDS"; sh -c \'echo $$ >> "$CLAUSONA_TEST_PIDS"; exec sleep 600\'; :';
      await atLimit(
        doctorRead(run),
        async ({ read, pids: [shell, child], signals, gone }) => {
          vi.advanceTimersByTime(60_000);
          await expect(read).rejects.toThrow(/^secret command did not finish in 60 s - /);
          expect(signals()).toEqual(
            expect.arrayContaining([
              [shell, "SIGINT"],
              [child, "SIGINT"],
            ]),
          );
          // A shell can hold off SIGINT until its child has ended; its grace ends it then.
          vi.advanceTimersByTime(2_000);
          expect(await gone()).toBe(true);
          // Every signal went to one of them, and none to a group.
          for (const [pid] of signals() as Array<[number, string]>) expect([shell, child]).toContain(pid);
        },
        2,
      );
    },
  );

  // The Keychain read waits on macOS's own dialog asking whether clausona may read the key; left
  // unanswered, doctor ends it at its limit. A stand-in `security` stands in for one never answered.
  it.skipIf(windows)(
    "ends a Keychain read that has not answered once doctor's limit passes",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const bin = mkdtempSync(path.join(tmpdir(), "clausona-security-stand-in-"));
      temps.push(bin);
      writeFileSync(path.join(bin, "security"), '#!/bin/sh\necho $$ > "$CLAUSONA_TEST_PIDS"\nexec sleep 600\n', {
        mode: 0o755,
      });
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      const read = () => resolveSecret("claude:x", { source: "keychain" }, "keychain", { limitMs: 60_000 });
      await atLimit(read, async ({ read, pids: [pid], signals, gone }) => {
        vi.advanceTimersByTime(60_000);
        await expect(read).rejects.toThrow(/^the Keychain did not answer in 60 s - /);
        expect(signals()).toEqual([[pid, "SIGINT"]]);
        expect(await gone()).toBe(true);
      });
    },
  );

  // The Health check screen holds the terminal in raw mode: a key command there runs in a group of
  // its own with no terminal, as a spend read does, and one that needs the terminal fails at once.
  it.skipIf(windows)(
    "reads a key without the terminal for the dashboard, and says to check one that prompts with doctor",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    async () => {
      const own = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
      const options = { limitMs: 60_000, terminal: false };
      // Bounded here, so that a read that waits on the terminal fails rather than hangs.
      const unbound = new AbortController();
      const waited = sleep(SPAWN_TIMEOUT_MS, undefined, { signal: unbound.signal }).then(() => {
        throw new Error("the read waited on the terminal");
      });
      waited.catch(() => {});
      try {
        const group = await Promise.race([
          resolveSecret("claude:x", { source: "command", run: "ps -o pgid= -p $$" }, undefined, options),
          waited,
        ]);
        expect(group).not.toBe(own);
        const prompt = 'printf "PIN: " > /dev/tty; read v < /dev/tty; echo "$v"';
        await expect(
          Promise.race([resolveSecret("claude:x", { source: "command", run: prompt }, undefined, options), waited]),
        ).rejects.toThrow(
          /^secret command .* - it ran without a terminal here, so if it asks for a PIN or a passphrase, run 'clausona doctor' to check it$/,
        );
      } finally {
        unbound.abort();
      }
    },
  );

  /**
   * The real resolveSecret in a node of its own, bundled once, whose stderr this test reads: what a
   * key command writes to stderr, passed through, can only be seen from outside the process that
   * ran it. It reads the command from $CLAUSONA_TEST_RUN and resolveSecret's options from
   * $CLAUSONA_TEST_OPTIONS, and prints `key:<key>` or `error:<message>`.
   */
  let bundled: string | undefined;
  function inNode(run: string, options: object): { stdout: string; stderr: string } {
    if (!bundled) {
      const dir = mkdtempSync(path.join(tmpdir(), "clausona-key-harness-"));
      temps.push(dir);
      const entry = path.join(dir, "harness.ts");
      writeFileSync(
        entry,
        [
          `import { resolveSecret } from ${JSON.stringify(path.join(import.meta.dirname, "secrets.ts"))};`,
          'const options = JSON.parse(process.env.CLAUSONA_TEST_OPTIONS ?? "{}");',
          'resolveSecret("claude:x", { source: "command", run: process.env.CLAUSONA_TEST_RUN ?? "" }, undefined, options).then(',
          '  (key) => process.stdout.write("key:" + key),',
          '  (error) => process.stdout.write("error:" + error.message),',
          ");",
        ].join("\n"),
      );
      bundled = path.join(dir, "harness.mjs");
      buildSync({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: bundled,
        logLevel: "silent",
      });
    }
    const ran = spawnSync(process.execPath, [bundled], {
      encoding: "utf8",
      env: { ...process.env, CLAUSONA_TEST_RUN: run, CLAUSONA_TEST_OPTIONS: JSON.stringify(options) },
      timeout: SPAWN_TIMEOUT_MS,
    });
    return { stdout: ran.stdout, stderr: ran.stderr };
  }

  // A tool that prompts or reports on stderr: at a launch and in `clausona doctor` it reaches the
  // terminal, as git's credential helpers' does; the dashboard and a spend read keep it out.
  it.skipIf(windows)(
    "passes a key command's stderr through where it keeps the terminal, and nowhere else",
    { timeout: SPAWNING_TEST_TIMEOUT_MS },
    () => {
      const run = "echo stderr-marker >&2; echo KEY";
      const launch = inNode(run, {});
      expect(launch.stdout).toBe("key:KEY");
      expect(launch.stderr).toContain("stderr-marker");
      expect(inNode(run, { limitMs: 60_000 }).stderr).toContain("stderr-marker");
      const dashboard = inNode(run, { limitMs: 60_000, terminal: false });
      expect(dashboard.stdout).toBe("key:KEY");
      expect(dashboard.stderr).not.toContain("stderr-marker");
    },
  );
});

/**
 * A stand-in `security` put first on PATH, so the real one - and the user's Keychain - is
 * never reached. It keeps its items in a file and logs every call's argv and stdin.
 */
function security(writes?: "store" | "drop" | "fail") {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-security-stand-in-"));
  temps.push(dir);
  const standIn = keychainStandIn(dir, { writes });
  vi.stubEnv("PATH", `${standIn.bin}${path.delimiter}${process.env.PATH ?? ""}`);
  return standIn;
}

describe.skipIf(process.platform === "win32")("storeSecret on the Keychain backend", () => {
  // Everything `security -i`'s line splitter treats specially, and `$` for good measure.
  const KEY = `sk-fixture-13b a"b'c\\d$HOME-end`;

  // `ps` shows every process's arguments to every user on the machine.
  it("never puts the key in security's arguments", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    const keychain = security();
    await storeSecret("claude:x", KEY, "keychain");
    expect(keychain.calls().length).toBeGreaterThan(0);
    for (const { argv } of keychain.calls()) for (const arg of argv) expect(arg).not.toContain(KEY);
  });

  it("hands security the key intact, as one add-generic-password line on stdin", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const keychain = security();
    await storeSecret("claude:x", KEY, "keychain");
    const [write] = keychain.calls();
    expect(write?.argv).toEqual(["-i"]);
    const input = write?.stdin ?? "";
    expect(input.endsWith("\n")).toBe(true);
    expect(input.split("\n")).toHaveLength(2);
    const args = splitSecurityLine(input.slice(0, -1));
    expect(args.slice(0, -1)).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "clausona-claude:x",
      "-a",
      "claude:x",
      "-X",
    ]);
    expect(Buffer.from(args.at(-1) as string, "hex").toString("utf8")).toBe(KEY);
    expect(keychain.stored("clausona-claude:x", "claude:x")).toBe(KEY);
  });

  it("quotes a profile id the line splitter would otherwise break apart", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const keychain = security();
    const id = `claude:we"ird\\ 'id`;
    await storeSecret(id, KEY, "keychain");
    const args = splitSecurityLine((keychain.calls()[0]?.stdin ?? "").slice(0, -1));
    expect(args.slice(0, 6)).toEqual(["add-generic-password", "-U", "-s", `clausona-${id}`, "-a", id]);
    expect(keychain.stored(`clausona-${id}`, id)).toBe(KEY);
  });

  it("throws when security reports the write failed", { timeout: SPAWNING_TEST_TIMEOUT_MS }, async () => {
    security("fail");
    await expect(storeSecret("claude:x", KEY, "keychain")).rejects.toThrow(/could not write Keychain item/);
  });

  // security's exit status is the OSStatus cut to 8 bits, and `-i` reports a result of -1 as
  // 0: a write can fail and still exit 0. Reading the item back is what catches it.
  it("throws when the write did not land although security exited 0", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const keychain = security("drop");
    const outcome = await storeSecret("claude:x", KEY, "keychain").catch((error: Error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Keychain item 'clausona-claude:x' did not take the new value");
    // Read back by service and account, the value on stdout: the key is in no argument.
    expect(keychain.calls().map(({ argv }) => argv)).toEqual([
      ["-i"],
      ["find-generic-password", "-s", "clausona-claude:x", "-a", "claude:x", "-w"],
    ]);
  });

  // find-generic-password -w prints the whole value as hex when any byte is not printable
  // ASCII, so the read-back compares against that, not against the key as typed.
  it("accepts the hex security prints back for a key with a non-ASCII character", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const keychain = security();
    const key = ["sk", "fixture", "\u00e9t\u00e9"].join("-");
    await expect(storeSecret("claude:x", key, "keychain")).resolves.toBeUndefined();
    expect(keychain.stored("clausona-claude:x", "claude:x")).toBe(key);
  });

  // A line break would end the command there and hand the rest of the id to `security` as
  // a command of its own.
  it("refuses an id with a line break, without running security", async () => {
    const keychain = security();
    await expect(storeSecret("claude:x\ndelete-keychain", KEY, "keychain")).rejects.toThrow(/line break/);
    expect(keychain.calls()).toEqual([]);
  });

  // `security -i` cuts a longer line and runs the rest as a second command, so the item
  // would be overwritten with a truncated key.
  it("refuses a key too long for one security line, without running security", async () => {
    const keychain = security();
    await expect(storeSecret("claude:x", `sk-fixture-${"k".repeat(2100)}`, "keychain")).rejects.toThrow(/too long/);
    expect(keychain.calls()).toEqual([]);
  });
});

// detectBackend() reports "keychain" on macOS, so exercising the file backend on this
// platform requires forcing it explicitly via the optional `backend` override on
// storeSecret/resolveSecret/deleteSecret. The module also resolves its secrets.json path
// from homedir() at load time, so a fresh module graph is required after HOME is stubbed -
// and USERPROFILE with it, which is where homedir() looks on Windows.
describe("file backend (forced via the backend override)", () => {
  it("stores, resolves, and deletes a secret", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret, resolveSecret: resolveSecretFresh, deleteSecret } = await import("./secrets.js");

    await storeSecret("claude:file-test", "sk-file-secret", "file");
    await expect(resolveSecretFresh("claude:file-test", { source: "keychain" }, "file")).resolves.toBe(
      "sk-file-secret",
    );

    await deleteSecret("claude:file-test", "file");
    await expect(resolveSecretFresh("claude:file-test", { source: "keychain" }, "file")).rejects.toThrow(
      /no stored secret/,
    );
  });

  // Off macOS this file is all that keeps a stored key from other users on the machine, and
  // nothing else pinned it: a writer without the mode shipped with every test green. Windows has
  // no mode bits to check; there the file is private because it sits in the user's profile.
  it.skipIf(process.platform === "win32")(
    "writes secrets.json for its owner alone, and rewrites a looser one so",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
      temps.push(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.resetModules();
      const { storeSecret } = await import("./secrets.js");
      const secretsPath = path.join(home, ".clausona", "secrets.json");

      await storeSecret("claude:a", "secret-a", "file");
      const written = statSync(secretsPath).mode & 0o777;
      chmodSync(secretsPath, 0o644);
      await storeSecret("claude:b", "secret-b", "file");
      const rewritten = statSync(secretsPath).mode & 0o777;

      expect(written.toString(8)).toBe("600");
      expect(rewritten.toString(8)).toBe("600");
    },
  );

  // Regression test for a data-loss bug: readSecretsFile used to collapse every read
  // failure (corrupt file, EACCES, ...) into `{}`, and storeSecret/deleteSecret do a
  // read-modify-write over that result — so a corrupt file made the next store/delete
  // silently rewrite secrets.json with only the entry being touched, destroying every
  // other profile's credential with no error. The corruption here appends garbage after
  // valid JSON (a truncated/partial-write is a realistic way this happens), which keeps
  // "secret-a" present in the raw bytes but makes the file fail to parse - so this test
  // can tell "rejected without touching the file" apart from "silently lost the data".
  it("does not destroy existing secrets when the file is corrupt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret } = await import("./secrets.js");

    await storeSecret("claude:a", "secret-a", "file");

    const secretsPath = path.join(home, ".clausona", "secrets.json");
    const validContent = readFileSync(secretsPath, "utf8");
    writeFileSync(secretsPath, `${validContent.trimEnd()}not json`);

    await expect(storeSecret("claude:b", "secret-b", "file")).rejects.toThrow();
    expect(readFileSync(secretsPath, "utf8")).toContain("secret-a");
  });

  it("rejects when the stored JSON is not an object", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { resolveSecret: resolveSecretFresh } = await import("./secrets.js");

    const secretsPath = path.join(home, ".clausona", "secrets.json");
    mkdirSync(path.dirname(secretsPath), { recursive: true });
    writeFileSync(secretsPath, "[]");

    await expect(resolveSecretFresh("claude:x", { source: "keychain" }, "file")).rejects.toThrow(secretsPath);
  });

  it("treats a missing file as no stored secret, not a read error", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { resolveSecret: resolveSecretFresh } = await import("./secrets.js");

    await expect(resolveSecretFresh("claude:missing", { source: "keychain" }, "file")).rejects.toThrow(
      /no stored secret/,
    );
  });

  // Doctor reports a source it does not know as an error and never resolves one; launch
  // reading the store for it anyway would work while doctor calls the profile broken.
  it.each([
    ["a source clausona does not know", { source: "vault" }],
    ["no source at all", undefined],
  ])("refuses %s rather than reading the store", async (_label, source) => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret, resolveSecret: resolveSecretFresh } = await import("./secrets.js");
    const stored = ["sk-", "stored-", "0f3a", "9c21"].join("");
    await storeSecret("claude:x", stored, "file");

    const outcome = await resolveSecretFresh("claude:x", source as unknown as SecretSource, "file").then(
      (value) => value,
      (error: Error) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    const message = (outcome as Error).message;
    expect(message).toMatch(/not keychain, env or command/);
    expect(message).toContain("clausona config claude:x --key");
    expect(message).not.toContain(stored);
  });
});
