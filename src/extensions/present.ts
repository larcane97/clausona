import path from "node:path";

import type { EffectiveState, Extension, Inventory } from "./model.js";
import { samePath } from "./read.js";
import { stateOf } from "./state.js";

/**
 * How the inventory reads on screen, shared by `clausona skills|mcp|hooks ls` and the dashboard:
 * labels for profiles, paths and locations, and the state of an item as either one shows it.
 */

const SCOPE_WORD = {
  global: "global",
  account: "account",
  project: "project",
  local: "local",
  plugin: "plugin",
  synced: "claude.ai",
  builtin: "built-in",
  managed: "managed",
} as const;

/** A profile id without its tool: `claude:work` is `work`. */
export function shortProfile(id: string): string {
  return id.replace(/^(claude|codex):/, "");
}

/** `~` for the home dir, only where a path starts with it. */
export function tilde(p: string, homeDir: string): string {
  if (p === homeDir) return "~";
  return p.startsWith(homeDir + path.sep) ? `~${p.slice(homeDir.length)}` : p;
}

/** What may stand before and after a path in a command line: its start or end, a space, a quote, a list separator. */
const PATH_START = String.raw`(?<=^|[\s"'=:;,(])`;
const PATH_END = String.raw`(?=$|[\s"':;,)]|${path.sep.replace(/\\/g, "\\\\")})`;

/**
 * `tilde` for every path in `text` that starts with the home dir, as in a command line or a URL,
 * so a long home prefix does not crowd out what the command runs. For display only: --json
 * keeps the text as read. Text that runs on from the home dir's name (`~-old`), or holds it
 * further into another path, names another folder and is left as it is.
 */
export function tildeIn(text: string, homeDir: string): string {
  // An empty pattern would match between every two characters.
  if (homeDir === "") return text;
  const home = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Windows compares paths case-folded, so a home dir typed in another case is the same folder.
  return text.replace(new RegExp(`${PATH_START}${home}${PATH_END}`, process.platform === "win32" ? "gi" : "g"), "~");
}

/** Where an item is defined, in a few words: `project app`, `local work · app`, `plugin superpowers`. */
export function whereLabel(item: Extension): string {
  const loc = item.location;
  const parts: string[] = [SCOPE_WORD[loc.scope]];
  if (loc.scope === "plugin" && loc.plugin) parts.push(loc.plugin.split("@")[0] ?? loc.plugin);
  else if (loc.profile) parts.push(shortProfile(loc.profile));
  if (loc.project && loc.scope !== "plugin") parts.push(`${loc.profile ? "· " : ""}${path.basename(loc.project)}`);
  return parts.join(" ");
}

/** The project an item is read in: its own when it has one, else the one the list is seen from. */
export function viewFrom(item: Extension, project: string | undefined): string | undefined {
  return item.location.project ?? project;
}

/** What `item` is with no account named: every account's approvals merged. */
export function stateHere(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  return stateOf(inv, item, viewFrom(item, project));
}

export type AccountState = { profile: string; state: EffectiveState };

/**
 * A Claude MCP server that every account opening the project sees (.mcp.json, plugin) is
 * switched per account, so it is read per account. Only the accounts that can load it count:
 * Claude accounts, and for a plugin's server the ones with the plugin installed. Codex records
 * projects too, but never loads a Claude server. Undefined for any other item, and when no such
 * account has recorded the project.
 */
export function accountStates(
  inv: Inventory,
  item: Extension,
  project: string | undefined,
): AccountState[] | undefined {
  const here = viewFrom(item, project);
  if (item.kind !== "mcp" || item.location.tool !== "claude" || item.location.profile !== undefined || !here) {
    return undefined;
  }
  const accounts =
    item.location.scope === "plugin" && item.location.accounts ? item.location.accounts : inv.claudeProfiles;
  const profiles = (inv.projects.find((p) => samePath(p.path, here))?.profiles ?? []).filter((profile) =>
    accounts.includes(profile),
  );
  if (profiles.length === 0) return undefined;
  return profiles.map((profile) => ({ profile, state: stateOf(inv, item, here, profile) }));
}
