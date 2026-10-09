import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detailsOf, tagsOf } from "../describe.js";
import { loadInventory } from "../inventory.js";
import { type Collector, type Extension, emptyFacts, type Inventory } from "../model.js";
import { samePath } from "../read.js";
import { rowsIn, type ScopeRow } from "../scopes.js";
import { type StashFile, stashFileName, stashIdFor, stashText } from "../stash.js";
import { claudeMcpTaken, stateOf } from "../state.js";
import { TestHome } from "../test-home.js";
import { readStash } from "./stash.js";

const DAY = 86_400_000;
const NOW = Date.now() + DAY;
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const STASH = path.join(".clausona", "extensions", "stash");

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

/** Two Claude accounts that have opened app; the default one has a live stitch. */
function seed() {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", { projects: { [app]: {} }, mcpServers: { stitch: { command: "stitch" } } });
  const work = h.claude("work", ".claude-work", { projects: { [app]: {} } });
  h.write(".claude/settings.json", {});
  return { h, app, work };
}

/** A stash file as clausona writes one, in the home's stash dir; returns its path. */
function stashed(h: TestHome, stash: Omit<StashFile, "version" | "id" | "stashedAt">, itemId: string): string {
  const id = stashIdFor(itemId, NOW);
  const file: StashFile = { version: 1, id, ...stash, stashedAt: new Date(NOW).toISOString() };
  return h.write(path.join(STASH, stashFileName(id)), stashText(file));
}

async function load(h: TestHome, app: string): Promise<Inventory> {
  return loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd: app,
    managedSettings: h.path("no-managed.json"),
  });
}

function rowNamed(rows: ScopeRow[], name: string): ScopeRow {
  const found = rows.filter((r) => r.name === name);
  expect(found).toHaveLength(1);
  return found[0] as ScopeRow;
}

/** The text of the lines from the one labelled `label` up to the next labelled one. */
function linesUnder(lines: { label?: string; text: string }[], label: string): string[] {
  const at = lines.findIndex((l) => l.label === label);
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && l.label !== "" && l.label !== undefined);
  return lines.slice(at, end < 0 ? undefined : end).map((l) => l.text);
}

