import { spawn } from "node:child_process";
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
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { evaluateSymlinkHealth } from "../core/doctor.js";
import { backupDirFor, claudeJsonPathForConfigDir } from "../core/paths.js";
import { isV1Registry, migrateRegistryV1toV2, setActiveProfile } from "../core/registry.js";
import { renderShellInit } from "../core/shell.js";
import { seedSeenSessions } from "../core/track-usage.js";
import { summarizeUsage } from "../core/usage.js";
import { allAdapters, getAdapter } from "../tools/registry.js";
import type { ToolAdapter } from "../tools/types.js";
import type {
  DiscoveredAccount,
  DoctorIssue,
  DoctorProfileResult,
  Profile,
  ProfileListItem,
  Registry,
  RegistryV1,
  ToolName,
  UsagePeriod,
  UsageStore,
} from "../types.js";
import { profileId } from "./profile-ref.js";

/** Files inside plugins/ that contain absolute paths and must be per-profile */
const PLUGINS_PATH_FILES = new Set(["known_marketplaces.json", "installed_plugins.json"]);

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
      const child = spawn(command, args, {
        env: { ...process.env, ...options.env },
        stdio: "inherit",
      });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout: "", stderr: "" }));
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "" }));
      return;
    }

    const child = spawn(command, args, {
      env: { ...process.env, ...options?.env },
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!options?.quiet) {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
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

function defaultProfileNameForConfigDir(configDir: string) {
  const base = path.basename(configDir);
  if (base === ".claude") {
    return "default";
  }

  return base.replace(/^\.claude-/, "") || "profile";
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
      const targetStats = await lstat(target).catch(() => null);
      if (targetStats?.isSymbolicLink()) {
        const linkTarget = await readlink(target);
        if (linkTarget === source) {
          await rm(target);
        }
      }
      continue;
    }
    const target = path.join(profileDir, item.name);
    const targetExists = await exists(target);
    if (targetExists) {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const currentTarget = await readlink(target);
        if (currentTarget === source) {
          linked += 1;
          continue;
        }
      } else if (backupDir) {
        // Real data — save to backup before removing
        const backupTarget = path.join(backupDir, item.name);
        if (!(await exists(backupTarget))) {
          await cp(target, backupTarget, { recursive: true });
        }
      }
      await rm(target, { force: true, recursive: true });
    }

    await symlink(source, target);
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
      if (!onDisk.has(name)) continue; // in JSON but not on disk → drop
      const e = entry as Record<string, unknown>;
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
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const currentTarget = await readlink(target);
        if (currentTarget === source) continue;
      }
      await rm(target, { force: true, recursive: true });
    }
    await symlink(source, target);
  }

  await syncPluginsJson(profileDir, primarySource);
}

