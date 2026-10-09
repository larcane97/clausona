import path from "node:path";

import type { Registry } from "../types.js";
import {
  type Collector,
  type Extension,
  emptyFacts,
  type Inventory,
  type Mark,
  type Places,
  type Scope,
  type Usage,
  type Warning,
} from "./model.js";
import { stashDir } from "./places.js";
import { collectProjects, type ProjectRecord, recordedPaths, resolveCurrentProject } from "./projects.js";
import { hashTree, isRecord, mapLimit, pathKey, samePath } from "./read.js";
import {
  type ClaudeAccount,
  claudePrimaryDir,
  collectClaudeSettingsFacts,
  loadClaudeAccounts,
  loadClaudeContext,
  managedSettingsPath,
} from "./sources/claude-context.js";
import { readClaudeHooks, readClaudePlugins } from "./sources/claude-hooks.js";
import { readClaudeMcp } from "./sources/claude-mcp.js";
import { readClaudeSkills } from "./sources/claude-skills.js";
import { type CodexContext, codexProjectRecords, loadCodexContext, readCodex } from "./sources/codex.js";
import { isMcpjsonServer, relevantIn, stateOf } from "./state.js";

export type LoadOptions = {
  homeDir: string;
  registry: Registry;
  cwd: string;
  /** Where to look for Claude Code's managed settings; tests point it at a file of their own. */
  managedSettings?: string;
  /** Where clausona keeps what it took out to turn off everywhere; default stashDir(homeDir). */
  stashDir?: string;
};

const DAY = 86_400_000;
export const CLEANUP_UNUSED_DAYS = 90;
export const CLEANUP_GRACE_DAYS = 14;

/** Scopes whose skills are folders the user put there - the ones a duplicate or cleanup can mean. */
const OWN_SCOPES: ReadonlySet<Scope> = new Set(["global", "account", "project"]);

/**
 * Everything every profile can load, read straight from the tools' files. Nothing is cached:
 * the dashboard and the CLI call this each time, so what they show is what is on disk.
 */
export async function loadInventory(options: LoadOptions): Promise<Inventory> {
  const { homeDir, registry } = options;
  const warnings: Warning[] = [];
  const out: Collector = { items: [], facts: emptyFacts(), warnings };
  const [startedIn, accounts, codex] = await Promise.all([
    resolveCurrentProject(options.cwd),
    loadClaudeAccounts(registry, homeDir, warnings),
    loadCodexContext(registry, homeDir, warnings),
  ]);
  const records: ProjectRecord[] = [
    ...accounts.map((a) => ({ tool: "claude" as const, profile: a.id, paths: recordedPaths(a.json?.projects) })),
    ...(codex ? codexProjectRecords(codex) : []),
  ];
  const { projects, current: currentProject } = await collectProjects(records, startedIn);
  // The Claude and Codex sources write apart - each its own items and facts, and warnings are
  // sorted below - so they read side by side.
  const readClaude = async (): Promise<void> => {
    if (accounts.length === 0) return;
    const ctx = await loadClaudeContext({
      accounts,
      registry,
      homeDir,
      projects,
      managedSettings: options.managedSettings ?? managedSettingsPath(process.platform),
      warnings,
    });
    collectClaudeSettingsFacts(ctx, out);
    await Promise.all([
      readClaudeSkills(ctx, projects, out),
      readClaudeMcp(ctx, projects, out),
      readClaudeHooks(ctx, out),
      readClaudePlugins(ctx, out),
    ]);
  };
  await Promise.all([readClaude(), codex ? readCodex(codex, projects, out) : undefined]);
  const items = out.items.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  return {
    items,
    projects,
    ...(currentProject ? { currentProject } : {}),
    homeDir,
    claudeProfiles: accounts.map((a) => a.id),
    facts: out.facts,
    usage: sumUsage(accounts),
    hashes: await hashDuplicates(items),
    warnings: uniqueWarnings(warnings),
    places: placesOf(options, accounts, codex),
  };
}

