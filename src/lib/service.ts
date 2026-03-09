import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { evaluateSymlinkHealth } from "../core/doctor.js";
import { seedSeenSessions } from "../core/track-usage.js";

/** Items that should never be shared via symlink between profiles */
const BASE_SHARED_LINK_SKIP = new Set([".claude.json", "image-cache", "statsig"]);

function sharedLinkSkipSet(mergeSessions: boolean): Set<string> {
  if (!mergeSessions) return new Set([...BASE_SHARED_LINK_SKIP, "projects"]);
  return BASE_SHARED_LINK_SKIP;
}
import { claudeJsonPathForConfigDir, keychainServiceForConfigDir } from "../core/paths.js";
import { setActiveProfile } from "../core/registry.js";
import { renderShellInit } from "../core/shell.js";
import { summarizeUsage } from "../core/usage.js";
import type {
  DiscoveredAccount,
  DoctorIssue,
  DoctorProfileResult,
  ProfileListItem,
  Registry,
  UsagePeriod,
  UsageStore,
} from "../types.js";

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const REGISTRY_PATH = path.join(CLAUSONA_DIR, "profiles.json");
const USAGE_PATH = path.join(CLAUSONA_DIR, "usage.json");
const PRIMARY_SOURCE = path.join(homedir(), ".claude");

type ClaudeJson = {
  oauthAccount?: {
    emailAddress?: string;
    organizationName?: string;
    displayName?: string;
  };
  lastCost?: number;
  lastTotalInputTokens?: number;
  lastTotalOutputTokens?: number;
};

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

async function writeJson(targetPath: string, value: unknown) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function parseClaudeJson(jsonPath: string): Promise<ClaudeJson | null> {
  if (!(await exists(jsonPath))) {
    return null;
  }

  return readJson<ClaudeJson | null>(jsonPath, null);
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
  });
}

async function runLoginFlow(configDir: string): Promise<boolean> {
  const result = await execCommand("claude", ["auth", "login"], {
    env: { CLAUDE_CONFIG_DIR: configDir },
    interactive: true,
  });
  return result.code === 0;
}

async function checkKeychain(service: string) {
  const result = await execCommand("security", ["find-generic-password", "-s", service], { quiet: true });
  return result.code === 0;
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

async function listConfigCandidates() {
  const home = homedir();
  const entries = await readdir(home, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(home, entry.name))
    .filter((dir) => {
      const base = path.basename(dir);
      return base === ".claude" || base.startsWith(".claude-");
    })
    .sort();
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
      } catch {
        // best-effort: skip failed items, backup has the originals
      }
    }

    await rm(path.join(dstSlug, "sessions-index.json"), { force: true });
  }

  return merged;
}

async function setupSharedLinks(profileDir: string, primarySource: string, mergeSessions = false) {
  const items = await readdir(primarySource, { withFileTypes: true });
  const skipSet = sharedLinkSkipSet(mergeSessions);
  let linked = 0;

  for (const item of items) {
    const source = path.join(primarySource, item.name);

    if (skipSet.has(item.name)) {
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
      }
      await rm(target, { force: true, recursive: true });
    }

    await symlink(source, target);
    linked += 1;
  }

  return linked;
}

export async function validateConfigDir(
  inputPath: string,
  registeredDirs: string[],
): Promise<{ error: string } | { account: { configDir: string; email: string; orgName?: string } }> {
  const configDir = inputPath.replace(/^~(?=$|\/)/, homedir());
  if (!(await exists(configDir))) {
    return { error: "Directory not found" };
  }
  const jsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir });
  const claudeJson = await parseClaudeJson(jsonPath);
  const email = claudeJson?.oauthAccount?.emailAddress;
  if (!email) {
    return { error: "No valid .claude.json with oauthAccount found" };
  }
  if (registeredDirs.includes(configDir)) {
    return { error: "This directory is already registered" };
  }
  return { account: { configDir, email, orgName: claudeJson.oauthAccount?.organizationName } };
}

