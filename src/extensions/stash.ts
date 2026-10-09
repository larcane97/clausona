import type { ToolName } from "../types.js";
import { bytesHash } from "./hash.js";
import type { Extension, HookPlace, Location, Scope } from "./model.js";
import { isRecord } from "./read.js";
import { hookSummary, mcpSummary } from "./redact.js";

/**
 * What clausona keeps of an MCP server or a hook it turned off everywhere: the tool has no
 * switch for that, so the entry comes out of the tool's file into a file of clausona's own, one
 * per entry, and goes back from there. Pure: the format, its parsing, and the item a file lists
 * as. Reading the folder is `sources/stash.ts`'s.
 */

/** One segment of a path into a JSON file: a key, an index, or a project's key in `projects` as written there. */
export type PathSeg = string | number | { projectKey: string };
export type JsonPath = readonly PathSeg[];

export const STASH_VERSION = 1;

/** One entry clausona took out of a tool's file to turn it off everywhere. Holds the raw entry: the file is 0600. */
export type StashFile = {
  version: 1;
  /** The file name without .json. */
  id: string;
  kind: "mcp" | "hook";
  tool: ToolName;
  /** The server's name, or the hook's "<Event> <matcher>" / "<Event>". */
  name: string;
  /** The file it came from. */
  file: string;
  /** Where it lived in that file, keys resolved: ["mcpServers","x"], ["projects","/abs/p","mcpServers","x"]; for a hook, its event array. */
  path: (string | number)[];
  /** Its Location.scope there: account, local, global, project, local layer and so on. */
  scope: Scope;
  profile?: string;
  project?: string;
  hook?: HookPlace;
  entry: unknown;
  /** ISO 8601. */
  stashedAt: string;
};

/** What plan() knows before apply reads the raw entry: everything but version, entry and stashedAt; the path may hold a { projectKey } segment. */
export type StashMeta = Omit<StashFile, "version" | "entry" | "stashedAt" | "path"> & { path: JsonPath };

const KINDS: ReadonlySet<string> = new Set(["mcp", "hook"] satisfies StashFile["kind"][]);
const TOOLS: ReadonlySet<string> = new Set(["claude", "codex"] satisfies ToolName[]);
const SCOPES: ReadonlySet<string> = new Set([
  "global",
  "account",
  "project",
  "local",
  "plugin",
  "synced",
  "builtin",
  "managed",
] satisfies Scope[]);

/** `${now.toString(36)}-${bytesHash(itemId).slice(0, 8)}` - unique per item and moment, and a valid file name everywhere. */
export function stashIdFor(itemId: string, now: number): string {
  return `${now.toString(36)}-${bytesHash(itemId).slice(0, 8)}`;
}

export function stashFileName(id: string): string {
  return `${id}.json`;
}

export function stashText(stash: StashFile): string {
  return `${JSON.stringify(stash, null, 2)}\n`;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hookPlace(value: unknown): HookPlace | undefined {
  if (!isRecord(value)) return undefined;
  const { base, event, matcher, group, index } = value;
  if ((base !== "hooks" && base !== "root") || typeof event !== "string" || !isIndex(group) || !isIndex(index)) {
    return undefined;
  }
  if (matcher !== undefined && typeof matcher !== "string") return undefined;
  return { base, event, ...(matcher !== undefined ? { matcher } : {}), group, index };
}

/** A stash file's object, or undefined when it is not version 1 or misses a field. Never throws. */
export function parseStash(value: unknown): StashFile | undefined {
  if (!isRecord(value) || value.version !== STASH_VERSION) return undefined;
  const { id, kind, tool, name, file, path, scope, profile, project, entry, stashedAt } = value;
  if (!isText(id) || !isText(name) || !isText(file) || !isText(stashedAt) || Number.isNaN(Date.parse(stashedAt))) {
    return undefined;
  }
  if (typeof kind !== "string" || !KINDS.has(kind) || typeof tool !== "string" || !TOOLS.has(tool)) return undefined;
  if (typeof scope !== "string" || !SCOPES.has(scope)) return undefined;
  if (!Array.isArray(path) || !path.every((seg) => typeof seg === "string" || isIndex(seg))) return undefined;
  if ((profile !== undefined && !isText(profile)) || (project !== undefined && !isText(project))) return undefined;
  // Every entry a source lists is an object; a hook also needs its place to go back to.
  if (!isRecord(entry)) return undefined;
  const hook = value.hook === undefined ? undefined : hookPlace(value.hook);
  if ((value.hook !== undefined && !hook) || (kind === "hook" && !hook)) return undefined;
  return {
    version: STASH_VERSION,
    id,
    kind: kind as StashFile["kind"],
    tool: tool as ToolName,
    name,
    file,
    path: [...path],
    scope: scope as Scope,
    ...(profile !== undefined ? { profile } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(hook ? { hook } : {}),
    entry,
    stashedAt,
  };
}

/** The inventory item for a stash file: original location, `stashed`, a redacted summary, and no raw entry. */
export function stashItem(stash: StashFile, stashPath: string): Extension {
  const { id, kind, tool, name, file, scope, profile, project, hook } = stash;
  const location: Location = {
    tool,
    scope,
    file,
    ...(profile ? { profile } : {}),
    ...(project ? { project } : {}),
  };
  return {
    id: `${kind}:${tool}:${scope}:stash-${id}:${name}`,
    kind,
    name,
    location,
    summary: kind === "hook" ? hookSummary(hook?.event ?? name, hook?.matcher, stash.entry) : mcpSummary(stash.entry),
    ...(kind === "hook" && hook ? { hook: { ...hook } } : {}),
    stashed: { file: stashPath, id, at: Date.parse(stash.stashedAt) },
  };
}