/** The files a write can touch that belong to an account or a tool rather than to one item, and the stash dir. */
function placesOf(options: LoadOptions, accounts: ClaudeAccount[], codex: CodexContext | undefined): Places {
  const { homeDir, registry } = options;
  return {
    ...(accounts.length > 0
      ? { claudeUserSettings: path.join(claudePrimaryDir(registry, accounts, homeDir), "settings.json") }
      : {}),
    claudeJson: Object.fromEntries(accounts.map((account) => [account.id, account.jsonPath])),
    ...(codex ? { codexConfig: codex.configFile, codexHooks: path.join(codex.primary.dir, "hooks.json") } : {}),
    stashDir: options.stashDir ?? stashDir(homeDir),
  };
}

/**
 * One warning per bad file and reason, by file. Sources can read one file more than once: a
 * plugin installed at user and at local scope shares one install path, so one hooks.json.
 */
function uniqueWarnings(warnings: Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings
    .filter((warning) => {
      const key = `${warning.file}\0${warning.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
}

/** Claude Code's `skillUsage`, summed over every account: one account's view alone misleads. */
export function sumUsage(accounts: ClaudeAccount[]): Record<string, Usage> {
  const usage: Record<string, Usage> = {};
  for (const account of accounts) {
    const records = isRecord(account.json?.skillUsage) ? account.json.skillUsage : {};
    for (const [key, entry] of Object.entries(records)) {
      if (!isRecord(entry)) continue;
      const count = typeof entry.usageCount === "number" && Number.isFinite(entry.usageCount) ? entry.usageCount : 0;
      const last = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : undefined;
      const total = usage[key] ?? { total: 0, byProfile: {} };
      usage[key] = total;
      total.total += count;
      total.byProfile[account.id] = (total.byProfile[account.id] ?? 0) + count;
      if (last !== undefined && (total.lastUsedAt === undefined || last > total.lastUsedAt)) total.lastUsedAt = last;
    }
  }
  return usage;
}

/** The usage of one row's items: each Claude usage key counted once. */
export function usageOf(inv: Inventory, items: Extension[]): Usage | undefined {
  const seen = new Set<string>();
  let merged: Usage | undefined;
  for (const item of items) {
    if (item.location.tool !== "claude") continue;
    for (const key of item.usageKeys ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      const usage = inv.usage[key];
      if (!usage) continue;
      merged = merged ?? { total: 0, byProfile: {} };
      merged.total += usage.total;
      for (const [profile, count] of Object.entries(usage.byProfile)) {
        merged.byProfile[profile] = (merged.byProfile[profile] ?? 0) + count;
      }
      if (usage.lastUsedAt !== undefined && (merged.lastUsedAt === undefined || usage.lastUsedAt > merged.lastUsedAt)) {
        merged.lastUsedAt = usage.lastUsedAt;
      }
    }
  }
  return merged;
}

/**
 * The folder a skill's files are in, as one key for every path that leads to it: its real path
 * as read, else a working link's target, else the skill's own folder.
 */
export function folderKey(item: Extension): string {
  return pathKey(item.realFolder ?? (item.link && !item.link.broken ? item.link.target : item.location.file));
}

/**
 * Skills sharing a name across folders of the user's own - not plugin, synced or built-in ones -
 * where at least two of those folders are distinct. A link to another listed folder is that
 * folder, not a second copy: counting it would keep it among the duplicates for good, even
 * after the copies were merged into one folder and a link.
 */
export function duplicateGroups(items: Extension[]): Extension[][] {
  const byName = new Map<string, Extension[]>();
  for (const item of items) {
    // A legacy command is one .md file, not a folder, so there is no folder copy to compare.
    if (item.kind !== "skill" || !OWN_SCOPES.has(item.location.scope) || item.summary?.type === "command") continue;
    const group = byName.get(item.name) ?? [];
    group.push(item);
    byName.set(item.name, group);
  }
  // pathKey is what samePath compares, so a set of keys counts the folders samePath tells apart.
  return [...byName.values()].filter((group) => new Set(group.map(folderKey)).size > 1);
}

/**
 * Folders hashed at once. Each walk keeps its own calls in flight and reads ahead up to the
 * hash's byte budget, so a few at a time keep the disk busy and bound the bytes held.
 */
const HASH_FOLDERS_AT_ONCE = 8;

/** Hashes in item order, so the keys' order does not depend on which hash finishes first. */
async function hashDuplicates(items: Extension[]): Promise<Record<string, string>> {
  const members = duplicateGroups(items)
    .flat()
    .filter((item) => !item.link?.broken);
  return Object.fromEntries(
    await mapLimit(
      members,
      HASH_FOLDERS_AT_ONCE,
      async (item) => [item.id, await hashTree(item.location.file)] as const,
    ),
  );
}

/** Duplicate groups by item id, worked out once per inventory. */
const groupCache = new WeakMap<Inventory, Map<string, Extension[]>>();
function groupFor(inv: Inventory, item: Extension): Extension[] | undefined {
  let byId = groupCache.get(inv);
  if (!byId) {
    byId = new Map();
    for (const group of duplicateGroups(inv.items)) for (const member of group) byId.set(member.id, group);
    groupCache.set(inv, byId);
  }
  return byId.get(item.id);
}

/**
 * Whether two copies of a skill can load in one place: one that no project owns loads in every
 * project, while a project's own loads in that project only. Two projects' copies never meet,
 * so they can differ without either being called out for it.
 */
function loadTogether(a: Extension, b: Extension): boolean {
  const [one, other] = [a.location.project, b.location.project];
  return one === undefined || other === undefined || samePath(one, other);
}

/**
 * Why a row deserves a second look, seen from `project`: a `.mcp.json` server is shadowed only
 * in a project below its dir whose nearer `.mcp.json` defines the name again.
 */
export function marksOf(inv: Inventory, item: Extension, now: number, project?: string): Mark[] {
  const marks: Mark[] = [];
  if (item.link?.broken) marks.push("broken-link");
  if (
    item.kind === "skill" &&
    item.location.scope === "project" &&
    stateOf(inv, item, item.location.project).shadowedBy
  ) {
    marks.push("shadowed");
  }
  if (
    project !== undefined &&
    isMcpjsonServer(item) &&
    relevantIn(item, project) &&
    stateOf(inv, item, project).shadowedBy
  ) {
    marks.push("shadowed");
  }
  const mine = inv.hashes[item.id];
  // A copy that differs from one it loads beside is marked "differs", but not called cleanup:
  // the copy in daily use is often one of them. The Duplicates filter and the Copies line still
  // take the whole group, copies in other projects too.
  if (
    mine !== undefined &&
    groupFor(inv, item)?.some(
      (o) => loadTogether(item, o) && inv.hashes[o.id] !== undefined && inv.hashes[o.id] !== mine,
    )
  ) {
    marks.push("differs");
  }
  if (isCleanup(inv, item, now)) marks.push("cleanup");
  return marks;
}

/** Cleanup is the mark a delete follows, so anything not known counts against it. */
function isCleanup(inv: Inventory, item: Extension, now: number): boolean {
  if (item.kind !== "skill" || !OWN_SCOPES.has(item.location.scope)) return false;
  if (item.link?.broken) return true;
  if (item.location.tool !== "claude") return false;
  const usage = usageOf(inv, [item]);
  if (usage?.lastUsedAt !== undefined) return now - usage.lastUsedAt > CLEANUP_UNUSED_DAYS * DAY;
  // Used, with no time recorded: there is no telling how long ago, so it is not called unused.
  if (usage !== undefined && usage.total > 0) return false;
  // Never used: only once the folder is known to be past the grace period, so a skill installed
  // today, or one whose age could not be read, is not flagged.
  return item.createdAt !== undefined && now - item.createdAt > CLEANUP_GRACE_DAYS * DAY;
}