export async function discoverAccounts(): Promise<DiscoveredAccount[]> {
  const home = homedir();
  const dirs = await listConfigCandidates();
  const discovered: DiscoveredAccount[] = [];

  for (const configDir of dirs) {
    const jsonPath = claudeJsonPathForConfigDir({ homeDir: home, configDir });
    const claudeJson = await parseClaudeJson(jsonPath);
    const email = claudeJson?.oauthAccount?.emailAddress;
    if (!email) {
      continue;
    }

    const resolvedConfig = await realpath(configDir).catch(() => configDir);
    const resolvedPrimary = await realpath(path.join(home, ".claude")).catch(() => path.join(home, ".claude"));
    const keychainService = keychainServiceForConfigDir({
      homeDir: home,
      configDir: resolvedConfig,
    });

    if (!(await checkKeychain(keychainService))) {
      continue;
    }

    discovered.push({
      configDir,
      jsonPath,
      email,
      orgName: claudeJson.oauthAccount?.organizationName,
      keychainService,
      isPrimary: resolvedConfig === resolvedPrimary,
    });
  }

  return discovered;
}

export async function loadRegistry() {
  return readJson<Registry | null>(REGISTRY_PATH, null);
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

  const registry: Registry = {
    primarySource: PRIMARY_SOURCE,
    activeProfile: options.defaultProfile,
    profiles: {},
  };

  for (const account of options.accounts) {
    const profileName = options.profileNames[account.configDir] ?? defaultProfileNameForConfigDir(account.configDir);
    const mergeSessions = account.isPrimary
      ? undefined
      : (options.mergeSessionsMap?.[account.configDir] ?? options.mergeSessions ?? false);
    registry.profiles[profileName] = {
      configDir: account.configDir,
      email: account.email,
      orgName: account.orgName,
      isPrimary: account.isPrimary,
      mergeSessions,
    };

    if (!account.isPrimary) {
      const merge = mergeSessions ?? false;
      const backupDir = path.join(CLAUSONA_DIR, "backups", profileName);
      if (!(await exists(backupDir))) {
        await cp(account.configDir, backupDir, { recursive: true });
      }
      if (merge) {
        await mergeSessionFiles(account.configDir, PRIMARY_SOURCE);
      }
      await setupSharedLinks(account.configDir, PRIMARY_SOURCE, merge);
    }
  }

  await saveRegistry(registry);
  // Reset usage on init — fresh start with seeded fingerprints
  await writeJson(USAGE_PATH, {});

  // Seed seenSessions so pre-existing usage is not recorded as new
  for (const account of options.accounts) {
    const profileName = options.profileNames[account.configDir] ?? defaultProfileNameForConfigDir(account.configDir);
    await seedSeenSessions(profileName, account.configDir);
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

  return Object.entries(registry.profiles).map(([name, profile]) => {
    const records = usage[name]?.records ?? [];
    return {
      name,
      email: profile.email,
      orgName: profile.orgName,
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      isActive: registry.activeProfile === name,
      mergeSessions: profile.mergeSessions,
      today: summarizeUsage({ now, period: "today", records }),
      week: summarizeUsage({ now, period: "week", records }),
      month: summarizeUsage({ now, period: "month", records }),
      total: summarizeUsage({ now, period: "all", records }),
    };
  });
}

export async function setActiveProfileByName(name: string) {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  const next = setActiveProfile(registry, name);
  await saveRegistry(next);
  return next.profiles[name];
}

export async function getCurrentProfile() {
  const registry = await loadRegistry();
  if (!registry || !registry.activeProfile || !registry.profiles[registry.activeProfile]) {
    return null;
  }

  const profile = registry.profiles[registry.activeProfile];
  const now = new Date().toISOString(); // summarizeUsage interprets cutoffs in the runtime's local timezone
  const usage = await loadUsageStore();
  const records = usage[registry.activeProfile]?.records ?? [];
  const resolvedConfigDir = await realpath(profile.configDir).catch(() => profile.configDir);
  const keychainService = keychainServiceForConfigDir({
    homeDir: homedir(),
    configDir: resolvedConfigDir,
  });

  return {
    name: registry.activeProfile,
    ...profile,
    keychainService,
    hasKeychain: await checkKeychain(keychainService),
    usage: {
      today: summarizeUsage({ now, period: "today", records }),
      total: summarizeUsage({ now, period: "all", records }),
    },
  };
}

export async function getUsageSummary(profileName: string | null, period: UsagePeriod) {
  const registry = await loadRegistry();
  if (!registry) {
    return null;
  }

  const usage = await loadUsageStore();
  const now = new Date().toISOString(); // summarizeUsage interprets cutoffs in the runtime's local timezone

  if (profileName) {
    const records = usage[profileName]?.records ?? [];
    return summarizeUsage({ now, period, records });
  }

  return Object.fromEntries(
    Object.keys(registry.profiles).map((name) => [
      name,
      summarizeUsage({ now, period, records: usage[name]?.records ?? [] }),
    ]),
  );
}

export async function doctorProfiles(): Promise<DoctorProfileResult[]> {
  const registry = await loadRegistry();
  if (!registry) {
    return [];
  }

  const primaryEntries = new Set((await readdir(registry.primarySource, { withFileTypes: true })).map((entry) => entry.name));
  const results: DoctorProfileResult[] = [];

  for (const [name, profile] of Object.entries(registry.profiles)) {
    const issues: DoctorIssue[] = [];
    const jsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir: profile.configDir });
    const claudeJson = await parseClaudeJson(jsonPath);

    if (!claudeJson) {
      issues.push({ kind: "missing_json", message: ".claude.json is missing" });
    } else if (!claudeJson.oauthAccount?.emailAddress) {
      issues.push({ kind: "missing_oauth", message: ".claude.json is missing oauthAccount.emailAddress" });
    }

    const resolvedDir = await realpath(profile.configDir).catch(() => profile.configDir);
    const keychainService = keychainServiceForConfigDir({
      homeDir: homedir(),
      configDir: resolvedDir,
    });
    if (!(await checkKeychain(keychainService))) {
      issues.push({ kind: "missing_keychain", message: `${keychainService} not found in Keychain` });
    }

    const dirEntries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
    const skipSet = sharedLinkSkipSet(profile.mergeSessions ?? false);
    const symlinkItems: Array<{ name: string; isSymlink: boolean; pointsToPrimary: boolean; targetExists: boolean; existsInPrimary: boolean }> = [];
    for (const entry of dirEntries) {
      const targetPath = path.join(profile.configDir, entry.name);
      const stats = await lstat(targetPath);
      const isSymlink = stats.isSymbolicLink();
      const pointsToPrimary = isSymlink && (await readlink(targetPath)) === path.join(registry.primarySource, entry.name);

      if (skipSet.has(entry.name)) {
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

    results.push({
      name,
      email: profile.email,
      configDir: profile.configDir,
      isPrimary: Boolean(profile.isPrimary),
      healthy: issues.length === 0,
      issues,
    });
  }

  return results;
}

export async function repairProfile(name: string) {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  const profile = registry.profiles[name];
  if (profile.isPrimary) {
    return { repaired: 0 };
  }

  const repaired = await setupSharedLinks(profile.configDir, registry.primarySource, profile.mergeSessions ?? false);

  // Restore skip-set items from backup if they were stale symlinks that got removed
  // Skip if the backup item is a symlink pointing to primary (stale)
  const backupDir = path.join(CLAUSONA_DIR, "backups", name);
  if (await exists(backupDir)) {
    const skipSet = sharedLinkSkipSet(profile.mergeSessions ?? false);
    for (const itemName of skipSet) {
      const target = path.join(profile.configDir, itemName);
      const backupItem = path.join(backupDir, itemName);
      if (!(await exists(target)) && (await exists(backupItem))) {
        const backupStats = await lstat(backupItem).catch(() => null);
        if (backupStats?.isSymbolicLink()) {
          const linkTarget = await readlink(backupItem);
          if (linkTarget === path.join(registry.primarySource, itemName)) continue;
        }
        await cp(backupItem, target, { recursive: true });
      }
    }
  }

  return { repaired };
}

export async function updateProfileConfig(name: string, options: { mergeSessions: boolean }) {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }
  const profile = registry.profiles[name];
  if (profile.isPrimary) {
    throw new Error("Cannot change session mode for the primary profile.");
  }

  const prev = profile.mergeSessions ?? false;
  const next = options.mergeSessions;
  if (prev === next) return { name, mergeSessions: next, changed: false };

  // separated → merged: merge session files before symlinking
  if (next) {
    await mergeSessionFiles(profile.configDir, registry.primarySource);
  }

  profile.mergeSessions = next;
  await saveRegistry(registry);
  await setupSharedLinks(profile.configDir, registry.primarySource, next);

  // merged → separated: restore skip-set items from backup
  // Skip if the backup item is a symlink pointing to primary (stale)
  if (!next) {
    const backupDir = path.join(CLAUSONA_DIR, "backups", name);
    if (await exists(backupDir)) {
      const skipSet = sharedLinkSkipSet(false);
      for (const itemName of skipSet) {
        const target = path.join(profile.configDir, itemName);
        const backupItem = path.join(backupDir, itemName);
        if (!(await exists(target)) && (await exists(backupItem))) {
          const backupStats = await lstat(backupItem).catch(() => null);
          if (backupStats?.isSymbolicLink()) {
            const linkTarget = await readlink(backupItem);
            if (linkTarget === path.join(registry.primarySource, itemName)) continue;
          }
          await cp(backupItem, target, { recursive: true });
        }
      }
    }
  }

  return { name, mergeSessions: next, changed: true };
}

