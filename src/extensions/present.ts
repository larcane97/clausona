import path from "node:path";

import type { EffectiveState, Extension, Inventory } from "./model.js";
import { isWithin, samePath } from "./read.js";
import { isMcpjsonServer, stateOf } from "./state.js";

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

/** A path cut to `width` from its middle: its start, `…`, and as many of its last parts as fit. */
export function middleCut(p: string, width: number): string {
  if (p.length <= width) return p;
  if (width < 3) return width <= 0 ? "" : `${p.slice(0, width - 1)}…`;
  // Each part but the first starts with its separator.
  const parts = p.split(/(?=[\\/])/);
  let tail = "";
  for (let at = parts.length - 1; at > 0; at--) {
    const next = `${parts[at]}${tail}`;
    // Room for the `…` and one character of the start.
    if (next.length + 2 > width) break;
    tail = next;
  }
  if (tail === "") {
    const head = Math.ceil((width - 1) / 2);
    return `${p.slice(0, head)}…${p.slice(p.length - (width - 1 - head))}`;
  }
  const head = p.slice(0, width - 1 - tail.length);
  // The start up to its last separator, so the cut reads as parts left out.
  const sep = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  return `${sep > 0 ? head.slice(0, sep + 1) : head}…${tail}`;
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

/**
 * A project in a word: its folder's name, and `~` for the home dir. A parent dir read for its
 * `.mcp.json` alone is no project, and goes by its path: `~/repos`.
 */
export function projectName(dir: string, inv: Pick<Inventory, "homeDir" | "projects">): string {
  if (samePath(dir, inv.homeDir)) return "~";
  return inv.projects.some((p) => samePath(p.path, dir)) ? path.basename(dir) : tilde(dir, inv.homeDir);
}

/** Where an item is defined, in a few words: `project app`, `local work · ~`, `plugin superpowers`. */
export function whereLabel(item: Extension, inv: Pick<Inventory, "homeDir" | "projects">): string {
  const loc = item.location;
  const parts: string[] = [SCOPE_WORD[loc.scope]];
  if (loc.scope === "plugin" && loc.plugin) parts.push(loc.plugin.split("@")[0] ?? loc.plugin);
  else if (loc.profile) parts.push(shortProfile(loc.profile));
  if (loc.project && loc.scope !== "plugin") {
    parts.push(`${loc.profile ? "· " : ""}${projectName(loc.project, inv)}`);
  }
  return parts.join(" ");
}

/**
 * The project an item is read in: its own when it has one, else the one the list is seen from.
 * A `.mcp.json` server of a dir above that project loads there, so it is read there too.
 */
export function viewFrom(item: Extension, project: string | undefined): string | undefined {
  const own = item.location.project;
  if (own === undefined) return project;
  return isMcpjsonServer(item) && isWithin(project, own) ? project : own;
}

/** What `item` is with no account named: every account's approvals merged. */
export function stateHere(inv: Inventory, item: Extension, project: string | undefined): EffectiveState {
  return stateOf(inv, item, viewFrom(item, project));
}

export type AccountState = { profile: string; state: EffectiveState };

/** Whether some account's own skills folder has a Claude skill of `name`. */
function ownSkillNamed(inv: Inventory, name: string): boolean {
  return inv.items.some(
    (other) =>
      other.kind === "skill" &&
      other.location.tool === "claude" &&
      other.location.scope === "account" &&
      other.name === name,
  );
}

/**
 * What every account sees but each reads its own way, read per account:
 * - a Claude MCP server that every account opening the project sees (.mcp.json, plugin), which
 *   each account switches, and a local server can hide. Only the accounts that can load it
 *   count: Claude accounts that have recorded the project, and for a plugin's server the ones
 *   with the plugin installed. Codex records projects too, but never loads a Claude server;
 * - a Claude project skill that an account's own same-name skill hides in that account only, in
 *   every Claude account.
 * Undefined for any other item, and for such a server when no such account has recorded the
 * project.
 */
export function accountStates(
  inv: Inventory,
  item: Extension,
  project: string | undefined,
): AccountState[] | undefined {
  const here = viewFrom(item, project);
  const loc = item.location;
  if (loc.tool !== "claude" || loc.profile !== undefined || !here) return undefined;
  const read = (profiles: string[]) =>
    profiles.map((profile) => ({ profile, state: stateOf(inv, item, here, profile) }));
  if (item.kind === "skill") {
    return loc.scope === "project" && ownSkillNamed(inv, item.name) ? read(inv.claudeProfiles) : undefined;
  }
  if (item.kind !== "mcp") return undefined;
  const accounts = loc.scope === "plugin" && loc.accounts ? loc.accounts : inv.claudeProfiles;
  const profiles = (inv.projects.find((p) => samePath(p.path, here))?.profiles ?? []).filter((profile) =>
    accounts.includes(profile),
  );
  return profiles.length === 0 ? undefined : read(profiles);
}
