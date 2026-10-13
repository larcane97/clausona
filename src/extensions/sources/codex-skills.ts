import path from "node:path";

import type { Collector, Extension } from "../model.js";
import { entryInfo, IO_LIMIT, listNames, mapLimit, parseFrontmatter, readText, realPath } from "../read.js";
import type { SkillLocation } from "./skill-dirs.js";

/**
 * Codex's skills in one skills folder, read as Codex 0.159.3 reads them (its `skills/list`, and
 * `parse_skill_frontmatter_metadata` in codex-rs/skills): a folder holding a SKILL.md is a skill,
 * named by the `name` in its front matter - whitespace collapsed - or, with none, by its folder.
 * The id keeps the folder, as it always has, so an id read before still names the skill when
 * its front matter names it otherwise. A SKILL.md Codex refuses - one with no front matter, or a
 * name over 64 characters - is listed with `codexError`, and does not load. A link whose target
 * is gone is listed too, to be cleaned up. `prefix` is a plugin's `<name>:`.
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
    const block = text === undefined ? undefined : frontMatterOf(text);
    const front = block === undefined ? {} : parseFrontmatter(`---\n${block}\n---\n`);
    const description = singleLine(front.description ?? "");
    const name = skillName(front.name, entry);
    const codexError = text === undefined ? undefined : refusal(block, name);
    const item: Extension = {
      id: `skill:${location.tool}:${location.scope}:${owner}:${prefix}${entry}`,
      kind: "skill",
      name: `${prefix}${name}`,
      ...(description ? { description } : {}),
      ...(codexError ? { codexError } : {}),
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

/**
 * A SKILL.md's front matter as Codex finds it: a first line that is `---`, spaces aside, then
 * the lines up to the next such line. Undefined when there is no closing line or nothing between
 * the two, which Codex calls missing front matter and does not load.
 */
function frontMatterOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end > 1 ? lines.slice(1, end).join("\n") : undefined;
}

/**
 * Why Codex lists no skill for a SKILL.md, if it does not: no front matter, or a name over
 * Codex's 64 characters. Such a folder is listed all the same, so it can be found and fixed.
 */
function refusal(block: string | undefined, name: string): Extension["codexError"] {
  if (block === undefined) return "no front matter";
  return [...name].length > 64 ? "name too long" : undefined;
}

/** Whitespace collapsed to single spaces, as Codex's `sanitize_single_line` does. */
function singleLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The name Codex gives a skill: its front matter's, else its folder's, else `skill`. */
function skillName(frontName: string | undefined, folder: string): string {
  return singleLine(frontName ?? "") || singleLine(folder) || "skill";
}
