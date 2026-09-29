import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  launchCachePath,
  launchRefPath,
  pluginSyncStampPath,
  pluginSyncWatchList,
  registryStamp,
  renderPosixSyncCheck,
} from "./launch-cache.js";
import {
  LAUNCH_MARKER,
  posixQuote,
  renderLaunchJson,
  renderPosixExports,
  renderPowerShellInit,
  renderShellInit,
  type ShellInitPaths,
} from "./shell.js";

const ZSH_AVAILABLE = spawnSync("which", ["zsh"]).status === 0;
const BASH_AVAILABLE = spawnSync("which", ["bash"]).status === 0;

// Two PowerShell cold starts running concurrently on a CI runner took 10s and 22s, so
// both the spawn budget and the surrounding test budget are sized for contention.
const POWERSHELL_SPAWN_TIMEOUT_MS = 45_000;
const POWERSHELL_TEST_TIMEOUT_MS = 60_000;
// On Windows renderShellInit() renders the PowerShell hook, which is what users there get -
// and a runner's Git Bash, which `which bash` finds, would be handed it.
const POSIX_HOST = process.platform !== "win32";
const describeIfZsh = POSIX_HOST && ZSH_AVAILABLE ? describe : describe.skip;
const describeIfBash = POSIX_HOST && BASH_AVAILABLE ? describe : describe.skip;

const UNSET = "<unset>";

/** What the stand-in `_track-usage` logs when the hook calls it outside the tool's subshell. */
const TRACKED = `track-usage CLAUDE_CONFIG_DIR=${UNSET}`;

/**
 * How long a case waits for `_track-usage`, which the hook starts in the background, so the
 * shell can exit before it has run. Generous, because only a call that never comes waits it
 * out, and a loaded runner can take seconds to start a process.
 */
const TRACK_WAIT_MS = 10_000;

/**
 * Polls `read` until `done` holds for what it returns, or TRACK_WAIT_MS has passed, and
 * returns the last reading either way - so a call that never came fails the assertion that
 * follows, with the reading in its message, rather than timing the case out.
 */
async function waitFor<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + TRACK_WAIT_MS;
  for (;;) {
    const value = read();
    if (done(value) || Date.now() >= deadline) return value;
    await sleep(25);
  }
}

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
    // Retried as well: a process the case started that is still writing here - which every
    // case waits out, see STDIO_AWAITING_BACKGROUND - would otherwise fail the removal.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

type Harness = {
  root: string;
  home: string;
  binDir: string;
  envDir: string;
  logPath: string;
  /** The cache and registry paths the hook is rendered with, all under `root`. */
  paths: ShellInitPaths;
  /** The config dir and primary the stand-in `_launch` script's plugin check points at. */
  plugins: { configDir: string; primary: string };
  log(): string[];
  /** The log once `_track-usage` has written to it, which it does in the background. */
  logTracked(): Promise<string[]>;
};

/** Whole seconds: bash 3.2, macOS's own, compares mtimes to the second. */
const NOW = Math.floor(Date.now() / 1000);

/** A cached script that must never be applied, marker and all, so nothing but its age stops it. */
const STALE = `${LAUNCH_MARKER}\nexport CLAUDE_CONFIG_DIR='/tmp/clausona-test-stale-cache'`;

function setMtime(target: string, seconds: number) {
  utimesSync(target, seconds, seconds);
}

/**
 * A launch script in the hook's cache, as `_launch` would have left it, `seconds` old: with
 * its ref, a hard link to the profiles.json there is now.
 */
function writeCache(harness: Harness, tool: "claude" | "codex", content: string, seconds: number) {
  const cachePath = harness.paths.cachePath(tool, "posix");
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, content);
  setMtime(cachePath, seconds);
  const refPath = harness.paths.refPath(tool);
  rmSync(refPath, { force: true });
  linkSync(harness.paths.registryPath, refPath);
}

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
  "  _launch)",
  '    printf "launch %s\\n" "$2" >> "$log"',
  '    if [ -f "$CLAUSONA_TEST_ENV_DIR/$2.env" ]; then cat "$CLAUSONA_TEST_ENV_DIR/$2.env"; fi',
  "    ;;",
  "  _sync-plugins)",
  `    printf "sync-plugins CLAUDE_CONFIG_DIR=%s\\n" "${expand("CLAUDE_CONFIG_DIR", UNSET)}" >> "$log"`,
  "    ;;",
  "  _track-usage)",
  // Slowed down by CLAUSONA_TEST_TRACK_DELAY, to show that the hook does not wait for it.
  `    sleep "${expand("CLAUSONA_TEST_TRACK_DELAY", "0")}"`,
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
    `printf "ANTHROPIC_API_KEY=[%s]\\n" "${expand("ANTHROPIC_API_KEY", UNSET)}"`,
    `exit ${expand("CLAUSONA_TEST_TOOL_EXIT", "0")}`,
    "",
  ].join("\n");
}

/** A tool's environment, as `--json` spells it: null means "must not be inherited". */
type ToolEnv = Record<string, string | null>;

/** Splits a payload the way `_launch` does, and renders it through the real renderer. */
function renderToolEnv(env: ToolEnv = {}): string {
  const exports: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === null) unset.push(key);
    else exports[key] = value;
  }
  return renderPosixExports(exports, unset);
}

/** Script lines joined as `_launch` joins them, after its marker, leaving out an empty part. */
function launchScript(...parts: string[]): string {
  return [LAUNCH_MARKER, ...parts].filter((part) => part !== "").join("\n");
}

