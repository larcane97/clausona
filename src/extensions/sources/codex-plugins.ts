import path from "node:path";

import { valueHash } from "../hash.js";
import type { Collector, Extension, Location, StateFacts } from "../model.js";
import { entryInfo, IO_LIMIT, isRecord, isWithin, listNames, mapLimit, readJsonObject } from "../read.js";
import { mcpSummary } from "../redact.js";
import { addHooks, addHooksFile } from "./claude-hooks.js";
import {
  addCodexHookTrust,
  codexReadsHookEvents,
  codexReadsHooksFile,
  exactJsonFile,
  markRefusedHooksFile,
} from "./codex-hooks.js";
import { readCodexSkills } from "./codex-skills.js";

/**
 * Codex's plugins, as Codex 0.159.3 loads them - checked against what its app-server lists
 * (`skills/list`, `hooks/list`, `mcpServerStatus/list`), the layout in OpenAI's plugin docs.
 *
 * A plugin is installed at `<Codex home>/plugins/cache/<marketplace>/<plugin>/<version>/`,
 * which every Codex profile shares, and is `<plugin>@<marketplace>` in config.toml: Codex loads
 * it where a `[plugins."<id>"]` table names it (see `codexPluginState`). Its manifest is
 * `.codex-plugin/plugin.json`, else `.claude-plugin/plugin.json`; without one Codex loads
 * nothing of it. A plugin installed from ChatGPT's catalog is left out: whether it is on is the
 * account's to say, not config.toml's.
 */

/** What Codex leaves beside the versions of a plugin it installed from ChatGPT's catalog. */
const REMOTE_INSTALL = ".codex-remote-plugin-install.json";

/** A plugin's own location, which what it brings shares with its own file. */
type PluginPlace = Omit<Location, "file"> & { plugin: string };

/** Every plugin in Codex's cache that Codex can load, with what each brings, in cache order. */
export async function readCodexPlugins(codexHome: string, out: Collector): Promise<void> {
  const cache = path.join(codexHome, "plugins", "cache");
  const found: { id: string; dir: string }[] = [];
  for (const marketplace of await listNames(cache, out.warnings)) {
    for (const plugin of await listNames(path.join(cache, marketplace), out.warnings)) {
      found.push({ id: `${plugin}@${marketplace}`, dir: path.join(cache, marketplace, plugin) });
    }
  }
  const read = await mapLimit(found, IO_LIMIT, ({ id, dir }) => readPlugin(id, dir, out));
  for (const items of read) out.items.push(...items);
}

