import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderPosixExports, renderPowerShellInit, renderShellInit } from "./shell.js";

const ZSH_AVAILABLE = spawnSync("which", ["zsh"]).status === 0;
const BASH_AVAILABLE = spawnSync("which", ["bash"]).status === 0;

// Two PowerShell cold starts running concurrently on a CI runner took 10s and 22s, so
// both the spawn budget and the surrounding test budget are sized for contention.
const POWERSHELL_SPAWN_TIMEOUT_MS = 45_000;
const POWERSHELL_TEST_TIMEOUT_MS = 60_000;
const describeIfZsh = ZSH_AVAILABLE ? describe : describe.skip;
const describeIfBash = BASH_AVAILABLE ? describe : describe.skip;

const UNSET = "<unset>";

/**
 * A profile's environment as the API-backed case produces it: a config dir, a base URL,
 * and a token whose value carries a single quote and a newline. Everything here is a
 * local placeholder - the point is that `renderPosixExports` plus the hook's `eval`
 * deliver the bytes unchanged.
 */
const AWKWARD_TOKEN = "placeholder-it's\nsecond-line";
const LOCAL_BASE_URL = "http://127.0.0.1:8787/v1";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

type Harness = {
  root: string;
  home: string;
  binDir: string;
  envDir: string;
  logPath: string;
  log(): string[];
};

/**
 * A POSIX `${NAME:-fallback}` expansion. Assembled rather than written literally so it is
 * not mistaken for - or reformatted as - a JavaScript template placeholder.
 */
function expand(name: string, fallback: string): string {
  return `\${${name}:-${fallback}}`;
}

