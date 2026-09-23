import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Registry, ToolName } from "../types.js";

// service.ts resolves ~/.clausona at module load, so the whole module graph has to see a
// temporary home. The mock reads `currentHome`, which each case sets before re-importing.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const MARKER = ".clausona-pending";

const temps: string[] = [];
function scratch(label: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `clausona-${label}-`));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const registryPath = (home: string) => path.join(home, ".clausona", "profiles.json");

function readRegistry(home: string): Registry {
  return JSON.parse(readFileSync(registryPath(home), "utf8")) as Registry;
}

function writeRegistry(home: string, registry: Registry) {
  writeFileSync(registryPath(home), JSON.stringify(registry));
}

/** A throwaway home with both tools' primaries and an initialized registry. */
function seedHome(): string {
  const home = scratch("addhome");
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  mkdirSync(path.join(claude, "projects"), { recursive: true });
  writeFileSync(path.join(claude, "settings.json"), "{}");
  mkdirSync(codex, { recursive: true });
  writeFileSync(path.join(codex, "config.toml"), "");
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  writeRegistry(home, { version: 2, primarySources: { claude, codex }, activeProfiles: {}, profiles: {} });
  return home;
}

/** What each tool's login leaves in the config dir, and what readAccountInfo reads back. */
function writeAccount(tool: ToolName, configDir: string, email: string) {
  if (tool === "claude") {
    writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
  } else {
    writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({ tokens: { account_id: email } }));
  }
}

type Login = (configDir: string) => Promise<boolean>;

/**
 * Loads the real service against `home`, with each tool's interactive login replaced.
 * Stubbing the adapter rather than a binary on PATH keeps these cases off the
 * PowerShell shim, which is what `claude.cmd` resolves through on Windows.
 */
async function loadService(home: string, login: Login) {
  currentHome = home;
  vi.resetModules();
  const { getAdapter } = await import("../tools/registry.js");
  const service = await import("./service.js");
  const spies = {
    claude: vi.spyOn(getAdapter("claude"), "runLogin").mockImplementation(login),
    codex: vi.spyOn(getAdapter("codex"), "runLogin").mockImplementation(login),
  };
  return { ...service, spies };
}