/** One plugin's items, its own first: none when Codex would load nothing of it. */
async function readPlugin(id: string, dir: string, out: Collector): Promise<Extension[]> {
  if ((await entryInfo(path.join(dir, REMOTE_INSTALL))).kind !== "missing") return [];
  const version = await loadedVersion(dir, out);
  if (version === undefined) return [];
  const root = path.join(dir, version);
  const manifestFile = await manifestOf(root);
  const manifest = manifestFile === undefined ? undefined : await readJsonObject(manifestFile, out.warnings);
  if (manifestFile === undefined || manifest === undefined) return [];
  const place: PluginPlace = { tool: "codex", scope: "plugin", plugin: id };
  const own: Collector = { items: [], facts: out.facts, warnings: out.warnings };
  own.items.push({
    id: `plugin:codex:plugin:${id}:${id}`,
    kind: "plugin",
    name: id,
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    location: { ...place, file: root },
  });
  // Codex names a plugin's skills after the manifest's name - or, with none, the version folder.
  const prefix = `${typeof manifest.name === "string" ? manifest.name : version}:`;
  for (const skills of paths(root, manifest.skills, "skills")) {
    await readCodexSkills(skills, place, id, own, { prefix });
  }
  await readServers(root, manifest, manifestFile, place, own);
  await readHooks(root, manifest, manifestFile, place, own);
  // Two skill folders a manifest names can hold one name; Codex loads one of them.
  const seen = new Set<string>();
  return own.items.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

/** The manifest Codex reads: its own, else Claude's. */
async function manifestOf(root: string): Promise<string | undefined> {
  for (const file of [
    path.join(root, ".codex-plugin", "plugin.json"),
    path.join(root, ".claude-plugin", "plugin.json"),
  ]) {
    if ((await entryInfo(file)).kind === "file") return file;
  }
  return undefined;
}

/**
 * The version folder Codex loads a plugin from: `local` when there is one, else the highest of
 * the folders in its cache folder - compared as versions when both names are, else as text,
 * which takes `zzz` over `1.0.0` and `2` over `10` as Codex does. A link among them is no
 * version Codex takes.
 */
async function loadedVersion(dir: string, out: Collector): Promise<string | undefined> {
  const names = await listNames(dir, out.warnings);
  const folders = await mapLimit(names, IO_LIMIT, async (name) => {
    const info = await entryInfo(path.join(dir, name));
    return info.kind === "dir" && info.link === undefined ? name : undefined;
  });
  const versions = folders.filter((name): name is string => name !== undefined);
  if (versions.includes("local")) return "local";
  let best: string | undefined;
  for (const version of versions) if (best === undefined || newer(version, best)) best = version;
  return best;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether version `a` is newer than `b`, by semver's order when both are versions, else by their text. */
function newer(a: string, b: string): boolean {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return a > b;
  for (let k = 1; k <= 3; k++) {
    const d = Number(x[k]) - Number(y[k]);
    if (d !== 0) return d > 0;
  }
  // A release is newer than its prereleases; prereleases go by their dot-separated parts.
  const [pa, pb] = [x[4], y[4]];
  if (pa === undefined || pb === undefined) return pa === undefined && pb !== undefined;
  const xs = pa.split(".");
  const ys = pb.split(".");
  for (let k = 0; k < Math.max(xs.length, ys.length); k++) {
    const [p, q] = [xs[k], ys[k]];
    if (p === undefined || q === undefined) return q === undefined;
    if (p === q) continue;
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (np && nq) return Number(p) > Number(q);
    // Numbers come before words.
    return np !== nq ? nq : p > q;
  }
  return false;
}

/** The paths a manifest field gives - one, or a list - inside `root`, or `fallback` when it gives none. */
function paths(root: string, field: unknown, fallback: string): string[] {
  const given = field === undefined ? [fallback] : [field].flat().filter((p): p is string => typeof p === "string");
  return given.map((p) => path.resolve(root, p)).filter((p) => isWithin(p, root));
}

/**
 * A plugin's MCP servers: the file the manifest's `mcpServers` names, the servers it holds
 * itself, or `.mcp.json`. A file holds them under `mcpServers` or at its root.
 */
async function readServers(
  root: string,
  manifest: Record<string, unknown>,
  manifestFile: string,
  place: PluginPlace,
  out: Collector,
): Promise<void> {
  const field = manifest.mcpServers;
  let file = manifestFile;
  let servers: unknown = field;
  if (!isRecord(field)) {
    const named =
      typeof field === "string" ? paths(root, field, "") : field === undefined ? [path.join(root, ".mcp.json")] : [];
    if (named[0] === undefined) return;
    file = named[0];
    const json = await readJsonObject(file, out.warnings);
    servers = isRecord(json?.mcpServers) ? json.mcpServers : json;
  }
  for (const [name, server] of Object.entries(isRecord(servers) ? servers : {})) {
    // As for any Codex server: one that says how to start it.
    if (!isRecord(server) || (server.command === undefined && server.url === undefined)) continue;
    const id = `mcp:codex:plugin:${place.plugin}:${name}`;
    out.items.push({ id, kind: "mcp", name, location: { ...place, file }, summary: mcpSummary(server) });
    out.facts.fingerprints[id] = valueHash(server);
    // A server the plugin ships off - `"enabled": false` - stays off until config.toml turns it on.
    if (typeof server.enabled === "boolean") {
      out.facts.codexPluginServers.push({ file, plugin: place.plugin, name, enabled: server.enabled, default: true });
    }
  }
}

/**
 * A plugin's hooks: what the manifest's `hooks` gives - a file, the hooks themselves under a
 * "hooks" key, or a list of either - or `hooks/hooks.json`. Each file's or entry's hooks are
 * their own, as Codex keys them by where they are.
 */
async function readHooks(
  root: string,
  manifest: Record<string, unknown>,
  manifestFile: string,
  place: PluginPlace,
  out: Collector,
): Promise<void> {
  const field = manifest.hooks === undefined ? "./hooks/hooks.json" : manifest.hooks;
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const entries = Array.isArray(field) ? field : [field];
  // A list holds hook files or hooks, not both; Codex ignores any other, and reads no hooks of the plugin.
  if (!entries.every((e) => typeof e === "string") && !entries.every(isRecord)) {
    out.warnings.push({
      file: manifestFile,
      message: "lists hook files and hooks together under hooks, which Codex ignores",
    });
    return;
  }
  // The manifest again, its numbers as Codex reads them, for the hashes of the hooks it holds.
  const exact = entries.some(isRecord) ? await exactJsonFile(manifestFile) : undefined;
  const exactEntries: unknown[] = Array.isArray(exact?.hooks) ? exact.hooks : [exact?.hooks];
  // One inline hook serde cannot read, and Codex reads none of the manifest's - its numbers as
  // Codex reads them.
  const inlineRead = entries.every((e, k) => {
    const read = isRecord(exactEntries[k]) ? (exactEntries[k] as Record<string, unknown>) : e;
    return !isRecord(read) || !isRecord(read.hooks) || codexReadsHookEvents(read.hooks);
  });
  // Codex 0.159.3 says nothing of it, and runs none: this names the plugin.
  if (!inlineRead) {
    const message = `has an inline hook Codex cannot read, so Codex drops every inline hook of plugin ${place.plugin}`;
    out.warnings.push({ file: manifestFile, message });
  }
  for (const [k, entry] of entries.entries()) {
    if (isRecord(entry)) {
      const owner = `${place.plugin}|${relative(manifestFile)}#hooks[${k}]`;
      if (!isRecord(entry.hooks)) continue;
      addHooks(entry.hooks, { ...place, file: manifestFile }, owner, out, "hooks");
      if (!inlineRead) {
        markRefusedHooksFile(out, manifestFile);
        continue;
      }
      // Codex keys an inline entry by the manifest's name alone, whichever folder holds it.
      const source = `${place.plugin}:plugin.json#hooks[${k}]`;
      const exactEntry = exactEntries[k];
      const hooks = isRecord(exactEntry) && isRecord(exactEntry.hooks) ? exactEntry.hooks : entry.hooks;
      addCodexHookTrust(hooks, `hook:codex:plugin:${owner}`, [source], out.facts, place.plugin);
      continue;
    }
    if (typeof entry !== "string") continue;
    for (const file of paths(root, entry, "")) {
      const json = await readJsonObject(file, out.warnings);
      if (!json) continue;
      const owner = `${place.plugin}|${relative(file)}`;
      addHooksFile(json, { ...place, file }, owner, out);
      // Its numbers as Codex reads them, for the check and the hashes.
      const exactFile = (await exactJsonFile(file)) ?? json;
      if (!codexReadsHooksFile(exactFile)) {
        markRefusedHooksFile(out, file);
        continue;
      }
      const source = `${place.plugin}:${relative(file)}`;
      addCodexHookTrust(exactFile.hooks, `hook:codex:plugin:${owner}`, [source], out.facts, place.plugin);
    }
  }
}

/**
 * The `[plugins."<id>"]` tables of one config.toml, and their `mcp_servers.<name>.enabled`
 * switches, into the facts: the user's (`project` undefined) or a project's.
 */
export function addPluginSwitches(
  config: Record<string, unknown>,
  file: string,
  project: string | undefined,
  facts: StateFacts,
  layer?: number,
): void {
  const where = { file, ...(project !== undefined ? { project } : {}), ...(layer !== undefined ? { layer } : {}) };
  for (const [plugin, table] of Object.entries(isRecord(config.plugins) ? config.plugins : {})) {
    if (!isRecord(table)) continue;
    facts.codexPlugins.push({
      ...where,
      plugin,
      ...(typeof table.enabled === "boolean" ? { enabled: table.enabled } : {}),
    });
    for (const [name, server] of Object.entries(isRecord(table.mcp_servers) ? table.mcp_servers : {})) {
      if (isRecord(server) && typeof server.enabled === "boolean") {
        facts.codexPluginServers.push({ ...where, plugin, name, enabled: server.enabled });
      }
    }
  }
}