function makeHarness(env: { claude?: ToolEnv; codex?: ToolEnv } = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "clausona-shell-"));
  tmpDirs.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const envDir = path.join(root, "env");
  const clausonaDir = path.join(root, "clausona");
  const plugins = { configDir: path.join(root, "claude-work"), primary: path.join(root, "claude-primary") };
  for (const dir of [home, binDir, envDir, clausonaDir]) mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(binDir, "clausona"), FAKE_CLAUSONA, { mode: 0o755 });
  writeFileSync(path.join(binDir, "claude"), fakeTool("CLAUDE_CONFIG_DIR"), { mode: 0o755 });
  writeFileSync(path.join(binDir, "codex"), fakeTool("CODEX_HOME"), { mode: 0o755 });

  // Written through the real renderers, so the eval in the hook consumes exactly the bytes
  // `clausona _launch` would have produced: claude's ends in the plugin check, whose stamp
  // does not exist yet, so the sync is due.
  writeFileSync(
    path.join(envDir, "claude.env"),
    launchScript(renderToolEnv(env.claude), renderPosixSyncCheck(plugins.configDir, plugins.primary)),
  );
  writeFileSync(path.join(envDir, "codex.env"), launchScript(renderToolEnv(env.codex)));

  // A registry, and no cache: the hook has to ask `_launch` until a test writes one.
  const registryPath = path.join(clausonaDir, "profiles.json");
  writeFileSync(registryPath, "{}");
  setMtime(registryPath, NOW - 100);

  const logPath = path.join(root, "calls.log");
  writeFileSync(logPath, "");
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");

  return {
    root,
    home,
    binDir,
    envDir,
    logPath,
    paths: {
      cachePath: (tool, format) => launchCachePath(clausonaDir, tool, format, "0.0.0-test"),
      refPath: (tool) => launchRefPath(clausonaDir, tool, "0.0.0-test"),
      registryPath,
      home,
    },
    plugins,
    log,
    logTracked: () => waitFor(log, (lines) => lines.includes(TRACKED)),
  };
}

type ShellName = "zsh" | "bash";

// -f for zsh and --noprofile --norc for bash both mean "read no startup files"; the
// spellings are not interchangeable (bash -f disables globbing instead).
const NO_RC_ARGS: Record<ShellName, string[]> = {
  zsh: ["-f"],
  bash: ["--noprofile", "--norc"],
};

/**
 * stdio for a shell whose background work - the hook's `_track-usage` - must be over when
 * spawnSync returns. The hook points only fds 0-2 of that job at /dev/null, so it inherits the
 * spare pipe on fd 3 like every other process the shell starts, and spawnSync reads each pipe
 * to its end: it returns once the last of them has exited. Without this the stand-in could
 * still be writing its log line into the case's directory while afterEach removes it.
 */
const STDIO_AWAITING_BACKGROUND = ["pipe", "pipe", "pipe", "pipe"] as const;

