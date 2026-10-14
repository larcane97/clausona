import path from "node:path";

import type { EffectiveState, Extension, Inventory, Project } from "./model.js";
import { isWithin, pathKey, samePath } from "./read.js";
import { isMcpjsonServer, stateOf } from "./state.js";

/**
 * How the inventory reads on screen, shared by `clausona skills|mcp|hooks ls` and the dashboard:
 * labels for profiles, paths and locations, and the state of an item as either one shows it.
 */

/** A profile id without its tool: `claude:work` is `work`. */
export function shortProfile(id: string): string {
  return id.replace(/^(claude|codex):/, "");
}

/**
 * `~` for the home dir, only where a path starts with it. On Windows in any case, as tildeIn
 * takes it: Codex writes its project keys in lower case, and they name the same folders.
 */
export function tilde(p: string, homeDir: string): string {
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, homeDir)) return "~";
  const head = p.slice(0, homeDir.length);
  return p.charAt(homeDir.length) === path.sep && same(head, homeDir) ? `~${p.slice(homeDir.length)}` : p;
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
 * A project in a word: its folder's name, and `~` for the home dir. Where two recorded projects
 * share a folder name, the folder above it too - `work/app`, `personal/app` - or the path where
 * even that is one. A parent dir read for its `.mcp.json` alone is no project, and goes by its
 * path: `~/repos`. The CLI, JSON and the screen all name a project so.
 */
export function projectName(dir: string, inv: Pick<Inventory, "homeDir" | "projects">): string {
  if (samePath(dir, inv.homeDir)) return "~";
  return projectNames(inv).get(pathKey(dir)) ?? tilde(dir, inv.homeDir);
}

/** How many of each name there are. */
function counted(names: string[]): (name: string) => number {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return (name) => counts.get(name) ?? 0;
}

/** Each recorded project's name by path key, worked out once per list of projects. */
const namesCache = new WeakMap<readonly Project[], { homeDir: string; names: Map<string, string> }>();

function projectNames(inv: Pick<Inventory, "homeDir" | "projects">): Map<string, string> {
  const cached = namesCache.get(inv.projects);
  if (cached?.homeDir === inv.homeDir) return cached.names;
  const named = inv.projects.map((p) => ({
    dir: p.path,
    name: samePath(p.path, inv.homeDir) ? "~" : path.basename(p.path),
  }));
  const shared = counted(named.map((p) => p.name));
  const longer = named.map((p) =>
    shared(p.name) > 1 ? { ...p, name: path.join(path.basename(path.dirname(p.dir)), p.name) } : p,
  );
  const still = counted(longer.map((p) => p.name));
  const names = new Map(longer.map((p) => [pathKey(p.dir), still(p.name) > 1 ? tilde(p.dir, inv.homeDir) : p.name]));
  namesCache.set(inv.projects, { homeDir: inv.homeDir, names });
  return names;
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

/**
 * Whether a personal Claude skill of `name` loads in some accounts only: one in an account's own
 * skills folder, or a Global one that an account whose skills folder is its own does not load.
 */
function personalSkillInSome(inv: Inventory, name: string): boolean {
  return inv.items.some(
    (other) =>
      other.kind === "skill" &&
      other.location.tool === "claude" &&
      other.name === name &&
      (other.location.scope === "account" ||
        (other.location.scope === "global" && other.location.accounts !== undefined)),
  );
}

/**
 * What every account sees but each reads its own way, read per account:
 * - a Claude MCP server that every account opening the project sees (.mcp.json, plugin), which
 *   each account switches, and a local server can hide. Only the accounts that can load it
 *   count: Claude accounts that have recorded the project, and for a plugin's server the ones
 *   with the plugin installed. Codex records projects too, but never loads a Claude server;
 * - a Claude project skill that a same-name personal skill hides in some accounts only - an
 *   account's own, or a Global one that not every account loads - in every Claude account.
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
    return loc.scope === "project" && personalSkillInSome(inv, item.name) ? read(inv.claudeProfiles) : undefined;
  }
  if (item.kind !== "mcp") return undefined;
  const accounts = loc.scope === "plugin" && loc.accounts ? loc.accounts : inv.claudeProfiles;
  const profiles = (inv.projects.find((p) => samePath(p.path, here))?.profiles ?? []).filter((profile) =>
    accounts.includes(profile),
  );
  return profiles.length === 0 ? undefined : read(profiles);
}
