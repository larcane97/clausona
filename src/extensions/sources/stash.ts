import path from "node:path";

import type { Collector, Extension } from "../model.js";
import { entryInfo, IO_LIMIT, listNames, mapLimit, readJsonObject } from "../read.js";
import { parseStash, stashFileName, stashItem } from "../stash.js";

/** The warning for a file there that lists nothing. Warnings are shown, so it never says "stash". */
const UNREADABLE = "is not a file clausona can read back";

/**
 * Every <dir>/*.json stash file as an item: what clausona took out of a tool's file to turn it
 * off everywhere, listed where it came from and read as off - `gone` once that file is no longer
 * there to put it back into. A file that is no stash clausona can read, or whose id is not its
 * name, is a warning and lists nothing; a dir that is not there holds nothing.
 */
export async function readStash(dir: string, out: Collector): Promise<void> {
  const names = (await listNames(dir, out.warnings)).filter((name) => name.endsWith(".json"));
  const items = await mapLimit(names, IO_LIMIT, async (name): Promise<Extension | undefined> => {
    const file = path.join(dir, name);
    const json = await readJsonObject(file, out.warnings);
    if (!json) return undefined;
    const stash = parseStash(json);
    // A file whose id is not its name - a copy made by hand - would list a second item of one id.
    if (!stash || stashFileName(stash.id) !== name) {
      out.warnings.push({ file, message: UNREADABLE });
      return undefined;
    }
    const item = stashItem(stash, file);
    if (item.stashed && (await entryInfo(stash.file)).kind !== "file") item.stashed.gone = true;
    return item;
  });
  // In name order, whichever read finished first.
  for (const item of items) if (item) out.items.push(item);
}