export async function addProfile(options: { name: string; fromPath?: string; mergeSessions?: boolean }) {
  const registry = await loadRegistry();
  if (!registry) {
    throw new Error("clausona is not initialized.");
  }

  if (registry.profiles[options.name]) {
    throw new Error(`Profile '${options.name}' already exists.`);
  }

  if (options.fromPath) {
    const configDir = options.fromPath.replace(/^~(?=$|\/)/, homedir());
    const jsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir });
    const claudeJson = await parseClaudeJson(jsonPath);
    const email = claudeJson?.oauthAccount?.emailAddress;
    if (!email) {
      throw new Error("Could not read account info from .claude.json");
    }

    const orgName = claudeJson.oauthAccount?.organizationName;
    const backupDir = path.join(CLAUSONA_DIR, "backups", options.name);
    await rm(backupDir, { force: true, recursive: true });
    await cp(configDir, backupDir, { recursive: true });
    const mergeSessions = options.mergeSessions ?? false;
    if (mergeSessions) {
      await mergeSessionFiles(configDir, registry.primarySource);
    }
    await setupSharedLinks(configDir, registry.primarySource, mergeSessions);
    registry.profiles[options.name] = { configDir, email, orgName, mergeSessions };
    await saveRegistry(registry);
    await seedSeenSessions(options.name, configDir);
    return { name: options.name, email, configDir, backupDir };
  }

  const configDir = path.join(homedir(), `.claude-${options.name}`);
  if (await exists(configDir)) {
    throw new Error(
      `${configDir.replace(homedir(), "~")} already exists. Use --from ${configDir.replace(homedir(), "~")} to import it instead.`,
    );
  }
  await mkdir(configDir, { recursive: true });

  // Check if credentials already exist (e.g. from a previous removed profile)
  const resolvedDir = await realpath(configDir).catch(() => configDir);
  const service = keychainServiceForConfigDir({ homeDir: homedir(), configDir: resolvedDir });
  const jsonPath = path.join(configDir, ".claude.json");
  const existingJson = await parseClaudeJson(jsonPath);
  const alreadyAuthenticated = existingJson?.oauthAccount?.emailAddress && (await checkKeychain(service));

  if (!alreadyAuthenticated) {
    const loggedIn = await runLoginFlow(configDir);
    if (!loggedIn) {
      await rm(configDir, { force: true, recursive: true });
      throw new Error("Claude login failed.");
    }
  }

  // Merge onboarding state from primary so claude skips the setup wizard
  const primaryJsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir: PRIMARY_SOURCE });
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
  if (needsWrite) {
    await writeJson(jsonPath, profileJson);
  }

  const claudeJson = await parseClaudeJson(jsonPath);
  const email = claudeJson?.oauthAccount?.emailAddress;
  if (!email) {
    await rm(configDir, { force: true, recursive: true });
    throw new Error("Login succeeded but account metadata is missing.");
  }

  // Backup before setupSharedLinks replaces files with symlinks
  const backupDir = path.join(CLAUSONA_DIR, "backups", options.name);
  await rm(backupDir, { force: true, recursive: true });
  await cp(configDir, backupDir, { recursive: true });

  const mergeSessions = options.mergeSessions ?? false;
  await setupSharedLinks(configDir, registry.primarySource, mergeSessions);
  registry.profiles[options.name] = {
    configDir,
    email,
    orgName: claudeJson.oauthAccount?.organizationName,
    mergeSessions,
  };
  await saveRegistry(registry);
  await seedSeenSessions(options.name, configDir);
  return { name: options.name, email, configDir };
}

