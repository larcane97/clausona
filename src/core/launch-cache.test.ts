import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BuiltEnv } from "../lib/profile-env.js";
import type { Profile } from "../types.js";
import {
  invalidateLaunchCache,
  isCacheable,
  launchCacheDir,
  launchCachePath,
  pluginSyncStampPath,
  pluginSyncWatchList,
  renderPosixSyncCheck,
  statRegistry,
  touchPluginSyncStamp,
  writeLaunchCache,
} from "./launch-cache.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-launch-cache-"));
  temps.push(dir);
  return dir;
}

/** Runs `fn` as the registry lock would: this file has nothing else holding it. */
const withLock = <T>(fn: () => Promise<T>) => fn();

const subscription: Profile = { tool: "claude", configDir: "/tmp/work", email: "you@example.com" };
const built = (partial: Partial<BuiltEnv> = {}): BuiltEnv => ({
  env: { CLAUDE_CONFIG_DIR: "/tmp/work" },
  unset: [],
  warnings: [],
  ...partial,
});

describe("launchCachePath", () => {
  it("names the version, the tool and the format, under <clausona>/cache", () => {
    const dir = path.join("/home/u", ".clausona");
    expect(launchCacheDir(dir)).toBe(path.join(dir, "cache"));
    expect(launchCachePath(dir, "claude", "posix", "1.2.3-beta")).toBe(
      path.join(dir, "cache", "launch-1.2.3-beta-claude.sh"),
    );
    expect(launchCachePath(dir, "codex", "json", "1.2.3")).toBe(path.join(dir, "cache", "launch-1.2.3-codex.json"));
  });
});

describe("isCacheable", () => {
  it("caches a subscription profile, env map and all", () => {
    expect(
      isCacheable(subscription, built({ env: { CLAUDE_CONFIG_DIR: "/tmp/work", ANTHROPIC_MODEL: "m" } }), []),
    ).toBe(true);
  });

  it("never caches an API profile, whose output carries its key", () => {
    const api: Profile = {
      ...subscription,
      kind: "api",
      api: { baseUrl: "http://localhost:8000", authScheme: "bearer", secret: { source: "env", name: "X" } },
    };
    expect(isCacheable(api, built(), [])).toBe(false);
  });

  it("never caches a run that warned, clears a variable, or guards one", () => {
    expect(isCacheable(subscription, built({ warnings: ["claude:work: something"] }), [])).toBe(false);
    expect(isCacheable(subscription, built({ unset: ["ANTHROPIC_API_KEY"] }), [])).toBe(false);
    expect(isCacheable(subscription, built(), ["ANTHROPIC_BASE_URL"])).toBe(false);
  });

  // A subscription profile may keep another service's token in its env map, in plain text in
  // profiles.json; the cache would be one more copy of it on disk.
  it("never caches an env map that carries a secret, by name or by shape", () => {
    expect(isCacheable(subscription, built({ env: { GITHUB_TOKEN: "plain" } }), [])).toBe(false);
    const keyShaped = ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-");
    expect(isCacheable(subscription, built({ env: { MY_SETTING: keyShaped } }), [])).toBe(false);
  });
});