/** A stand-in `clausona` that records what the hook called and replays a canned env. */
const FAKE_CLAUSONA = [
  "#!/bin/sh",
  'log="$CLAUSONA_TEST_LOG"',
  'case "$1" in',
  "  _shell-env)",
  '    printf "shell-env %s\\n" "$2" >> "$log"',
  '    if [ -f "$CLAUSONA_TEST_ENV_DIR/$2.env" ]; then cat "$CLAUSONA_TEST_ENV_DIR/$2.env"; fi',
  "    ;;",
  "  _sync-plugins)",
  `    printf "sync-plugins CLAUDE_CONFIG_DIR=%s\\n" "${expand("CLAUDE_CONFIG_DIR", UNSET)}" >> "$log"`,
  "    ;;",
  "  _track-usage)",
  `    printf "track-usage CLAUDE_CONFIG_DIR=%s\\n" "${expand("CLAUDE_CONFIG_DIR", UNSET)}" >> "$log"`,
  "    ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/** A stand-in tool that reports the environment it was actually launched with. */
function fakeTool(configVar: string): string {
  return [
    "#!/bin/sh",
    'printf "args=%s\\n" "$*"',
    `printf "${configVar}=%s\\n" "${expand(configVar, UNSET)}"`,
    `printf "ANTHROPIC_BASE_URL=%s\\n" "${expand("ANTHROPIC_BASE_URL", UNSET)}"`,
    `printf "ANTHROPIC_AUTH_TOKEN=[%s]\\n" "${expand("ANTHROPIC_AUTH_TOKEN", UNSET)}"`,
    `exit ${expand("CLAUSONA_TEST_TOOL_EXIT", "0")}`,
    "",
  ].join("\n");
}

function makeHarness(env: { claude?: Record<string, string>; codex?: Record<string, string> } = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "clausona-shell-"));
  tmpDirs.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const envDir = path.join(root, "env");
  for (const dir of [home, binDir, envDir]) mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(binDir, "clausona"), FAKE_CLAUSONA, { mode: 0o755 });
  writeFileSync(path.join(binDir, "claude"), fakeTool("CLAUDE_CONFIG_DIR"), { mode: 0o755 });
  writeFileSync(path.join(binDir, "codex"), fakeTool("CODEX_HOME"), { mode: 0o755 });

  // Written through the real renderer, so the eval in the hook consumes exactly the
  // bytes `clausona _shell-env` would have produced.
  writeFileSync(path.join(envDir, "claude.env"), renderPosixExports(env.claude ?? {}));
  writeFileSync(path.join(envDir, "codex.env"), renderPosixExports(env.codex ?? {}));

  const logPath = path.join(root, "calls.log");
  writeFileSync(logPath, "");

  return {
    root,
    home,
    binDir,
    envDir,
    logPath,
    log: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

type ShellName = "zsh" | "bash";

// -f for zsh and --noprofile --norc for bash both mean "read no startup files"; the
// spellings are not interchangeable (bash -f disables globbing instead).
const NO_RC_ARGS: Record<ShellName, string[]> = {
  zsh: ["-f"],
  bash: ["--noprofile", "--norc"],
};

function runShell(
  shell: ShellName,
  harness: Harness,
  body: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const script = `${renderShellInit()}\n${body}\n`;
  const result = spawnSync(shell, [...NO_RC_ARGS[shell], ...extraArgs, "-c", script], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: `${harness.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: harness.home,
      CLAUSONA_TEST_LOG: harness.logPath,
      CLAUSONA_TEST_ENV_DIR: harness.envDir,
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Prints the parent shell's view of a variable after the wrapped command returned. */
function reportParent(...names: string[]): string {
  return names.map((name) => `printf "parent ${name}=%s\\n" "\${${name}:-${UNSET}}"`).join("\n");
}

for (const shell of ["zsh", "bash"] as const) {
  const describeIfShell = shell === "zsh" ? describeIfZsh : describeIfBash;

  describeIfShell(`posix shell integration (real ${shell})`, () => {
    it("applies the profile environment to the tool and leaks nothing into the parent", () => {
      const workDir = "/tmp/clausona-test-claude-work";
      const harness = makeHarness({
        claude: {
          CLAUDE_CONFIG_DIR: workDir,
          ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: AWKWARD_TOKEN,
        },
      });

      const result = runShell(
        shell,
        harness,
        [
          "claude --version",
          'printf "rc=%s\\n" "$?"',
          reportParent("CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"),
        ].join("\n"),
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // Inside the subshell the tool sees the whole profile environment...
      expect(result.stdout).toContain("args=--version");
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${workDir}`);
      expect(result.stdout).toContain(`ANTHROPIC_BASE_URL=${LOCAL_BASE_URL}`);
      expect(result.stdout).toContain(`ANTHROPIC_AUTH_TOKEN=[${AWKWARD_TOKEN}]`);
      // ...and the parent shell sees none of it.
      expect(result.stdout).toContain(`parent CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(result.stdout).toContain(`parent ANTHROPIC_BASE_URL=${UNSET}`);
      expect(result.stdout).toContain(`parent ANTHROPIC_AUTH_TOKEN=${UNSET}`);
    });

    it("leaves a variable the user exported themselves untouched", () => {
      const userBaseUrl = "http://127.0.0.1:9999/mine";
      const harness = makeHarness({
        claude: { ANTHROPIC_BASE_URL: LOCAL_BASE_URL },
      });

      const result = runShell(shell, harness, ["claude", reportParent("ANTHROPIC_BASE_URL")].join("\n"), {
        ANTHROPIC_BASE_URL: userBaseUrl,
      });

      expect(result.status).toBe(0);
      // The profile wins for the duration of the run...
      expect(result.stdout).toContain(`ANTHROPIC_BASE_URL=${LOCAL_BASE_URL}`);
      // ...and the user's own value is intact afterwards.
      expect(result.stdout).toContain(`parent ANTHROPIC_BASE_URL=${userBaseUrl}`);
    });

    it("propagates a non-zero exit code out of the subshell", () => {
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-claude-work" } });

      const result = runShell(shell, harness, ['claude\nprintf "rc=%s\\n" "$?"'].join("\n"), {
        CLAUSONA_TEST_TOOL_EXIT: "42",
      });

      expect(result.stdout).toContain("rc=42");
      // The function's own return value, not just the echoed number.
      const chained = runShell(shell, harness, 'claude && printf "SHOULD_NOT_RUN\\n"', {
        CLAUSONA_TEST_TOOL_EXIT: "42",
      });
      expect(chained.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(chained.status).toBe(42);
    });

    it("runs _sync-plugins inside the subshell and _track-usage after it", () => {
      const workDir = "/tmp/clausona-test-claude-work";
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: workDir } });

      const result = runShell(shell, harness, "claude");

      expect(result.status).toBe(0);
      expect(harness.log()).toEqual([
        "shell-env claude",
        // Inside the subshell, so the plugin sync sees the profile's config dir...
        `sync-plugins CLAUDE_CONFIG_DIR=${workDir}`,
        // ...while usage tracking runs in the parent, which never had it.
        `track-usage CLAUDE_CONFIG_DIR=${UNSET}`,
      ]);
    });

    it("steps aside entirely when the user set CLAUDE_CONFIG_DIR", () => {
      const userDir = "/tmp/clausona-test-user-dir";
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-claude-work" } });

      const result = runShell(
        shell,
        harness,
        ["claude", 'printf "aside rc=%s\\n" "$?"', reportParent("CLAUDE_CONFIG_DIR")].join("\n"),
        { CLAUDE_CONFIG_DIR: userDir, CLAUSONA_TEST_TOOL_EXIT: "9" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${userDir}`);
      // This branch is `command claude "$@"; return $?` - a regression that swallowed the
      // status here would still pass a test run against a tool that exits 0.
      expect(result.stdout).toContain("aside rc=9");
      // The old hook unset the user's variable on the way out; this one must not.
      expect(result.stdout).toContain(`parent CLAUDE_CONFIG_DIR=${userDir}`);
      expect(harness.log()).toEqual([]);

      // The function's own return value, not just the echoed number.
      const chained = runShell(shell, harness, 'claude && printf "SHOULD_NOT_RUN\\n"', {
        CLAUDE_CONFIG_DIR: userDir,
        CLAUSONA_TEST_TOOL_EXIT: "9",
      });
      expect(chained.stdout).not.toContain("SHOULD_NOT_RUN");
      expect(chained.status).toBe(9);
    });

    it("sets nothing at all when the profile resolves to an empty environment", () => {
      // The primary/subscription case: `_shell-env` prints nothing, so the tool must run
      // exactly as it would without clausona - and usage tracking still happens.
      const harness = makeHarness();

      const result = runShell(shell, harness, ["claude", reportParent("CLAUDE_CONFIG_DIR")].join("\n"));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(result.stdout).toContain(`parent CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(harness.log()).toContain("track-usage CLAUDE_CONFIG_DIR=<unset>");
    });

    it("drives codex on the same mechanism, without usage tracking", () => {
      const codexDir = "/tmp/clausona-test-codex-work";
      const harness = makeHarness({ codex: { CODEX_HOME: codexDir } });

      const result = runShell(shell, harness, ["codex exec", reportParent("CODEX_HOME")].join("\n"));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("args=exec");
      expect(result.stdout).toContain(`CODEX_HOME=${codexDir}`);
      expect(result.stdout).toContain(`parent CODEX_HOME=${UNSET}`);
      expect(harness.log()).toEqual(["shell-env codex"]);
    });

    it("steps aside for codex too, exit code intact", () => {
      const userDir = "/tmp/clausona-test-codex-user-dir";
      const harness = makeHarness({ codex: { CODEX_HOME: "/tmp/clausona-test-codex-work" } });

      const result = runShell(shell, harness, ["codex", 'printf "aside rc=%s\\n" "$?"'].join("\n"), {
        CODEX_HOME: userDir,
        CLAUSONA_TEST_TOOL_EXIT: "9",
      });

      expect(result.stdout).toContain(`CODEX_HOME=${userDir}`);
      expect(result.stdout).toContain("aside rc=9");
      expect(harness.log()).toEqual([]);
    });

    it("forwards arguments containing shell metacharacters verbatim", () => {
      const harness = makeHarness();

      const result = runShell(shell, harness, `claude 'hello $(id) & echo INJECTED' '*'`);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("args=hello $(id) & echo INJECTED *");
      expect(result.stdout).not.toContain("INJECTED\n");
    });
  });
}

describeIfZsh("posix shell integration (interactive zsh)", () => {
  /**
   * A smoke test, and only that: it establishes that the emitted script parses under `-i`
   * and that both wrappers end up defined as functions.
   *
   * It does NOT catch the bug it looks like it catches. A `!` inside a double-quoted string
   * is history-expanded when the function is *defined*, which breaks `source ~/.zshrc` for
   * every user - but zsh does not history-expand a `-c` script, with or without `-i`. Adding
   * `command claude "$@!version"` to the script and running it here yields status 0, empty
   * stderr, and a function body that still holds `"$@!version"` verbatim. The static scan in
   * shell.test.ts ("does not use ! inside double-quoted strings") is the guard for that class.
   */
  it("sources cleanly in an interactive zsh", () => {
    const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-claude-work" } });

    const result = runShell(
      "zsh",
      harness,
      ['printf "sourced=%s\\n" "$(whence -w claude)"', 'printf "sourced=%s\\n" "$(whence -w codex)"'].join("\n"),
      {},
      ["-i"],
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sourced=claude: function");
    expect(result.stdout).toContain("sourced=codex: function");
  });
});

const describeIfPowerShell = process.platform === "win32" ? describe : describe.skip;

/**
 * Windows-only: the PowerShell hook has no subshell to throw away, so it captures and
 * restores each variable by hand. These run only on win32 - everything they assert about
 * the generated script's shape is also pinned statically in shell.test.ts.
 */
describeIfPowerShell("PowerShell wrapper integration", () => {
  type WindowsHarness = { binDir: string; logPath: string; log(): string[] };

  /**
   * `echo` is the only way to emit the payload from a .cmd, and cmd.exe reads these as
   * operators inside one. `^` has to come first, or it would double the carets the later
   * replacements introduce; `%` escapes as `%%` rather than with a caret, because a batch
   * file would otherwise read `%NAME%` as a variable to expand.
   *
   * No value used below contains any of them today - this is here so that one which does
   * fails on its own assertion rather than inside cmd.exe.
   */
  function escapeForCmdEcho(text: string): string {
    return text
      .replaceAll("^", "^^")
      .replaceAll("&", "^&")
      .replaceAll("|", "^|")
      .replaceAll("<", "^<")
      .replaceAll(">", "^>")
      .replaceAll("%", "%%");
  }

  function makeWindowsHarness(env: Record<string, string>): WindowsHarness {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-shell-ps-"));
    tmpDirs.push(root);
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = path.join(root, "calls.log");
    writeFileSync(logPath, "");

    // Logs every subcommand the hook asks for, so the call sequence can be asserted the way
    // the POSIX harness does; `_shell-env <tool> --json` is the only one that answers.
    writeFileSync(
      path.join(binDir, "clausona.cmd"),
      [
        "@echo off",
        '>>"%CLAUSONA_TEST_LOG%" echo %1',
        'if not "%1"=="_shell-env" exit /b 0',
        `echo ${escapeForCmdEcho(JSON.stringify(env))}`,
        "exit /b 0",
      ].join("\r\n"),
    );
    for (const [tool, configVar] of [
      ["claude", "CLAUDE_CONFIG_DIR"],
      ["codex", "CODEX_HOME"],
    ]) {
      writeFileSync(
        path.join(binDir, `${tool}.cmd`),
        [
          "@echo off",
          `node -e "const v=n=>process.env[n]===undefined?'<unset>':process.env[n];process.stdout.write([v('${configVar}'),v('ANTHROPIC_BASE_URL'),JSON.stringify(v('ANTHROPIC_AUTH_TOKEN')),process.argv[1]||''].join('|'))" %*`,
          `exit /b %CLAUSONA_TEST_TOOL_EXIT%`,
        ].join("\r\n"),
      );
    }

    return {
      binDir,
      logPath,
      log: () =>
        readFileSync(logPath, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
    };
  }

  function runPowerShell(harness: WindowsHarness, body: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${renderPowerShellInit()}\n${body}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUSONA_TEST_TOOL_EXIT: "0",
          ...extraEnv,
          CLAUSONA_TEST_LOG: harness.logPath,
          PATH: `${harness.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: POWERSHELL_SPAWN_TIMEOUT_MS,
      },
    );
  }

  it(
    "applies the profile environment and preserves metacharacters in arguments",
    () => {
      const workDir = "C:\\clausona-test\\work";
      const harness = makeWindowsHarness({
        CLAUDE_CONFIG_DIR: workDir,
        ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: AWKWARD_TOKEN,
      });

      const result = runPowerShell(harness, `claude 'hello & echo INJECTED'`);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(workDir);
      expect(result.stdout).toContain(LOCAL_BASE_URL);
      // A value carrying a single quote and a newline must survive ConvertFrom-Json.
      expect(result.stdout).toContain(JSON.stringify(AWKWARD_TOKEN));
      expect(result.stdout).toContain("hello & echo INJECTED");
      // The same call sequence the POSIX tests pin, in the same order.
      expect(harness.log()).toEqual(["_shell-env", "_sync-plugins", "_track-usage"]);
    },
    // Cold powershell.exe startup on a CI runner took 5.4s, over vitest's 5s default, so
    // the test was killed before it could assert. Must exceed the spawn timeout above.
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "restores a previously unset variable to unset, not to an empty string",
    () => {
      const harness = makeWindowsHarness({ ANTHROPIC_BASE_URL: LOCAL_BASE_URL });

      const result = runPowerShell(
        harness,
        [
          "claude | Out-Null",
          `if (Test-Path Env:ANTHROPIC_BASE_URL) { 'STILL_SET' } else { 'REMOVED' }`,
          `$env:CLAUDE_CONFIG_DIR = 'C:\\mine'`,
          "claude | Out-Null",
          `$env:CLAUDE_CONFIG_DIR`,
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("REMOVED");
      expect(result.stdout).not.toContain("STILL_SET");
      // A variable the user set is restored to its own value, never blanked.
      expect(result.stdout).toContain("C:\\mine");
      // Three calls from the first invocation and none from the second: once the user has
      // set CLAUDE_CONFIG_DIR the wrapper steps aside and asks clausona for nothing.
      expect(harness.log()).toEqual(["_shell-env", "_sync-plugins", "_track-usage"]);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "propagates a non-zero exit code through LASTEXITCODE",
    () => {
      const harness = makeWindowsHarness({ CLAUDE_CONFIG_DIR: "C:\\clausona-test\\work" });

      const result = runPowerShell(harness, "claude | Out-Null\n$LASTEXITCODE", {
        CLAUSONA_TEST_TOOL_EXIT: "42",
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("42");
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "drives codex on the same helper, without plugin sync or usage tracking",
    () => {
      const codexHome = "C:\\clausona-test\\codex";
      const harness = makeWindowsHarness({ CODEX_HOME: codexHome });

      const result = runPowerShell(harness, "codex exec");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(codexHome);
      expect(result.stdout).toContain("exec");
      // _sync-plugins and _track-usage are claude-only on this platform too.
      expect(harness.log()).toEqual(["_shell-env"]);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );
});
