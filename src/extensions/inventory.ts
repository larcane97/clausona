import type { Registry } from "../types.js";
import {
  type Collector,
  type Extension,
  emptyFacts,
  type Inventory,
  type Mark,
  type Scope,
  type Usage,
  type Warning,
} from "./model.js";
import { collectProjects, type ProjectRecord, recordedPaths, resolveCurrentProject } from "./projects.js";
import { hashTree, isRecord } from "./read.js";
import {
  type ClaudeAccount,
  collectClaudeSettingsFacts,
  loadClaudeAccounts,
  loadClaudeContext,
  managedSettingsPath,
} from "./sources/claude-context.js";
import { readClaudeHooks, readClaudePlugins } from "./sources/claude-hooks.js";
import { readClaudeMcp } from "./sources/claude-mcp.js";
import { readClaudeSkills } from "./sources/claude-skills.js";
import { codexProjectRecords, loadCodexContext, readCodex } from "./sources/codex.js";
import { stateOf } from "./state.js";

export type LoadOptions = {
  homeDir: string;
  registry: Registry;
  cwd: string;
  /** Where to look for Claude Code's managed settings; tests point it at a file of their own. */
  managedSettings?: string;
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
  const currentProject = await resolveCurrentProject(options.cwd, homeDir);
  const accounts = await loadClaudeAccounts(registry, homeDir, warnings);
  const codex = await loadCodexContext(registry, homeDir, warnings);
  const records: ProjectRecord[] = [
    ...accounts.map((a) => ({ tool: "claude" as const, profile: a.id, paths: recordedPaths(a.json?.projects) })),
    ...(codex ? codexProjectRecords(codex) : []),
  ];
  const projects = await collectProjects(records, homeDir, currentProject);
  if (accounts.length > 0) {
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
  }
  if (codex) await readCodex(codex, projects, out);
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

/** Skills sharing a name across folders of the user's own - not plugin, synced or built-in ones. */
export function duplicateGroups(items: Extension[]): Extension[][] {
  const byName = new Map<string, Extension[]>();
  for (const item of items) {
    if (item.kind !== "skill" || !OWN_SCOPES.has(item.location.scope) || item.summary?.type === "command") continue;
    const group = byName.get(item.name) ?? [];
    group.push(item);
    byName.set(item.name, group);
  }
  return [...byName.values()].filter((group) => group.length > 1);
}

async function hashDuplicates(items: Extension[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  await Promise.all(
    duplicateGroups(items)
      .flat()
      .filter((item) => !item.link?.broken)
      .map(async (item) => {
        hashes[item.id] = await hashTree(item.location.file);
      }),
  );
  return hashes;
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

/** Why a row deserves a second look. */
export function marksOf(inv: Inventory, item: Extension, now: number): Mark[] {
  const marks: Mark[] = [];
  if (item.link?.broken) marks.push("broken-link");
  if (
    item.kind === "skill" &&
    item.location.scope === "project" &&
    stateOf(inv, item, item.location.project).shadowedBy
  ) {
    marks.push("shadowed");
  }
  const mine = inv.hashes[item.id];
  if (
    mine !== undefined &&
    groupFor(inv, item)?.some((o) => inv.hashes[o.id] !== undefined && inv.hashes[o.id] !== mine)
  ) {
    marks.push("differs");
  }
  if (isCleanup(inv, item, now, marks)) marks.push("cleanup");
  return marks;
}

function isCleanup(inv: Inventory, item: Extension, now: number, marks: Mark[]): boolean {
  if (item.kind !== "skill" || !OWN_SCOPES.has(item.location.scope)) return false;
  // A copy that differs is marked "differs" and listed by the Duplicates filter, but not called
  // cleanup: the copy in daily use is often one of them.
  if (marks.includes("broken-link")) return true;
  if (item.location.tool !== "claude") return false;
  const usage = usageOf(inv, [item]);
  if (usage?.lastUsedAt !== undefined) return now - usage.lastUsedAt > CLEANUP_UNUSED_DAYS * DAY;
  // Never used: only once the folder is past the grace period, so a skill installed today is not flagged.
  return item.createdAt === undefined || now - item.createdAt > CLEANUP_GRACE_DAYS * DAY;
}
