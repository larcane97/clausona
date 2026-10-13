import path from "node:path";

import { parse } from "smol-toml";

import type { Registry } from "../../types.js";
import { valueHash } from "../hash.js";
import type { Collector, Location, Project, Warning } from "../model.js";
import { codexProjectConfig } from "../places.js";
import { isHomeProject, type ProjectRecord, recordedPaths } from "../projects.js";
import { entryInfo, isRecord, pathKey, readJsonObject, readText, realPath, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import { codexTrustedIn } from "../state.js";
import { addHooksFile } from "./claude-hooks.js";
import { codexConfigProblem, mergeCodexConfig } from "./codex-config-check.js";
import {
  addCodexHookStates,
  addCodexHookTrust,
  addConfigHooks,
  codexHomeHooksFile,
  codexReadsHooksFile,
  exactConfigHooks,
  exactJsonFile,
  exactToml,
  markRefusedHooksFile,
  markUnsupportedHooks,
} from "./codex-hooks.js";
import { addPluginSwitches, readCodexPlugins } from "./codex-plugins.js";
import { readCodexSkills } from "./codex-skills.js";
import { codexRoots, projectRootMarkers } from "./codex-trust.js";
import type { SkillLocation } from "./skill-dirs.js";

export type CodexHome = { id: string; dir: string; isPrimary: boolean };

export type CodexContext = {
  homeDir: string;
  primary: CodexHome;
  homes: CodexHome[];
  configFile: string;
  config?: Record<string, unknown>;
  /** The user's config.toml with its numbers as Codex reads them, which a project's is checked merged over. */
  exact?: Record<string, unknown>;
};

/**
 * Why a file is not valid TOML, keeping only where. smol-toml's message carries a code block
 * of the text around the error, and in a config.toml that text can be an API key or a token,
 * while a warning reaches the TUI and `--json`.
 */
function invalidToml(error: unknown): string {
  return isRecord(error) && typeof error.line === "number" && typeof error.column === "number"
    ? `is not valid TOML at line ${error.line}, column ${error.column}`
    : "is not valid TOML";
}

/** A config.toml as clausona reads it, and as Codex reads its numbers (`exactToml`), for the checks. */
export type CodexConfigFile = { value: Record<string, unknown>; exact: Record<string, unknown> };

/**
 * A Codex config.toml, or undefined when missing; one that does not parse is a warning. An
 * integer past 2^53 is a bigint, as Codex reads it as the i64 it is; one past 64 bits Codex 0.159.3
 * refuses ("u64 value was too large"), the whole file with it, so that is a warning too. Whether
 * Codex reads its typed config is the caller's to check (codexConfigProblem): a project's is
 * checked merged over the user's.
 */
export async function readCodexConfig(file: string, warnings: Warning[]): Promise<CodexConfigFile | undefined> {
  const text = await readText(file, warnings);
  if (text === undefined) return undefined;
  let value: Record<string, unknown>;
  try {
    value = parse(text, { integersAsBigInt: "asNeeded" }) as Record<string, unknown>;
  } catch (error) {
    warnings.push({ file, message: invalidToml(error) });
    return undefined;
  }
  if (pastI64(value)) {
    warnings.push({ file, message: "has an integer too large for 64 bits, so Codex refuses the whole file" });
    return undefined;
  }
  return { value, exact: exactToml(text) ?? value };
}

/**
 * The user's config.toml as an object, or undefined when missing or refused: one that does not
 * parse, holds an integer past 64 bits, or a value of a section clausona reads that Codex cannot
 * read (codexConfigProblem), Codex refuses whole, and this warns.
 */
export async function readTomlObject(file: string, warnings: Warning[]): Promise<Record<string, unknown> | undefined> {
  const read = await readCodexConfig(file, warnings);
  if (read === undefined) return undefined;
  const problem = codexConfigProblem(read.exact);
  if (problem === undefined) return read.value;
  warnings.push({ file, message: `has ${problem} Codex cannot read, so Codex refuses the whole file` });
  return undefined;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Whether a TOML value holds an integer Codex's i64 cannot. */
function pastI64(value: unknown): boolean {
  if (typeof value === "bigint") return value < I64_MIN || value > I64_MAX;
  if (Array.isArray(value)) return value.some(pastI64);
  return isRecord(value) && Object.values(value).some(pastI64);
}

/**
 * The Codex homes and the primary's config.toml. Every Codex profile links config.toml,
 * hooks.json and skills/ to the primary's, so the primary's are every account's; a profile
 * whose skills/ is its own is read on its own.
 */
export async function loadCodexContext(
  registry: Registry,
  homeDir: string,
  warnings: Warning[],
): Promise<CodexContext | undefined> {
  const primaryDir = registry.primarySources.codex;
  const homes = Object.entries(registry.profiles)
    .filter(([, profile]) => profile.tool === "codex")
    .map(([id, profile]) => ({
      id,
      dir: profile.configDir,
      isPrimary: profile.isPrimary === true || (primaryDir !== undefined && samePath(profile.configDir, primaryDir)),
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const primary = homes[0];
  if (!primary) return undefined;
  const configFile = path.join(primary.dir, "config.toml");
  const read = await readCodexConfig(configFile, warnings);
  const problem = read && codexConfigProblem(read.exact);
  if (problem)
    warnings.push({ file: configFile, message: `has ${problem} Codex cannot read, so Codex refuses the whole file` });
  const config = read && !problem ? read : undefined;
  return { homeDir, primary, homes, configFile, ...(config ? { config: config.value, exact: config.exact } : {}) };
}

/** The projects Codex has recorded trust for, as one record under the primary. */
export function codexProjectRecords(ctx: CodexContext): ProjectRecord[] {
  return [{ tool: "codex", profile: ctx.primary.id, paths: recordedPaths(ctx.config?.projects) }];
}

/**
 * Codex's skills, MCP servers, hooks - a hooks.json's, and a config.toml's `[hooks]` beside it -
 * and plugins, and the switches for them: `[[skills.config]]`
 * in the user config.toml (by name, or by the SKILL.md path - the only per-project skill switch,
 * since Codex ignores `[[skills.config]]` in a project's config; spec, Spike 1),
 * `mcp_servers.<name>.enabled`, and the `[plugins."<id>"]` tables, in the user and project
 * config.toml. Beside them, the trust the user config.toml records for each project, and the
 * folders Codex looks it up in (codex-trust.ts): Codex 0.159.3 reads a project's `.codex/` only
 * when it trusts the project, so `state.ts` leaves the switches of any other out. In a linked
 * worktree, the hooks are its main checkout's, which Codex runs there in place of its own. Codex keeps no skill usage on disk that we found, so its skills
 * carry no usage keys.
 */
export async function readCodex(ctx: CodexContext, projects: Project[], out: Collector): Promise<void> {
  const global: SkillLocation = { tool: "codex", scope: "global" };
  // The trust first: whether Codex reads a project's config.toml, and checks it, turns on it.
  for (const [project, table] of Object.entries(isRecord(ctx.config?.projects) ? ctx.config.projects : {})) {
    // A table with no trust_level decides nothing, so Codex looks further (codexTrustFolders).
    if (!isRecord(table)) continue;
    const level = table.trust_level === undefined ? {} : { trusted: table.trust_level === "trusted" };
    out.facts.codexTrust.push({ project, ...level });
  }
  const jobs: Promise<void>[] = [
    readCodexSkills(path.join(ctx.homeDir, ".agents", "skills"), global, "agents", out),
    readCodexSkills(path.join(ctx.primary.dir, "skills"), global, "home", out),
    // Codex writes these itself, and follows no link among them.
    readCodexSkills(
      path.join(ctx.primary.dir, "skills", ".system"),
      { tool: "codex", scope: "builtin" },
      "system",
      out,
      { followLinks: false },
    ),
  ];
  for (const home of ctx.homes) {
    if (home.isPrimary) continue;
    jobs.push(
      (async () => {
        const [mine, primary] = await Promise.all([
          realPath(path.join(home.dir, "skills")).catch(() => undefined),
          realPath(path.join(ctx.primary.dir, "skills")).catch(() => undefined),
        ]);
        if (mine === undefined || samePath(mine, primary)) return;
        await readCodexSkills(
          path.join(home.dir, "skills"),
          { tool: "codex", scope: "account", profile: home.id },
          home.id,
          out,
        );
      })(),
    );
  }
  const trustRecorded = isRecord(ctx.config?.projects) && Object.keys(ctx.config.projects).length > 0;
  const markers = projectRootMarkers(ctx.config);
  for (const project of projects) {
    // The home dir's .agents/skills and .codex/ are the user's own, read above.
    if (isHomeProject(project, ctx.homeDir)) continue;
    const here: SkillLocation = { tool: "codex", scope: "project", project: project.path };
    jobs.push(readCodexSkills(path.join(project.path, ".agents", "skills"), here, project.path, out));
    jobs.push(
      (async () => {
        // Where Codex looks for the project's trust, and its main checkout in a linked worktree;
        // with no project recorded, Codex trusts none, and runs none of its hooks.
        const roots = trustRecorded ? await codexRoots(project.path, markers) : undefined;
        if (roots) out.facts.codexTrustFolders[pathKey(project.path)] = roots.folders;
        const own = path.dirname(codexProjectConfig(project.path));
        // Codex reads a worktree's main checkout's hooks only for a .codex folder there is.
        const worktree = roots?.worktree && (await entryInfo(own)).kind === "dir" ? roots.worktree : undefined;
        if (worktree) out.facts.codexWorktrees[pathKey(project.path)] = worktree;
        const file = codexProjectConfig(project.path);
        const config = projectConfig(ctx, project.path, file, await readCodexConfig(file, out.warnings), out);
        if (config) {
          addServers(config, { ...here, file }, project.path, out);
          addPluginSwitches(config, file, project.path, out.facts);
        }
        // Codex looks up no trust for a worktree's own hooks: it never reads them there.
        await addFolderHooks(own, config, here, project.path, out, "", worktree === undefined);
        if (!worktree) return;
        // In a worktree Codex runs the main checkout's hooks, under their own paths, and none of these.
        for (const item of out.items) {
          const loc = item.location;
          if (item.kind === "hook" && loc.tool === "codex" && loc.project === project.path && !item.stashed) {
            if (samePath(path.dirname(loc.file), own)) item.codexError = "main checkout's runs";
          }
        }
        const main = await readTomlObject(path.join(worktree.hooks, "config.toml"), out.warnings);
        await addFolderHooks(worktree.hooks, main, here, project.path, out, MAIN_CHECKOUT_AT);
      })(),
    );
  }
  jobs.push(
    (async () => {
      const file = path.join(ctx.primary.dir, "hooks.json");
      const hooks = await readJsonObject(file, out.warnings);
      if (!hooks) return;
      addHooksFile(hooks, { ...global, file }, "-", out);
      // Its numbers as Codex reads them, for the check and the hashes.
      const exact = (await exactJsonFile(file)) ?? hooks;
      if (!codexReadsHooksFile(exact)) markRefusedHooksFile(out, file);
      else addCodexHookTrust(exact.hooks, "hook:codex:global:-", await userHookSources(ctx, file), out.facts);
    })(),
  );
  jobs.push(readCodexPlugins(ctx.primary.dir, out));
  if (ctx.config) {
    addServers(ctx.config, { ...global, file: ctx.configFile }, "-", out);
    addPluginSwitches(ctx.config, ctx.configFile, undefined, out.facts);
    addCodexHookStates(ctx.config, ctx.configFile, out.facts);
    if (isRecord(ctx.config.hooks)) {
      const [sources, exact] = await Promise.all([
        userHookSources(ctx, ctx.configFile),
        exactConfigHooks(ctx.configFile),
      ]);
      addConfigHooks(ctx.config, { ...global, file: ctx.configFile }, "-", sources, out, exact);
    }
    const skills = isRecord(ctx.config.skills) ? ctx.config.skills : undefined;
    const entries = (Array.isArray(skills?.config) ? skills.config : []).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.enabled !== "boolean") return [];
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const skillPath = typeof entry.path === "string" ? entry.path : undefined;
      // Codex ignores an entry with neither selector or with both.
      if ((name === undefined) === (skillPath === undefined)) return [];
      return [{ name, skillPath, enabled: entry.enabled }];
    });
    // In their order, which decides between two that name one skill.
    const real = await Promise.all(entries.map(({ skillPath }) => resolvedSkillPath(skillPath)));
    for (const [k, { name, skillPath, enabled }] of entries.entries()) {
      const realPath = real[k];
      out.facts.codexSkillConfig.push({
        file: ctx.configFile,
        ...(name ? { name } : {}),
        ...(skillPath ? { path: skillPath } : {}),
        ...(realPath !== undefined ? { realPath } : {}),
        enabled,
      });
    }
  }
  await Promise.all(jobs);
  markUnsupportedHooks(out);
}

/**
 * A project's config.toml, as read, where Codex reads it: where Codex trusts the project, it
 * checks the file merged over the user's (mergeCodexConfig), and refuses its config there when
 * that has a value of the wrong type - a switch for a server the user does not define too - which
 * is a warning, and the file is read no further. Codex leaves an untrusted project's alone.
 */
function projectConfig(
  ctx: CodexContext,
  project: string,
  file: string,
  read: CodexConfigFile | undefined,
  out: Collector,
): Record<string, unknown> | undefined {
  if (read === undefined) return undefined;
  if (!codexTrustedIn(out.facts, project)) return read.value;
  const problem = codexConfigProblem(mergeCodexConfig(ctx.exact ?? {}, read.exact) as Record<string, unknown>);
  if (problem === undefined) return read.value;
  out.warnings.push({ file, message: `has ${problem} Codex cannot read, so Codex loads no config in this project` });
  return undefined;
}

/** What a worktree's id for one of its main checkout's hooks puts before the hook's place. */
const MAIN_CHECKOUT_AT = "main:";

/**
 * The hooks of a project's `.codex` folder, `folder`, as Codex runs them for `here`: its
 * config.toml's `[hooks]` (`config`, read already) and its hooks.json, each keyed by its own
 * path. `at` goes before the place in their ids: MAIN_CHECKOUT_AT for a worktree's main
 * checkout's, which are the worktree's rows, apart from the main checkout's own. Without
 * `trusted`, their trust is not looked up, as Codex does not for hooks it never runs.
 */
async function addFolderHooks(
  folder: string,
  config: Record<string, unknown> | undefined,
  here: SkillLocation,
  owner: string,
  out: Collector,
  at = "",
  trusted = true,
): Promise<void> {
  const file = path.join(folder, "config.toml");
  if (config && isRecord(config.hooks)) {
    const exact = await exactConfigHooks(file);
    const sources = trusted ? await hookSources(file) : [];
    addConfigHooks(config, { ...here, file }, owner, sources, out, exact, at);
  }
  const hooksFile = path.join(folder, "hooks.json");
  const hooks = await readJsonObject(hooksFile, out.warnings);
  if (!hooks) return;
  addHooksFile(hooks, { ...here, file: hooksFile }, owner, out, at);
  // Its numbers as Codex reads them, for the check and the hashes.
  const exact = (await exactJsonFile(hooksFile)) ?? hooks;
  if (!codexReadsHooksFile(exact)) markRefusedHooksFile(out, hooksFile);
  else if (trusted) {
    const idBase = `hook:codex:project:${owner}`;
    addCodexHookTrust(exact.hooks, idBase, await hookSources(hooksFile), out.facts, undefined, at);
  }
}

/**
 * The paths a trust key can name a hooks file by: as found, and its real path - how Codex names
 * it depends on how it reached the project.
 */
async function hookSources(file: string): Promise<string[]> {
  const real = await realPath(file).catch(() => undefined);
  return real === undefined || real === file ? [file] : [file, real];
}

/**
 * The user hooks.json, or config.toml, under each Codex profile that shares the primary's: Codex
 * keys a hook's trust by its file's path under the CODEX_HOME it runs with, so each profile
 * trusts it on its own. The primary runs with none set, at its folder as it is; any other with
 * the folder clausona sets, which Codex makes canonical first.
 */
async function userHookSources(ctx: CodexContext, file: string): Promise<string[]> {
  const name = path.basename(file);
  const shared = await realPath(file).catch(() => undefined);
  const each = await Promise.all(
    ctx.homes.map(async (home) => {
      const own = path.join(home.dir, name);
      if (home.isPrimary) return hookSources(own);
      const real = await realPath(own).catch(() => undefined);
      if (real === undefined || !samePath(real, shared)) return [];
      const keyed = await codexHomeHooksFile(home.dir);
      return keyed === undefined ? [] : [path.join(path.dirname(keyed), name)];
    }),
  );
  return [...new Set(each.flat())];
}

/**
 * A `[[skills.config]]` path with its folder resolved through every link - a linked skills
 * folder, a skill folder that is a link, `/tmp` on macOS - for matching the skill as Codex
 * does. Undefined for no path, a relative one, or a folder that is not there.
 */
async function resolvedSkillPath(skillPath: string | undefined): Promise<string | undefined> {
  if (skillPath === undefined || !path.isAbsolute(skillPath)) return undefined;
  const folder = await realPath(path.dirname(skillPath)).catch(() => undefined);
  return folder === undefined ? undefined : path.join(folder, path.basename(skillPath));
}

/**
 * Each `[mcp_servers.<name>]` table: a server when it says how to start one, by `command` or
 * `url`. A table that only sets `enabled` - as a project's config.toml switches a user server
 * off - is that switch alone, for the server of that name, and not a second server.
 */
function addServers(config: Record<string, unknown>, location: Location, owner: string, out: Collector): void {
  for (const [name, server] of Object.entries(isRecord(config.mcp_servers) ? config.mcp_servers : {})) {
    if (!isRecord(server)) continue;
    if (server.command !== undefined || server.url !== undefined) {
      const id = `mcp:codex:${location.scope}:${owner}:${name}`;
      out.items.push({ id, kind: "mcp", name, location, summary: mcpSummary(server) });
      out.facts.fingerprints[id] = valueHash(server);
    }
    if (typeof server.enabled === "boolean") {
      out.facts.codexMcpEnabled.push({
        file: location.file,
        ...(location.project ? { project: location.project } : {}),
        name,
        enabled: server.enabled,
      });
    }
  }
}