export async function loginProfile(name: string) {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  const loggedIn = await runLoginFlow(registry.profiles[name].configDir);
  if (!loggedIn) {
    throw new Error("Claude login failed.");
  }

  return registry.profiles[name];
}

async function cleanupProfile(name: string, profile: { configDir: string; isPrimary?: boolean }) {
  if (profile.isPrimary) return;

  // 1. Strip all symlinks from profile directory
  const entries = await readdir(profile.configDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(profile.configDir, entry.name);
    const stats = await lstat(p);
    if (stats.isSymbolicLink()) {
      await rm(p);
    }
  }

  // 2. Restore backup if available (original files before clausona setup)
  const backupDir = path.join(CLAUSONA_DIR, "backups", name);
  if (await exists(backupDir)) {
    await cp(backupDir, profile.configDir, { recursive: true });
    await rm(backupDir, { force: true, recursive: true });
  }
}

export async function removeProfile(name: string) {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  const profile = registry.profiles[name];
  if (profile.isPrimary) {
    throw new Error("Cannot remove the primary profile.");
  }

  await cleanupProfile(name, profile);

  delete registry.profiles[name];
  if (registry.activeProfile === name) {
    registry.activeProfile = Object.keys(registry.profiles)[0] ?? "";
  }
  await saveRegistry(registry);
}

export async function resolveProfileEnv(name: string): Promise<{ configDir: string; env: NodeJS.ProcessEnv }> {
  const registry = await loadRegistry();
  if (!registry || !registry.profiles[name]) {
    throw new Error(`Profile '${name}' not found.`);
  }

  const profile = registry.profiles[name];
  const env = { ...process.env };

  if (profile.isPrimary) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = profile.configDir;
  }

  return { configDir: profile.configDir, env };
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
    for (const [name, profile] of Object.entries(registry.profiles)) {
      if (profile.isPrimary) continue;
      try {
        await cleanupProfile(name, profile);
        removed.push(`profile: ${name} (symlinks stripped, data preserved at ${profile.configDir.replace(home, "~")})`);
      } catch {
        // best-effort
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
