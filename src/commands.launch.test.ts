import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  launchCacheDir,
  launchCachePath,
  launchRefPath,
  pluginSyncStampPath,
  pluginSyncWatchList,
  registryStamp,
  renderPosixSyncCheck,
} from "./core/launch-cache.js";
import { LAUNCH_MARKER } from "./core/shell.js";

/**
 * `_launch <tool>` is what the new hook runs on a cache miss: the environment `_shell-env`
 * prints, the plugin sync `_sync-plugins` does, and - when the script holds nothing that must
 * be worked out afresh each launch - a copy of it in the launch cache for the next run.
 *
 * Same seam as commands.shell-env.test.ts: service.ts derives ~/.clausona from homedir() at
 * import time, so stubbing HOME and re-importing the module graph points the whole command
 * at a temp directory.
 */

/**
 * A seam into every file read: `afterRead` runs once a read has finished, before the reader
 * sees the result, which lets a test do what another process could do at that moment.
 * Everything else is the real thing.
 */
const fsHooks = vi.hoisted(() => ({ afterRead: undefined as ((target: string) => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const content = await actual.readFile(...args);
    fsHooks.afterRead?.(String(args[0]));
    return content;
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const VERSION = __CLAUSONA_VERSION__;
const temps: string[] = [];

afterEach(() => {
  fsHooks.afterRead = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harness(makeRegistry: (home: string) => unknown) {
  // Resolved, because _launch caches nothing for a config dir reached through a symlink, and
  // the temp dir often is one: /var on macOS, an 8.3 short name on a Windows runner.
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "clausona-launch-")));
  temps.push(home);
  const clausonaDir = path.join(home, ".clausona");
  const primary = path.join(home, ".claude");
  const workDir = path.join(home, ".claude-work");
  // Every profile below lives in a directory that exists, as a real one does; ~/.codex is
  // codex's default dir, which _launch has to find a plain path too.
  const dirs = [clausonaDir, primary, workDir, path.join(home, ".codex"), path.join(home, ".codex-work")];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });

  const registry = makeRegistry(home);
  const registryPath = path.join(clausonaDir, "profiles.json");
  if (registry !== undefined) writeFileSync(registryPath, JSON.stringify(registry));

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  const { runCommand } = await import("./commands.js");
  const service = await import("./lib/service.js");

  const warnings: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });

  return {
    home,
    clausonaDir,
    primary,
    workDir,
    registryPath,
    warnings,
    service,
    runCommand,
    launch: (...args: string[]) => runCommand("_launch", args),
    cachePath: (tool: "claude" | "codex", format: "posix" | "json") =>
      launchCachePath(clausonaDir, tool, format, VERSION),
    launchFiles: () => readdirSync(launchCacheDir(clausonaDir), { withFileTypes: true }).filter((e) => e.isFile()),
  };
}

function registryWith(profile: Record<string, unknown>, home: string, id = "claude:work") {
  const tool = id.split(":")[0] as string;
  return {
    version: 2,
    primarySources: { claude: path.join(home, ".claude") },
    activeProfiles: { [tool]: id },
    profiles: { [id]: profile },
  };
}

