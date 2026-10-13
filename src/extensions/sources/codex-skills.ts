import path from "node:path";

import type { Collector, Extension } from "../model.js";
import { entryInfo, IO_LIMIT, listNames, mapLimit, parseFrontmatter, readText, realPath } from "../read.js";
import type { SkillLocation } from "./skill-dirs.js";

/**
 * Codex's skills in one skills folder, read as Codex 0.159.3 reads them (its `skills/list`, and
 * `parse_skill_frontmatter_metadata` in codex-rs/skills): a folder holding a SKILL.md is a skill,
 * named by the `name` in its front matter - whitespace collapsed - or, with none, by its folder.
 * The id keeps the folder, as it always has, so an id read before still names the skill when
 * its front matter names it otherwise. A link whose target is gone is listed too, to be cleaned
 * up. `prefix` is a plugin's `<name>:`.
 */
export async function readCodexSkills(
  dir: string,
  location: SkillLocation,
  owner: string,
  out: Collector,
  options: { prefix?: string } = {},
): Promise<void> {
  const prefix = options.prefix ?? "";
  const found = await mapLimit(await listNames(dir, out.warnings), IO_LIMIT, async (entry) => {
    const folder = path.join(dir, entry);
    const info = await entryInfo(folder);
    const broken = info.link?.broken === true;
    if (info.kind !== "dir" && !broken) return undefined;
    const text = broken ? undefined : await readText(path.join(folder, "SKILL.md"), out.warnings);
    if (!broken && text === undefined) return undefined;
    const realFolder = broken ? undefined : await realPath(folder).catch(() => undefined);
    const front = text === undefined ? {} : parseFrontmatter(text);
    const description = singleLine(front.description ?? "");
    const item: Extension = {
      id: `skill:${location.tool}:${location.scope}:${owner}:${prefix}${entry}`,
      kind: "skill",
      name: `${prefix}${skillName(front.name, entry)}`,
      ...(description ? { description } : {}),
      location: { ...location, file: folder },
      ...(info.link ? { link: info.link } : {}),
      ...(realFolder !== undefined ? { realFolder } : {}),
      ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
      // Codex keeps no record of use that we found.
      usageKeys: [],
    };
    return item;
  });
  for (const item of found) if (item) out.items.push(item);
}

/** Whitespace collapsed to single spaces, as Codex's `sanitize_single_line` does. */
function singleLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The name Codex gives a skill: its front matter's, else its folder's, else `skill`. */
function skillName(frontName: string | undefined, folder: string): string {
  return singleLine(frontName ?? "") || singleLine(folder) || "skill";
}