function signingIn(tool: ToolName, email: string): Login {
  return async (configDir) => {
    writeAccount(tool, configDir, email);
    return true;
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the add to be refused");
}

describe("addProfile marks the directory it creates", () => {
  it("keeps the marker through the login and drops it once the profile is registered", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".claude-work");
    let markedDuringLogin = false;
    const { addProfile } = await loadService(home, async (dir) => {
      markedDuringLogin = existsSync(path.join(dir, MARKER));
      writeAccount("claude", dir, "work@example.com");
      return true;
    });

    const added = await addProfile({ tool: "claude", name: "work" });

    expect(markedDuringLogin).toBe(true);
    expect(added.email).toBe("work@example.com");
    expect(readRegistry(home).profiles["claude:work"]?.configDir).toBe(configDir);
    expect(existsSync(path.join(configDir, MARKER))).toBe(false);
  });

  it("removes the directory when the login fails", async () => {
    const home = seedHome();
    const { addProfile } = await loadService(home, async () => false);

    expect(await rejection(addProfile({ tool: "claude", name: "work" }))).toBe("claude login failed.");
    expect(existsSync(path.join(home, ".claude-work"))).toBe(false);
  });

  it("takes its signal handlers down once the login returns", async () => {
    const home = seedHome();
    const before = { hup: process.listenerCount("SIGHUP"), term: process.listenerCount("SIGTERM") };
    let during = { hup: 0, term: 0 };
    const { addProfile } = await loadService(home, async (dir) => {
      during = { hup: process.listenerCount("SIGHUP"), term: process.listenerCount("SIGTERM") };
      writeAccount("claude", dir, "work@example.com");
      return true;
    });

    await addProfile({ tool: "claude", name: "work" });

    expect(during).toEqual({ hup: before.hup + 1, term: before.term + 1 });
    expect(process.listenerCount("SIGHUP")).toBe(before.hup);
    expect(process.listenerCount("SIGTERM")).toBe(before.term);
  });

  it("takes them down after a failed login too", async () => {
    const home = seedHome();
    const before = process.listenerCount("SIGTERM");
    const { addProfile } = await loadService(home, async () => false);

    await rejection(addProfile({ tool: "codex", name: "work" }));

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("addProfile with the directory already there", () => {
  it("reuses a directory an interrupted add left behind", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".claude-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, MARKER), "");
    const { addProfile, spies } = await loadService(home, signingIn("claude", "hup@example.com"));

    const added = await addProfile({ tool: "claude", name: "hup" });

    expect(spies.claude).toHaveBeenCalledWith(configDir);
    expect(added.email).toBe("hup@example.com");
    expect(readRegistry(home).profiles["claude:hup"]?.configDir).toBe(configDir);
    expect(existsSync(path.join(configDir, MARKER))).toBe(false);
  });

  it("skips the login when the leftover already holds the sign-in", async () => {
    // The process died after the login wrote its credential but before registration.
    const home = seedHome();
    const configDir = path.join(home, ".codex-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, MARKER), "");
    writeAccount("codex", configDir, "acct-hup");
    const { addProfile, spies } = await loadService(home, async () => false);

    const added = await addProfile({ tool: "codex", name: "hup" });

    expect(spies.codex).not.toHaveBeenCalled();
    expect(added.email).toBe("acct-hup");
    expect(existsSync(path.join(configDir, MARKER))).toBe(false);
  });

  it("removes a reused leftover whose login fails again", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".codex-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, MARKER), "");
    const { addProfile } = await loadService(home, async () => false);

    expect(await rejection(addProfile({ tool: "codex", name: "hup" }))).toBe("codex login failed.");
    expect(existsSync(configDir)).toBe(false);
  });

  it("says how to remove an unmarked directory with no account instead of suggesting --from", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".claude-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "notes.txt"), "mine");
    const { addProfile, spies } = await loadService(home, signingIn("claude", "hup@example.com"));

    const message = await rejection(addProfile({ tool: "claude", name: "hup" }));

    // --from reads the account out of the directory, so it can never import this one.
    expect(message).not.toContain("--from");
    expect(message).toContain("interrupted add");
    expect(message).toContain(
      process.platform === "win32" ? `Remove-Item -LiteralPath '${configDir}' -Recurse -Force` : "rm -rf ~/.claude-hup",
    );
    // No marker, so it may be the user's: nothing is signed into it or deleted.
    expect(spies.claude).not.toHaveBeenCalled();
    expect(readFileSync(path.join(configDir, "notes.txt"), "utf8")).toBe("mine");
  });

  // The PowerShell form quotes every path, so only the POSIX form has a choice to get wrong.
  it.skipIf(process.platform === "win32")("quotes a directory name the shell would split", async () => {
    const home = seedHome();
    mkdirSync(path.join(home, ".claude-my work"));
    const { addProfile } = await loadService(home, signingIn("claude", "x@example.com"));

    const message = await rejection(addProfile({ tool: "claude", name: "my work" }));

    expect(message).toContain("rm -rf ~/'.claude-my work'");
  });

  it("still suggests --from for an unmarked directory that holds an account", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".codex-mine");
    mkdirSync(configDir);
    writeAccount("codex", configDir, "acct-mine");
    const { addProfile, spies } = await loadService(home, signingIn("codex", "acct-other"));

    const message = await rejection(addProfile({ tool: "codex", name: "mine" }));

    const shown = path.join("~", ".codex-mine");
    expect(message).toBe(`${shown} already exists. Use --from ${shown} to import it instead.`);
    expect(spies.codex).not.toHaveBeenCalled();
    expect(existsSync(path.join(configDir, "auth.json"))).toBe(true);
  });

  it("does not reuse a marked directory another profile has registered", async () => {
    // Imported with --from under another name before this change, so it kept the marker.
    const home = seedHome();
    const configDir = path.join(home, ".claude-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, MARKER), "");
    const registry = readRegistry(home);
    registry.profiles["claude:other"] = { tool: "claude", configDir, email: "other@example.com" };
    writeRegistry(home, registry);
    const { addProfile, spies } = await loadService(home, async () => false);

    const message = await rejection(addProfile({ tool: "claude", name: "hup" }));

    expect(message).toBe(`${path.join("~", ".claude-hup")} already exists and is registered as claude:other.`);
    // A failed login would otherwise have deleted a registered profile's directory.
    expect(spies.claude).not.toHaveBeenCalled();
    expect(existsSync(configDir)).toBe(true);
  });

  it("drops the marker when an interrupted add's directory is imported with --from", async () => {
    const home = seedHome();
    const configDir = path.join(home, ".codex-hup");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, MARKER), "");
    writeAccount("codex", configDir, "acct-hup");
    const { addProfile } = await loadService(home, async () => false);

    await addProfile({ tool: "codex", name: "work", fromPath: configDir });

    // Now a registered profile's directory, not a leftover a later add may take over.
    expect(existsSync(path.join(configDir, MARKER))).toBe(false);
  });
});