describe("writeLaunchCache", () => {
  function setup() {
    const root = tempDir();
    const registryPath = path.join(root, "profiles.json");
    writeFileSync(registryPath, "{}");
    const cachePath = launchCachePath(root, "claude", "posix", "9.9.9");
    return { root, registryPath, cachePath };
  }

  it("writes the file owner-only, in an owner-only directory", async () => {
    const { registryPath, cachePath } = setup();
    const before = await statRegistry(registryPath);

    const wrote = await writeLaunchCache({ path: cachePath, content: "export A='1'", registryPath, before, withLock });

    expect(wrote).toBe(true);
    expect(readFileSync(cachePath, "utf8")).toBe("export A='1'");
    if (process.platform !== "win32") {
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(cachePath)).mode & 0o777).toBe(0o700);
    }
  });

  // `csn use` in another shell between the read and the write: the script describes the
  // registry as it was, and must not outlive it.
  it("writes nothing when profiles.json was replaced after it was read", async () => {
    const { registryPath, cachePath } = setup();
    const before = await statRegistry(registryPath);
    writeFileSync(`${registryPath}.tmp`, "{}");
    await rename(`${registryPath}.tmp`, registryPath);

    const wrote = await writeLaunchCache({ path: cachePath, content: "export A='1'", registryPath, before, withLock });

    expect(wrote).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("writes nothing when the registry lock is taken", async () => {
    const { registryPath, cachePath } = setup();
    const before = await statRegistry(registryPath);

    const wrote = await writeLaunchCache({
      path: cachePath,
      content: "export A='1'",
      registryPath,
      before,
      withLock: async () => undefined,
    });

    expect(wrote).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("removes other versions' launch scripts once it has written its own", async () => {
    const { root, registryPath, cachePath } = setup();
    const cacheDir = launchCacheDir(root);
    mkdirSync(cacheDir, { recursive: true });
    for (const name of ["launch-9.9.9-codex.json", "launch-9.9.8-claude.sh", "launch-9.9.9-beta-claude.sh", "node"]) {
      writeFileSync(path.join(cacheDir, name), "");
    }

    await writeLaunchCache({
      path: cachePath,
      content: "",
      registryPath,
      before: await statRegistry(registryPath),
      withLock,
      keepVersion: "9.9.9",
    });

    expect(readdirSync(cacheDir).sort()).toEqual(["launch-9.9.9-claude.sh", "launch-9.9.9-codex.json", "node"]);
  });
});

describe("invalidateLaunchCache", () => {
  it("removes every launch script and nothing else", async () => {
    const root = tempDir();
    const cacheDir = launchCacheDir(root);
    mkdirSync(path.join(cacheDir, "node"), { recursive: true });
    for (const name of ["launch-1-claude.sh", "launch-1-codex.json", "launch-2-claude.sh.tmp.42", "other.txt"]) {
      writeFileSync(path.join(cacheDir, name), "");
    }

    await invalidateLaunchCache(root);

    expect(readdirSync(cacheDir).sort()).toEqual(["node", "other.txt"]);
  });

  it("is fine with no cache directory at all", async () => {
    await expect(invalidateLaunchCache(path.join(tempDir(), "absent"))).resolves.toBeUndefined();
  });
});

describe("the plugin sync check", () => {
  it("watches the five files the sync reads, and stamps inside the profile's plugins", () => {
    expect(pluginSyncStampPath("/p")).toBe(path.join("/p", "plugins", ".clausona-synced"));
    expect(pluginSyncWatchList("/p", "/primary")).toEqual([
      path.join("/p", "plugins", "known_marketplaces.json"),
      path.join("/p", "plugins", "installed_plugins.json"),
      path.join("/primary", "plugins", "marketplaces"),
      path.join("/primary", "plugins", "installed_plugins.json"),
      path.join("/primary", "plugins", "cache"),
    ]);
  });

  it("single-quotes every path, one with a quote in it included", () => {
    const line = renderPosixSyncCheck("/home/o'brien/.claude-work", "/home/o'brien/.claude");
    const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
    const stamp = quote(pluginSyncStampPath("/home/o'brien/.claude-work"));
    const watched = pluginSyncWatchList("/home/o'brien/.claude-work", "/home/o'brien/.claude").map(quote);
    expect(line).toBe(
      `if [[ ! -e ${stamp} || ${watched.map((w) => `${w} -nt ${stamp}`).join(" || ")} ]]; then clausona _sync-plugins 2>/dev/null; fi`,
    );
    expect(line).not.toContain('"');
  });

  it.skipIf(process.platform === "win32" || spawnSync("which", ["bash"]).status !== 0)(
    "runs in bash, and checks the very stamp that touchPluginSyncStamp writes",
    async () => {
      const configDir = path.join(tempDir(), "it's");
      const check = () =>
        spawnSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            `clausona() { echo "SYNC $1"; }\n${renderPosixSyncCheck(configDir, configDir)}`,
          ],
          { encoding: "utf8" },
        );

      expect(check().stdout).toBe("SYNC _sync-plugins\n");
      await touchPluginSyncStamp(configDir);
      expect(existsSync(pluginSyncStampPath(configDir))).toBe(true);
      // Stamped, and none of the watched paths exist, so none is newer: nothing to sync.
      const fresh = check();
      expect(fresh.stderr).toBe("");
      expect(fresh.stdout).toBe("");
    },
  );
});
