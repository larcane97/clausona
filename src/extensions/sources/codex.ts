import path from "node:path";

import { parse } from "smol-toml";

import type { Registry } from "../../types.js";
import { valueHash } from "../hash.js";
import type { Collector, Location, Project, Warning } from "../model.js";
import { codexProjectConfig, codexProjectHooks } from "../places.js";
import { isHomeProject, type ProjectRecord, recordedPaths } from "../projects.js";
import { isRecord, pathKey, readJsonObject, readText, realPath, samePath } from "../read.js";
import { mcpSummary } from "../redact.js";
import { addHooksFile } from "./claude-hooks.js";
import {
  addCodexHookStates,
  addCodexHookTrust,
  addConfigHooks,
  codexHomeHooksFile,
  codexReadsHookEvents,
  codexReadsHooksFile,
  exactConfigHooks,
  exactJsonFile,
  markRefusedHooksFile,
  markUnsupportedHooks,
} from "./codex-hooks.js";
import { addPluginSwitches, readCodexPlugins } from "./codex-plugins.js";
import { readCodexSkills } from "./codex-skills.js";
import { codexTrustFolders, projectRootMarkers } from "./codex-trust.js";
import type { SkillLocation } from "./skill-dirs.js";

export type CodexHome = { id: string; dir: string; isPrimary: boolean };

export type CodexContext = {
  homeDir: string;
  primary: CodexHome;
  homes: CodexHome[];
  configFile: string;
  config?: Record<string, unknown>;
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

/**
 * A Codex config.toml as an object, or undefined when missing; one that does not parse is a
 * warning. An integer past 2^53 is a bigint, as Codex reads it as the i64 it is. Two things make
 * Codex 0.159.3 refuse the whole file, and are warnings too: an integer past 64 bits ("u64 value
 * was too large"), and a hook under `[hooks]` it cannot read ("invalid configuration").
 */
export async function readTomlObject(file: string, warnings: Warning[]): Promise<Record<string, unknown> | undefined> {
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
  if (isRecord(value.hooks) && !codexReadsHookEvents(value.hooks)) {
    warnings.push({ file, message: "has a hook Codex cannot read, so Codex refuses the whole file" });
    return undefined;
  }
  return value;
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
  const config = await readTomlObject(configFile, warnings);
  return { homeDir, primary, homes, configFile, ...(config ? { config } : {}) };
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
 * when it trusts the project, so `state.ts` leaves the switches of any other out. Codex keeps no skill usage on disk that we found, so its skills
 * carry no usage keys.
 */
export async function readCodex(ctx: CodexContext, projects: Project[], out: Collector): Promise<void> {
  const global: SkillLocation = { tool: "codex", scope: "global" };
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
        const file = codexProjectConfig(project.path);
        const config = await readTomlObject(file, out.warnings);
        if (config) {
          addServers(config, { ...here, file }, project.path, out);
          addPluginSwitches(config, file, project.path, out.facts);
          if (isRecord(config.hooks)) {
            const exact = await exactConfigHooks(file);
            addConfigHooks(config, { ...here, file }, project.path, await hookSources(file), out, exact);
          }
        }
        const hooksFile = codexProjectHooks(project.path);
        const hooks = await readJsonObject(hooksFile, out.warnings);
        if (hooks) {
          addHooksFile(hooks, { ...here, file: hooksFile }, project.path, out);
          if (!codexReadsHooksFile(hooks)) markRefusedHooksFile(out, hooksFile);
          else
            addCodexHookTrust(
              (await exactJsonFile(hooksFile))?.hooks ?? hooks.hooks,
              `hook:codex:project:${project.path}`,
              await hookSources(hooksFile),
              out.facts,
            );
        }
      })(),
    );
    // Where Codex looks for the project's trust; with no project recorded there is none to find.
    if (trustRecorded) {
      jobs.push(
        (async () => {
          out.facts.codexTrustFolders[pathKey(project.path)] = await codexTrustFolders(project.path, markers);
        })(),
      );
    }
  }
  jobs.push(
    (async () => {
      const file = path.join(ctx.primary.dir, "hooks.json");
      const hooks = await readJsonObject(file, out.warnings);
      if (!hooks) return;
      addHooksFile(hooks, { ...global, file }, "-", out);
      if (!codexReadsHooksFile(hooks)) markRefusedHooksFile(out, file);
      else {
        const exact = (await exactJsonFile(file))?.hooks ?? hooks.hooks;
        addCodexHookTrust(exact, "hook:codex:global:-", await userHookSources(ctx, file), out.facts);
      }
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
    for (const [project, table] of Object.entries(isRecord(ctx.config.projects) ? ctx.config.projects : {})) {
      // A table with no trust_level decides nothing, so Codex looks further (codexTrustFolders).
      if (!isRecord(table)) continue;
      const level = table.trust_level === undefined ? {} : { trusted: table.trust_level === "trusted" };
      out.facts.codexTrust.push({ project, ...level });
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
