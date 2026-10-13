import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SPAWNING_TEST_TIMEOUT_MS } from "../test-timeouts.js";
import { codexHomesInPsLine, codexProcessesFor, normalizeHome } from "./running-codex.js";

describe("codexHomesInPsLine", () => {
  it("reads CODEX_HOME out of the environment ps -E prints after the command", () => {
    expect(codexHomesInPsLine("/opt/codex/codex resume CODEX_HOME=/Users/me/.codex-work/ PATH=/usr/bin")).toEqual([
      "/Users/me/.codex-work/",
    ]);
    expect(codexHomesInPsLine("codex TERM=xterm CODEX_HOME=~/.codex-work")).toEqual(["~/.codex-work"]);
  });

  it("keeps a value with a space in it whole, up to the next variable", () => {
    expect(codexHomesInPsLine("codex CODEX_HOME=/Users/me/My Codex HOME=/Users/me")).toEqual(["/Users/me/My Codex"]);
  });

  it("finds none where there is none", () => {
    expect(codexHomesInPsLine("codex SUPERSET_CODEX_HOME=/x PATH=/usr/bin")).toEqual([]);
  });
});

describe("normalizeHome", () => {
  it("spells a home one way: ~ expanded, a trailing separator and relative parts resolved", async () => {
    const nowhere = path.join(path.parse(process.cwd()).root, "nowhere-clausona", "codex-work");
    expect(await normalizeHome(`${nowhere}${path.sep}`)).toBe(nowhere);
    expect(await normalizeHome(path.join(nowhere, "..", "codex-work"))).toBe(nowhere);
    expect(await normalizeHome("~/nowhere-clausona-codex")).toBe(path.join(homedir(), "nowhere-clausona-codex"));
  });
});

describe.skipIf(process.platform === "win32")("codexProcessesFor, with stand-ins for pgrep and ps", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A Codex home to look for, and shell scripts beside it to stand in for pgrep and ps. */
  function scratch() {
    const dir = mkdtempSync(path.join(tmpdir(), "clausona-running-"));
    temps.push(dir);
    const home = path.join(dir, ".codex-work");
    mkdirSync(home);
    const script = (name: string, body: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    };
    // exec, so the kill at the time limit stops the sleep itself and leaves nothing running.
    const sleeper = (name: string) => script(name, "exec sleep 30");
    // ps -wwE -o command= -p <pid>: the pid is its fifth argument. ps prints nothing for another.
    const ps = (name: string, lines: Record<string, string>) =>
      script(
        name,
        `case "$5" in ${Object.entries(lines)
          .map(([pid, line]) => `${pid}) ${line} ;;`)
          .join(" ")} *) exit 1 ;; esac`,
      );
    return { home, script, sleeper, ps };
  }

  it("finds the ids whose CODEX_HOME is the home, from what pgrep and ps print", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const { home, script, ps } = scratch();
    const pgrep = script("pgrep", "echo 101; echo 202");
    const lines = { 101: `echo "codex CODEX_HOME=${home}/ PATH=/usr/bin"`, 202: `echo "codex CODEX_HOME=/elsewhere"` };

    expect(await codexProcessesFor(home, { platform: "darwin", pgrep, ps: ps("ps", lines) })).toEqual([101]);
    // pgrep's answer when nothing matches: nothing printed, and exit 1.
    const none = script("pgrep-none", "exit 1");
    expect(await codexProcessesFor(home, { platform: "darwin", pgrep: none, ps: ps("ps", lines) })).toEqual([]);
  });

  it("gives no answer when pgrep or ps runs out of time, as on a busy machine", {
    timeout: SPAWNING_TEST_TIMEOUT_MS,
  }, async () => {
    const { home, script, sleeper, ps } = scratch();
    const timeoutMs = 500;
    const elsewhere = ps("ps", { 101: `echo "codex CODEX_HOME=/elsewhere"` });

    expect(
      await codexProcessesFor(home, { platform: "darwin", pgrep: sleeper("pgrep"), ps: elsewhere, timeoutMs }),
    ).toBeNull();
    const pgrep = script("pgrep-answers", "echo 101");
    expect(await codexProcessesFor(home, { platform: "darwin", pgrep, ps: sleeper("ps"), timeoutMs })).toBeNull();
  });
});
