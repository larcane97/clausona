import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changeNotices } from "./notices.js";
import { claimStarPrompt } from "./star.js";
import { recordLatestTag } from "./update.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-01T09:00:00.000Z");

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clausona-notices-"));
  file = path.join(dir, "notices.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stored = async () => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("changeNotices", () => {
  // The dashboard claims the star while its update check records the tag; a command's question
  // waits for its answer while the background check writes.
  it("keeps every change made at the same time", async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `key${i}`);

    const results = await Promise.all(keys.map((key) => changeNotices(file, (notices) => ({ ...notices, [key]: 1 }))));

    expect(results).toEqual(keys.map(() => true));
    expect(Object.keys(await stored()).sort()).toEqual(keys);
  });

  it("keeps the star's asking when the dashboard's check records a tag at the same time", async () => {
    await writeFile(file, JSON.stringify({ firstUsedAt: new Date(START).toISOString() }));
    const deps = { path: file, now: () => START + 4 * DAY, env: {} };

    const [asked] = await Promise.all([claimStarPrompt(deps), recordLatestTag(deps, "v9.0.0")]);

    expect(asked).toBe(true);
    expect(await stored()).toMatchObject({ starAsked: true, latestTag: "v9.0.0" });
  });

  it("leaves the file alone when the change gives nothing to write", async () => {
    await writeFile(file, "{}");

    expect(await changeNotices(file, () => null)).toBe(false);
    expect(await readFile(file, "utf8")).toBe("{}");
  });
});