export async function validateConfigDir(
  inputPath: string,
  registeredDirs: string[],
): Promise<{ error: string } | { account: { tool: ToolName; configDir: string; email: string; orgName?: string } }> {
  const configDir = inputPath.replace(/^~(?=$|\/)/, homedir());
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
  defaultProfile: string;
  mergeSessions?: boolean;
  mergeSessionsMap?: Record<string, boolean>;
}) {
  await ensureStorage();

  const home = homedir();
  // Build per-tool primary sources from the adapter defaults; only include tools with at least one account
  const primarySources: Registry["primarySources"] = {};
  for (const account of options.accounts) {
    if (!primarySources[account.tool]) {
      primarySources[account.tool] = getAdapter(account.tool).defaultConfigDir(home);
    }
  }

  const registry: Registry = {
    version: 2,
    primarySources,
    activeProfiles: {},
    profiles: {},
  };

  for (const account of options.accounts) {
    const baseName = options.profileNames[account.configDir] ?? defaultProfileNameForConfigDir(account.configDir);
    const id = profileId(account.tool, baseName);
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

    if (!account.isPrimary) {
      const merge = mergeSessions ?? false;
      const backupDir = backupDirFor(CLAUSONA_DIR, account.tool, baseName);
      if (!(await exists(backupDir))) {
        await mkdir(backupDir, { recursive: true });
        // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.
      }
      const adapter = getAdapter(account.tool);
      const primary = primarySources[account.tool];
      if (!primary) {
        throw new Error(`primarySource for ${account.tool} not set — registry build invariant violated`);
      }
      if (merge && account.tool === "claude") {
        await mergeSessionFiles(account.configDir, primary);
      }
      await setupSharedLinks(adapter, account.configDir, primary, merge, backupDir);
      if (account.tool === "claude") {
        await mergePluginFiles(path.join(account.configDir, "plugins"), path.join(primary, "plugins"));
        await setupPluginsDir(account.configDir, primary);
      }
    }
  }

  // Determine activeProfiles map from options.defaultProfile (per-tool)
  // defaultProfile is a bare name from CLI; resolve to claude:<name> for backwards compat.
  const claudeAccounts = options.accounts.filter((a) => a.tool === "claude");
  const codexAccounts = options.accounts.filter((a) => a.tool === "codex");
  if (claudeAccounts.length > 0) {
    const fallback =
      options.profileNames[claudeAccounts[0].configDir] ?? defaultProfileNameForConfigDir(claudeAccounts[0].configDir);
    const wanted = profileId("claude", options.defaultProfile);
    registry.activeProfiles.claude = registry.profiles[wanted] ? wanted : profileId("claude", fallback);
  }
  if (codexAccounts.length > 0) {
    const fallback =
      options.profileNames[codexAccounts[0].configDir] ?? defaultProfileNameForConfigDir(codexAccounts[0].configDir);
    registry.activeProfiles.codex = profileId("codex", fallback);
  }

  await saveRegistry(registry);
  await writeJson(USAGE_PATH, {});

  // Seed seenSessions for each registered profile (claude only — codex usage tracking is v1 OOS)
  for (const account of options.accounts) {
    const baseName = options.profileNames[account.configDir] ?? defaultProfileNameForConfigDir(account.configDir);
    const id = profileId(account.tool, baseName);
    if (account.tool === "claude") {
      await seedSeenSessions(id, account.configDir);
    }
  }

  return registry;
}

