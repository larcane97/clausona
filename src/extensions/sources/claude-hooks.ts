import path from "node:path";

import { valueHash } from "../hash.js";
import type { Collector, HookPlace, Location, Scope, SettingsLayer } from "../model.js";
import { isRecord, pathKey, readJsonObject, realPath } from "../read.js";
import { hookSummary } from "../redact.js";
import {
  type ClaudeContext,
  declared,
  insidePlugin,
  type PluginInstall,
  pluginLocation,
  pluginManifestFile,
  pluginOwner,
} from "./claude-context.js";

function layerScope(layer: SettingsLayer): Scope {
  return layer === "user" ? "global" : layer;
}

/**
 * One item per hook command, `hooks[event][group].hooks[index]` - the shape of Claude Code's
 * settings, of a plugin's hooks.json, and of Codex's hooks.json alike - with that place, `base`
 * saying whether the events sit under the file's "hooks" key or at its root. An entry that is
 * not an object is no command Claude Code could run, so it is not listed, though it keeps its
 * place in the array. `at`, put before the place in the id, tells apart the files of one owner:
 * a plugin's hooks.json, its manifest and the files its manifest names.
 */
export function addHooks(
  hooks: unknown,
  location: Location,
  owner: string,
  out: Collector,
  base: HookPlace["base"],
  at = "",
): void {
  if (!isRecord(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, g) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return;
      const matcher = typeof group.matcher === "string" && group.matcher !== "" ? group.matcher : undefined;
      group.hooks.forEach((hook, h) => {
        if (!isRecord(hook)) return;
        const id = `hook:${location.tool}:${location.scope}:${owner}:${event}#${at}${g}.${h}`;
        out.items.push({
          id,
          kind: "hook",
          name: matcher ? `${event} ${matcher}` : event,
          location,
          summary: hookSummary(event, matcher, hook),
          hook: { base, event, ...(matcher ? { matcher } : {}), group: g, index: h },
        });
        out.facts.fingerprints[id] = valueHash(hook);
      });
    });
  }
}

/**
 * A hooks.json's hooks - a plugin's or Codex's - whose events sit under a "hooks" key, or at the
 * root of a file written without one.
 */
export function addHooksFile(
  json: Record<string, unknown>,
  location: Location,
  owner: string,
  out: Collector,
  at = "",
): void {
  if (isRecord(json.hooks)) addHooks(json.hooks, location, owner, out, "hooks", at);
  else addHooks(json, location, owner, out, "root", at);
}

/**
 * The hooks in every settings file Claude Code reads, and each plugin's: its hooks/hooks.json,
 * then what its manifest declares (see `readPluginHooks`). A settings hook's id owner is its
 * file, which fixes the layer and the project too: the managed file and each
 * managed-settings.d drop-in share a layer, as a project's settings.json and
 * settings.local.json share a project.
 */
export async function readClaudeHooks(ctx: ClaudeContext, out: Collector): Promise<void> {
  for (const settings of ctx.settings) {
    addHooks(
      settings.data.hooks,
      {
        tool: "claude",
        scope: layerScope(settings.layer),
        file: settings.file,
        ...(settings.project ? { project: settings.project } : {}),
      },
      `${settings.layer}:${pathKey(settings.file)}`,
      out,
      "hooks",
    );
  }
  await Promise.all(ctx.plugins.map((plugin) => readPluginHooks(plugin, out)));
}

/**
 * A plugin's hooks, as Claude Code 2.1.296 merges them: hooks/hooks.json, then each thing the
 * manifest's `hooks` declares - an inline object of events, or the path of a hooks file, read
 * as hooks.json is. A path that leaves the plugin is not read, nor the same file twice, the
 * standard hooks.json included. Their ids keep hooks.json's as they were and say for the rest
 * which file they are in (`plugin.json:`, `plugin.json[1]:`, `config/extra.json:`), so a hook
 * of each on one event makes a row of its own.
 */
async function readPluginHooks(plugin: PluginInstall, out: Collector): Promise<void> {
  const from = pluginLocation(plugin);
  const owner = pluginOwner(plugin);
  const file = path.join(plugin.installPath, "hooks", "hooks.json");
  const json = await readJsonObject(file, out.warnings);
  if (json) addHooksFile(json, { ...from, file }, owner, out);
  const manifestFile = pluginManifestFile(plugin);
  const manifest = await readJsonObject(manifestFile, out.warnings);
  const entries = declared(manifest, "hooks");
  const listed = Array.isArray(manifest?.hooks);
  const seen = new Set([await fileKey(file)]);
  for (const [i, entry] of entries.entries()) {
    if (isRecord(entry)) {
      addHooks(
        entry,
        { ...from, file: manifestFile },
        owner,
        out,
        "hooks",
        listed ? `plugin.json[${i}]:` : "plugin.json:",
      );
      continue;
    }
    if (typeof entry !== "string") continue;
    const named = await insidePlugin(plugin, entry);
    if (named === undefined) continue;
    const key = await fileKey(named);
    if (seen.has(key)) continue;
    seen.add(key);
    const hooks = await readJsonObject(named, out.warnings);
    const at = `${path.relative(plugin.installPath, named).split(path.sep).join("/").replaceAll("#", "%23")}:`;
    if (hooks) addHooksFile(hooks, { ...from, file: named }, owner, out, at);
  }
}

/** One key for every path that leads to a file: its real path, or the path where it is not there. */
async function fileKey(file: string): Promise<string> {
  return pathKey(await realPath(file).catch(() => file));
}

/** One item per plugin install, so a list can show - and later switch - a plugin as a whole. */
export async function readClaudePlugins(ctx: ClaudeContext, out: Collector): Promise<void> {
  await Promise.all(
    ctx.plugins.map(async (plugin) => {
      const manifest = await readJsonObject(
        path.join(plugin.installPath, ".claude-plugin", "plugin.json"),
        out.warnings,
      );
      out.items.push({
        id: `plugin:claude:plugin:${pluginOwner(plugin)}:${plugin.id}`,
        kind: "plugin",
        name: plugin.id,
        ...(typeof manifest?.description === "string" ? { description: manifest.description } : {}),
        location: { ...pluginLocation(plugin), file: plugin.installPath },
      });
    }),
  );
}
