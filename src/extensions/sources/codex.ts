import path from "node:path";

import { parse } from "smol-toml";

import type { Registry } from "../../types.js";
import { valueHash } from "../hash.js";
import type { Collector, Location, Project, Warning } from "../model.js";
import { codexProjectConfig } from "../places.js";
import { tilde } from "../present.js";
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
  /** Set when Codex refuses the user's config.toml, and so loads none of its config anywhere. */
  refused?: true;
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

/** Why Codex refuses a config.toml whole, in words for a warning; `parse` for one that does not parse. */
type Refused = { refused: string; parse: boolean };

/**
 * A Codex config.toml, undefined when missing, or why Codex refuses it whole: one that does not
 * parse, and one with an integer past 64 bits ("u64 value was too large" in Codex 0.159.3), which
 * the caller warns of. An integer past 2^53 is a bigint, as Codex reads it as the i64 it is.
 * Whether Codex reads its typed config is the caller's to check (codexConfigProblem): a project's
 * is checked merged over the user's.
 */
export async function readCodexConfig(
  file: string,
  warnings: Warning[],
): Promise<CodexConfigFile | Refused | undefined> {
  const text = await readText(file, warnings);
  if (text === undefined) return undefined;
  let value: Record<string, unknown>;
  try {
    value = parse(text, { integersAsBigInt: "asNeeded" }) as Record<string, unknown>;
  } catch (error) {
    return { refused: invalidToml(error), parse: true };
  }
  if (pastI64(value)) return { refused: "has an integer too large for 64 bits", parse: false };
  return { value, exact: exactToml(text) ?? value };
}

const REFUSES_FILE = "so Codex refuses the whole file";

/** A file's warning where Codex refuses it whole and nothing names a place it loads no config in. */
function refusedWords({ refused, parse }: Refused): string {
  return parse ? refused : `${refused}, ${REFUSES_FILE}`;
}

/**
 * The project config.toml files Codex refuses, one warning per file and cause however many projects
 * read it - a main checkout's, as its own project and as each of its worktrees' - naming every
 * project it keeps all config from, by its path: in a list of warnings each line reads the same
 * wherever it is shown. A file only an untrusted project reads, Codex leaves alone, and its
 * warning names none.
 */
class ProjectRefusals {
  private readonly byCause = new Map<string, { file: string; cause: Refused; places: Set<string> }>();

  note(file: string, cause: Refused, place: string | undefined): void {
    const key = `${file}\0${cause.refused}`;
    const entry = this.byCause.get(key) ?? { file, cause, places: new Set<string>() };
    if (place !== undefined) entry.places.add(place);
    this.byCause.set(key, entry);
  }