function runShell(
  shell: ShellName,
  harness: Harness,
  body: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  // Only for a case that shows the hook returns before `_track-usage` is done, and that waits
  // for its log line itself.
  { awaitBackground = true }: { awaitBackground?: boolean } = {},
): { status: number | null; stdout: string; stderr: string } {
  const script = `${renderShellInit(process.platform, harness.paths)}\n${body}\n`;
  const result = spawnSync(shell, [...NO_RC_ARGS[shell], ...extraArgs, "-c", script], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: awaitBackground ? [...STDIO_AWAITING_BACKGROUND] : "pipe",
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

    // An API profile clears a credential the user exported for something else, because
    // Claude Code would send it to the profile's endpoint next to the profile's own. The
    // unset runs inside the hook's subshell, so it lasts exactly as long as the tool.
    it("keeps a credential the profile clears from the tool, and only from the tool", () => {
      const parentKey = "sk-ant-parent-sentinel";
      const harness = makeHarness({
        claude: {
          ANTHROPIC_API_KEY: null,
          ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: AWKWARD_TOKEN,
        },
      });

      const result = runShell(shell, harness, ["claude", reportParent("ANTHROPIC_API_KEY")].join("\n"), {
        ANTHROPIC_API_KEY: parentKey,
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // The tool gets the profile's own credential and not the parent's...
      expect(result.stdout).toContain(`ANTHROPIC_AUTH_TOKEN=[${AWKWARD_TOKEN}]`);
      expect(result.stdout).toContain(`ANTHROPIC_API_KEY=[${UNSET}]`);
      // ...and the parent's is back, untouched, once the tool has returned.
      expect(result.stdout).toContain(`parent ANTHROPIC_API_KEY=${parentKey}`);
      expect(result.stdout.split(parentKey)).toHaveLength(2);
    });

    /**
     * A variable the user made `readonly` cannot be unset. A plain `unset` fails the wrong
     * way in both shells - bash carries on and the tool gets the caller's credential; zsh
     * abandons the eval and the tool runs on the default account - so the run has to stop
     * instead, and say which variable stopped it.
     */
    it("refuses to start the tool when a variable the profile clears is read-only", async () => {
      const parentKey = "sk-ant-parent-sentinel";
      const harness = makeHarness({
        claude: {
          ANTHROPIC_API_KEY: null,
          CLAUDE_CONFIG_DIR: "/tmp/clausona-test-claude-work",
          ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "placeholder-token",
        },
      });

      const result = runShell(
        shell,
        harness,
        ["readonly ANTHROPIC_API_KEY", "claude", 'printf "rc=%s\\n" "$?"', reportParent("ANTHROPIC_API_KEY")].join(
          "\n",
        ),
        { ANTHROPIC_API_KEY: parentKey },
      );

      expect(result.status).toBe(0);
      // The tool never started, and the wrapper reports the failure...
      expect(result.stdout).not.toContain("args=");
      expect(result.stdout).toContain("rc=1");
      // ...with the variable's name on stderr, and nothing of its value.
      expect(result.stderr).toContain("clausona: ANTHROPIC_API_KEY is read-only in this shell");
      expect(result.stderr).not.toContain(parentKey);
      expect(result.stdout).toContain(`parent ANTHROPIC_API_KEY=${parentKey}`);
      // The plugin sync inside the subshell never ran; usage tracking after it still did.
      expect(await harness.logTracked()).toEqual(["launch claude", TRACKED]);
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

    it("runs a due plugin sync inside the subshell, and _track-usage after it", async () => {
      const workDir = "/tmp/clausona-test-claude-work";
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: workDir } });

      const result = runShell(shell, harness, "claude");

      expect(result.status).toBe(0);
      expect(await harness.logTracked()).toEqual([
        "launch claude",
        // Inside the subshell, so the plugin sync sees the profile's config dir...
        `sync-plugins CLAUDE_CONFIG_DIR=${workDir}`,
        // ...while usage tracking runs in the parent, which never had it.
        TRACKED,
      ]);
    });

    /**
     * `_track-usage` is another Node start, so the hook no longer waits for it: the prompt comes
     * back as soon as the tool exits, with the tool's exit code, and the usage is recorded after.
     * Here it takes seconds, and has still not written when the next command runs. Its streams
     * are not the shell's either, so the shell's own caller is not kept waiting for it - which is
     * why this case alone runs the shell without the spare pipe that waits background work out,
     * and waits for the log line itself instead.
     */
    it("returns the tool's exit code without waiting for _track-usage", async () => {
      const workDir = "/tmp/clausona-test-claude-work";
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: workDir } });
      const delaySeconds = 5;

      const started = Date.now();
      const result = runShell(
        shell,
        harness,
        [
          "claude",
          'printf "rc=%s\\n" "$?"',
          'if grep -q track-usage "$CLAUSONA_TEST_LOG"; then printf "waited\\n"; else printf "returned first\\n"; fi',
        ].join("\n"),
        { CLAUSONA_TEST_TOOL_EXIT: "42", CLAUSONA_TEST_TRACK_DELAY: String(delaySeconds) },
        [],
        { awaitBackground: false },
      );
      const elapsed = Date.now() - started;

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("rc=42");
      expect(result.stdout).toContain("returned first");
      expect(elapsed).toBeLessThan(delaySeconds * 1000);
      // ...and it did run, once, outside the tool's subshell.
      expect(await harness.logTracked()).toEqual([
        "launch claude",
        `sync-plugins CLAUDE_CONFIG_DIR=${workDir}`,
        TRACKED,
      ]);
    }, 30_000);

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

    it("sets nothing at all when the profile resolves to an empty environment", async () => {
      // The primary/subscription case: `_launch` prints no exports, so the tool must run
      // exactly as it would without clausona - and usage tracking still happens.
      const harness = makeHarness();

      const result = runShell(shell, harness, ["claude", reportParent("CLAUDE_CONFIG_DIR")].join("\n"));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(result.stdout).toContain(`parent CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(await harness.logTracked()).toContain(TRACKED);
    });

    it("drives codex on the same mechanism, without usage tracking", () => {
      const codexDir = "/tmp/clausona-test-codex-work";
      const harness = makeHarness({ codex: { CODEX_HOME: codexDir } });

      const result = runShell(shell, harness, ["codex exec", reportParent("CODEX_HOME")].join("\n"));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("args=exec");
      expect(result.stdout).toContain(`CODEX_HOME=${codexDir}`);
      expect(result.stdout).toContain(`parent CODEX_HOME=${UNSET}`);
      expect(harness.log()).toEqual(["launch codex"]);
    });

    // The point of the cache: nothing runs before the tool starts.
    it("starts each tool from its cached launch script, calling no clausona before it", async () => {
      const harness = makeHarness({
        claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-from-launch" },
        codex: { CODEX_HOME: "/tmp/clausona-test-codex-from-launch" },
      });
      const fromCache = (env: ToolEnv) => launchScript(renderToolEnv(env));
      writeCache(harness, "claude", fromCache({ CLAUDE_CONFIG_DIR: "/tmp/clausona-test-from-cache" }), NOW - 50);
      writeCache(harness, "codex", fromCache({ CODEX_HOME: "/tmp/clausona-test-codex-from-cache" }), NOW - 50);

      const result = runShell(shell, harness, ["claude", "codex", reportParent("CLAUDE_CONFIG_DIR")].join("\n"));

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("CLAUDE_CONFIG_DIR=/tmp/clausona-test-from-cache");
      expect(result.stdout).toContain("CODEX_HOME=/tmp/clausona-test-codex-from-cache");
      expect(result.stdout).toContain(`parent CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(await harness.logTracked()).toEqual([TRACKED]);
    });

    /**
     * After `csn use work` the very next run must start as work. A save deletes the cache, and
     * the hook also refuses one that is not strictly newer than profiles.json - equal times
     * included, since a filesystem that keeps whole seconds cannot order two writes in one -
     * and one with no profiles.json to be newer than, which bash's own `-nt` would accept.
     */
    for (const [label, arrange] of [
      ["missing", () => {}],
      ["older than the registry", (h: Harness) => writeCache(h, "claude", STALE, NOW - 150)],
      ["as old as the registry", (h: Harness) => writeCache(h, "claude", STALE, NOW - 100)],
      [
        "there with no registry",
        (h: Harness) => {
          writeCache(h, "claude", STALE, NOW - 50);
          rmSync(h.paths.registryPath);
        },
      ],
      // A backup moved back over profiles.json: another file, and older than the script, so a
      // time comparison alone would have trusted the script rendered from the file it replaced.
      [
        "rendered from another profiles.json, even an older one",
        (h: Harness) => {
          writeCache(h, "claude", STALE, NOW - 50);
          const backup = `${h.paths.registryPath}.bak`;
          writeFileSync(backup, "{}");
          setMtime(backup, NOW - 200);
          renameSync(backup, h.paths.registryPath);
        },
      ],
      // Fresh and trusted, but not a launch script: nothing but the marker says one is.
      [
        "without the launch marker",
        (h: Harness) => writeCache(h, "claude", "export CLAUDE_CONFIG_DIR='/tmp/clausona-test-stale-cache'", NOW - 50),
      ],
    ] as const) {
      it(`asks _launch when the cached script is ${label}`, () => {
        const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-from-launch" } });
        arrange(harness);

        const result = runShell(shell, harness, "claude");

        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("CLAUDE_CONFIG_DIR=/tmp/clausona-test-from-launch");
        expect(harness.log()[0]).toBe("launch claude");
      });
    }

    /**
     * A clausona older than `_launch` - after a downgrade, with this hook still in the shell -
     * answers it with its usage text on stdout and exit 0; so does anything that prints a
     * banner there. None of it may run, and the tool starts with no profile applied - but not
     * unannounced, or it would be on the default account without a word. Nothing printed at
     * all stays silent, as it does with clausona gone from PATH.
     */
    it("evaluates nothing from a _launch that answers without the marker, and says so", () => {
      const harness = makeHarness();
      const envFile = path.join(harness.envDir, "claude.env");
      writeFileSync(
        envFile,
        "Usage: clausona [command]\nprintf 'INJECTED\\n'\nexport CLAUDE_CONFIG_DIR=/tmp/clausona-test-usage",
      );

      const result = runShell(shell, harness, 'claude\nprintf "rc=%s\\n" "$?"');

      expect(result.stdout).not.toContain("INJECTED");
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(result.stdout).toContain("rc=0");
      expect(result.stderr).toBe(
        "clausona: unexpected output from clausona _launch; starting claude without a profile\n",
      );
      expect(harness.log()[0]).toBe("launch claude");

      writeFileSync(envFile, "");
      const silent = runShell(shell, harness, "claude");
      expect(silent.stdout).toContain(`CLAUDE_CONFIG_DIR=${UNSET}`);
      expect(silent.stderr).toBe("");
    });

    /**
     * A caller's `set -e` (zsh's ERR_EXIT). A clausona that fails - here every call exits 1 -
     * must not end the hook's subshell before the tool starts: not from the cached script's
     * plugin sync, and not from `_launch`. Nor may `_track-usage` end the caller's own shell
     * after it, as the foreground call did: the hook returns, and the next command runs.
     */
    it("starts the tool under set -e when clausona fails", () => {
      const harness = makeHarness();
      writeFileSync(path.join(harness.binDir, "clausona"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const { configDir, primary } = harness.plugins;
      // A cached script whose plugin check is due, so it runs the failing clausona.
      const cached = launchScript(
        renderToolEnv({ CLAUDE_CONFIG_DIR: configDir }),
        renderPosixSyncCheck(configDir, primary),
      );
      writeCache(harness, "claude", cached, NOW - 50);

      const hit = runShell(shell, harness, 'set -e\nclaude\nprintf "after claude\\n"');
      expect(hit.stdout).toContain(`CLAUDE_CONFIG_DIR=${configDir}`);
      expect(hit.stdout).toContain("after claude");
      expect(hit.status).toBe(0);

      // With no cache, `_launch` itself fails, and the tool starts with no profile.
      rmSync(harness.paths.cachePath("claude", "posix"));
      const miss = runShell(shell, harness, "set -e\nclaude");
      expect(miss.stdout).toContain("args=");
      expect(miss.stdout).toContain(`CLAUDE_CONFIG_DIR=${UNSET}`);
    });

    // `HOME=/tmp/x claude`: the paths baked into the hook are not that home's, and `_launch`
    // looks where it says - for a registry that is most likely not there.
    it("asks _launch under another HOME than the hook was rendered for", () => {
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-from-launch" } });
      writeCache(harness, "claude", STALE, NOW - 50);

      const result = runShell(shell, harness, "claude", { HOME: path.join(harness.root, "elsewhere") });

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("CLAUDE_CONFIG_DIR=/tmp/clausona-test-from-launch");
      expect(harness.log()[0]).toBe("launch claude");
    });

    /**
     * The cached script's last line decides the plugin sync on its own: due when the stamp is
     * missing or anything the sync reads is newer, and otherwise not run at all. Each watched
     * path is touched in turn, so a path dropped from the list, or quoted wrongly, fails here.
     */
    it("syncs plugins from the cached script only when the stamp is missing or stale", () => {
      const harness = makeHarness();
      const { configDir, primary } = harness.plugins;
      writeCache(
        harness,
        "claude",
        launchScript(renderToolEnv({ CLAUDE_CONFIG_DIR: configDir }), renderPosixSyncCheck(configDir, primary)),
        NOW - 50,
      );
      const synced = () => harness.log().filter((line) => line.startsWith("sync-plugins"));
      const run = () => {
        writeFileSync(harness.logPath, "");
        expect(runShell(shell, harness, "claude").stderr).toBe("");
        return synced();
      };

      // No stamp yet: due.
      expect(run()).toEqual([`sync-plugins CLAUDE_CONFIG_DIR=${configDir}`]);

      const watched = pluginSyncWatchList(configDir, primary);
      for (const target of watched) {
        mkdirSync(path.dirname(target), { recursive: true });
        if (target.endsWith(".json")) writeFileSync(target, "{}");
        else mkdirSync(target, { recursive: true });
        setMtime(target, NOW - 30);
      }
      const stamp = pluginSyncStampPath(configDir);
      writeFileSync(stamp, "");
      setMtime(stamp, NOW - 20);

      // Stamp newer than everything it watches: nothing to do.
      expect(run()).toEqual([]);

      // Each watched path in turn made exactly as new as the stamp: due, since the stamp's time
      // is taken before the sync reads, and a change in that same tick may have been missed.
      for (const target of watched) {
        setMtime(target, NOW - 20);
        expect(run(), target).toEqual([`sync-plugins CLAUDE_CONFIG_DIR=${configDir}`]);
        setMtime(target, NOW - 30);
      }
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

const SCRIPT_AVAILABLE = spawnSync("which", ["script"]).status === 0;

/**
 * `argv` run on a pseudo-terminal of its own, the way a terminal emulator runs a shell. BSD
 * `script`, on macOS, takes the command as words; util-linux `script`, on Linux, as one
 * string for a shell to run.
 */
function onTerminal(argv: string[]): [string, string[]] {
  if (process.platform === "linux") return ["script", ["-qec", argv.map(posixQuote).join(" "), "/dev/null"]];
  return ["script", ["-q", "/dev/null", ...argv]];
}

for (const shell of ["zsh", "bash"] as const) {
  const available = POSIX_HOST && SCRIPT_AVAILABLE && (shell === "zsh" ? ZSH_AVAILABLE : BASH_AVAILABLE);

  describe.skipIf(!available)(`posix shell integration (interactive ${shell} on a terminal)`, () => {
    /**
     * An interactive shell announces each job it starts in the background, `[1] 12345`, and
     * again when it ends, `[1] + done ...` - over the user's prompt, after every claude run.
     * The hook starts `_track-usage` from a subshell that exits at once, so the job is the
     * subshell's, and the shell the user types in has none to announce. Only a terminal shows
     * it: without one, zsh has no job control to announce anything with.
     */
    it("announces no background job when it records usage", async () => {
      const harness = makeHarness({ claude: { CLAUDE_CONFIG_DIR: "/tmp/clausona-test-claude-work" } });
      const script = [
        renderShellInit(process.platform, harness.paths),
        "claude >/dev/null",
        // Until the tracker has written, then a little past it, and one more command: a shell
        // announces a job's end as it happens (zsh) or once the next command is done (bash).
        "_i=0",
        'until grep -q track-usage "$CLAUSONA_TEST_LOG" || [ "$_i" -ge 100 ]; do sleep 0.1; _i=$((_i + 1)); done',
        "sleep 0.5",
        "true",
        'printf "END\\n"',
      ].join("\n");
      const [file, args] = onTerminal([shell, ...NO_RC_ARGS[shell], "-i", "-c", script]);

      const result = spawnSync(file, args, {
        encoding: "utf8",
        timeout: 20_000,
        // Not a pipe: macOS's `script` cannot read terminal settings from a socket, and exits.
        // The spare pipe on fd 3 is STDIO_AWAITING_BACKGROUND's, where `script` passes it on.
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          PATH: `${harness.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          HOME: harness.home,
          CLAUSONA_TEST_LOG: harness.logPath,
          CLAUSONA_TEST_ENV_DIR: harness.envDir,
        },
      });
      const output = result.stdout.replaceAll("\r", "");

      expect(output).toContain("END");
      expect(output).not.toMatch(/\[\d+\]/);
      expect(output).not.toMatch(/\bdone\b/i);
      expect(await harness.logTracked()).toContain(TRACKED);
    }, 30_000);
  });
}

const describeIfPowerShell = process.platform === "win32" ? describe : describe.skip;

/**
 * Windows PowerShell 5.1, which every Windows has and every case below runs on, and PowerShell
 * 7, which a case runs on as well when it rests on something the two versions do differently,
 * and the runner has it.
 */
type PowerShellHost = "powershell.exe" | "pwsh.exe";
const PWSH_AVAILABLE = process.platform === "win32" && spawnSync("where.exe", ["pwsh.exe"]).status === 0;

/**
 * Windows-only: the PowerShell hook has no subshell to throw away, so it captures and
 * restores each variable by hand. These run only on win32 - everything they assert about
 * the generated script's shape is also pinned statically in shell.test.ts.
 */
describeIfPowerShell("PowerShell wrapper integration", () => {
  type WindowsHarness = {
    binDir: string;
    logPath: string;
    /** The cache and registry paths the hook is rendered with; no cache exists at first. */
    paths: ShellInitPaths;
    /** The plugin check the stand-in `_launch` hands back: its stamp does not exist yet. */
    sync: { stamp: string; watch: string[] };
    /** Where each `_track-usage` call leaves an entry of its own; see TRACK_USAGE_CMD. */
    trackedDir: string;
    /** The calls the hook waited for, in order: everything but `_track-usage`. */
    log(): string[];
    /** How many `_track-usage` calls there have been, once there are `count`, or at the deadline. */
    tracked(count: number): Promise<number>;
  };

  /** A string as a PowerShell literal, for the test bodies below. */
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

  /**
   * The stand-in's `_track-usage`, from its `:track` label. The hook starts it without waiting,
   * so it can run while the next call - or the test body's own Add-Content - writes the log,
   * and cmd.exe's `>>` and Add-Content both refuse a file another process has open for writing:
   * a line would go missing, or the body would throw. So each call makes a directory of its own
   * instead, numbered by the first free name: mkdir fails on one that exists, so two calls at
   * once never take the same number. CLAUSONA_TEST_TRACK_DELAY slows it down by that many
   * seconds, give or take one, to show the hook does not wait for it.
   */
  const TRACK_USAGE_CMD = [
    "exit /b 0",
    ":track",
    "if defined CLAUSONA_TEST_TRACK_DELAY ping -n %CLAUSONA_TEST_TRACK_DELAY% 127.0.0.1 >nul",
    "set /a n=0",
    ":next",
    "set /a n+=1",
    "if %n% GTR 50 exit /b 1",
    'mkdir "%CLAUSONA_TEST_TRACKED%\\%n%" 2>nul || goto next',
    "exit /b 0",
  ];

  /**
   * A cached launch script, as `_launch --json` would have left it, `seconds` old: stamped
   * with the time and length of the profiles.json there is now, as Node reads them.
   */
  function writeJsonCache(harness: WindowsHarness, document: object, seconds: number) {
    const cachePath = harness.paths.cachePath("claude", "json");
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const registry = registryStamp(statSync(harness.paths.registryPath, { bigint: true }));
    writeFileSync(cachePath, JSON.stringify({ ...document, registry }));
    setMtime(cachePath, seconds);
  }

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

  function makeWindowsHarness(env: ToolEnv): WindowsHarness {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-shell-ps-"));
    tmpDirs.push(root);
    const binDir = path.join(root, "bin");
    const clausonaDir = path.join(root, "clausona");
    const trackedDir = path.join(root, "tracked");
    for (const dir of [binDir, clausonaDir, trackedDir]) mkdirSync(dir, { recursive: true });
    const logPath = path.join(root, "calls.log");
    writeFileSync(logPath, "");
    const registryPath = path.join(clausonaDir, "profiles.json");
    writeFileSync(registryPath, "{}");
    setMtime(registryPath, NOW - 100);
    const configDir = path.join(root, "claude-work");
    const primary = path.join(root, "claude-primary");
    const sync = { stamp: pluginSyncStampPath(configDir), watch: pluginSyncWatchList(configDir, primary) };

    // Logs every other subcommand the hook asks for, with the tool it names, so the call
    // sequence can be asserted the way the POSIX harness does; `_track-usage` goes to
    // TRACK_USAGE_CMD. `_launch <tool> --json` is the only one that answers, with the
    // environment and a plugin check whose stamp is missing, so the sync is due. The redirect
    // leads the line so `echo` never ends in a bare digit that cmd.exe would read as a handle
    // to redirect. The hook only ever passes fixed words here, so the arguments need no
    // escaping. With CLAUSONA_TEST_WARN set, every subcommand also writes that word to stderr,
    // the way a real profile warning does.
    writeFileSync(
      path.join(binDir, "clausona.cmd"),
      [
        "@echo off",
        "if defined CLAUSONA_TEST_WARN echo %CLAUSONA_TEST_WARN% 1>&2",
        'if "%1"=="_track-usage" goto track',
        '>>"%CLAUSONA_TEST_LOG%" echo %1 %2',
        'if not "%1"=="_launch" exit /b 0',
        `echo ${escapeForCmdEcho(JSON.stringify({ env, sync }))}`,
        ...TRACK_USAGE_CMD,
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
          `node -e "const v=n=>process.env[n]===undefined?'<unset>':process.env[n];process.stdout.write([v('${configVar}'),v('ANTHROPIC_BASE_URL'),JSON.stringify(v('ANTHROPIC_AUTH_TOKEN')),'key='+v('ANTHROPIC_API_KEY'),'oauth='+v('CLAUDE_CODE_OAUTH_TOKEN'),process.argv[1]||''].join('|'))" %*`,
          `exit /b %CLAUSONA_TEST_TOOL_EXIT%`,
        ].join("\r\n"),
      );
    }

    return {
      binDir,
      logPath,
      paths: {
        cachePath: (tool, format) => launchCachePath(clausonaDir, tool, format, "0.0.0-test"),
        refPath: (tool) => launchRefPath(clausonaDir, tool, "0.0.0-test"),
        registryPath,
        // runPowerShell hands the hook this process's own environment, USERPROFILE included.
        home: process.env.USERPROFILE ?? "",
      },
      sync,
      trackedDir,
      log: () =>
        readFileSync(logPath, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      tracked: (count) =>
        waitFor(
          () => readdirSync(trackedDir).length,
          (seen) => seen >= count,
        ),
    };
  }

  function runPowerShell(
    harness: WindowsHarness,
    body: string,
    extraEnv: Record<string, string> = {},
    host: PowerShellHost = "powershell.exe",
  ) {
    return spawnSync(
      host,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${renderPowerShellInit(harness.paths)}\n${body}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUSONA_TEST_TOOL_EXIT: "0",
          ...extraEnv,
          CLAUSONA_TEST_LOG: harness.logPath,
          CLAUSONA_TEST_TRACKED: harness.trackedDir,
          PATH: `${harness.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: POWERSHELL_SPAWN_TIMEOUT_MS,
      },
    );
  }

  it(
    "applies the profile environment and preserves metacharacters in arguments",
    async () => {
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
      // The same call sequence the POSIX tests pin, in the same order, and usage recorded after.
      expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
      expect(await harness.tracked(1)).toBe(1);
    },
    // Cold powershell.exe startup on a CI runner took 5.4s, over vitest's 5s default, so
    // the test was killed before it could assert. Must exceed the spawn timeout above.
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "restores a previously unset variable to unset, not to an empty string",
    async () => {
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
      // The first invocation's calls and none from the second: once the user has set
      // CLAUDE_CONFIG_DIR the wrapper steps aside and asks clausona for nothing.
      expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
      expect(await harness.tracked(1)).toBe(1);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  /**
   * `_launch --json` gives a credential the run must not inherit the value null. The
   * hook hands that straight to SetEnvironmentVariable, which removes the variable, and
   * the restore in its finally puts back the caller's own value - or, for a variable that
   * was absent, removes it again rather than leaving an empty one behind.
   */
  it(
    "removes a variable _launch names with null, for the run only",
    async () => {
      const parentKey = "sk-ant-parent-sentinel";
      const harness = makeWindowsHarness({
        ANTHROPIC_BASE_URL: LOCAL_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: "placeholder-token",
        ANTHROPIC_API_KEY: null,
        CLAUDE_CODE_OAUTH_TOKEN: null,
      });

      const result = runPowerShell(
        harness,
        [
          "Remove-Item Env:CLAUDE_CODE_OAUTH_TOKEN -ErrorAction SilentlyContinue",
          "claude",
          '"after key=$env:ANTHROPIC_API_KEY"',
          "if (Test-Path Env:CLAUDE_CODE_OAUTH_TOKEN) { 'OAUTH_SET' } else { 'OAUTH_ABSENT' }",
        ].join("\n"),
        { ANTHROPIC_API_KEY: parentKey },
      );

      expect(result.status).toBe(0);
      // The tool ran with the profile's credential and neither of the others...
      expect(result.stdout).toContain(JSON.stringify("placeholder-token"));
      expect(result.stdout).toContain(`key=${UNSET}`);
      expect(result.stdout).toContain(`oauth=${UNSET}`);
      // ...the caller's key is back afterwards, and appears nowhere else...
      expect(result.stdout).toContain(`after key=${parentKey}`);
      expect(result.stdout.split(parentKey)).toHaveLength(2);
      // ...and a variable that was absent before the run is absent after it.
      expect(result.stdout).toContain("OAUTH_ABSENT");
      expect(result.stdout).not.toContain("OAUTH_SET");
      // Waited for, so the case's directory is not removed under it.
      expect(await harness.tracked(1)).toBe(1);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "propagates a non-zero exit code through LASTEXITCODE",
    async () => {
      const harness = makeWindowsHarness({ CLAUDE_CONFIG_DIR: "C:\\clausona-test\\work" });

      const result = runPowerShell(harness, "claude | Out-Null\n$LASTEXITCODE", {
        CLAUSONA_TEST_TOOL_EXIT: "42",
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      expect(await harness.tracked(1)).toBe(1);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  /**
   * `_track-usage` is another Node start, so the hook does not wait for it: the prompt comes
   * back as soon as the tool exits, with the tool's exit code in $LASTEXITCODE, and the usage is
   * recorded after. Here it takes seconds, and has still not recorded when the next line runs.
   */
  it(
    "returns the tool's exit code without waiting for _track-usage",
    async () => {
      const harness = makeWindowsHarness({ CLAUDE_CONFIG_DIR: "C:\\clausona-test\\work" });

      const result = runPowerShell(
        harness,
        [
          "claude | Out-Null",
          '"rc=$LASTEXITCODE"',
          "if (Test-Path -LiteralPath (Join-Path $env:CLAUSONA_TEST_TRACKED '1')) { 'waited' } else { 'returned first' }",
        ].join("\n"),
        { CLAUSONA_TEST_TOOL_EXIT: "42", CLAUSONA_TEST_TRACK_DELAY: "4" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("rc=42");
      expect(result.stdout).toContain("returned first");
      // ...and it did run, once.
      expect(await harness.tracked(1)).toBe(1);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  it(
    "survives a caller's ErrorActionPreference of Stop when every clausona step warns",
    async () => {
      // 5.1 turns a redirected native stderr line into a terminating error under Stop. Each
      // clausona call redirects stderr, so without the Continue override the lookup would
      // die before applying the profile, and the sync would stop the tool from starting.
      const workDir = "C:\\clausona-test\\work";
      const warning = "clausona-test-warning";
      const harness = makeWindowsHarness({ CLAUDE_CONFIG_DIR: workDir });

      const result = runPowerShell(
        harness,
        ["$ErrorActionPreference = 'Stop'", "claude", '"rc=$LASTEXITCODE"', '"pref=$ErrorActionPreference"'].join("\n"),
        { CLAUSONA_TEST_WARN: warning, CLAUSONA_TEST_TOOL_EXIT: "7" },
      );

      // The tool started, with the profile applied...
      expect(result.stdout).toContain(workDir);
      // ...the lookup's warning was replayed rather than thrown...
      expect(result.stderr).toContain(warning);
      expect(result.stderr).not.toContain("NativeCommandError");
      // ...starting _track-usage after the tool neither threw nor replaced its exit code...
      expect(result.stdout).toContain("rc=7");
      // ...and the caller's own preference is what it was.
      expect(result.stdout).toContain("pref=Stop");
      expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
      expect(await harness.tracked(1)).toBe(1);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  /**
   * PowerShell wraps each line a native command writes to a redirected stderr in an ErrorRecord,
   * and 5.1 renders one as `clausona.cmd : <line>` followed by At line:, CategoryInfo and
   * FullyQualifiedErrorId lines - so a hook that renders them shows every warning twice, dressed
   * as a crash. stderr must hold exactly what `_launch` wrote: each line once, its leading spaces
   * kept, and an empty line empty, which 5.1's ErrorRecord.ToString() spells as the exception's
   * type name. The stand-in writes both streams from node, so the bytes are exactly these.
   */
  for (const host of ["powershell.exe", "pwsh.exe"] as const) {
    it.skipIf(host === "pwsh.exe" && !PWSH_AVAILABLE)(
      `replays a _launch warning as exactly the lines it wrote (${host})`,
      async () => {
        const workDir = "C:\\clausona-test\\work";
        const warning = "  ! clausona-test-warning one\n\n  ! clausona-test-warning two\n";
        const harness = makeWindowsHarness({});
        const root = path.dirname(harness.binDir);
        const payload = path.join(root, "launch.json");
        const stderrText = path.join(root, "launch.stderr");
        writeFileSync(payload, renderLaunchJson({ CLAUDE_CONFIG_DIR: workDir }, [], harness.sync), "utf8");
        writeFileSync(stderrText, warning, "utf8");
        writeFileSync(
          path.join(harness.binDir, "clausona.cmd"),
          [
            "@echo off",
            'if "%1"=="_track-usage" goto track',
            '>>"%CLAUSONA_TEST_LOG%" echo %1 %2',
            'if not "%1"=="_launch" exit /b 0',
            `node -e "const fs=require('fs');process.stderr.write(fs.readFileSync(process.env.CLAUSONA_TEST_STDERR,'utf8'));process.stdout.write(fs.readFileSync(process.env.CLAUSONA_TEST_PAYLOAD,'utf8'))"`,
            ...TRACK_USAGE_CMD,
          ].join("\r\n"),
        );

        const result = runPowerShell(
          harness,
          "claude",
          { CLAUSONA_TEST_PAYLOAD: payload, CLAUSONA_TEST_STDERR: stderrText },
          host,
        );

        expect(result.status).toBe(0);
        // The JSON on stdout still applied the profile...
        expect(result.stdout).toContain(workDir);
        // ...and stderr has the warning once, with none of PowerShell's error formatting...
        const stderr = `\n${result.stderr.replaceAll("\r\n", "\n")}`;
        expect(stderr).not.toContain("NativeCommandError");
        expect(stderr).not.toContain("CategoryInfo");
        expect(stderr).not.toContain("RemoteException");
        expect(stderr.split("clausona-test-warning")).toHaveLength(3);
        // ...as the very lines _launch wrote, from the start of a line.
        expect(stderr).toContain(`\n${warning}`);
        expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
        expect(await harness.tracked(1)).toBe(1);
      },
      POWERSHELL_TEST_TIMEOUT_MS,
    );
  }

  /**
   * PowerShell decodes a native command's stdout with [Console]::OutputEncoding, which is the
   * console's OEM code page by default - 437 on this runner, 949 on a Korean install - and
   * not UTF-8. Raw UTF-8 from `_shell-env --json` turned a Hangul user folder into a path
   * that does not exist. So the stand-in writes exactly what `_launch --json` writes, the
   * way clausona writes it: from node, as UTF-8 bytes - never `echo`, which would write it in
   * the console's own code page and hide the problem. And the tool reports the directory it
   * got percent-encoded, so nothing on the way back depends on a code page either.
   */
  it(
    "hands the tool a non-ASCII config directory intact",
    async () => {
      const workDir = "C:\\clausona-test\\\uD64D\uAE38\uB3D9\\.claude-work";
      const harness = makeWindowsHarness({});
      const payload = path.join(path.dirname(harness.binDir), "launch.json");
      writeFileSync(payload, renderLaunchJson({ CLAUDE_CONFIG_DIR: workDir }, [], harness.sync), "utf8");
      writeFileSync(
        path.join(harness.binDir, "clausona.cmd"),
        [
          "@echo off",
          'if "%1"=="_track-usage" goto track',
          '>>"%CLAUSONA_TEST_LOG%" echo %1 %2',
          'if not "%1"=="_launch" exit /b 0',
          `node -e "process.stdout.write(require('fs').readFileSync(process.env.CLAUSONA_TEST_PAYLOAD,'utf8'))"`,
          ...TRACK_USAGE_CMD,
        ].join("\r\n"),
      );
      writeFileSync(
        path.join(harness.binDir, "claude.cmd"),
        [
          "@echo off",
          `node -e "process.stdout.write('dir='+encodeURIComponent(String(process.env.CLAUDE_CONFIG_DIR)))"`,
          "exit /b 0",
        ].join("\r\n"),
      );

      const result = runPowerShell(harness, "claude", { CLAUSONA_TEST_PAYLOAD: payload });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`dir=${encodeURIComponent(workDir)}`);
      expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
      expect(await harness.tracked(1)).toBe(1);
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
      // _sync-plugins is claude-only on this platform too. So is _track-usage, which shell.test.ts
      // pins: started without waiting, it could not be told apart from a late one here.
      expect(harness.log()).toEqual(["_launch codex"]);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  /**
   * One PowerShell start, two runs: first from a cache stamped with the registry as it is - no
   * clausona before the tool, and the variable gone again afterwards - then, with an older
   * backup moved back over profiles.json, from `_launch`, whose warning is replayed. The backup
   * is older than the cache, so a time comparison alone would have trusted the cache.
   */
  it(
    "starts from the cached launch script, and asks _launch once profiles.json is another file",
    async () => {
      const warning = "clausona-test-warning";
      const harness = makeWindowsHarness({ CLAUDE_CONFIG_DIR: "C:\\clausona-test\\from-launch" });
      writeJsonCache(harness, { env: { CLAUDE_CONFIG_DIR: "C:\\clausona-test\\from-cache" } }, NOW - 50);
      const backup = `${harness.paths.registryPath}.bak`;
      writeFileSync(backup, "{}");
      setMtime(backup, NOW - 200);

      const result = runPowerShell(
        harness,
        [
          "claude",
          "if (Test-Path Env:CLAUDE_CONFIG_DIR) { 'LEFT_SET' } else { 'RESTORED' }",
          `Move-Item -LiteralPath ${psQuote(backup)} -Destination ${psQuote(harness.paths.registryPath)} -Force`,
          "claude",
        ].join("\n"),
        { CLAUSONA_TEST_WARN: warning },
      );

      expect(result.status).toBe(0);
      const fromCache = result.stdout.indexOf("C:\\clausona-test\\from-cache");
      const fromLaunch = result.stdout.indexOf("C:\\clausona-test\\from-launch");
      expect(fromCache).toBeGreaterThan(-1);
      expect(fromLaunch).toBeGreaterThan(fromCache);
      expect(result.stdout).toContain("RESTORED");
      expect(result.stdout).not.toContain("LEFT_SET");
      // Only the second run asked clausona anything before the tool, and both recorded usage...
      expect(harness.log()).toEqual(["_launch claude", "_sync-plugins"]);
      expect(await harness.tracked(2)).toBe(2);
      // ...and its warning reached the console, once: the ones _track-usage printed in its own
      // hidden window did not.
      expect(result.stderr.split(warning)).toHaveLength(2);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );

  /**
   * The hook's own staleness check, on a cache hit and under a caller's Stop: a stale stamp
   * syncs, a fresh one does not, and a watched path brought up to the stamp's own time syncs
   * again - the stamp's time is taken before the sync reads, so a change in that tick may have
   * been missed. One PowerShell start for all three, with a marker in the log between them.
   */
  it(
    "syncs plugins only when the stamp is stale, whatever the caller's ErrorActionPreference",
    async () => {
      const harness = makeWindowsHarness({});
      const { stamp, watch } = harness.sync;
      for (const target of watch) {
        mkdirSync(path.dirname(target), { recursive: true });
        if (target.endsWith(".json")) writeFileSync(target, "{}");
        else mkdirSync(target, { recursive: true });
        setMtime(target, NOW - 30);
      }
      writeFileSync(stamp, "");
      setMtime(stamp, NOW - 40);
      writeJsonCache(harness, { env: {}, sync: harness.sync }, NOW - 50);
      const mark = (label: string) => `Add-Content -LiteralPath $env:CLAUSONA_TEST_LOG -Value ${psQuote(label)}`;
      const bump = (target: string, seconds: number) =>
        [
          `$item = Get-Item -LiteralPath ${psQuote(target)}`,
          `$item.LastWriteTimeUtc = $item.LastWriteTimeUtc.AddSeconds(${seconds})`,
        ].join("\n");

      const result = runPowerShell(
        harness,
        [
          "$ErrorActionPreference = 'Stop'",
          // Stamp older than what it watches: due.
          "claude | Out-Null",
          mark("MARK fresh"),
          // To NOW-20, newer than everything it watches: nothing to do.
          bump(stamp, 20),
          "claude | Out-Null",
          mark("MARK touched"),
          // The plugin cache to NOW-20, exactly the stamp's time: due again.
          bump(watch[4] as string, 10),
          "claude | Out-Null",
          '"pref=$ErrorActionPreference"',
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("pref=Stop");
      expect(harness.log()).toEqual(["_sync-plugins", "MARK fresh", "MARK touched", "_sync-plugins"]);
      expect(await harness.tracked(3)).toBe(3);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );
});