describe("readStash", () => {
  it("lists an account's server taken out to turn it off everywhere in that account's row, off", async () => {
    const { h, app, work } = seed();
    const itemId = "mcp:claude:account:claude:work:stitch";
    const stashPath = stashed(
      h,
      {
        kind: "mcp",
        tool: "claude",
        name: "stitch",
        file: work.jsonPath,
        path: ["mcpServers", "stitch"],
        scope: "account",
        profile: "claude:work",
        entry: { command: "stitch", env: { TOKEN: KEY } },
      },
      itemId,
    );
    const id = stashIdFor(itemId, NOW);
    const inv = await load(h, app);

    const item = inv.items.find((i) => i.id === `mcp:claude:account:stash-${id}:stitch`) as Extension;
    expect(item).toBeDefined();
    expect(item.location.profile).toBe("claude:work");
    expect(samePath(item.location.file, work.jsonPath)).toBe(true);
    expect(item.stashed).toEqual({ file: stashPath, id, at: NOW });
    expect(stateOf(inv, item, app)).toEqual({ value: "off", setBy: { file: stashPath, key: "stash" } });

    const row = rowNamed(rowsIn(inv, "claude", "mcp", "global", app, NOW), "stitch");
    expect(row.items.map((i) => i.location.profile)).toEqual(["claude:default", "claude:work"]);
    expect(tagsOf(inv, row, app, NOW)).toEqual(["off in 1 of 2 accounts"]);
    const details = detailsOf(inv, row, app, NOW);
    expect(linesUnder(details, "Accounts")).toEqual([
      "default  on",
      `${"work".padEnd("default".length)}  off everywhere (kept by clausona)`,
    ]);
    // Nothing the screen or the CLI says names where clausona keeps it.
    expect(JSON.stringify(details)).not.toMatch(/stash/i);
    expect(JSON.stringify(inv)).not.toContain(KEY);
    expect(inv.warnings).toEqual([]);
  });

  it("lists a user-settings hook taken out as off in Global, saying clausona keeps it", async () => {
    const { h, app } = seed();
    stashed(
      h,
      {
        kind: "hook",
        tool: "claude",
        name: "Stop",
        file: h.path(".claude", "settings.json"),
        path: ["hooks", "Stop"],
        scope: "global",
        hook: { base: "hooks", event: "Stop", group: 0, index: 0 },
        entry: { type: "command", command: "notify-send done" },
      },
      "hook:claude:global:user:settings:Stop#0.0",
    );
    const inv = await load(h, app);

    const row = rowNamed(rowsIn(inv, "claude", "hook", "global", app, NOW), "Stop");
    expect(row.items[0]?.hook).toEqual({ base: "hooks", event: "Stop", group: 0, index: 0 });
    expect(tagsOf(inv, row, app, NOW)).toEqual(["off"]);
    expect(detailsOf(inv, row, app, NOW).find((l) => l.label === "Loaded")).toEqual({
      label: "Loaded",
      text: "off everywhere — clausona keeps its settings so you can turn it back on",
      tone: "warning",
    });
    expect(rowsIn(inv, "claude", "hook", "loaded", app, NOW)).toEqual([]);
  });

  it("hides nothing with a copy Claude Code no longer sees", async () => {
    const { h, app, work } = seed();
    // work's own local pg for app is taken out; app's .mcp.json pg, which work approves, is what work starts.
    h.write(".claude-work/.claude.json", { projects: { [app]: { enabledMcpjsonServers: ["pg"] } } });
    h.write("repos/app/.mcp.json", { mcpServers: { pg: { command: "pg" } } });
    stashed(
      h,
      {
        kind: "mcp",
        tool: "claude",
        name: "pg",
        file: work.jsonPath,
        path: ["projects", app, "mcpServers", "pg"],
        scope: "local",
        profile: "claude:work",
        project: app,
        entry: { command: "pg-local" },
      },
      `mcp:claude:local:claude:work@${app}:pg`,
    );
    const inv = await load(h, app);

    const mcpjson = inv.items.find((i) => i.name === "pg" && i.location.scope === "project") as Extension;
    expect(claudeMcpTaken(inv, "pg", app, "claude:work")).toBe(mcpjson);
    expect(stateOf(inv, mcpjson, app, "claude:work")).toEqual({
      value: "on",
      setBy: { file: work.jsonPath, key: "enabledMcpjsonServers" },
    });
    const local = rowNamed(
      rowsIn(inv, "claude", "mcp", "project", app, NOW).filter((r) => r.items[0]?.stashed),
      "pg",
    );
    expect(local.items[0]?.location.project).toBe(app);
    expect(tagsOf(inv, local, app, NOW)).toEqual(["off"]);
  });

  it("says which files it cannot read and skips what is no stash file", async () => {
    const h = new TestHome();
    homes.push(h);
    const dir = h.path(STASH);
    const broken = h.write(path.join(STASH, "broken.json"), "{ broken");
    const other = h.write(path.join(STASH, "v2.json"), { version: 2 });
    h.write(path.join(STASH, "notes.txt"), "not a stash file");
    h.write(path.join(STASH, ".partial.json"), "{ half");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    await readStash(dir, out);

    expect(out.items).toEqual([]);
    // The files are read side by side, so their warnings come in any order; loadInventory sorts them.
    const warnings = [...out.warnings].sort((a, b) => a.file.localeCompare(b.file));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.file).toBe(broken);
    expect(warnings[0]?.message).toMatch(/^is not valid JSON at /);
    expect(warnings[1]).toEqual({ file: other, message: "is not a file clausona can read back" });
  });

  it("skips a file whose id is not its name, so ids stay unique", async () => {
    const { h, app, work } = seed();
    const stash = {
      kind: "mcp" as const,
      tool: "claude" as const,
      name: "stitch",
      file: work.jsonPath,
      path: ["mcpServers", "stitch"],
      scope: "account" as const,
      profile: "claude:work",
      entry: { command: "stitch" },
    };
    const original = stashed(h, stash, "mcp:claude:account:claude:work:stitch");
    const copy = h.write(path.join(STASH, "copy.json"), readFileSync(original, "utf8"));
    const inv = await load(h, app);

    expect(inv.items.filter((i) => i.stashed).map((i) => i.stashed?.file)).toEqual([original]);
    expect(inv.warnings).toEqual([{ file: copy, message: "is not a file clausona can read back" }]);
  });

  it("reads nothing, and says nothing, when there is no stash dir", async () => {
    const h = new TestHome();
    homes.push(h);
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    await readStash(h.path(STASH), out);
    expect(out).toEqual({ items: [], facts: emptyFacts(), warnings: [] });

    const { h: seeded, app } = seed();
    expect((await load(seeded, app)).warnings).toEqual([]);
  });

  it("marks a copy whose file is gone", async () => {
    const { h, app } = seed();
    stashed(
      h,
      {
        kind: "mcp",
        tool: "claude",
        name: "stitch",
        file: h.path(".claude-gone", ".claude.json"),
        path: ["mcpServers", "stitch"],
        scope: "account",
        profile: "claude:gone",
        entry: { command: "stitch" },
      },
      "mcp:claude:account:claude:gone:stitch",
    );
    const inv = await load(h, app);
    const item = inv.items.find((i) => i.stashed) as Extension;
    expect(item.stashed?.gone).toBe(true);
    expect(stateOf(inv, item, app).value).toBe("off");
  });
});
