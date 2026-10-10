import path from "node:path";

import { valueHash } from "../hash.js";
import type { Collector, HookPlace, Location, Scope, SettingsLayer } from "../model.js";
import { isRecord, pathKey, readJsonObject } from "../read.js";
import { hookSummary } from "../redact.js";
import { type ClaudeContext, type PluginInstall, pluginOwner } from "./claude-context.js";

function layerScope(layer: SettingsLayer): Scope {
  return layer === "user" ? "global" : layer;
}

/**
 * One item per hook command, `hooks[event][group].hooks[index]` - the shape of Claude Code's
 * settings, of a plugin's hooks.json, and of Codex's hooks.json alike - with that place, `base`
 * saying whether the events sit under the file's "hooks" key or at its root. An entry that is
 * not an object is no command Claude Code could run, so it is not listed, though it keeps its
 * place in the array.
 */
export function addHooks(
  hooks: unknown,
  location: Location,
  owner: string,
  out: Collector,
  base: HookPlace["base"],
): void {
  if (!isRecord(hooks)) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, g) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return;
      const matcher = typeof group.matcher === "string" && group.matcher !== "" ? group.matcher : undefined;
      group.hooks.forEach((hook, h) => {
        if (!isRecord(hook)) return;
        const id = `hook:${location.tool}:${location.scope}:${owner}:${event}#${g}.${h}`;
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
export function addHooksFile(json: Record<string, unknown>, location: Location, owner: string, out: Collector): void {
  if (isRecord(json.hooks)) addHooks(json.hooks, location, owner, out, "hooks");
  else addHooks(json, location, owner, out, "root");
}

/** Where something a plugin install brings is defined, with the accounts that have the install. */
function pluginLocation(plugin: PluginInstall, file: string): Location {
  return {
    tool: "claude",
    scope: "plugin",
    plugin: plugin.id,
    file,
    ...(plugin.project ? { project: plugin.project } : {}),
    accounts: plugin.profiles,
  };
}

/**
 * The hooks in every settings file Claude Code reads, and in each plugin's hooks/hooks.json. A
 * settings hook's id owner is its file, which fixes the layer and the project too: the managed
 * file and each managed-settings.d drop-in share a layer, as a project's settings.json and
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
  await Promise.all(
    ctx.plugins.map(async (plugin) => {
      const file = path.join(plugin.installPath, "hooks", "hooks.json");
      const json = await readJsonObject(file, out.warnings);
      if (json) addHooksFile(json, pluginLocation(plugin, file), pluginOwner(plugin), out);
    }),
  );
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
        location: pluginLocation(plugin, plugin.installPath),
      });
    }),
  );
}
