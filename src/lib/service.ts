import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { checkBaseUrl, isAnthropicHost } from "../core/api-url.js";
import { countIssues, evaluateApiHealth, evaluateSymlinkHealth, missingEndpointRemedy } from "../core/doctor.js";
import { backupDirFor, claudeJsonPathForConfigDir } from "../core/paths.js";
import { spawnCommand } from "../core/process.js";
import { collectQuotas, type QuotaTarget } from "../core/quota-store.js";
import { isV1Registry, migrateRegistryV1toV2, setActiveProfile } from "../core/registry.js";
import { createSharedLink, inspectSharedLink } from "../core/shared-links.js";
import { isPosixEnvName, renderShellInit } from "../core/shell.js";
import { seedSeenSessions } from "../core/track-usage.js";
import { summarizeUsage } from "../core/usage.js";
import { validateEnvEntry } from "../tools/claude-env-catalog.js";
import { ALL_TOOLS, allAdapters, getAdapter } from "../tools/registry.js";
import type { ToolAdapter } from "../tools/types.js";
import type {
  ApiEndpoint,
  DiscoveredAccount,
  DoctorIssue,
  DoctorProfileResult,
  Profile,
  ProfileListItem,
  QuotaSnapshot,
  Registry,
  RegistryV1,
  SecretSource,
  ToolName,
  UsagePeriod,
  UsageStore,
} from "../types.js";
import {
  buildProfileEnv,
  CREDENTIAL_ENV_KEYS,
  displayName,
  envKeyCaseTwin,
  envKeyCaseTwinError,
  isSecretEnvName,
  profileModel,
} from "./profile-env.js";
import { foldProfileName, initProfileNames, parseProfileRef, profileId, validateProfileName } from "./profile-ref.js";
import { redactProfile } from "./redact.js";
import { deleteSecret, resolveSecret, storeSecret } from "./secrets.js";

/** Files inside plugins/ that contain absolute paths and must be per-profile */
const PLUGINS_PATH_FILES = new Set(["known_marketplaces.json", "installed_plugins.json"]);

/**
 * True when a known_marketplaces.json entry describes a marketplace clausona manages —
 * a directory under the profile's plugins/marketplaces.
 *
 * Claude Code also registers marketplaces straight from a path the user picked, and
 * those keep that path as their installLocation. They are the user's own registrations:
 * clausona never created them and has nowhere to relocate them to, so they are neither
 * drift to report nor state to rewrite. Treating them as managed made every profile
 * holding one permanently unhealthy, and made the suggested repair delete them.
 */
function isManagedMarketplace(entry: unknown, configDir: string): boolean {
  const location = (entry as Record<string, unknown> | null | undefined)?.installLocation;
  // An entry with no location at all is malformed rather than user-registered, so it
  // stays in scope and gets reported and rewritten as before.
  if (typeof location !== "string") return true;
  return location.startsWith(path.join(configDir, "plugins", "marketplaces") + path.sep);
}

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const REGISTRY_PATH = path.join(CLAUSONA_DIR, "profiles.json");
const USAGE_PATH = path.join(CLAUSONA_DIR, "usage.json");

async function exists(targetPath: string) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A profile's settings.json for the doctor: the parsed object, `{}` when there is no such
 * file, and null when there is one that cannot be used.
 *
 * `readJson`'s single fallback cannot tell those last two apart, and here they mean opposite
 * things: no file means nothing is configured, while a file that does not parse means the
 * apiKeyHelper check could not run - which is not the same as finding no helper.
 */
async function readSettings(targetPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(targetPath, "utf8");
  } catch (error) {
    // A broken shared link reads as ENOENT too; it has its own finding already.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readJson<T>(targetPath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function warn(message: string): void {
  process.stderr.write(`  warn: ${message}\n`);
}

async function writeJson(targetPath: string, value: unknown) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

async function execCommand(
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; quiet?: boolean; interactive?: boolean },
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    if (options?.interactive) {
      const child = spawnCommand(command, args, {
        env: { ...process.env, ...options.env },
        stdio: "inherit",
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "" }));
      return;
    }

    const child = spawnCommand(command, args, {
      env: { ...process.env, ...options?.env },
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!options?.quiet) {
        process.stdout.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!options?.quiet) {
        process.stderr.write(chunk);
      }
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", () => {
      resolve({ code: 1, stdout, stderr });
    });
  });
}

async function ensureStorage() {
  await mkdir(CLAUSONA_DIR, { recursive: true });
}

function shouldSkipShare(adapter: ToolAdapter, name: string, mergeSessions: boolean): boolean {
  if (adapter.sharedSkipSet(mergeSessions).has(name)) return true;
  if (adapter.shouldSkipName?.(name, mergeSessions)) return true;
  return false;
}