export async function listProfiles(): Promise<ProfileListItem[]> {
  const registry = await loadRegistry();
  if (!registry) {
    return [];
  }

  const usage = await loadUsageStore();
  const now = new Date().toISOString(); // summarizeUsage interprets cutoffs in the runtime's local timezone

  return Object.entries(registry.profiles).map(([id, profile]) => {
    const records = usage[id]?.records ?? [];
    return {
      name: id,
      tool: profile.tool,
      email: profile.email,
      orgName: profile.orgName,
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      isActive: registry.activeProfiles[profile.tool] === id,
      mergeSessions: profile.mergeSessions,
      today: summarizeUsage({ now, period: "today", records }),
      week: summarizeUsage({ now, period: "week", records }),
      month: summarizeUsage({ now, period: "month", records }),
      total: summarizeUsage({ now, period: "all", records }),
    };
  });
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

  for (const [id, profile] of Object.entries(registry.profiles)) {
    const issues: DoctorIssue[] = [];

    const primarySource = registry.primarySources[profile.tool];
    const adapter = getAdapter(profile.tool);

    // Run tool-aware account/keychain checks
    {
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

      if (adapter.keychainServiceName && adapter.hasKeychainCredential) {
        const resolvedDir = await realpath(profile.configDir).catch(() => profile.configDir);
        const keychainService = adapter.keychainServiceName({ homeDir: homedir(), configDir: resolvedDir });
        if (!(await adapter.hasKeychainCredential(keychainService))) {
          issues.push({ kind: "missing_keychain", message: `${keychainService} not found in Keychain` });
        }
      }
    }

    if (primarySource) {
      const primaryEntries = new Set(
        (await readdir(primarySource, { withFileTypes: true }).catch(() => [])).map((entry) => entry.name),
      );

      const dirEntries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
      const isSkipped = (n: string) => shouldSkipShare(adapter, n, profile.mergeSessions ?? false);
      const symlinkItems: Array<{
        name: string;
        isSymlink: boolean;
        pointsToPrimary: boolean;
        targetExists: boolean;
        existsInPrimary: boolean;
      }> = [];
      for (const entry of dirEntries) {
        const targetPath = path.join(profile.configDir, entry.name);
        const stats = await lstat(targetPath);
        const isSymlink = stats.isSymbolicLink();
        const pointsToPrimary = isSymlink && (await readlink(targetPath)) === path.join(primarySource, entry.name);

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

        if (isSymlink) {
          const targetExists = await exists(await realpath(targetPath).catch(() => ""));
          if (!targetExists) {
            await rm(targetPath, { force: true });
            continue;
          }
        }
        symlinkItems.push({
          name: entry.name,
          isSymlink,
          pointsToPrimary,
          targetExists: true,
          existsInPrimary: primaryEntries.has(entry.name),
        });
      }

      issues.push(
        ...evaluateSymlinkHealth({
          isPrimary: Boolean(profile.isPrimary),
          items: symlinkItems,
        }),
      );
    }

    // Check plugins/ consistency for non-primary claude profiles with a real plugins/ dir
    if (!profile.isPrimary && profile.tool === "claude") {
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
      email: profile.email,
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      healthy: issues.length === 0,
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

  const name = id.split(":").slice(1).join(":");
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);
  const profileAdapter = getAdapter(profile.tool);
  const primarySource = registry.primarySources[profile.tool] ?? profileAdapter.defaultConfigDir(homedir());
  const repaired = await setupSharedLinks(
    profileAdapter,
    profile.configDir,
    primarySource,
    profile.mergeSessions ?? false,
    backupDir,
  );
  if (profile.tool === "claude") {
    await setupPluginsDir(profile.configDir, primarySource);
  }

  // Restore skip-set items from backup if they were stale symlinks that got removed
  // Skip if the backup item is a symlink pointing to primary (stale)
  if (await exists(backupDir)) {
    const skipSet = profileAdapter.sharedSkipSet(profile.mergeSessions ?? false);
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

  // separated → merged: merge session files before symlinking
  if (next && profile.tool === "claude") {
    await mergeSessionFiles(profile.configDir, primarySource);
  }

  profile.mergeSessions = next;
  await saveRegistry(registry);

  const name = id.split(":").slice(1).join(":");
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);
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

async function cleanupProfile(name: string, profile: Profile) {
  if (profile.isPrimary) return;

  // 1a. Strip inner symlinks from plugins/ dir (real dir with inner symlinks)
  const profilePlugins = path.join(profile.configDir, "plugins");
  const pluginsStats = await lstat(profilePlugins).catch(() => null);
  if (pluginsStats && !pluginsStats.isSymbolicLink()) {
    const pluginEntries = await readdir(profilePlugins, { withFileTypes: true }).catch(() => []);
    for (const entry of pluginEntries) {
      const p = path.join(profilePlugins, entry.name);
      const stats = await lstat(p);
      if (stats.isSymbolicLink()) {
        await rm(p);
      }
    }
  }

  // 1b. Strip all symlinks from profile directory
  const entries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(profile.configDir, entry.name);
    const stats = await lstat(p);
    if (stats.isSymbolicLink()) {
      await rm(p);
    }
  }

  // 2. Restore backup if available (original files before clausona setup)
  const backupDir = backupDirFor(CLAUSONA_DIR, profile.tool, name);
  if (await exists(backupDir)) {
    await cp(backupDir, profile.configDir, { recursive: true });
    await rm(backupDir, { force: true, recursive: true });
  }
}

export async function addProfile(options: {
  tool: ToolName;
  name: string;
  fromPath?: string;
  mergeSessions?: boolean;
}) {
  if (options.name === "" || options.name.includes(":")) {
    throw new Error(`Invalid profile name '${options.name}': must be non-empty and not contain ':'.`);
  }

  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");

  const id = profileId(options.tool, options.name);
  if (registry.profiles[id]) throw new Error(`Profile '${id}' already exists.`);

  const adapter = getAdapter(options.tool);
  const home = homedir();
  const primarySource = registry.primarySources[options.tool] ?? adapter.defaultConfigDir(home);

  if (options.fromPath) {
    const configDir = options.fromPath.replace(/^~(?=$|\/)/, home);
    const accountInfo = await adapter.readAccountInfo(configDir);
    if (!accountInfo) throw new Error("Could not read account info from config dir.");

    const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);
    await rm(backupDir, { force: true, recursive: true });
    await mkdir(backupDir, { recursive: true });
    // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.
    const mergeSessions = options.mergeSessions ?? false;
    try {
      if (mergeSessions && options.tool === "claude") {
        await mergeSessionFiles(configDir, primarySource);
      }
      await setupSharedLinks(adapter, configDir, primarySource, mergeSessions, backupDir);
      if (options.tool === "claude") {
        await mergePluginFiles(path.join(configDir, "plugins"), path.join(primarySource, "plugins"));
        await setupPluginsDir(configDir, primarySource);
      }
    } catch (error) {
      await cleanupProfile(options.name, { tool: options.tool, configDir, email: "", isPrimary: false }).catch(
        () => {},
      );
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

  const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);
  await rm(backupDir, { force: true, recursive: true });
  await mkdir(backupDir, { recursive: true });
  // Per-item backup happens inside setupSharedLinks; no need to copy the full dir.

  const mergeSessions = options.mergeSessions ?? false;
  try {
    await setupSharedLinks(adapter, configDir, primarySource, mergeSessions, backupDir);
    if (options.tool === "claude") {
      await setupPluginsDir(configDir, primarySource);
    }
  } catch (error) {
    await cleanupProfile(options.name, { tool: options.tool, configDir, email: "", isPrimary: false }).catch(() => {});
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

export async function loginProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const loggedIn = await getAdapter(profile.tool).runLogin(profile.configDir);
  if (!loggedIn) throw new Error(`${profile.tool} login failed.`);
  return profile;
}

export async function removeProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);

  const profile = registry.profiles[id];
  if (profile.isPrimary) throw new Error("Cannot remove the primary profile.");

  const name = id.split(":").slice(1).join(":");
  await cleanupProfile(name, profile);

  delete registry.profiles[id];
  // If the removed profile was the active one for its tool, pick another or clear
  if (registry.activeProfiles[profile.tool] === id) {
    const otherKey = Object.keys(registry.profiles).find((k) => registry.profiles[k].tool === profile.tool);
    if (otherKey) {
      registry.activeProfiles[profile.tool] = otherKey;
    } else {
      delete registry.activeProfiles[profile.tool];
    }
  }
  // Clean primarySources if no profile of this tool remains
  const anyLeftForTool = Object.values(registry.profiles).some((p) => p.tool === profile.tool);
  if (!anyLeftForTool) {
    delete registry.primarySources[profile.tool];
  }
  await saveRegistry(registry);
}

export async function resolveProfileEnv(
  id: string,
): Promise<{ tool: ToolName; binary: string; configDir: string; env: NodeJS.ProcessEnv }> {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const adapter = getAdapter(profile.tool);
  const env = { ...process.env };
  if (profile.isPrimary) {
    delete env[adapter.configEnvVar];
  } else {
    env[adapter.configEnvVar] = profile.configDir;
  }
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
        const name = id.split(":").slice(1).join(":");
        await cleanupProfile(name, profile);
        removed.push(`profile: ${id} (symlinks stripped, data preserved at ${profile.configDir.replace(home, "~")})`);
      } catch (e) {
        warn(`uninstall: could not clean up profile ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 2. Remove shell integration from rc files
  const rcFiles = [path.join(home, ".zshrc")];
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
  const appDir = path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "clausona");
  if (await exists(appDir)) {
    await rm(appDir, { force: true, recursive: true });
    removed.push(`app: ${appDir}`);
  }

  // 5. Remove launcher binary (find via which)
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

  return { removed };
}
