import path from "node:path";

import type { Collector, Location } from "../model.js";
import { entryInfo, listNames, parseFrontmatter, readText } from "../read.js";

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
  for (const entry of await listNames(dir, out.warnings)) {
    if (options.skip?.includes(entry)) continue;
    const folder = path.join(dir, entry);
    const info = await entryInfo(folder);
    const broken = info.link?.broken === true;
    if (info.kind !== "dir" && !broken) continue;
    const text = broken ? undefined : await readText(path.join(folder, "SKILL.md"), out.warnings);
    if (!broken && text === undefined) continue;
    const front = text === undefined ? {} : parseFrontmatter(text);
    const name = `${options.prefix ?? ""}${entry}`;
    out.items.push({
      id: `skill:${location.tool}:${location.scope}:${owner}:${name}`,
      kind: "skill",
      name,
      ...(front.description ? { description: front.description } : {}),
      location: { ...location, file: folder },
      ...(info.link ? { link: info.link } : {}),
      ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
      usageKeys: options.usageKeys ? options.usageKeys(name) : [name],
    });
  }
}
