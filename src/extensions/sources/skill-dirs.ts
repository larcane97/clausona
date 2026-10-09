import path from "node:path";

import type { Collector, Extension, Location } from "../model.js";
import { entryInfo, IO_LIMIT, listNames, mapLimit, parseFrontmatter, readText, realPath } from "../read.js";

export type SkillLocation = Omit<Location, "file">;

/**
 * One item per skill folder in `dir`: a folder holding a SKILL.md, or a link whose target is
 * gone (listed so it can be cleaned up). Shared by the Claude and Codex sources, which both lay
 * skills out as `<dir>/<name>/SKILL.md`. Dot-entries (`.trash`, Codex's `.system`) are skipped
 * by `listNames`; the caller reads `.system` on its own.
 */
export async function readSkillFolders(
  dir: string,
  location: SkillLocation,
  owner: string,
  out: Collector,
  options: { skip?: readonly string[]; prefix?: string; usageKeys?: (name: string) => string[] } = {},
): Promise<void> {
  // The entries are read in parallel and listed in their own order, as one at a time would.
  const found = await mapLimit(await listNames(dir, out.warnings), IO_LIMIT, async (entry) => {
    if (options.skip?.includes(entry)) return undefined;
    const folder = path.join(dir, entry);
    const info = await entryInfo(folder);
    const broken = info.link?.broken === true;
    if (info.kind !== "dir" && !broken) return undefined;
    const text = broken ? undefined : await readText(path.join(folder, "SKILL.md"), out.warnings);
    if (!broken && text === undefined) return undefined;
    // A skills dir that is itself a link leaves no link on the folders inside it, so only the
    // real path tells that `~/.claude/skills/x` and `~/.agents/skills/x` are one folder.
    const realFolder = broken ? undefined : await realPath(folder).catch(() => undefined);
    const front = text === undefined ? {} : parseFrontmatter(text);
    const name = `${options.prefix ?? ""}${entry}`;
    const item: Extension = {
      id: `skill:${location.tool}:${location.scope}:${owner}:${name}`,
      kind: "skill",
      name,
      ...(front.description ? { description: front.description } : {}),
      location: { ...location, file: folder },
      ...(info.link ? { link: info.link } : {}),
      ...(realFolder !== undefined ? { realFolder } : {}),
      ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
      usageKeys: options.usageKeys ? options.usageKeys(name) : [name],
    };
    return item;
  });
  for (const item of found) if (item) out.items.push(item);
}
