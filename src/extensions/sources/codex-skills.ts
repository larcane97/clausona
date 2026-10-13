import path from "node:path";

import type { Collector, Extension } from "../model.js";
import {
  type EntryInfo,
  entryInfo,
  IO_LIMIT,
  listNames,
  mapLimit,
  parseFrontmatter,
  pathKey,
  readText,
  realPath,
} from "../read.js";
import { codexFrontMatterError, rustTrim } from "./codex-front-matter.js";
import type { SkillLocation } from "./skill-dirs.js";

/** How deep below a skills folder Codex looks for a SKILL.md: the folder holding one, at most 6 down. */
const MAX_DEPTH = 6;

/** How many folders Codex looks in below one skills folder, that folder too. */
const MAX_FOLDERS = 2000;

/** A folder the walk looks in: where it is reached, its path below the skills folder, how deep. */
type Folder = { path: string; rel: string; depth: number; real: string; info: EntryInfo };

/**
 * Codex's skills in one skills folder, read as Codex 0.159.3 reads them (its `skills/list`, and
 * `parse_skill_frontmatter_metadata` in codex-rs/skills).
 *
 * Every folder holding a SKILL.md is a skill, the skills folder itself too, as deep as Codex
 * looks: a walk through the folders below it, breadth first, to a depth of 6 and 2000 folders,
 * leaving out a folder whose name starts with `.` and going on into a skill's own folders. It
 * goes through a linked folder - each real folder once - unless `followLinks` is false, as for
 * the skills Codex writes itself.
 *
 * A skill is named by the `name` in its front matter, whitespace collapsed, or, with none, by its
 * folder. Its id ends in its folder's path below the skills folder, so a skill at the top keeps
 * the id it always had, whatever its front matter names it. A SKILL.md Codex refuses - one with
 * no front matter, front matter that is not valid YAML, a name over 64 characters, or no
 * description - is listed with `codexError`, and does not load.
 * A link at the top whose target is gone is listed too, to be cleaned up. `prefix` is a plugin's
 * `<name>:`.
 */
export async function readCodexSkills(
  dir: string,
  location: SkillLocation,
  owner: string,
  out: Collector,
  options: { prefix?: string; followLinks?: boolean } = {},
): Promise<void> {
  const prefix = options.prefix ?? "";
  const { skills, broken } = await walk(dir, options.followLinks !== false, out);
  const items = await mapLimit(skills, IO_LIMIT, async (folder) => {
    const text = await readText(path.join(folder.path, "SKILL.md"), out.warnings);
    if (text === undefined) return undefined;
    const block = frontMatterOf(text);
    const front = block === undefined ? {} : parseFrontmatter(`---\n${block}\n---\n`);
    const description = singleLine(front.description ?? "");
    const name = skillName(front.name, path.basename(folder.path));
    const codexError = refusal(block, name);
    const item: Extension = {
      id: `skill:${location.tool}:${location.scope}:${owner}:${prefix}${folder.rel || path.basename(folder.path)}`,
      kind: "skill",
      name: `${prefix}${name}`,
      ...(description ? { description } : {}),
      ...(codexError ? { codexError } : {}),
      location: { ...location, file: folder.path },
      ...(folder.info.link ? { link: folder.info.link } : {}),
      realFolder: folder.real,
      skillsDir: dir,
      ...(folder.info.createdAt !== undefined ? { createdAt: folder.info.createdAt } : {}),
      // Codex keeps no record of use that we found.
      usageKeys: [],
    };
    return item;
  });
  for (const item of items) if (item) out.items.push(item);
  for (const link of broken) {
    out.items.push({
      id: `skill:${location.tool}:${location.scope}:${owner}:${prefix}${link.rel}`,
      kind: "skill",
      name: `${prefix}${link.rel}`,
      location: { ...location, file: link.path },
      ...(link.info.link ? { link: link.info.link } : {}),
      usageKeys: [],
    });
  }
}

/**
 * The folders below `root` that hold a SKILL.md, as Codex's walk finds them, and the links at the
 * top whose target is gone. Folders at one depth are read side by side.
 */
async function walk(
  root: string,
  followLinks: boolean,
  out: Collector,
): Promise<{ skills: Folder[]; broken: { path: string; rel: string; info: EntryInfo }[] }> {
  const rootInfo = await entryInfo(root);
  const rootReal = rootInfo.kind === "dir" ? await realPath(root).catch(() => undefined) : undefined;
  if (rootReal === undefined) return { skills: [], broken: [] };
  const visited = new Set([pathKey(rootReal)]);
  const skills: Folder[] = [];
  const broken: { path: string; rel: string; info: EntryInfo }[] = [];
  let level: Folder[] = [{ path: root, rel: "", depth: 0, real: rootReal, info: rootInfo }];
  while (level.length > 0) {
    const read = await mapLimit(level, IO_LIMIT, async (folder) => {
      // listNames leaves out what starts with `.`, as Codex does.
      const names = await listNames(folder.path, out.warnings);
      const entries = await mapLimit(names, IO_LIMIT, async (name) => ({
        name,
        info: await entryInfo(path.join(folder.path, name)),
      }));
      return { folder, entries };
    });
    const next: Folder[] = [];
    for (const { folder, entries } of read) {
      if (entries.some((e) => e.name === "SKILL.md" && e.info.kind === "file")) skills.push(folder);
      for (const { name, info } of entries) {
        const at = path.join(folder.path, name);
        const rel = folder.rel === "" ? name : `${folder.rel}/${name}`;
        if (info.link?.broken) {
          if (folder.depth === 0) broken.push({ path: at, rel, info });
          continue;
        }
        if (info.kind !== "dir" || (info.link && !followLinks) || folder.depth + 1 > MAX_DEPTH) continue;
        const real = info.link ? await realPath(at).catch(() => undefined) : path.join(folder.real, name);
        if (real === undefined || visited.has(pathKey(real)) || visited.size >= MAX_FOLDERS) continue;
        visited.add(pathKey(real));
        next.push({ path: at, rel, depth: folder.depth + 1, real, info });
      }
    }
    level = next;
  }
  return { skills, broken };
}

/**
 * A SKILL.md's front matter as Codex finds it: a first line that is `---`, spaces aside as Rust
 * trims them - a byte order mark is none - then the lines up to the next such line. Undefined
 * when there is no closing line or nothing between the two, which Codex calls missing front
 * matter and does not load.
 */
function frontMatterOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (rustTrim(lines[0] ?? "") !== "---") return undefined;
  const end = lines.findIndex((line, i) => i > 0 && rustTrim(line) === "---");
  return end > 1 ? lines.slice(1, end).join("\n") : undefined;
}

/**
 * Why Codex lists no skill for a SKILL.md, if it does not, in the order it checks: no front
 * matter, front matter that is not YAML it reads (codexFrontMatterError), a name over Codex's 64
 * characters, or no description. Such a folder is listed all the same, so it can be found and
 * fixed.
 */
function refusal(block: string | undefined, name: string): Extension["codexError"] {
  if (block === undefined) return "no front matter";
  const problem = codexFrontMatterError(block);
  if (problem === "invalid front matter") return problem;
  return [...name].length > 64 ? "name too long" : problem;
}

/** Whitespace collapsed to single spaces, as Codex's `sanitize_single_line` does. */
function singleLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** The name Codex gives a skill: its front matter's, else its folder's, else `skill`. */
function skillName(frontName: string | undefined, folder: string): string {
  return singleLine(frontName ?? "") || singleLine(folder) || "skill";
}