const subscription = (home: string, extra: Record<string, unknown> = {}) =>
  registryWith(
    { tool: "claude", configDir: path.join(home, ".claude-work"), email: "you@example.com", ...extra },
    home,
  );

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe("_launch", () => {
  it("prints the marker, _shell-env's exports and the plugin check, and caches exactly that", async () => {
    const h = await harness((home) => subscription(home, { env: { ANTHROPIC_MODEL: "m" } }));

    const exports = await h.runCommand("_shell-env", ["claude"]);
    const out = await h.launch("claude");

    expect(out).toBe(`${LAUNCH_MARKER}\n${exports}\n${renderPosixSyncCheck(h.workDir, h.primary)}`);
    expect(readFileSync(h.cachePath("claude", "posix"), "utf8")).toBe(out);
    // Next to it, a hard link to the profiles.json it was rendered from.
    const [registry, ref] = [h.registryPath, launchRefPath(h.clausonaDir, "claude", VERSION)].map((p) =>
      statSync(p, { bigint: true }),
    );
    expect([ref?.dev, ref?.ino]).toEqual([registry?.dev, registry?.ino]);
    // The sync ran for the profile's own config dir, and stamped it.
    expect(existsSync(pluginSyncStampPath(h.workDir))).toBe(true);
    expect(existsSync(path.join(h.workDir, "plugins", "installed_plugins.json"))).toBe(true);
    expect(h.warnings).toEqual([]);
  });

  it("syncs and checks the primary's plugins for the primary profile, which exports nothing", async () => {
    const h = await harness((home) =>
      registryWith({ tool: "claude", configDir: path.join(home, ".claude"), email: "a@b.c", isPrimary: true }, home),
    );

    const out = await h.launch("claude");

    expect(out).toBe(`${LAUNCH_MARKER}\n${renderPosixSyncCheck(h.primary, h.primary)}`);
    expect(existsSync(pluginSyncStampPath(h.primary))).toBe(true);
    expect(readFileSync(h.cachePath("claude", "posix"), "utf8")).toBe(out);
  });

  it("prints only the exports for codex, and caches them", async () => {
    const h = await harness((home) =>
      registryWith({ tool: "codex", configDir: path.join(home, ".codex-work"), email: "c@d.e" }, home, "codex:work"),
    );

    const out = await h.launch("codex");

    expect(out).toBe(`${LAUNCH_MARKER}\nexport CODEX_HOME='${path.join(h.home, ".codex-work")}'`);
    expect(readFileSync(h.cachePath("codex", "posix"), "utf8")).toBe(out);
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
  });

  it("prints --json in ASCII alone, with the sync check, and caches it", async () => {
    const hangul = "홍길동";
    let configDir = "";
    const h = await harness((home) => {
      configDir = path.join(home, hangul, ".claude-work");
      mkdirSync(configDir, { recursive: true });
      return registryWith({ tool: "claude", configDir, email: "you@example.com" }, home);
    });

    const raw = await h.launch("claude", "--json");

    expect([...Buffer.from(raw, "utf8")].filter((byte) => byte > 0x7e)).toEqual([]);
    const primary = h.primary;
    expect(JSON.parse(raw)).toEqual({
      env: { CLAUDE_CONFIG_DIR: configDir },
      sync: {
        stamp: pluginSyncStampPath(configDir),
        watch: [
          path.join(configDir, "plugins", "known_marketplaces.json"),
          path.join(configDir, "plugins", "installed_plugins.json"),
          path.join(primary, "plugins", "marketplaces"),
          path.join(primary, "plugins", "installed_plugins.json"),
          path.join(primary, "plugins", "cache"),
        ],
      },
      // The profiles.json it was rendered from, as the PowerShell hook will compare it.
      registry: registryStamp(statSync(h.registryPath, { bigint: true })),
    });
    expect(readFileSync(h.cachePath("claude", "json"), "utf8")).toBe(raw);
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
  });

  /**
   * An installPath is `cache/<marketplace>/<plugin>/<version>`: a version added or removed
   * changes the plugin directory's mtime, not `cache`'s, so the directories down to the plugin
   * are watched too - as they are when the script is made.
   */
  it("watches the plugin cache's marketplace and plugin directories", async () => {
    const h = await harness((home) => subscription(home));
    const cache = path.join(h.primary, "plugins", "cache");
    mkdirSync(path.join(cache, "market", "plugin", "1.0.0"), { recursive: true });
    writeFileSync(path.join(cache, "market", "README"), "");

    const { sync } = JSON.parse(await h.launch("claude", "--json"));

    expect(sync.watch.slice(5)).toEqual([path.join(cache, "market"), path.join(cache, "market", "plugin")]);
    expect(await h.launch("claude")).toContain(`'${path.join(cache, "market", "plugin")}'`);
  });

  it("gives codex's --json no sync block", async () => {
    const h = await harness((home) =>
      registryWith({ tool: "codex", configDir: path.join(home, ".codex-work"), email: "c@d.e" }, home, "codex:work"),
    );

    expect(JSON.parse(await h.launch("codex", "--json"))).toEqual({
      env: { CODEX_HOME: path.join(h.home, ".codex-work") },
      registry: registryStamp(statSync(h.registryPath, { bigint: true })),
    });
  });

  // The whole point of the rule: the key an API profile resolves at launch must stay in the
  // store it came from.
  it("prints an API profile's key but never writes it anywhere", async () => {
    const key = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
    const h = await harness((home) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: path.join(home, ".claude-work"),
          email: "",
          label: "router",
          api: {
            baseUrl: "https://openrouter.ai/api",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", key);

    expect(await h.launch("claude")).toContain(key);
    expect(await h.launch("claude", "--json")).toContain(key);

    expect(existsSync(launchCacheDir(h.clausonaDir)) ? h.launchFiles().map((e) => e.name) : []).toEqual([]);
    for (const file of filesUnder(h.clausonaDir)) expect(readFileSync(file, "utf8"), file).not.toContain(key);
  });

  /**
   * Whether CLAUDE_CONFIG_DIR is exported at all turns on the realpaths of the config dir and
   * of ~/.claude, and a symlink can be pointed elsewhere without profiles.json changing. A
   * junction on Windows, which needs no privilege and resolves the same way.
   */
  for (const [label, arrange] of [
    [
      "the config dir",
      (h: Awaited<ReturnType<typeof harness>>) => {
        const real = path.join(h.home, "real-work");
        mkdirSync(real);
        rmSync(h.workDir, { recursive: true });
        symlinkSync(real, h.workDir, "junction");
      },
    ],
    [
      "~/.claude",
      (h: Awaited<ReturnType<typeof harness>>) => {
        const real = path.join(h.home, "real-claude");
        mkdirSync(real);
        rmSync(h.primary, { recursive: true });
        symlinkSync(real, h.primary, "junction");
      },
    ],
  ] as const) {
    it(`caches nothing when ${label} is reached through a symlink`, async () => {
      const h = await harness((home) => subscription(home));
      arrange(h);

      expect(await h.launch("claude")).toContain(`export CLAUDE_CONFIG_DIR='${h.workDir}'`);

      expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
    });
  }

  it("warns on every launch, and never caches, for a profile that warns", async () => {
    const h = await harness((home) => subscription(home, { env: "API_TIMEOUT_MS=1" }));

    await h.launch("claude");
    await h.launch("claude");

    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain("clausona config claude:work --edit");
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
  });

  /**
   * `csn use` in another shell, landing just after this launch read profiles.json: the script
   * about to be cached describes the file that is gone. profiles.json is stat'ed before it is
   * read, so the write sees it changed and caches nothing. Stat'ed after, it would have seen
   * the new file and cached the old profile's script under it.
   */
  it("caches nothing when profiles.json is replaced between its stat and its read", async () => {
    const h = await harness((home) => subscription(home));
    let replaced = false;
    fsHooks.afterRead = (target) => {
      if (target !== h.registryPath || replaced) return;
      replaced = true;
      writeFileSync(`${h.registryPath}.saved`, readFileSync(h.registryPath, "utf8"));
      renameSync(`${h.registryPath}.saved`, h.registryPath);
    };

    expect(await h.launch("claude")).toContain(`export CLAUDE_CONFIG_DIR='${h.workDir}'`);

    expect(replaced).toBe(true);
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
  });

  // `csn use`, `config` and every other writer save through updateRegistry. The next launch
  // must see what they wrote, whatever the cache held.
  it("loses its cache as soon as the registry is saved", async () => {
    const h = await harness((home) => subscription(home));
    await h.launch("claude");
    await h.launch("claude", "--json");
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(true);

    await h.service.updateRegistry((current) => current);

    expect(h.launchFiles()).toEqual([]);
  });

  it("loses its cache when a v1 registry is migrated", async () => {
    const h = await harness((home) => ({
      primarySource: path.join(home, ".claude"),
      activeProfile: "default",
      profiles: { default: { configDir: path.join(home, ".claude"), email: "a@b.c", isPrimary: true } },
    }));
    mkdirSync(launchCacheDir(h.clausonaDir), { recursive: true });
    writeFileSync(h.cachePath("claude", "posix"), "export STALE='1'");

    await h.service.loadRegistry();

    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
  });

  it("keeps the cache owner-only", async () => {
    const h = await harness((home) => subscription(home));
    await h.launch("claude");
    if (process.platform !== "win32") {
      expect(statSync(h.cachePath("claude", "posix")).mode & 0o777).toBe(0o600);
      expect(statSync(launchCacheDir(h.clausonaDir)).mode & 0o777).toBe(0o700);
    }
  });

  /**
   * The hook evals only what opens with the marker, so a script with nothing to set is the
   * marker alone - not empty output, which the hook would take for an older clausona's.
   * `--json` has no comment to open with, and stays empty.
   */
  describe("degenerate input", () => {
    it("prints only the marker, and caches nothing, with no registry at all", async () => {
      const h = await harness(() => undefined);
      expect(await h.launch("claude")).toBe(LAUNCH_MARKER);
      expect(await h.launch("claude", "--json")).toBe("");
      expect(existsSync(launchCacheDir(h.clausonaDir))).toBe(false);
    });

    it("prints only the marker when the tool has no active profile", async () => {
      const h = await harness((home) => ({ ...subscription(home), activeProfiles: {} }));
      expect(await h.launch("claude")).toBe(LAUNCH_MARKER);
      expect(existsSync(launchCacheDir(h.clausonaDir))).toBe(false);
    });

    it("prints only the marker for a tool clausona does not manage", async () => {
      const h = await harness((home) => subscription(home));
      expect(await h.launch("gemini")).toBe(LAUNCH_MARKER);
    });
  });
});

/**
 * A profile's plugins/ links everything in the primary's but the two JSON files. The sync
 * stamp is each profile's own: linked, every profile's stamp would be the primary's, and a
 * sync of one would mark them all done.
 */
describe("a profile's plugins directory", () => {
  it("links the primary's plugin files, but not its sync stamp", async () => {
    const h = await harness((home) => subscription(home));
    const primaryPlugins = path.join(h.primary, "plugins");
    mkdirSync(path.join(primaryPlugins, "cache"), { recursive: true });
    for (const name of [".clausona-synced", ".clausona-synced.tmp-4242"]) {
      writeFileSync(path.join(primaryPlugins, name), "");
    }

    await h.service.repairProfile("claude:work");

    const linked = readdirSync(path.join(h.workDir, "plugins"));
    expect(linked).toContain("cache");
    expect(linked.filter((name) => name.startsWith(".clausona-synced"))).toEqual([]);
  });
});

/**
 * A hook reads a command's stdout as a script. An internal command this version does not have
 * - a hook from another version asking - fails, with its usage on stderr, instead of printing
 * that usage where the hook would run it, as 0.4.0-beta did for `_launch`.
 */
describe("an unknown internal command", () => {
  it("fails instead of printing usage on stdout", async () => {
    const h = await harness((home) => subscription(home));
    await expect(h.runCommand("_no-such-command", [])).rejects.toThrow(/Unknown command: _no-such-command/);
    // A mistyped public command still just gets the usage, as before.
    expect(await h.runCommand("no-such-command", [])).toContain("USAGE");
  });
});

describe("_sync-plugins", () => {
  // Old hooks still call it on every launch; stamping keeps the new hook's check fresh too.
  it("stamps the profile it synced", async () => {
    const h = await harness((home) => subscription(home));
    vi.stubEnv("CLAUDE_CONFIG_DIR", h.workDir);

    expect(await h.runCommand("_sync-plugins", [])).toBe("");

    expect(existsSync(pluginSyncStampPath(h.workDir))).toBe(true);
  });

  /**
   * A sync that rewrote the profile's files leaves them at least as new as its stamp, whose
   * time is taken before it reads anything, so one more sync is due; that one finds nothing to
   * write, and after it nothing is due. `due` is the hook's rule: no stamp, or a watched path
   * at least as new as it.
   */
  it("converges: one more sync after a sync that changed files, and then none", async () => {
    const h = await harness((home) => subscription(home));
    vi.stubEnv("CLAUDE_CONFIG_DIR", h.workDir);
    const stamp = pluginSyncStampPath(h.workDir);
    const watched = pluginSyncWatchList(h.workDir, h.primary);
    const mtime = (target: string) => statSync(target, { bigint: true }).mtimeNs;
    const due = () => !existsSync(stamp) || watched.some((w) => existsSync(w) && mtime(w) >= mtime(stamp));
    const own = watched.slice(0, 2);

    // The first sync writes the profile's two files.
    await h.runCommand("_sync-plugins", []);
    expect(due()).toBe(true);

    // Time passes before the next launch, keeping the order the sync left them in.
    const now = Math.floor(Date.now() / 1000);
    utimesSync(stamp, now - 10, now - 10);
    for (const file of own) utimesSync(file, now - 5, now - 5);

    await h.runCommand("_sync-plugins", []);
    // Nothing to write this time...
    for (const file of own) expect(statSync(file).mtimeMs, file).toBe((now - 5) * 1000);
    // ...and nothing due after it.
    expect(due()).toBe(false);
  });

  // Claude Code rewrites these files in its own layout. The same JSON is no change: not
  // rewritten, and not reported as one.
  it("leaves a file with the same JSON in another layout alone", async () => {
    const h = await harness((home) => subscription(home));
    await h.service.syncPluginsJson(h.workDir, h.primary);
    const own = pluginSyncWatchList(h.workDir, h.primary).slice(0, 2);
    const then = Math.floor(Date.now() / 1000) - 5;
    for (const file of own) {
      // Compact, with no trailing newline, where clausona indents by two and ends with one.
      writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8"))));
      utimesSync(file, then, then);
    }

    expect(await h.service.syncPluginsJson(h.workDir, h.primary)).toEqual({ ok: true, changed: false });

    for (const file of own) expect(statSync(file).mtimeMs, file).toBe(then * 1000);
  });

  /**
   * A sync runs because something it watches changed - often a marketplace or plugin
   * directory the cached script does not watch yet, whether or not this profile's files
   * changed with it. So claude's script goes every time, with its ref, and the next launch
   * lists the directory; codex's is not the sync's business.
   */
  it("drops claude's launch script every time it runs", async () => {
    const h = await harness((home) => ({
      ...subscription(home),
      activeProfiles: { claude: "claude:work", codex: "codex:work" },
      profiles: {
        "claude:work": { tool: "claude", configDir: path.join(home, ".claude-work"), email: "you@example.com" },
        "codex:work": { tool: "codex", configDir: path.join(home, ".codex-work"), email: "c@d.e" },
      },
    }));
    vi.stubEnv("CLAUDE_CONFIG_DIR", h.workDir);
    await h.launch("claude");
    await h.launch("codex");
    expect(existsSync(h.cachePath("claude", "posix"))).toBe(true);

    // The sync finds nothing to change, and the script still goes.
    await h.runCommand("_sync-plugins", []);

    expect(existsSync(h.cachePath("claude", "posix"))).toBe(false);
    expect(existsSync(launchRefPath(h.clausonaDir, "claude", VERSION))).toBe(false);
    expect(existsSync(h.cachePath("codex", "posix"))).toBe(true);
  });

  // A sync that could not write its files is not done, and must run again next launch.
  it("does not stamp a sync that failed", async () => {
    const h = await harness((home) => subscription(home));
    vi.stubEnv("CLAUDE_CONFIG_DIR", h.workDir);
    // A directory where the sync has to write a file: the rename into place fails.
    mkdirSync(path.join(h.workDir, "plugins", "known_marketplaces.json", "in-the-way"), { recursive: true });

    expect(await h.runCommand("_sync-plugins", [])).toBe("");

    expect(existsSync(pluginSyncStampPath(h.workDir))).toBe(false);
  });
});