describe("the marker stays out of shared state", () => {
  it.each(["claude", "codex"] as const)("is never linked, backed up, or reported for %s", async (tool) => {
    const home = seedHome();
    const { addProfile, doctorProfiles } = await loadService(home, signingIn(tool, `${tool}@example.com`));
    // Only a directory that add created carries the marker, so a primary never should —
    // but if one did, sharing it would mark every profile as a reusable leftover.
    writeFileSync(path.join(home, `.${tool}`, MARKER), "");

    const added = await addProfile({ tool, name: "work" });
    expect(existsSync(path.join(added.configDir, MARKER))).toBe(false);
    // A backed-up marker would be copied back into the directory when the profile is removed.
    expect(existsSync(path.join(home, ".clausona", "backups", tool, "work", MARKER))).toBe(false);

    // A marker left in a registered profile (its removal is best effort) is not a finding.
    writeFileSync(path.join(added.configDir, MARKER), "");
    const results = await doctorProfiles();
    const issues = results.flatMap((result) => result.issues.map((issue) => issue.message));
    expect(issues.filter((message) => message.includes(MARKER))).toEqual([]);
  });

  it("leaves a removed profile's directory to --from rather than to a new add", async () => {
    const home = seedHome();
    const { addProfile, removeProfile, spies } = await loadService(home, signingIn("claude", "work@example.com"));
    const added = await addProfile({ tool: "claude", name: "work" });
    await removeProfile("claude:work");
    spies.claude.mockClear();

    const message = await rejection(addProfile({ tool: "claude", name: "work" }));

    // remove keeps the directory and its data; signing a new add into it (and deleting it
    // if that login failed) would be wrong.
    expect(message).toContain("Use --from");
    expect(spies.claude).not.toHaveBeenCalled();
    expect(existsSync(added.configDir)).toBe(true);
  });
});

