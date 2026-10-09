import path from "node:path";

import type { Collector, Extension, Project } from "../model.js";
import { isHomeProject } from "../projects.js";
import { entryInfo, IO_LIMIT, isRecord, listNames, mapLimit, parseFrontmatter, readText } from "../read.js";
import { type ClaudeContext, pluginOwner, sharesPrimaryEntry } from "./claude-context.js";
import { readSkillFolders, type SkillLocation } from "./skill-dirs.js";

/**
 * Every skill and legacy command Claude Code can load: the primary's (shared by every account
 * through clausona's links), a profile's own when its folder is not that link, the claude.ai
 * buckets under `skills/synced/`, each project's, and each installed plugin's. Then one
 * built-in item for each `skillOverrides` key no skill found here answers to - so it must run
 * after `collectClaudeSettingsFacts`.
 */
export async function readClaudeSkills(ctx: ClaudeContext, projects: Project[], out: Collector): Promise<void> {
  const jobs: Promise<void>[] = [];
  const global: SkillLocation = { tool: "claude", scope: "global" };
  jobs.push(readSkillFolders(path.join(ctx.primaryDir, "skills"), global, "-", out, { skip: ["synced"] }));
  jobs.push(readCommandFiles(path.join(ctx.primaryDir, "commands"), global, "-", out));
  for (const account of ctx.accounts) {
    if (account.isPrimary) continue;
    const own: SkillLocation = { tool: "claude", scope: "account", profile: account.id };
    jobs.push(
      (async () => {
        if (!(await sharesPrimaryEntry(account, ctx.primaryDir, "skills"))) {
          await readSkillFolders(path.join(account.configDir, "skills"), own, account.id, out, { skip: ["synced"] });
        }
      })(),
      (async () => {
        if (!(await sharesPrimaryEntry(account, ctx.primaryDir, "commands"))) {
          await readCommandFiles(path.join(account.configDir, "commands"), own, account.id, out);
        }
      })(),
    );
  }
  jobs.push(readSynced(ctx, out));
  for (const project of projects) {
    // The home dir's .claude/skills and .claude/commands are the user's own, read above.
    if (isHomeProject(project, ctx.homeDir)) continue;
    const here: SkillLocation = { tool: "claude", scope: "project", project: project.path };
    jobs.push(readSkillFolders(path.join(project.path, ".claude", "skills"), here, project.path, out));
    jobs.push(readCommandFiles(path.join(project.path, ".claude", "commands"), here, project.path, out));
  }
  for (const plugin of ctx.plugins) {
    const from: SkillLocation = {
      tool: "claude",
      scope: "plugin",
      plugin: plugin.id,
      ...(plugin.project ? { project: plugin.project } : {}),
      accounts: plugin.profiles,
    };
    const prefix = `${plugin.name}:`;
    const owner = pluginOwner(plugin);
    jobs.push(readSkillFolders(path.join(plugin.installPath, "skills"), from, owner, out, { prefix }));
    jobs.push(readCommandFiles(path.join(plugin.installPath, "commands"), from, owner, out, prefix));
  }
  await Promise.all(jobs);
  addOverrideOnlySkills(out);
}

/**
 * Legacy commands: `<dir>/<name>.md`, and one level of subfolders, which Claude Code lists by
 * file name with the folder as a namespace in the description - so the name is the file's.
 */
async function readCommandFiles(
  dir: string,
  location: SkillLocation,
  owner: string,
  out: Collector,
  prefix = "",
): Promise<void> {
  // The entries are read in parallel and listed in their own order, as one at a time would.
  const visit = async (sub: string): Promise<Extension[]> => {
    const found = await mapLimit(await listNames(path.join(dir, sub), out.warnings), IO_LIMIT, async (entry) => {
      const file = path.join(dir, sub, entry);
      const info = await entryInfo(file);
      if (info.kind === "dir" && sub === "") return visit(entry);
      if (info.kind !== "file" || !entry.endsWith(".md")) return [];
      const text = await readText(file, out.warnings);
      const front = text === undefined ? {} : parseFrontmatter(text);
      const name = `${prefix}${entry.slice(0, -3)}`;
      const item: Extension = {
        id: `skill:claude:${location.scope}:${owner}:command:${sub ? `${sub}/` : ""}${name}`,
        kind: "skill",
        name,
        ...(front.description ? { description: front.description } : {}),
        location: { ...location, file },
        ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
        usageKeys: [name],
        summary: sub ? { type: "command", namespace: sub } : { type: "command" },
      };
      return [item];
    });
    return found.flat();
  };
  out.items.push(...(await visit("")));
}

/**
 * claude.ai skills: `skills/synced/<organizationUuid>_<accountUuid>/<name>/`. A bucket belongs to
 * the account whose `oauthAccount` carries both ids; one that matches no account is listed
 * without one. The Skill tool names these `anthropic-skills:<name>`, so usage is looked up
 * under that key as well.
 */
async function readSynced(ctx: ClaudeContext, out: Collector): Promise<void> {
  const owners = new Map<string, string>();
  for (const account of ctx.accounts) {
    const oauth = isRecord(account.json?.oauthAccount) ? account.json.oauthAccount : undefined;
    if (typeof oauth?.organizationUuid === "string" && typeof oauth.accountUuid === "string") {
      owners.set(`${oauth.organizationUuid}_${oauth.accountUuid}`, account.id);
    }
  }
  const root = path.join(ctx.primaryDir, "skills", "synced");
  await Promise.all(
    (await listNames(root, out.warnings)).map((bucket) => {
      const profile = owners.get(bucket);
      return readSkillFolders(
        path.join(root, bucket),
        { tool: "claude", scope: "synced", ...(profile ? { profile } : {}) },
        bucket,
        out,
        { usageKeys: (name) => [name, `anthropic-skills:${name}`] },
      );
    }),
  );
}

/**
 * A `skillOverrides` key no skill read here answers to: a skill built into Claude Code
 * (`claude-api`, `workflow-authoring`), or one removed since. clausona cannot tell which, so
 * it lists the key as built-in rather than calling it stale.
 */
function addOverrideOnlySkills(out: Collector): void {
  const known = new Set(out.items.filter((i) => i.kind === "skill" && i.location.tool === "claude").map((i) => i.name));
  for (const overrides of out.facts.claudeSkillOverrides) {
    for (const key of Object.keys(overrides.map)) {
      if (known.has(key)) continue;
      known.add(key);
      out.items.push({
        id: `skill:claude:builtin:-:${key}`,
        kind: "skill",
        name: key,
        description: "Comes with Claude Code, or no longer installed",
        location: { tool: "claude", scope: "builtin", file: overrides.file },
        usageKeys: [key],
      });
    }
  }
}