  warn(warnings: Warning[], homeDir: string): void {
    for (const { file, cause, places } of this.byCause.values()) {
      const named = [...places].map((place) => tilde(place, homeDir)).sort();
      const list = named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
      const message =
        named.length === 0 ? refusedWords(cause) : `${cause.refused}, so Codex loads no config in ${list}`;
      warnings.push({ file, message });
    }
  }
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
  const refused = read && "refused" in read ? read : undefined;
  const problem = read && !("refused" in read) ? codexConfigProblem(read.exact) : undefined;
  if (refused) warnings.push({ file: configFile, message: refusedWords(refused) });
  if (problem) warnings.push({ file: configFile, message: `has ${problem} Codex cannot read, ${REFUSES_FILE}` });
  const ctx: CodexContext = { homeDir, primary, homes, configFile };
  // Codex then loads no config: config/read, skills/list and hooks/list fail.
  if (refused || problem) return { ...ctx, refused: true };
  return read && !("refused" in read) ? { ...ctx, config: read.value, exact: read.exact } : ctx;
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
  if (ctx.refused) out.facts.codexConfigRefused.push({ file: ctx.configFile });
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
  const refusals = new ProjectRefusals();
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
        const mainFile = worktree ? path.join(worktree.hooks, "config.toml") : undefined;
        const { config, main } = await projectConfig(ctx, project.path, file, out, refusals, mainFile);
        if (config) {
          // Where Codex trusts the project, it merges each server over the user's of its name.
          const user = codexTrustedIn(out.facts, project.path) ? ctx.config?.mcp_servers : undefined;
          addServers(config, { ...here, file }, project.path, out, isRecord(user) ? user : undefined);
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
  refusals.warn(out.warnings, ctx.homeDir);
  markUnsupportedHooks(out);
}

/**
 * A project's config.toml, and in a linked worktree its main checkout's (`mainFile`), where Codex
 * reads them. Codex checks the project's config merged over the user's (mergeCodexConfig) - in a
 * worktree with the main checkout's `[hooks]` (and `[hooks.state]`) in place of its own, and
 * nothing else of that file. Where it trusts the project, it refuses one that does not parse, or
 * that check failing - a switch for a server the user does not define too - and then loads none
 * of its config there, the user's included (codexConfigRefused): a warning on the file at fault
 * (ProjectRefusals), and the files read no further. Codex leaves an untrusted project's alone,
 * one that does not parse too.
 */
async function projectConfig(
  ctx: CodexContext,
  project: string,
  file: string,
  out: Collector,
  refusals: ProjectRefusals,
  mainFile?: string,
): Promise<{ config?: Record<string, unknown>; main?: Record<string, unknown> }> {
  const trusted = codexTrustedIn(out.facts, project);
  const read = await readCodexConfig(file, out.warnings);
  const main = mainFile === undefined ? undefined : await readCodexConfig(mainFile, out.warnings);
  const value = (r: CodexConfigFile | Refused | undefined) => (r === undefined || "refused" in r ? undefined : r.value);
  const refuse = (at: string, cause: Refused) => {
    refusals.note(at, cause, project);
    out.facts.codexConfigRefused.push({ file: at, project });
    return {};
  };
  if (!trusted) {
    if (read && "refused" in read) refusals.note(file, read, undefined);
    if (mainFile !== undefined && main && "refused" in main) refusals.note(mainFile, main, undefined);
    return { config: value(read), main: value(main) };
  }
  if (read && "refused" in read) return refuse(file, read);
  if (mainFile !== undefined && main && "refused" in main) return refuse(mainFile, main);
  const mainRead = main && !("refused" in main) ? main : undefined;
  if (read === undefined && mainRead === undefined) return {};
  const own = read?.exact ?? {};
  let checked = own;
  if (mainFile !== undefined) {
    const { hooks: _dropped, ...rest } = own;
    const hooks = mainRead?.exact.hooks;
    checked = hooks === undefined ? rest : { ...rest, hooks };
  }
  const problem = codexConfigProblem(mergeCodexConfig(ctx.exact ?? {}, checked) as Record<string, unknown>);
  if (problem === undefined) return { config: value(read), main: value(main) };
  // In a worktree, a hook is the main checkout's.
  const at = mainFile !== undefined && problem === "a hook" ? mainFile : file;
  return refuse(at, { refused: `has ${problem} Codex cannot read`, parse: false });
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
 * off - is that switch alone, for the server of that name, and not a second server. With
 * `under`, the user's servers in a project Codex trusts: a server's summary is what Codex runs,
 * its table merged over the user's of its name (mergeCodexConfig), so the project's `command`
 * with the user's `args`, and `env` from both. Its fingerprint is its own table, which a write changes.
 */
function addServers(
  config: Record<string, unknown>,
  location: Location,
  owner: string,
  out: Collector,
  under?: Record<string, unknown>,
): void {
  for (const [name, server] of Object.entries(isRecord(config.mcp_servers) ? config.mcp_servers : {})) {
    if (!isRecord(server)) continue;
    if (server.command !== undefined || server.url !== undefined) {
      const id = `mcp:codex:${location.scope}:${owner}:${name}`;
      // What Codex runs: the table merged over the user's of its name, at every depth.
      const runs = under !== undefined && Object.hasOwn(under, name) ? mergeCodexConfig(under[name], server) : server;
      out.items.push({ id, kind: "mcp", name, location, summary: mcpSummary(runs) });
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