// The rest drives the real CLI in a child process, because what is under test is how
// that process ends. POSIX only: Windows never delivers SIGTERM from the OS, and its
// SIGHUP is Node's emulation of the console window closing, which a test cannot produce.
describe.skipIf(process.platform === "win32")("add interrupted mid-login", () => {
  const CHILD_TEST_TIMEOUT_MS = 60_000;
  let cliPath = "";
  let fakeBin = "";

  beforeAll(async () => {
    const out = scratch("cli");
    cliPath = path.join(out, "clausona.mjs");
    // Mirrors build.mjs, with the react-devtools-core stub done as a plugin so nothing
    // is written into the repo.
    await build({
      entryPoints: [fileURLToPath(new URL("../index.tsx", import.meta.url))],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: cliPath,
      banner: {
        js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
      },
      jsx: "automatic",
      define: { __CLAUSONA_VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
      plugins: [
        {
          name: "stub-react-devtools-core",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "stub", namespace: "stub" }));
            pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default undefined;" }));
          },
        },
      ],
    });

    // Stands in for `claude auth login`: either signs in at once, or announces that the
    // login is under way and then waits like a browser sign-in nobody completes. The
    // slow-exit variant saves its config as it goes on a hangup, creating the directory
    // if it has to, the way a tool writing on exit would.
    fakeBin = scratch("bin");
    const claude = path.join(fakeBin, "claude");
    writeFileSync(
      claude,
      [
        "#!/bin/sh",
        '[ "$1" = auth ] && [ "$2" = login ] || exit 1',
        'case "$FAKE_LOGIN" in',
        "  succeed)",
        '    printf \'{"oauthAccount":{"emailAddress":"hup@example.com"}}\' > "$CLAUDE_CONFIG_DIR/.claude.json"',
        "    exit 0 ;;",
        "  slow-exit)",
        '    trap \'sleep 0.3; mkdir -p "$CLAUDE_CONFIG_DIR"; : > "$CLAUDE_CONFIG_DIR/.claude.json"; exit 1\' HUP',
        '    : > "$FAKE_LOGIN_STARTED"',
        "    sleep 60 &",
        "    wait",
        "    exit 1 ;;",
        "esac",
        ': > "$FAKE_LOGIN_STARTED"',
        "exec sleep 60",
        "",
      ].join("\n"),
    );
    chmodSync(claude, 0o755);
  }, CHILD_TEST_TIMEOUT_MS);

  const running: ChildProcess[] = [];
  afterEach(() => {
    // The login stand-in outlives a clausona that was signalled on its own.
    for (const child of running.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  function runAdd(home: string, env: Record<string, string> = {}) {
    // Detached, so the add and its login child share a process group of their own that
    // a signal can reach the way a closing terminal's does.
    const child = spawn(process.execPath, [cliPath, "add", "claude:hup"], {
      env: { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    running.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    // "exit", not "close": a login child that outlives clausona keeps the output pipes
    // open, and "close" waits for those.
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const closed = new Promise<{ code: number | null; output: string }>((resolve) => {
      child.on("close", (code) => resolve({ code, output }));
    });
    return { child, ended, closed, output: () => output };
  }

  // A hangup reaches the login child as well, and under load its exit is sometimes seen
  // before clausona's own signal is. The add then ends through the failed-login path
  // (exit 1) rather than by the signal; either way it must not outlive the hangup.
  const HUNG_UP = /^(signal SIGHUP|exit 1)$/;
  function howItEnded({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) {
    return signal ? `signal ${signal}` : `exit ${code}`;
  }

  function groupAlive(group: number): boolean {
    try {
      process.kill(-group, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function startLogin(home: string, env: Record<string, string> = {}) {
    const started = path.join(home, "login-started");
    const run = runAdd(home, { ...env, FAKE_LOGIN_STARTED: started });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error(`the login never started: ${run.output()}`);
      if (run.child.exitCode !== null || run.child.signalCode !== null) {
        throw new Error(`clausona ended before the login started: ${run.output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return run;
  }

  it(
    "removes the directory when SIGTERM ends the add, and still ends by the signal",
    async () => {
      const home = seedHome();
      const configDir = path.join(home, ".claude-hup");
      const { child, ended } = await startLogin(home);
      expect(existsSync(path.join(configDir, MARKER))).toBe(true);

      process.kill(child.pid as number, "SIGTERM");
      const { signal } = await ended;

      expect(signal).toBe("SIGTERM");
      expect(existsSync(configDir)).toBe(false);
    },
    CHILD_TEST_TIMEOUT_MS,
  );

  it(
    "removes the directory when the terminal hangs up on the add and its login",
    async () => {
      const home = seedHome();
      const configDir = path.join(home, ".claude-hup");
      const { child, ended } = await startLogin(home);

      process.kill(-(child.pid as number), "SIGHUP");

      expect(howItEnded(await ended)).toMatch(HUNG_UP);
      expect(existsSync(configDir)).toBe(false);
    },
    CHILD_TEST_TIMEOUT_MS,
  );

  it(
    "waits for a hung-up login to finish exiting before removing the directory",
    async () => {
      const home = seedHome();
      const configDir = path.join(home, ".claude-hup");
      const { child, ended } = await startLogin(home, { FAKE_LOGIN: "slow-exit" });
      const group = child.pid as number;

      process.kill(-group, "SIGHUP");
      expect(howItEnded(await ended)).toMatch(HUNG_UP);
      // Judge only once the login is gone too: removing the directory while it was still
      // exiting would have let it recreate one, without the marker.
      const deadline = Date.now() + 30_000;
      while (groupAlive(group)) {
        if (Date.now() > deadline) throw new Error("the login never exited");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(existsSync(configDir)).toBe(false);
    },
    CHILD_TEST_TIMEOUT_MS,
  );

  it(
    "lets Ctrl+C end the add as before, and the next add reuses what it left",
    async () => {
      const home = seedHome();
      const configDir = path.join(home, ".claude-hup");
      const first = await startLogin(home);

      // Ctrl+C in a login that reads the terminal in cooked mode: the whole group gets it.
      process.kill(-(first.child.pid as number), "SIGINT");
      expect((await first.ended).signal).toBe("SIGINT");
      expect(existsSync(path.join(configDir, MARKER))).toBe(true);

      const retry = await runAdd(home, { FAKE_LOGIN: "succeed" }).closed;

      expect(retry.output).toContain("Added");
      expect(retry.code).toBe(0);
      expect(readRegistry(home).profiles["claude:hup"]?.configDir).toBe(configDir);
      expect(existsSync(path.join(configDir, MARKER))).toBe(false);
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});