async function mergeSessionFiles(sourceDir: string, primarySource: string) {
  const srcProjects = path.join(sourceDir, "projects");
  const dstProjects = path.join(primarySource, "projects");

  const srcStats = await lstat(srcProjects).catch(() => null);
  if (!srcStats || srcStats.isSymbolicLink()) return 0;
  if (!(await exists(dstProjects))) return 0;

  const slugs = await readdir(srcProjects, { withFileTypes: true });
  let merged = 0;

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const srcSlug = path.join(srcProjects, slug.name);
    const dstSlug = path.join(dstProjects, slug.name);
    await mkdir(dstSlug, { recursive: true });

    const items = await readdir(srcSlug, { withFileTypes: true });
    for (const item of items) {
      if (item.name === "sessions-index.json") continue;
      const dstItem = path.join(dstSlug, item.name);
      if (await exists(dstItem)) continue;
      try {
        await cp(path.join(srcSlug, item.name), dstItem, { recursive: true });
        merged++;
      } catch (e) {
        warn(`mergeSessionFiles: could not copy ${item.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await rm(path.join(dstSlug, "sessions-index.json"), { force: true });
  }

  return merged;
}

/**
 * Move session-keyed record directories (`jobs/`, `teams/`) into the primary.
 *
 * Unlike `projects/`, these hold one self-contained directory per session id and no
 * index to rebuild, so a merge is a plain per-record move. Records are addressed by the
 * session id (`jobs/` uses its first 8 characters), which makes collisions across
 * accounts effectively impossible; where one does occur the primary's copy wins rather
 * than being overwritten.
 */
async function mergeRecordDirs(sourceDir: string, primarySource: string, kind: "jobs" | "teams") {
  const src = path.join(sourceDir, kind);
  const dst = path.join(primarySource, kind);

  const srcStats = await lstat(src).catch(() => null);
  if (!srcStats || srcStats.isSymbolicLink()) return 0;
  if (!(await exists(dst))) return 0;

  const entries = await readdir(src, { withFileTypes: true });
  let merged = 0;

  for (const entry of entries) {
    // Loose files at this level (jobs/pins.json) are whole-store state, not records;
    // merging them would mean merging their contents, so the primary's copy stands.
    if (!entry.isDirectory()) continue;

    const target = path.join(dst, entry.name);
    if (await exists(target)) continue;
    try {
      await cp(path.join(src, entry.name), target, { recursive: true });
      if (kind === "jobs") await rebaseJobTranscriptPath(target, sourceDir, primarySource);
      merged++;
    } catch (e) {
      warn(`mergeRecordDirs(${kind}): could not copy ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return merged;
}

/**
 * A job record stores the absolute path of its transcript, written against the config
 * dir it was created under. That path still resolves while the profile exists — its
 * `projects/` is a shared link to the primary — but it breaks the moment the profile
 * directory goes away, so the merged copy is rebased onto the primary.
 */
async function rebaseJobTranscriptPath(jobDir: string, sourceDir: string, primarySource: string) {
  const statePath = path.join(jobDir, "state.json");
  const state = await readJson<Record<string, unknown>>(statePath, {});
  const recorded = state.linkScanPath;
  if (typeof recorded !== "string") return;

  const prefix = sourceDir.endsWith(path.sep) ? sourceDir : sourceDir + path.sep;
  if (!recorded.startsWith(prefix)) return;

  state.linkScanPath = path.join(primarySource, recorded.slice(prefix.length));
  await writeJson(statePath, state);
}

/**
 * Fold a profile's own session state into the primary ahead of replacing it with shared
 * links. `setupSharedLinks` backs a local directory up and then deletes it, and a
 * backup under ~/.clausona is invisible to the tool — so anything not merged here is
 * gone from the user's session and background lists.
 */
export async function mergeSessionState(sourceDir: string, primarySource: string) {
  await mergeSessionFiles(sourceDir, primarySource);
  await mergeRecordDirs(sourceDir, primarySource, "jobs");
  await mergeRecordDirs(sourceDir, primarySource, "teams");
}

export async function setupSharedLinks(
  adapter: ToolAdapter,
  profileDir: string,
  primarySource: string,
  mergeSessions = false,
  backupDir?: string,
) {
  const items = await readdir(primarySource, { withFileTypes: true });
  let linked = 0;

  for (const item of items) {
    const source = path.join(primarySource, item.name);

    if (shouldSkipShare(adapter, item.name, mergeSessions)) {
      // Remove symlinks to primary for skipped items (e.g. projects/ when separated)
      const target = path.join(profileDir, item.name);
      const linkInfo = await inspectSharedLink(target, source);
      if (linkInfo.isSharedLink && linkInfo.pointsToSource) {
        await rm(target, { force: true, recursive: true });
      }
      continue;
    }
    const target = path.join(profileDir, item.name);
    const targetExists = await exists(target);
    if (targetExists) {
      const linkInfo = await inspectSharedLink(target, source);
      if (linkInfo.isSharedLink && linkInfo.pointsToSource && linkInfo.targetExists) {
        linked += 1;
        continue;
      }
      if (!linkInfo.isSharedLink && backupDir) {
        // Real data — save to backup before removing
        const backupTarget = path.join(backupDir, item.name);
        if (!(await exists(backupTarget))) {
          await cp(target, backupTarget, { recursive: true });
        }
      }
      await rm(target, { force: true, recursive: true });
    }

    await createSharedLink(source, target, { isDirectory: item.isDirectory() });
    linked += 1;
  }

  return linked;
}

export async function syncPluginsJson(configDir: string, primarySource: string): Promise<void> {
  try {
    const knownPath = path.join(configDir, "plugins", "known_marketplaces.json");
    const knownJson = await readJson<Record<string, unknown>>(knownPath, {});

    const marketplacesDir = path.join(primarySource, "plugins", "marketplaces");
    const marketplaceDirs = await readdir(marketplacesDir, { withFileTypes: true }).catch(() => []);
    const onDisk = new Set(marketplaceDirs.filter((e) => e.isDirectory()).map((e) => e.name));

    // Sync known_marketplaces.json
    const syncedKnown: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(knownJson)) {
      const e = entry as Record<string, unknown>;
      if (!isManagedMarketplace(e, configDir)) {
        syncedKnown[name] = e; // registered by the user from their own path — carry through
        continue;
      }
      if (!onDisk.has(name)) continue; // in JSON but not on disk → drop
      syncedKnown[name] = {
        ...e,
        installLocation: path.join(configDir, "plugins", "marketplaces", name),
      };
    }

    const registry = await loadRegistry();
    for (const name of onDisk) {
      if (syncedKnown[name]) continue; // already handled above
      // On disk but not in JSON — look up metadata from registered profiles
      let found: Record<string, unknown> | null = null;
      if (registry) {
        for (const profile of Object.values(registry.profiles)) {
          const otherKnown = await readJson<Record<string, unknown>>(
            path.join(profile.configDir, "plugins", "known_marketplaces.json"),
            {},
          );
          if (otherKnown[name]) {
            found = otherKnown[name] as Record<string, unknown>;
            break;
          }
        }
      }

      if (found) {
        syncedKnown[name] = {
          ...found,
          installLocation: path.join(configDir, "plugins", "marketplaces", name),
        };
        continue;
      }

      // Try reading .git/config for source metadata
      let sourceInfo: Record<string, unknown> = {};
      try {
        const gitConfig = await readFile(
          path.join(primarySource, "plugins", "marketplaces", name, ".git", "config"),
          "utf8",
        );
        const remoteSection = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
        if (remoteSection) {
          const url = remoteSection[1].trim();
          const ghMatch = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
          if (ghMatch) {
            sourceInfo = { source: "github", repo: ghMatch[1] };
          } else {
            sourceInfo = { source: "git", url };
          }
        }
      } catch {
        // .git/config not readable — create minimal entry
      }

      syncedKnown[name] = {
        ...sourceInfo,
        installLocation: path.join(configDir, "plugins", "marketplaces", name),
        lastUpdated: new Date().toISOString(),
      };
    }

    await writeJson(knownPath, syncedKnown);

    // Sync installed_plugins.json (v2 format: { version, plugins: { name: [entries] } })
    const installedPath = path.join(configDir, "plugins", "installed_plugins.json");
    type PluginEntry = Record<string, unknown> & { installPath?: string };
    type InstalledPlugins = { version?: number; plugins?: Record<string, PluginEntry[]> };
    let installedJson = await readJson<InstalledPlugins | null>(installedPath, null);
    if (installedJson === null) {
      installedJson = await readJson<InstalledPlugins>(path.join(primarySource, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: {},
      });
    }

    const syncedPlugins: Record<string, PluginEntry[]> = {};
    for (const [pluginName, entries] of Object.entries(installedJson.plugins ?? {})) {
      const syncedEntries: PluginEntry[] = [];
      for (const entry of entries) {
        if (entry.installPath) {
          const resolved = await realpath(entry.installPath).catch(() => null);
          if (!resolved) continue; // target doesn't exist — remove entry
          const pluginsIdx = entry.installPath.indexOf("/plugins/");
          const newInstallPath =
            pluginsIdx !== -1 ? path.join(configDir, entry.installPath.slice(pluginsIdx + 1)) : entry.installPath;
          syncedEntries.push({ ...entry, installPath: newInstallPath });
        } else {
          syncedEntries.push(entry);
        }
      }
      if (syncedEntries.length > 0) {
        syncedPlugins[pluginName] = syncedEntries;
      }
    }

    await writeJson(installedPath, { version: installedJson.version ?? 2, plugins: syncedPlugins });
  } catch {
    // Never block Claude from launching
  }
}

async function mergePluginFiles(profilePluginsDir: string, primaryPluginsDir: string): Promise<void> {
  // 1. Merge marketplaces dirs
  try {
    const srcMarketplaces = path.join(profilePluginsDir, "marketplaces");
    const dstMarketplaces = path.join(primaryPluginsDir, "marketplaces");
    const marketplaceDirs = await readdir(srcMarketplaces, { withFileTypes: true }).catch(() => []);
    for (const entry of marketplaceDirs) {
      if (!entry.isDirectory()) continue;
      const dst = path.join(dstMarketplaces, entry.name);
      if (await exists(dst)) continue;
      try {
        await cp(path.join(srcMarketplaces, entry.name), dst, { recursive: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }

  // 2. Merge cache items
  try {
    const srcCache = path.join(profilePluginsDir, "cache");
    const dstCache = path.join(primaryPluginsDir, "cache");
    const cacheItems = await readdir(srcCache, { withFileTypes: true }).catch(() => []);
    for (const entry of cacheItems) {
      const dst = path.join(dstCache, entry.name);
      if (await exists(dst)) continue;
      try {
        await cp(path.join(srcCache, entry.name), dst, { recursive: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }

  // 3. Merge known_marketplaces.json entries
  try {
    const srcKnown = await readJson<Record<string, unknown>>(
      path.join(profilePluginsDir, "known_marketplaces.json"),
      {},
    );
    const dstKnownPath = path.join(primaryPluginsDir, "known_marketplaces.json");
    const dstKnown = await readJson<Record<string, unknown>>(dstKnownPath, {});
    let changed = false;
    for (const [name, entry] of Object.entries(srcKnown)) {
      if (dstKnown[name]) continue;
      const e = entry as Record<string, unknown>;
      dstKnown[name] = {
        ...e,
        installLocation: path.join(primaryPluginsDir, "marketplaces", name),
      };
      changed = true;
    }
    if (changed) await writeJson(dstKnownPath, dstKnown);
  } catch {
    // best-effort
  }

  // 4. Merge installed_plugins.json entries (v2 format: { version, plugins: { name: [entries] } })
  try {
    type PluginEntry = Record<string, unknown> & { installPath?: string };
    type InstalledPlugins = { version?: number; plugins?: Record<string, PluginEntry[]> };
    const srcInstalled = await readJson<InstalledPlugins>(path.join(profilePluginsDir, "installed_plugins.json"), {
      plugins: {},
    });
    const dstInstalledPath = path.join(primaryPluginsDir, "installed_plugins.json");
    const dstInstalled = await readJson<InstalledPlugins>(dstInstalledPath, { version: 2, plugins: {} });
    const dstPlugins = dstInstalled.plugins ?? {};
    let changed = false;
    for (const [pluginName, entries] of Object.entries(srcInstalled.plugins ?? {})) {
      if (dstPlugins[pluginName]) continue;
      dstPlugins[pluginName] = entries.map((entry) => {
        if (entry.installPath) {
          const pluginsIdx = entry.installPath.indexOf("/plugins/");
          const newInstallPath =
            pluginsIdx !== -1
              ? path.join(primaryPluginsDir, entry.installPath.slice(pluginsIdx + "/plugins/".length))
              : entry.installPath;
          return { ...entry, installPath: newInstallPath };
        }
        return entry;
      });
      changed = true;
    }
    if (changed) await writeJson(dstInstalledPath, { version: dstInstalled.version ?? 2, plugins: dstPlugins });
  } catch {
    // best-effort
  }
}

async function setupPluginsDir(profileDir: string, primarySource: string): Promise<void> {
  const primaryPlugins = path.join(primarySource, "plugins");
  if (!(await exists(primaryPlugins))) return;

  const profilePlugins = path.join(profileDir, "plugins");

  // Migration: remove wholesale symlink if present
  const profilePluginsStats = await lstat(profilePlugins).catch(() => null);
  if (profilePluginsStats?.isSymbolicLink()) {
    await rm(profilePlugins);
  }

  await mkdir(profilePlugins, { recursive: true });

  const items = await readdir(primaryPlugins, { withFileTypes: true });
  for (const item of items) {
    if (PLUGINS_PATH_FILES.has(item.name)) continue; // syncPluginsJson handles these

    const source = path.join(primaryPlugins, item.name);
    const target = path.join(profilePlugins, item.name);
    const targetExists = await exists(target);
    if (targetExists) {
      const linkInfo = await inspectSharedLink(target, source);
      if (linkInfo.isSharedLink && linkInfo.pointsToSource && linkInfo.targetExists) continue;
      await rm(target, { force: true, recursive: true });
    }
    await createSharedLink(source, target, { isDirectory: item.isDirectory() });
  }

  await syncPluginsJson(profileDir, primarySource);
}

export async function validateConfigDir(
  inputPath: string,
  registeredDirs: string[],
): Promise<{ error: string } | { account: { tool: ToolName; configDir: string; email: string; orgName?: string } }> {
  const configDir = inputPath.replace(/^~(?=$|[\\/])/, homedir());
  if (!(await exists(configDir))) {
    return { error: "Directory not found" };
  }
  if (registeredDirs.includes(configDir)) {
    return { error: "This directory is already registered" };
  }

  for (const adapter of allAdapters()) {
    const account = await adapter.readAccountInfo(configDir);
    if (account) {
      return { account: { tool: adapter.name, configDir, email: account.email, orgName: account.orgName } };
    }
  }

  return { error: "No valid Claude or Codex account found at this path" };
}

export async function discoverAccounts(): Promise<DiscoveredAccount[]> {
  const home = homedir();
  const out: DiscoveredAccount[] = [];

  const entries = await readdir(home, { withFileTypes: true });
  for (const adapter of allAdapters()) {
    const matchingDirs = entries
      .filter((e) => e.isDirectory() && adapter.configDirPattern.test(e.name))
      .map((e) => path.join(home, e.name))
      .sort();

    for (const configDir of matchingDirs) {
      const account = await adapter.readAccountInfo(configDir);
      if (!account) continue;

      const resolvedConfig = await realpath(configDir).catch(() => configDir);
      const resolvedPrimary = await realpath(adapter.defaultConfigDir(home)).catch(() =>
        adapter.defaultConfigDir(home),
      );
      const isPrimary = resolvedConfig === resolvedPrimary;

      // Per-tool credential gate (Claude requires Keychain on macOS)
      if (adapter.keychainServiceName && adapter.hasKeychainCredential) {
        const service = adapter.keychainServiceName({ homeDir: home, configDir: resolvedConfig });
        if (process.platform === "darwin" && !(await adapter.hasKeychainCredential(service))) {
          continue;
        }
      }

      const jsonPath =
        adapter.name === "claude"
          ? claudeJsonPathForConfigDir({ homeDir: home, configDir })
          : path.join(configDir, "auth.json");

      out.push({
        tool: adapter.name,
        configDir,
        jsonPath,
        email: account.email,
        orgName: account.orgName,
        keychainService: adapter.keychainServiceName?.({ homeDir: home, configDir: resolvedConfig }) ?? "",
        isPrimary,
      });
    }
  }

  return out;
}

export async function loadRegistry(): Promise<Registry | null> {
  const raw = await readJson<unknown>(REGISTRY_PATH, null);
  if (raw === null) return null;
  if (!isV1Registry(raw)) return raw as Registry;

  // Migrate v1 → v2 in place with backups

  // 1. Backup the v1 profiles.json (only if backup doesn't already exist)
  const regBak = `${REGISTRY_PATH}.v1.bak`;
  if (!(await exists(regBak))) {
    await cp(REGISTRY_PATH, regBak).catch((e) =>
      warn(`migration: could not backup profiles.json: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  const v1 = raw as RegistryV1;
  const migrated = migrateRegistryV1toV2(v1);
  await writeJson(REGISTRY_PATH, migrated);

  // 2. Backup directory layout migration: backups/<name>/ → backups/claude/<name>/
  const backupsDir = path.join(CLAUSONA_DIR, "backups");
  const backupEntries = await readdir(backupsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of backupEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "claude" || entry.name === "codex") continue; // already-new layout
    const src = path.join(backupsDir, entry.name);
    const dst = path.join(backupsDir, "claude", entry.name);
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(src, dst).catch((e) =>
      warn(`migration: could not move backup ${entry.name}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // 3. Usage store key rename: <name> → claude:<name>
  const usageRaw = await readJson<Record<string, unknown> | null>(USAGE_PATH, null);
  if (usageRaw && Object.keys(usageRaw).some((k) => !k.includes(":"))) {
    const usageBak = `${USAGE_PATH}.v1.bak`;
    if (!(await exists(usageBak))) {
      await cp(USAGE_PATH, usageBak).catch((e) =>
        warn(`migration: could not backup usage.json: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    const renamed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(usageRaw)) {
      renamed[k.includes(":") ? k : `claude:${k}`] = v;
    }
    await writeJson(USAGE_PATH, renamed);
  }

  process.stderr.write(
    "  clausona migrated registry to v2 (codex support enabled). Open a new terminal to activate the codex() wrapper.\n",
  );
  return migrated;
}

export async function saveRegistry(registry: Registry) {
  await writeJson(REGISTRY_PATH, registry);
}

export async function loadUsageStore() {
  return readJson<UsageStore>(USAGE_PATH, {});
}

export async function initializeRegistry(options: {
  accounts: DiscoveredAccount[];
  profileNames: Record<string, string>;
  /** A bare claude profile name the user picked; leave it out when nobody chose one. */
  defaultProfile?: string;
  mergeSessions?: boolean;
  mergeSessionsMap?: Record<string, boolean>;
}) {
  const existing = await loadRegistry();
  // API profiles are not discovered, so a registry rebuilt from what init found would drop
  // them, and with them the only reference to their stored key, config dir and backup.
  // They are carried over exactly as they are.
  const carried = Object.entries(existing?.profiles ?? {}).filter(([, profile]) => profile.kind === "api");
  const carriedDirs = new Set(carried.map(([, profile]) => path.resolve(profile.configDir)));
  // An account found in an API profile's own directory is that profile, not a new one.
  const accounts = options.accounts.filter((account) => !carriedDirs.has(path.resolve(account.configDir)));
  // An account the caller left unnamed is named exactly as the init command names it.
  const names = await proposeInitProfileNames(accounts, existing, options.profileNames);

  // Every name is checked before anything is written. A new name gets the same rules as
  // `add`: the name rule, and no two ids of one tool that differ only by case - they would
  // share a backup directory on a case-insensitive filesystem. An account re-registered
  // under the name it already has creates nothing, so a name from before the rules keeps
  // working: renaming it would strand its backup and everything keyed by its id.
  const planned: Array<{ account: DiscoveredAccount; id: string; backupDir: string | null; kept: boolean }> = [];
  const initIds = new Map<string, { id: string; kept: boolean; api?: boolean }>(
    carried.map(([id]) => [foldProfileName(id), { id, kept: false, api: true }]),
  );
  for (const account of accounts) {
    const name = names[account.configDir];
    const id = profileId(account.tool, name);
    const registered = existing?.profiles[id];
    const kept =
      registered?.tool === account.tool && path.resolve(registered.configDir) === path.resolve(account.configDir);
    if (!kept) {
      const nameCheck = validateProfileName(name);
      if (!nameCheck.ok) throw new Error(nameCheck.error);
    }
    const clash = initIds.get(foldProfileName(id));
    if (clash?.api) throw new Error(`'${clash.id}' is an API profile, which init keeps. Give '${id}' another name.`);
    if (clash?.id === id) throw new Error(`Two accounts are both named '${id}'. Give each account its own name.`);
    if (clash && !(clash.kept && kept)) {
      throw new Error(
        `'${clash.id}' and '${id}' name the same profile (names are compared without case). Give each account its own name.`,
      );
    }
    initIds.set(foldProfileName(id), { id, kept });
    // Resolved now, so a kept name the containment guard refuses stops init before it writes.
    const backupDir = account.isPrimary ? null : backupDirFor(CLAUSONA_DIR, account.tool, name);
    // A re-registered profile goes on using its own backup. A new name gets the add paths'
    // rule: a directory already there that holds something belongs to someone else. Derived
    // names are steered around those, so only a name the caller chose can land on one.
    if (backupDir && !kept && (await backupDirOccupied(backupDir))) throw backupDirTaken(backupDir, id);
    planned.push({ account, id, backupDir, kept });
  }

  await ensureStorage();

  const home = homedir();
  // Build per-tool primary sources from the adapter defaults; only include tools with at least one profile
  const primarySources: Registry["primarySources"] = {};
  for (const { tool } of [...accounts, ...carried.map(([, profile]) => profile)]) {
    if (!primarySources[tool]) {
      primarySources[tool] = getAdapter(tool).defaultConfigDir(home);
    }
  }

  const registry: Registry = {
    version: 2,
    primarySources,
    activeProfiles: {},
    profiles: {},
  };

  for (const { account, id, backupDir, kept } of planned) {
    const mergeSessions = account.isPrimary
      ? undefined
      : (options.mergeSessionsMap?.[account.configDir] ?? options.mergeSessions ?? false);
    registry.profiles[id] = {
      tool: account.tool,
      configDir: account.configDir,
      email: account.email,
      orgName: account.orgName,
      isPrimary: account.isPrimary,
      mergeSessions,
    };

    if (backupDir) {
      const merge = mergeSessions ?? false;
      if (!kept) {
        await claimBackupDir(backupDir, id);
      } else if (!(await exists(backupDir))) {
        await mkdir(backupDir, { recursive: true });
      }
      // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.
      const adapter = getAdapter(account.tool);
      const primary = primarySources[account.tool];
      if (!primary) {
        throw new Error(`primarySource for ${account.tool} not set — registry build invariant violated`);
      }
      if (merge && account.tool === "claude") {
        await mergeSessionState(account.configDir, primary);
      }
      await setupSharedLinks(adapter, account.configDir, primary, merge, backupDir);
      if (account.tool === "claude") {
        await mergePluginFiles(path.join(account.configDir, "plugins"), path.join(primary, "plugins"));
        await setupPluginsDir(account.configDir, primary);
      }
    }
  }

  for (const [id, profile] of carried) registry.profiles[id] = profile;

  // A default the user picked wins for the tool it names - a bare name, so claude. A tool
  // nobody chose for keeps the profile that was active, API or subscription, while it is still
  // registered, and otherwise gets its first account. `init --auto` never chooses, so running
  // it again leaves the active profiles as they were.
  const picked = options.defaultProfile === undefined ? undefined : profileId("claude", options.defaultProfile);
  for (const tool of ALL_TOOLS) {
    const active = existing?.activeProfiles[tool];
    const next =
      (tool === "claude" && picked && registry.profiles[picked] ? picked : undefined) ??
      (active && registry.profiles[active]?.tool === tool ? active : undefined) ??
      planned.find((p) => p.account.tool === tool)?.id;
    if (next) registry.activeProfiles[tool] = next;
  }

  await saveRegistry(registry);
  await writeJson(USAGE_PATH, {});

  // Seed seenSessions for each registered profile (claude only — codex usage tracking is v1 OOS).
  // usage.json was just reset, so a carried API profile needs it as much as any other.
  for (const [id, { tool, configDir }] of [...planned.map((p) => [p.id, p.account] as const), ...carried]) {
    if (tool === "claude") {
      await seedSeenSessions(id, configDir);
    }
  }

  return registry;
}

export type ListProfilesOptions = {
  /** Attach plan quota from each tool's usage endpoint. Off for callers that must stay offline. */
  quota?: boolean;
  /** Bypass the quota cache and re-fetch. */
  refresh?: boolean;
  /** Renew lapsed access tokens instead of reporting them as expired. Default on. */
  renew?: boolean;
  /**
   * Attach the endpoint block and the env map.
   *
   * Off by default, and deliberately: `list --json` is JSON.stringify of exactly this
   * array, and neither belongs in a listing that gets piped into a file or a log. The api
   * block holds a reference rather than a key, but a reference names an environment
   * variable or a whole command line, and the env map is free-form.
   *
   * The TUI asks for it because its preview panel is a screen rather than a pipe, and
   * "what is this profile" is the question the panel exists to answer. Both come through
   * `redactProfile`, so it still shows where the key is read from and never what it is.
   */
  detail?: boolean;
};

export async function listProfiles(options: ListProfilesOptions = {}): Promise<ProfileListItem[]> {
  const registry = await loadRegistry();
  if (!registry) {
    return [];
  }

  const usage = await loadUsageStore();
  const now = new Date().toISOString(); // summarizeUsage interprets cutoffs in the runtime's local timezone

  const entries = Object.entries(registry.profiles);

  let quotas: Record<string, QuotaSnapshot> = {};
  if (options.quota) {
    // An API profile has no plan limits and no OAuth credential. Left in, readCredential
    // returns null and the row renders as `missing`, which reads like an expired account.
    const targets: QuotaTarget[] = entries
      .filter(([, profile]) => profile.kind !== "api")
      .map(([id, profile]) => ({
        id,
        tool: profile.tool,
        configDir: profile.configDir,
      }));
    quotas = await collectQuotas(targets, { refresh: options.refresh, renew: options.renew });
  }

  return entries.map(([id, profile]) => {
    const records = usage[id]?.records ?? [];
    const model = profileModel(profile);
    // Redacted like every other path that prints a profile: the dashboard draws these.
    const shown = options.detail ? redactProfile(profile) : undefined;
    return {
      name: id,
      tool: profile.tool,
      kind: profile.kind,
      email: profile.email,
      label: profile.label,
      orgName: profile.orgName,
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      isActive: registry.activeProfiles[profile.tool] === id,
      mergeSessions: profile.mergeSessions,
      // The one value from the env map that is listed - by name, never by widening to the
      // map. Absent rather than undefined, so a profile without one gains no key.
      ...(model === undefined ? {} : { model }),
      ...(shown ? { api: shown.api, env: shown.env } : {}),
      quota: quotas[id],
      today: summarizeUsage({ now, period: "today", records }),
      week: summarizeUsage({ now, period: "week", records }),
      month: summarizeUsage({ now, period: "month", records }),
      total: summarizeUsage({ now, period: "all", records }),
    };
  });
}

/**
 * Resolves quota for already-listed profiles. Split out from listProfiles so the TUI
 * can paint immediately and fill quota in once the network settles.
 */
export async function fetchProfileQuotas(
  items: Pick<ProfileListItem, "name" | "tool" | "kind" | "configDir">[],
  options: { refresh?: boolean; renew?: boolean } = {},
): Promise<Record<string, QuotaSnapshot>> {
  return collectQuotas(
    // Same exclusion as listProfiles: an API profile has no plan quota to read, so
    // asking for one costs a credential lookup and answers `missing`.
    items
      .filter((item) => item.kind !== "api")
      .map((item) => ({ id: item.name, tool: item.tool, configDir: item.configDir })),
    options,
  );
}

export async function setActiveProfileByName(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) {
    throw new Error(`Profile '${id}' not found.`);
  }

  const next = setActiveProfile(registry, id);
  await saveRegistry(next);
  return next.profiles[id];
}

export async function getUsageSummary(profileId_: string | null, period: UsagePeriod) {
  const registry = await loadRegistry();
  if (!registry) {
    return null;
  }

  const usage = await loadUsageStore();
  const now = new Date().toISOString(); // summarizeUsage interprets cutoffs in the runtime's local timezone

  if (profileId_) {
    const records = usage[profileId_]?.records ?? [];
    return summarizeUsage({ now, period, records });
  }

  return Object.fromEntries(
    Object.keys(registry.profiles).map((id) => [
      id,
      summarizeUsage({ now, period, records: usage[id]?.records ?? [] }),
    ]),
  );
}

export async function doctorProfiles(): Promise<DoctorProfileResult[]> {
  const registry = await loadRegistry();
  if (!registry) {
    return [];
  }

  const results: DoctorProfileResult[] = [];
  const home = homedir();

  for (const [id, profile] of Object.entries(registry.profiles)) {
    const issues: DoctorIssue[] = [];

    const primarySource = registry.primarySources[profile.tool];
    const adapter = getAdapter(profile.tool);

    /**
     * An API profile pointing at a directory that is not there. Everything the shared-link
     * and plugins checks would say about it is a consequence of that one absence, and each
     * of those findings carries "run 'clausona repair'" in its own text - a command that
     * fails with ENOENT in exactly this state, because it symlinks into a directory it does
     * not create. So they are skipped and the profile is left with the one instruction that
     * works.
     *
     * Only for an API profile, and deliberately: a subscription profile in the same state
     * reports the same findings it always has, because a registry without API profiles has
     * to produce the report it produced before they existed. The same misleading advice is
     * reachable there; closing it is a change to subscription behaviour, and belongs to
     * whoever can decide that.
     */
    const configDirMissing = profile.kind === "api" && !(await exists(profile.configDir));

    if (profile.kind === "api") {
      // An API profile has no account JSON and no Claude Code credential, by design, so
      // the checks below would report every healthy one as broken. These take their place.
      const settingsPath = path.join(profile.configDir, "settings.json");
      issues.push(
        ...evaluateApiHealth({
          id,
          profile,
          configDirExists: !configDirMissing,
          // The outcome, and nothing else. resolveSecret returns the key itself: it is
          // awaited and dropped in the same expression so no binding ever holds it.
          secret: profile.api
            ? await resolveSecret(id, profile.api.secret)
                .then(() => ({ ok: true }) as const)
                .catch((error: unknown) => ({
                  ok: false as const,
                  error: error instanceof Error ? error.message : String(error),
                }))
            : undefined,
          settings: await readSettings(settingsPath),
          settingsPath: settingsPath.replace(home, "~"),
          // Whether the helper the profile reads is the primary's or its own, which is the
          // difference between "someone else's helper also runs here" and "this profile has
          // one". A local override is reported separately, by its own check.
          settingsShared: primarySource
            ? (await inspectSharedLink(settingsPath, path.join(primarySource, "settings.json"))).pointsToSource
            : false,
          credentialEnvKeys: CREDENTIAL_ENV_KEYS,
          secretEnvName: isSecretEnvName,
        }),
      );
    } else {
      // Run tool-aware account/keychain checks
      const accountInfo = await adapter.readAccountInfo(profile.configDir);
      if (!accountInfo) {
        issues.push({
          kind: "missing_json",
          message:
            profile.tool === "claude"
              ? ".claude.json is missing or missing oauthAccount.emailAddress"
              : "auth.json is missing or id_token is unparseable",
        });
      }

      // The Keychain only exists on macOS, and the probe returns false everywhere else
      // no matter what the profile holds — so running it unconditionally reported every
      // Linux and Windows profile as broken while never saying anything about the store
      // those platforms actually use. Check whichever store the platform keeps tokens in.
      if (adapter.keychainServiceName && adapter.hasKeychainCredential) {
        if (process.platform === "darwin") {
          const resolvedDir = await realpath(profile.configDir).catch(() => profile.configDir);
          const keychainService = adapter.keychainServiceName({ homeDir: homedir(), configDir: resolvedDir });
          if (!(await adapter.hasKeychainCredential(keychainService))) {
            issues.push({ kind: "missing_keychain", message: `${keychainService} not found in Keychain` });
          }
        } else if (adapter.readCredential && !(await adapter.readCredential(profile.configDir))) {
          issues.push({
            kind: "missing_oauth",
            message: ".credentials.json is missing or has no access token - sign in from this profile",
          });
        }
      }
    }

    if (primarySource && !configDirMissing) {
      const primaryDirents = await readdir(primarySource, { withFileTypes: true }).catch(() => []);
      const primaryEntries = new Set(primaryDirents.map((entry) => entry.name));

      const dirEntries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
      const isSkipped = (n: string) => shouldSkipShare(adapter, n, profile.mergeSessions ?? false);
      const sharedLinkItems: Array<{
        name: string;
        isSharedLink: boolean;
        pointsToPrimary: boolean;
        targetExists: boolean;
        existsInPrimary: boolean;
      }> = [];
      for (const entry of dirEntries) {
        const targetPath = path.join(profile.configDir, entry.name);
        const sourcePath = path.join(primarySource, entry.name);
        const linkInfo = await inspectSharedLink(targetPath, sourcePath);
        const pointsToPrimary = linkInfo.pointsToSource;

        if (isSkipped(entry.name)) {
          // Items in skip set should NOT be symlinked to primary
          if (!profile.isPrimary && pointsToPrimary) {
            issues.push({
              kind: "stale_symlink",
              message: `${entry.name} is symlinked to primary but should not be shared`,
            });
          }
          continue;
        }

        if (linkInfo.isSharedLink) {
          if (!linkInfo.targetExists) {
            await rm(targetPath, { force: true });
            continue;
          }
        }
        sharedLinkItems.push({
          name: entry.name,
          isSharedLink: linkInfo.isSharedLink,
          pointsToPrimary,
          targetExists: true,
          existsInPrimary: primaryEntries.has(entry.name),
        });
      }

      // The loop above can only see what the profile already has, so a directory the
      // primary gained after this profile was set up is invisible to it — the case that
      // let split background-session state read as healthy. Walk the primary too.
      const missingSharedDirs: string[] = [];
      if (!profile.isPrimary) {
        for (const entry of primaryDirents) {
          if (!entry.isDirectory()) continue;
          if (isSkipped(entry.name)) continue;
          if (await exists(path.join(profile.configDir, entry.name))) continue;
          missingSharedDirs.push(entry.name);
        }
      }

      issues.push(
        ...evaluateSymlinkHealth({
          isPrimary: Boolean(profile.isPrimary),
          items: sharedLinkItems,
          missingSharedDirs,
        }),
      );
    }

    // Check plugins/ consistency for non-primary claude profiles with a real plugins/ dir
    if (!profile.isPrimary && profile.tool === "claude" && !configDirMissing) {
      const profilePlugins = path.join(profile.configDir, "plugins");
      const pluginsStats = await lstat(profilePlugins).catch(() => null);
      if (pluginsStats && !pluginsStats.isSymbolicLink()) {
        const knownJson = await readJson<Record<string, unknown>>(
          path.join(profilePlugins, "known_marketplaces.json"),
          {},
        );
        const marketplaceDirs = await readdir(path.join(profilePlugins, "marketplaces"), { withFileTypes: true }).catch(
          () => [],
        );
        const onDisk = new Set(marketplaceDirs.filter((e) => e.isDirectory()).map((e) => e.name));

        let pluginsOutOfSync = false;
        for (const name of onDisk) {
          if (!knownJson[name]) {
            pluginsOutOfSync = true;
            break;
          }
        }
        if (!pluginsOutOfSync) {
          for (const [name, entry] of Object.entries(knownJson)) {
            if (!isManagedMarketplace(entry, profile.configDir)) continue;
            if (!onDisk.has(name)) {
              pluginsOutOfSync = true;
              break;
            }
            const e = entry as Record<string, unknown>;
            if (e.installLocation !== path.join(profile.configDir, "plugins", "marketplaces", name)) {
              pluginsOutOfSync = true;
              break;
            }
          }
        }

        if (pluginsOutOfSync) {
          issues.push({
            kind: "plugins_out_of_sync",
            message: "plugins/ marketplaces and known_marketplaces.json are out of sync",
          });
        }
      }
    }

    results.push({
      name: id,
      // An API profile has no account email; its label stands in, exactly as it does in
      // `list` and `config --show`. A subscription profile has no label, so its title is
      // the email it always was.
      email: displayName(profile),
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      // Warnings do not make a profile unhealthy: it works, and saying otherwise would
      // send a user to `repair` or `login` for something neither command can change.
      healthy: countIssues(issues).errors === 0,
      issues,
    });
  }

  return results;
}

export async function repairProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) {
    throw new Error(`Profile '${id}' not found.`);
  }

  const profile = registry.profiles[id];
  if (profile.isPrimary) {
    return { repaired: 0 };
  }

  const { name } = parseProfileRef(id, registry);
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);
  const profileAdapter = getAdapter(profile.tool);
  const primarySource = registry.primarySources[profile.tool] ?? profileAdapter.defaultConfigDir(homedir());
  const mergeSessions = profile.mergeSessions ?? false;

  // A profile that shares sessions may hold session state the primary has never seen —
  // that is the whole point of repairing a profile whose links predate a directory the
  // tool added later. Fold it in before setupSharedLinks deletes it.
  if (mergeSessions && profile.tool === "claude") {
    await mergeSessionState(profile.configDir, primarySource);
  }

  const repaired = await setupSharedLinks(profileAdapter, profile.configDir, primarySource, mergeSessions, backupDir);
  if (profile.tool === "claude") {
    await setupPluginsDir(profile.configDir, primarySource);
  }

  // Restore skip-set items from backup if they were stale symlinks that got removed
  // Skip if the backup item is a symlink pointing to primary (stale)
  if (await exists(backupDir)) {
    const skipSet = profileAdapter.sharedSkipSet(mergeSessions);
    for (const itemName of skipSet) {
      const target = path.join(profile.configDir, itemName);
      const backupItem = path.join(backupDir, itemName);
      if (!(await exists(target)) && (await exists(backupItem))) {
        const backupStats = await lstat(backupItem).catch(() => null);
        if (backupStats?.isSymbolicLink()) {
          const linkTarget = await readlink(backupItem);
          if (linkTarget === path.join(primarySource, itemName)) continue;
        }
        await cp(backupItem, target, { recursive: true });
      }
    }
  }

  return { repaired };
}

export async function updateProfileConfig(id: string, options: { mergeSessions: boolean }) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) {
    throw new Error(`Profile '${id}' not found.`);
  }
  const profile = registry.profiles[id];
  if (profile.isPrimary) {
    throw new Error("Cannot change session mode for the primary profile.");
  }

  const prev = profile.mergeSessions ?? false;
  const next = options.mergeSessions;
  if (prev === next) return { name: id, mergeSessions: next, changed: false };

  const primarySource = registry.primarySources[profile.tool] ?? getAdapter(profile.tool).defaultConfigDir(homedir());
  // Resolved before the registry changes, so a name backupDirFor refuses changes nothing.
  const { name } = parseProfileRef(id, registry);
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);

  // separated → merged: merge session files before symlinking
  if (next && profile.tool === "claude") {
    await mergeSessionState(profile.configDir, primarySource);
  }

  profile.mergeSessions = next;
  await saveRegistry(registry);

  const updateAdapter = getAdapter(profile.tool);
  await setupSharedLinks(updateAdapter, profile.configDir, primarySource, next, backupDir);
  if (profile.tool === "claude") {
    await setupPluginsDir(profile.configDir, primarySource);
  }

  // merged → separated: restore skip-set items from backup
  // Skip if the backup item is a symlink pointing to primary (stale)
  if (!next) {
    if (await exists(backupDir)) {
      const skipSet = updateAdapter.sharedSkipSet(false);
      for (const itemName of skipSet) {
        const target = path.join(profile.configDir, itemName);
        const backupItem = path.join(backupDir, itemName);
        if (!(await exists(target)) && (await exists(backupItem))) {
          const backupStats = await lstat(backupItem).catch(() => null);
          if (backupStats?.isSymbolicLink()) {
            const linkTarget = await readlink(backupItem);
            if (linkTarget === path.join(primarySource, itemName)) continue;
          }
          await cp(backupItem, target, { recursive: true });
        }
      }
    }
  }

  return { name: id, mergeSessions: next, changed: true };
}

/**
 * A blank ANTHROPIC_MODEL, by any route that writes it. `list` and the preview read a blank
 * one as "none pinned" (see `profileModel`), but launch exports it as it is - so letting one
 * in would make what `list` says differ from what Claude Code gets. `--model ""` was already
 * refused; `--set`, `--edit` and `add --api --set` are the other doors.
 *
 * Worded by where it was written, not by which flag: at `add` there is nothing yet to clear.
 */
export function checkModelEntry(key: string, value: string, context: "add" | "config"): void {
  if (key !== "ANTHROPIC_MODEL" || value.trim() !== "") return;
  throw new Error(
    context === "add"
      ? "A model id cannot be blank. To pin none, leave the model out."
      : "A model id cannot be blank. To pin none, clear it with clausona config <profile> --unset ANTHROPIC_MODEL.",
  );
}

export async function updateProfileEnv(id: string, changes: { set?: Record<string, string>; unset?: string[] }) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const env = { ...(profile.env ?? {}) };

  for (const [key, value] of Object.entries(changes.set ?? {})) {
    const result = validateEnvEntry(key, value);
    if (!result.ok) throw new Error(result.error);
    checkModelEntry(key, value, "config");
    env[key] = value;
  }
  for (const key of changes.unset ?? []) delete env[key];
  // Checked against the map as it will be saved, so a rename in case within one call works.
  for (const key of Object.keys(changes.set ?? {})) {
    if (!Object.hasOwn(env, key)) continue;
    const twin = envKeyCaseTwin(key, Object.keys(env), profile.kind);
    if (twin !== undefined) throw new Error(envKeyCaseTwinError(key, twin));
  }

  registry.profiles[id] = { ...profile, env };
  await saveRegistry(registry);
  return registry.profiles[id];
}

/**
 * The endpoint block a change to an API profile works on, or why there is none. Two
 * different answers: a subscription profile is not an API profile at all, while one marked
 * `api` with no block - a hand edit - is an API profile to doctor and `list`, and has a
 * remedy, the one doctor gives for it.
 */
export function requireEndpoint(id: string, profile: Profile): ApiEndpoint {
  if (profile.kind !== "api") throw new Error(`Profile '${id}' is not an API profile.`);
  if (!profile.api) {
    throw new Error(
      `Profile '${id}' has no endpoint in ~/.clausona/profiles.json, so there is nothing for config to change - ${missingEndpointRemedy(id)}.`,
    );
  }
  return profile.api;
}

export async function updateProfileSecret(id: string, secret: SecretSource, value?: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const api = requireEndpoint(id, profile);
  const { source, toStore } = checkSecretSource(secret, value);

  // Ordered so the registry never names a credential that is not there: a new value is
  // stored before the registry points at it, and an old one is deleted only after the
  // registry has stopped pointing at it.
  if (toStore !== null) await storeSecret(id, toStore);
  registry.profiles[id] = { ...profile, api: { ...api, secret: source } };
  await saveRegistry(registry);
  if (toStore === null) {
    // Leaving a stored value behind after switching to an env or command source would
    // keep a credential alive that nothing reads any more.
    await deleteSecret(id).catch(() => {});
  }
}

/**
 * The scheme `add --api` picks for a host when `--auth` is not given: Anthropic's own API
 * reads X-Api-Key, and gateways, proxies and self-hosted servers overwhelmingly take a Bearer
 * token. One rule for `add` and for `config --base-url`, which is what keeps the two from
 * producing different profiles for the same URL.
 */
export function defaultAuthScheme(hostname: string): ApiEndpoint["authScheme"] {
  return isAnthropicHost(hostname) ? "api-key" : "bearer";
}

/** A host an http URL can reach without the key leaving the machine. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127\./.test(hostname);
}

export type ProfileApiUpdate = {
  profile: Profile;
  /** The host the key went to before, and goes to now. Undefined for a URL that does not parse. */
  previousHost?: string;
  host?: string;
  /** What `add`'s defaults moved with a new base URL, because they were still the old host's. */
  followed: { label: boolean; auth: boolean };
  /**
   * The scheme the new host would default to, when a base URL change kept a scheme that
   * differs from it: one that was chosen, or one there was no old host to judge by.
   */
  hostDefaultAuth?: ApiEndpoint["authScheme"];
  /** The new base URL sends the key unencrypted to somewhere off this machine, and did not before. */
  cleartext: boolean;
};

/**
 * Changes what `add --api` set besides the key: the endpoint, how the key is presented, and
 * the label. Every value goes through the rule `addApiProfile` applies, and all of them are
 * checked before anything is written, so a call that is refused changes nothing. The key
 * and where it is read from are `updateProfileSecret`'s, and are left alone.
 *
 * `add`'s two defaults move with a new base URL while they are still the old host's: the
 * label, which is the host, and the auth scheme, which the host decides. Left behind, `list`
 * names a host the profile no longer talks to, and the key goes in a header the new host
 * does not read - a 401 with nothing to explain it. One that was chosen stays; a scheme that
 * stays and differs from the new host's default is reported, so the caller can say so. With
 * a stored URL too broken to have a host there is nothing to compare, and both stay.
 */
export async function updateProfileApi(
  id: string,
  changes: { baseUrl?: string; authScheme?: string; label?: string },
): Promise<ProfileApiUpdate> {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const api = requireEndpoint(id, profile);

  const baseUrl = changes.baseUrl?.trim() ?? api.baseUrl;
  const url = changes.baseUrl === undefined ? undefined : parseBaseUrl(baseUrl);
  const chosenAuth = changes.authScheme === undefined ? undefined : checkAuthScheme(changes.authScheme);
  const chosenLabel = changes.label === undefined ? undefined : checkLabel(changes.label);

  const before = checkBaseUrl(api.baseUrl);
  const previous = before.ok ? before.url : undefined;
  const followLabel =
    chosenLabel === undefined && url !== undefined && previous !== undefined && profile.label === previous.host;
  const followAuth =
    chosenAuth === undefined &&
    url !== undefined &&
    previous !== undefined &&
    api.authScheme === defaultAuthScheme(previous.hostname) &&
    defaultAuthScheme(url.hostname) !== api.authScheme;
  const label = followLabel && url ? url.host : (chosenLabel ?? profile.label);
  const authScheme = chosenAuth ?? (followAuth && url ? defaultAuthScheme(url.hostname) : api.authScheme);
  const hostDefault = url ? defaultAuthScheme(url.hostname) : undefined;

  registry.profiles[id] = { ...profile, label, api: { ...api, baseUrl, authScheme } };
  await saveRegistry(registry);
  return {
    profile: registry.profiles[id],
    previousHost: previous?.host,
    host: url?.host ?? previous?.host,
    followed: { label: followLabel, auth: followAuth },
    hostDefaultAuth:
      chosenAuth === undefined && hostDefault !== undefined && hostDefault !== authScheme ? hostDefault : undefined,
    cleartext:
      url !== undefined &&
      url.protocol === "http:" &&
      !isLoopbackHost(url.hostname) &&
      !(previous?.protocol === "http:" && previous.host === url.host),
  };
}

async function cleanupProfile(
  name: string,
  profile: Profile,
  primarySource: string,
  options: { keepBackup?: boolean } = {},
) {
  if (profile.isPrimary) return;

  // Resolved before anything is touched: for a name that is not a directory of its own
  // under the backups, backupDirFor throws, and the profile should be left exactly as it was.
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);

  // The registry entry is about to go; a credential outliving it is a credential nothing
  // will ever clean up. Only an API profile can own one, and gating on that keeps removing
  // a subscription profile from reaching into the credential store at all.
  if (profile.kind === "api") await deleteSecret(profileId(profile.tool, name)).catch(() => {});

  // 1a. Strip inner symlinks from plugins/ dir (real dir with inner symlinks)
  const profilePlugins = path.join(profile.configDir, "plugins");
  const pluginsStats = await lstat(profilePlugins).catch(() => null);
  if (pluginsStats && !pluginsStats.isSymbolicLink()) {
    const pluginEntries = await readdir(profilePlugins, { withFileTypes: true }).catch(() => []);
    for (const entry of pluginEntries) {
      const p = path.join(profilePlugins, entry.name);
      const source = path.join(primarySource, "plugins", entry.name);
      const linkInfo = await inspectSharedLink(p, source);
      if (linkInfo.isSharedLink) {
        await rm(p, { force: true, recursive: true });
      }
    }
  }

  // 1b. Strip all symlinks from profile directory
  const entries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(profile.configDir, entry.name);
    const source = path.join(primarySource, entry.name);
    const linkInfo = await inspectSharedLink(p, source);
    if (linkInfo.isSharedLink) {
      await rm(p, { force: true, recursive: true });
    }
  }

  // 2. Restore backup if available (original files before clausona setup), unless the
  // caller found another profile keeping its backup in the same directory.
  if (!options.keepBackup && (await exists(backupDir))) {
    await cp(backupDir, profile.configDir, { recursive: true });
    await rm(backupDir, { force: true, recursive: true });
  }
}

/**
 * A new profile's id must differ from every existing one by more than case. Its backup
 * directory is backups/<tool>/<name>, and on a case-insensitive filesystem - macOS and
 * Windows by default - `Work` names the directory `work` already owns.
 */
function assertProfileIdAvailable(registry: Registry, id: string) {
  if (registry.profiles[id]) throw new Error(`Profile '${id}' already exists.`);
  const folded = foldProfileName(id);
  const clash = Object.keys(registry.profiles).find((existing) => foldProfileName(existing) === folded);
  if (clash) throw new Error(`Profile '${clash}' already exists (names are compared without case).`);
}

/**
 * A new profile's backup directory must not exist yet. Whatever is there belongs to someone
 * else - a profile whose name differs only by case on a case-insensitive filesystem, or one
 * that outlived its registry entry and may hold the user's original files - and the add
 * paths used to clear it before use.
 */
function backupDirTaken(backupDir: string, id: string): Error {
  return new Error(
    `${backupDir.replace(homedir(), "~")} already exists, so '${id}' cannot use it as its backup directory. It may hold another profile's original files: move it somewhere else (or delete it once you are sure nothing in it is needed), then try again.`,
  );
}

/**
 * Clears the way for a new profile's backup directory. An empty directory left there holds
 * nothing to lose, and rmdir removes a directory only while it is empty; anything else at
 * that path - a directory with something in it, or not a directory at all - is refused.
 */
async function clearBackupDir(backupDir: string, id: string) {
  await rmdir(backupDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    // POSIX allows EEXIST as well as ENOTEMPTY for a directory that is not empty.
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST" || error.code === "ENOTDIR") {
      throw backupDirTaken(backupDir, id);
    }
    throw error;
  });
}

/** Whether a backup directory holds anything - or is something other than a directory. */
async function backupDirOccupied(backupDir: string): Promise<boolean> {
  const stats = await lstat(backupDir).catch(() => null);
  if (!stats) return false;
  if (!stats.isDirectory()) return true;
  return (await readdir(backupDir)).length > 0;
}

/**
 * The names init proposes for these accounts: initProfileNames, with derived names kept clear
 * of every backup directory that already holds something. Taking one would make it the new
 * profile's backup, and an item it already has would then be deleted from the account
 * without being saved.
 */
export async function proposeInitProfileNames(
  accounts: DiscoveredAccount[],
  registry: Registry | null,
  chosen: Record<string, string> = {},
): Promise<Record<string, string>> {
  const occupied = new Set<string>();
  for (const tool of ALL_TOOLS) {
    const base = path.join(CLAUSONA_DIR, "backups", tool);
    for (const name of await readdir(base).catch((): string[] => [])) {
      if (await backupDirOccupied(path.join(base, name))) occupied.add(foldProfileName(profileId(tool, name)));
    }
  }
  return initProfileNames(accounts, registry, chosen, occupied);
}

/** Creates a new profile's backup directory, and refuses rather than reuse one that holds anything. */
async function claimBackupDir(backupDir: string, id: string) {
  await clearBackupDir(backupDir, id);
  await mkdir(path.dirname(backupDir), { recursive: true });
  // Not recursive: one that appeared since it was cleared is refused, not adopted.
  await mkdir(backupDir).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? backupDirTaken(backupDir, id) : error;
  });
}

/** True when `child` is `parent` or lies inside it. Both are absolute, normalized paths. */
function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Another registered profile whose backup directory is this profile's, holds it, or lies
 * inside it. Which files in a shared directory belong to which profile cannot be told apart,
 * so it is not this profile's alone to restore from and delete. A registry can hold such a
 * pair from before the name rule: names that differ only by case (one directory on a
 * case-insensitive filesystem), a name that normalizes to this one (`work/`) or nests under
 * it (`work/x`), or one that reaches into another tool's backups (`claude:../codex/work`).
 *
 * Each other profile's directory is worked out with the plain path math that placed it -
 * joined onto its own tool's backups, as backupDirFor did before it refused such names -
 * and not through backupDirFor: an entry that is malformed or refused must not make this
 * profile's removal fail.
 */
function backupDirSharer(registry: Registry, id: string, tool: ToolName, name: string): string | undefined {
  const backups = path.join(CLAUSONA_DIR, "backups");
  const where = (entryTool: string, entryName: string) =>
    foldProfileName(path.resolve(path.join(backups, entryTool, entryName)));
  const own = where(tool, name);
  return Object.entries(registry.profiles).find(([other, profile]) => {
    if (other === id || typeof profile !== "object" || profile === null || profile.isPrimary) return false;
    const separator = other.indexOf(":");
    if (separator < 0 || typeof profile.tool !== "string") return false;
    const theirs = where(profile.tool, other.slice(separator + 1));
    return isWithin(own, theirs) || isWithin(theirs, own);
  })?.[0];
}

/**
 * `add --from` moves each entry the primary shares into a backup and links it to the
 * primary's. Run on the primary itself, that replaces each entry with a link to itself; run
 * on another profile's directory, it gives two profiles one directory; run on a directory
 * that holds one of those - the home directory holds the primary and its `.claude.json` -
 * it replaces that directory's own entries with links. All are compared by where they
 * resolve, so a trailing separator or a link cannot slip past.
 */
async function assertImportable(registry: Registry, tool: ToolName, configDir: string, primarySource: string) {
  const home = homedir();
  const resolve = (dir: string) => realpath(dir).catch(() => path.resolve(dir));
  const target = await resolve(configDir);
  const shown = configDir.replace(home, "~");
  if (target === (await resolve(primarySource))) {
    throw new Error(`Cannot add ${shown}: it is ${tool}'s primary config directory, which every profile shares.`);
  }
  for (const [id, profile] of Object.entries(registry.profiles)) {
    if (target === (await resolve(profile.configDir))) {
      throw new Error(`Cannot add ${shown}: it is already registered as '${id}'.`);
    }
  }
  if (target === (await resolve(home))) {
    throw new Error(`Cannot add ${shown}: it is the home directory, not a config directory.`);
  }
  for (const managed of [primarySource, ...Object.values(registry.profiles).map((profile) => profile.configDir)]) {
    if (isWithin(target, await resolve(managed))) {
      throw new Error(`Cannot add ${shown}: it holds ${managed.replace(home, "~")}, which clausona already manages.`);
    }
  }
}

export async function addProfile(options: {
  tool: ToolName;
  name: string;
  fromPath?: string;
  mergeSessions?: boolean;
}) {
  const nameCheck = validateProfileName(options.name);
  if (!nameCheck.ok) throw new Error(nameCheck.error);

  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");

  const id = profileId(options.tool, options.name);
  assertProfileIdAvailable(registry, id);

  const adapter = getAdapter(options.tool);
  const home = homedir();
  const primarySource = registry.primarySources[options.tool] ?? adapter.defaultConfigDir(home);

  if (options.fromPath) {
    const configDir = options.fromPath.replace(/^~(?=$|[\\/])/, home);
    await assertImportable(registry, options.tool, configDir, primarySource);
    const accountInfo = await adapter.readAccountInfo(configDir);
    if (!accountInfo) throw new Error("Could not read account info from config dir.");

    const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);
    await claimBackupDir(backupDir, id);
    // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.
    const mergeSessions = options.mergeSessions ?? false;
    try {
      if (mergeSessions && options.tool === "claude") {
        await mergeSessionState(configDir, primarySource);
      }
      await setupSharedLinks(adapter, configDir, primarySource, mergeSessions, backupDir);
      if (options.tool === "claude") {
        await mergePluginFiles(path.join(configDir, "plugins"), path.join(primarySource, "plugins"));
        await setupPluginsDir(configDir, primarySource);
      }
    } catch (error) {
      await cleanupProfile(
        options.name,
        { tool: options.tool, configDir, email: "", isPrimary: false },
        primarySource,
      ).catch(() => {});
      throw new Error(
        `Failed to set up profile '${options.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    registry.profiles[id] = {
      tool: options.tool,
      configDir,
      email: accountInfo.email,
      orgName: accountInfo.orgName,
      mergeSessions,
    };
    if (!registry.primarySources[options.tool]) {
      registry.primarySources[options.tool] = primarySource;
    }
    await saveRegistry(registry);
    if (options.tool === "claude") await seedSeenSessions(id, configDir);
    return { name: options.name, email: accountInfo.email, configDir, backupDir };
  }

  // New profile with no --from: create a fresh config dir and run login
  const dirSuffix = options.tool === "claude" ? ".claude" : ".codex";
  const configDir = path.join(home, `${dirSuffix}-${options.name}`);
  if (await exists(configDir)) {
    throw new Error(
      `${configDir.replace(home, "~")} already exists. Use --from ${configDir.replace(home, "~")} to import it instead.`,
    );
  }
  // Cleared here as well as where it is created, so a refusal does not come after a sign-in.
  const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);
  await clearBackupDir(backupDir, id);
  await mkdir(configDir, { recursive: true });

  // Check if credentials already exist for this dir
  let alreadyAuthenticated = false;
  if (options.tool === "claude") {
    const resolvedDir = await realpath(configDir).catch(() => configDir);
    const service = adapter.keychainServiceName?.({ homeDir: home, configDir: resolvedDir });
    const existing = service && adapter.hasKeychainCredential ? await adapter.hasKeychainCredential(service) : false;
    const existingAccount = await adapter.readAccountInfo(configDir);
    alreadyAuthenticated = !!(existingAccount && existing);
  } else {
    const existingAccount = await adapter.readAccountInfo(configDir);
    alreadyAuthenticated = !!existingAccount;
  }

  if (!alreadyAuthenticated) {
    const loggedIn = await adapter.runLogin(configDir);
    if (!loggedIn) {
      await rm(configDir, { force: true, recursive: true });
      throw new Error(`${options.tool} login failed.`);
    }
  }

  // Merge onboarding state for Claude (skip for codex — no equivalent)
  if (options.tool === "claude") {
    const primaryJsonPath = claudeJsonPathForConfigDir({ homeDir: home, configDir: primarySource });
    const jsonPath = path.join(configDir, ".claude.json");
    const primaryJson = await readJson<Record<string, unknown>>(primaryJsonPath, {});
    const profileJson = await readJson<Record<string, unknown>>(jsonPath, {});
    const onboardingKeys = ["hasCompletedOnboarding", "lastOnboardingVersion"] as const;
    let needsWrite = false;
    for (const key of onboardingKeys) {
      if (primaryJson[key] !== undefined && profileJson[key] === undefined) {
        profileJson[key] = primaryJson[key];
        needsWrite = true;
      }
    }
    if (needsWrite) await writeJson(jsonPath, profileJson);
  }

  const accountInfo = await adapter.readAccountInfo(configDir);
  if (!accountInfo) {
    await rm(configDir, { force: true, recursive: true });
    throw new Error("Login succeeded but account metadata is missing.");
  }

  await claimBackupDir(backupDir, id).catch(async (error) => {
    await rm(configDir, { force: true, recursive: true });
    throw error;
  });
  // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.

  const mergeSessions = options.mergeSessions ?? false;
  try {
    await setupSharedLinks(adapter, configDir, primarySource, mergeSessions, backupDir);
    if (options.tool === "claude") {
      await setupPluginsDir(configDir, primarySource);
    }
  } catch (error) {
    await cleanupProfile(
      options.name,
      { tool: options.tool, configDir, email: "", isPrimary: false },
      primarySource,
    ).catch(() => {});
    await rm(configDir, { force: true, recursive: true }).catch(() => {});
    throw new Error(
      `Failed to set up profile '${options.name}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  registry.profiles[id] = {
    tool: options.tool,
    configDir,
    email: accountInfo.email,
    orgName: accountInfo.orgName,
    mergeSessions,
  };
  if (!registry.primarySources[options.tool]) {
    registry.primarySources[options.tool] = primarySource;
  }
  await saveRegistry(registry);
  if (options.tool === "claude") await seedSeenSessions(id, configDir);
  return { name: options.name, email: accountInfo.email, configDir };
}

/**
 * Checks a key source before anything is stored or persisted. Returns the reference to
 * persist - rebuilt from its known fields, so nothing else a caller attached to the object
 * reaches profiles.json - and the value to store, which only the keychain source has.
 * No error here carries a key.
 */
function checkSecretSource(
  secret: SecretSource,
  value: string | undefined,
): { source: SecretSource; toStore: string | null } {
  switch (secret.source) {
    case "keychain":
      if (value === undefined || value.trim() === "") throw new Error("no API key supplied for the keychain source");
      // A pasted key often brings a newline along, and the file backend reads back what it stored.
      return { source: { source: "keychain" }, toStore: value.trim() };
    case "env":
      // Not echoed: a key pasted where the variable name belongs would land in the error.
      if (typeof secret.name !== "string" || !isPosixEnvName(secret.name)) {
        throw new Error(
          "Invalid key variable name: use letters, digits and underscores, starting with a letter or underscore. Pass the variable's name, not the key.",
        );
      }
      return { source: { source: "env", name: secret.name }, toStore: null };
    case "command":
      if (typeof secret.run !== "string" || secret.run.trim() === "") {
        throw new Error("The key command is empty.");
      }
      return { source: { source: "command", run: secret.run }, toStore: null };
    default:
      throw new Error("Unknown key source: use keychain, env or command.");
  }
}

/**
 * Exported so the CLI can apply this rule before it asks for a key, rather than after -
 * a rejected base URL should not cost the user a typed key. It is the definition, not a
 * copy: `addApiProfile` calls the same function, and the caller gets the same message.
 */
export function parseBaseUrl(baseUrl: string): URL {
  // The rules live in core/api-url.ts, which the doctor reads too; only the wording is
  // here. Neither message repeats the URL: profiles.json holds references to secrets,
  // never secrets, and a password in the URL would be persisted and exported with it.
  const checked = checkBaseUrl(baseUrl);
  if (!checked.ok) {
    switch (checked.problem.reason) {
      case "empty":
      case "unparseable":
        throw new Error("Invalid base URL: must be an absolute http:// or https:// URL.");
      case "scheme":
        throw new Error(`Invalid base URL: the scheme must be http or https, not '${checked.problem.scheme}'.`);
      default:
        throw new Error(
          "Invalid base URL: it must not carry credentials. Supply the key through the key source instead.",
        );
    }
  }
  return checked.url;
}

/**
 * The label rule, for `add --api` and `config --label` alike. Exported so the CLI can apply
 * it before asking for a key, as it does `parseBaseUrl`.
 *
 * A blank label would render the profile as an empty row in `list`, since an API profile
 * has no account email for `displayName` to fall back on.
 */
export function checkLabel(label: string, context: "add" | "config" = "config"): string {
  const trimmed = label.trim();
  if (trimmed === "") {
    // At add, leaving the label out gets the endpoint's host; at config there is no such
    // default to fall back on, only the label the profile already has.
    const hint = context === "add" ? " Leave --label out to use the endpoint's host." : "";
    throw new Error(`Label cannot be blank: it is the name \`clausona list\` shows for this profile.${hint}`);
  }
  return trimmed;
}

function checkAuthScheme(scheme: string): ApiEndpoint["authScheme"] {
  // Not echoed: arguments passed in the wrong order would put the key here.
  if (scheme !== "bearer" && scheme !== "api-key") {
    throw new Error("Invalid auth scheme: must be 'bearer' or 'api-key'.");
  }
  return scheme;
}

export async function addApiProfile(options: {
  tool: ToolName;
  name: string;
  baseUrl: string;
  authScheme: "bearer" | "api-key";
  secret: SecretSource;
  /** Present only for the keychain source: the value to store. */
  secretValue?: string;
  label?: string;
  env?: Record<string, string>;
  mergeSessions?: boolean;
}) {
  // Every input is checked before the first side effect, so a rejection leaves no config
  // directory, stored credential, or registry entry behind.
  const nameCheck = validateProfileName(options.name);
  if (!nameCheck.ok) throw new Error(nameCheck.error);
  if (options.tool !== "claude") {
    throw new Error("API profiles are supported for claude only in this version.");
  }
  const baseUrl = options.baseUrl.trim();
  const url = parseBaseUrl(baseUrl);
  checkAuthScheme(options.authScheme);
  // Absent means "use the host".
  const label = options.label === undefined ? url.host : checkLabel(options.label, "add");
  const { source: secret, toStore } = checkSecretSource(options.secret, options.secretValue);
  const env = { ...options.env };
  for (const [key, value] of Object.entries(env)) {
    const result = validateEnvEntry(key, value);
    if (!result.ok) throw new Error(result.error);
    checkModelEntry(key, value, "add");
    const twin = envKeyCaseTwin(key, Object.keys(env), "api");
    if (twin !== undefined) throw new Error(envKeyCaseTwinError(key, twin));
  }

  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");

  const id = profileId(options.tool, options.name);
  assertProfileIdAvailable(registry, id);

  const adapter = getAdapter(options.tool);
  const home = homedir();
  const primarySource = registry.primarySources[options.tool] ?? adapter.defaultConfigDir(home);
  const configDir = path.join(home, `.claude-${options.name}`);
  if (await exists(configDir)) {
    throw new Error(`${configDir.replace(home, "~")} already exists. Choose another profile name.`);
  }

  const mergeSessions = options.mergeSessions ?? false;
  const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);
  // The first side effect, so a backup directory that is already there changes nothing.
  await claimBackupDir(backupDir, id);
  try {
    await mkdir(configDir, { recursive: true });
    // Carry the primary's onboarding state across. An API profile has no login step, so an
    // onboarding wizard on first launch is even more jarring than it is for a new account.
    const primaryJsonPath = claudeJsonPathForConfigDir({ homeDir: home, configDir: primarySource });
    const jsonPath = path.join(configDir, ".claude.json");
    const primaryJson = await readJson<Record<string, unknown>>(primaryJsonPath, {});
    const profileJson = await readJson<Record<string, unknown>>(jsonPath, {});
    for (const key of ["hasCompletedOnboarding", "lastOnboardingVersion"] as const) {
      if (primaryJson[key] !== undefined && profileJson[key] === undefined) profileJson[key] = primaryJson[key];
    }
    await writeJson(jsonPath, profileJson);

    await setupSharedLinks(adapter, configDir, primarySource, mergeSessions, backupDir);
    await setupPluginsDir(configDir, primarySource);
    if (toStore !== null) await storeSecret(id, toStore);

    // Inside the try: a registry write that fails must not strand the credential above.
    registry.profiles[id] = {
      tool: options.tool,
      kind: "api",
      configDir,
      email: "",
      label,
      mergeSessions,
      api: { baseUrl, authScheme: options.authScheme, secret },
      env,
    };
    if (!registry.primarySources[options.tool]) registry.primarySources[options.tool] = primarySource;
    await saveRegistry(registry);
  } catch (error) {
    await cleanupProfile(
      options.name,
      { tool: options.tool, kind: "api", configDir, email: "", isPrimary: false },
      primarySource,
    ).catch(() => {});
    await rm(configDir, { force: true, recursive: true }).catch(() => {});
    throw new Error(
      `Failed to set up profile '${options.name}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await seedSeenSessions(id, configDir);
  return { name: options.name, configDir };
}

export async function loginProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  if (profile.kind === "api") {
    throw new Error(`'${id}' is an API profile. Change its key with 'clausona config ${id} --key'.`);
  }
  const loggedIn = await getAdapter(profile.tool).runLogin(profile.configDir);
  if (!loggedIn) throw new Error(`${profile.tool} login failed.`);
  return profile;
}

export async function removeProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);

  // Every value the removal uses is read and checked here, before its first side effect.
  // cleanupProfile deletes a stored key before it touches anything else, then strips the links
  // and restores and deletes the backup, so a bad value it met on the way would leave the
  // removal half done with the entry still registered. profiles.json can be edited by hand,
  // so nothing in it is taken on trust.
  const home = homedir();
  const shownRegistry = REGISTRY_PATH.replace(home, "~");
  const unremovable = (reason: string) =>
    new Error(`Profile '${id}' ${reason}, so it cannot be removed. Remove its entry from ${shownRegistry} by hand.`);
  const profile = registry.profiles[id];
  if (typeof profile !== "object") throw unremovable("is not a profile entry");
  if (profile.isPrimary) throw new Error("Cannot remove the primary profile.");
  if (!ALL_TOOLS.includes(profile.tool)) throw unremovable("has no known tool (claude or codex)");
  // The tool decides whose stored key and backup directory this removal deletes.
  if (!id.startsWith(`${profile.tool}:`)) throw unremovable(`is not listed as '${profile.tool}:<name>'`);
  if (typeof profile.configDir !== "string" || !path.isAbsolute(profile.configDir)) {
    throw unremovable("has no config directory path");
  }
  // Recognising which links lead to the primary depends on this, so a value that is not a path
  // is refused rather than replaced by the default: a wrong guess would strip the wrong links.
  const adapter = getAdapter(profile.tool);
  const recorded: unknown = registry.primarySources?.[profile.tool];
  if (recorded !== undefined && (typeof recorded !== "string" || !path.isAbsolute(recorded))) {
    throw new Error(
      `primarySources.${profile.tool} in ${shownRegistry} is not a path, so '${id}' cannot be removed: clausona needs it to tell the profile's links to the primary apart. Set it to the ${profile.tool} primary config directory (${adapter.defaultConfigDir(home).replace(home, "~")}) and run the command again.`,
    );
  }
  const primarySource = (recorded as string | undefined) ?? adapter.defaultConfigDir(home);
  const { name } = parseProfileRef(id, registry);
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);
  const sharer = backupDirSharer(registry, id, profile.tool, name);
  const sharedWarning = sharer
    ? `${id}: left ${backupDir.replace(home, "~")} in place because '${sharer}' keeps its backup there too. Nothing from it was restored into ${profile.configDir.replace(home, "~")}; copy back anything you need from it by hand.`
    : undefined;

  // The profiles of this tool that remain, counting only entries clausona could have written:
  // the next active profile is picked from these.
  const remaining = Object.keys(registry.profiles).filter((key) => {
    const other = registry.profiles[key];
    return (
      key !== id &&
      key.startsWith(`${profile.tool}:`) &&
      other?.tool === profile.tool &&
      typeof other.configDir === "string" &&
      path.isAbsolute(other.configDir)
    );
  });
  const profiles = { ...registry.profiles };
  delete profiles[id];
  const activeProfiles = { ...registry.activeProfiles };
  if (activeProfiles[profile.tool] === id) {
    if (remaining.length > 0) activeProfiles[profile.tool] = remaining[0];
    else delete activeProfiles[profile.tool];
  }
  const primarySources = { ...registry.primarySources };
  if (remaining.length === 0) delete primarySources[profile.tool];
  const next: Registry = { ...registry, profiles, activeProfiles, primarySources };

  await cleanupProfile(name, profile, primarySource, { keepBackup: sharer !== undefined });
  if (sharedWarning) warn(sharedWarning);
  await saveRegistry(next);
}

/**
 * Deletes a variable from an environment copy. Windows treats environment names
 * case-insensitively - `anthropic_api_key` is ANTHROPIC_API_KEY to the tool - and a spread
 * of process.env keeps whatever spelling the variable was created with, so there every
 * spelling goes, except one the profile set itself. On POSIX a differently cased name is a
 * different variable.
 */
function deleteEnvVar(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform, keep: Record<string, string>) {
  if (platform !== "win32") {
    delete env[key];
    return;
  }
  const upper = key.toUpperCase();
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === upper && !Object.hasOwn(keep, name)) delete env[name];
  }
}

export async function resolveProfileEnv(
  id: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ tool: ToolName; binary: string; configDir: string; env: NodeJS.ProcessEnv }> {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const adapter = getAdapter(profile.tool);
  const { env: profileEnv, unset, warnings } = await buildProfileEnv(id, profile);
  for (const warning of warnings) warn(warning);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // On Windows an inherited `my_flag` is the profile's `My_Flag` under another spelling, and
  // with both in the env the child would get whichever sorts first - so the profile's own
  // spelling replaces every inherited one.
  for (const key of Object.keys(profileEnv)) deleteEnvVar(env, key, platform, {});
  Object.assign(env, profileEnv);
  // buildProfileEnv omits the config variable for a primary profile; an inherited value
  // from the surrounding shell would otherwise survive and point at the wrong profile.
  if (!Object.hasOwn(profileEnv, adapter.configEnvVar)) {
    deleteEnvVar(env, adapter.configEnvVar, platform, profileEnv);
  }
  // A credential the caller exported for something else, which the tool would otherwise
  // send to this profile's endpoint alongside the profile's own, or a provider switch that
  // would route around it. The shell hooks unset the same list.
  for (const key of unset) deleteEnvVar(env, key, platform, profileEnv);
  if (profile.tool === "claude") {
    const primary = registry.primarySources.claude ?? adapter.defaultConfigDir(homedir());
    await syncPluginsJson(profile.configDir, primary).catch((e) =>
      warn(`syncPluginsJson: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  return { tool: profile.tool, binary: adapter.binary, configDir: profile.configDir, env };
}

export function shellInit() {
  return renderShellInit();
}

export async function uninstallClausona() {
  const removed: string[] = [];
  const home = homedir();

  // 1. Strip symlinks, restore backups for all non-primary profiles
  const registry = await loadRegistry();
  if (registry) {
    for (const [id, profile] of Object.entries(registry.profiles)) {
      if (profile.isPrimary) continue;
      try {
        const { name } = parseProfileRef(id, registry);
        const primarySource =
          registry.primarySources[profile.tool] ?? getAdapter(profile.tool).defaultConfigDir(homedir());
        await cleanupProfile(name, profile, primarySource);
        removed.push(`profile: ${id} (symlinks stripped, data preserved at ${profile.configDir.replace(home, "~")})`);
      } catch (e) {
        warn(`uninstall: could not clean up profile ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 2. Remove shell integration from rc files
  const rcFiles = [
    path.join(home, ".zshrc"),
    path.join(home, ".bashrc"),
    path.join(home, "Documents", "WindowsPowerShell", "profile.ps1"),
    path.join(home, "Documents", "PowerShell", "profile.ps1"),
  ];
  for (const rcFile of rcFiles) {
    try {
      const content = await readFile(rcFile, "utf8");
      const filtered = content
        .split("\n")
        .filter((line) => !line.includes("clausona shell-init"))
        .join("\n");
      if (filtered !== content) {
        await writeFile(rcFile, filtered, "utf8");
        removed.push(`shell-init: ${rcFile}`);
      }
    } catch {
      // file doesn't exist or not readable
    }
  }

  // 3. Remove ~/.clausona/ directory (registry, usage, remaining backups)
  if (await exists(CLAUSONA_DIR)) {
    await rm(CLAUSONA_DIR, { force: true, recursive: true });
    removed.push(`data: ${CLAUSONA_DIR}`);
  }

  // 4. Remove app directory
  const appDir =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "clausona")
      : path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "clausona");
  if (await exists(appDir)) {
    await rm(appDir, { force: true, recursive: true });
    removed.push(`app: ${appDir}`);
  }

  // 5. Remove launcher binaries
  if (process.platform === "win32") {
    for (const launcherName of ["clausona.cmd", "csn.cmd"]) {
      const launcherPath = path.join(home, ".local", "bin", launcherName);
      if (await exists(launcherPath)) {
        try {
          await rm(launcherPath, { force: true });
          removed.push(`launcher: ${launcherPath}`);
        } catch {
          removed.push(`launcher: ${launcherPath} (manual removal required — file is in use)`);
        }
      }
    }
  } else {
    const which = await execCommand("which", ["clausona"], { quiet: true });
    const launcherPath = which.stdout.trim();
    if (launcherPath && (await exists(launcherPath))) {
      try {
        await rm(launcherPath, { force: true });
        removed.push(`launcher: ${launcherPath}`);
      } catch {
        // may need sudo — report to user
        removed.push(`launcher: ${launcherPath} (manual removal required — needs sudo)`);
      }
    }
  }

  return { removed };
}
