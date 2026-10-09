import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { QuotaTarget } from "../../core/quota-store.js";
import type { RoutesFile } from "../../core/route-config.js";
import { RoutesFileError } from "../../core/routes-store.js";
import { stripAnsi } from "../../lib/cli-style.js";
import type { QuotaSnapshot, Registry } from "../../types.js";
import { DOWN, ESC, type Instance, press, renderAt, type, waitForFrame } from "../test-drive.js";
import { RoutesScreen, type RoutesScreenDeps } from "./RoutesScreen.js";

vi.setConfig({ testTimeout: 15_000 });

const NOW = Date.parse("2026-10-09T00:00:00.000Z");

const profile = (tool: "claude" | "codex", name: string, extra: object = {}) => ({
  tool,
  configDir: `/home/u/.${tool}-${name}`,
  email: `${name}@example.com`,
  ...extra,
});

const REGISTRY: Registry = {
  version: 2,
  primarySources: { claude: "/home/u/.claude" },
  activeProfiles: { claude: "claude:team" },
  profiles: {
    "claude:team": profile("claude", "team", { isPrimary: true }),
    "claude:work": profile("claude", "work"),
    "claude:side": profile("claude", "side"),
    "claude:old": profile("claude", "old"),
    "claude:ops-share": profile("claude", "ops-share"),
    "codex:x": profile("codex", "x"),
  },
};

/** Sorted by name: main, solo, wide. */
const FILE: RoutesFile = {
  version: 1,
  routes: {
    solo: { tool: "claude", from: ["work"], fallback: ["team"], strategy: "headroom" },
    main: {
      tool: "claude",
      from: ["*"],
      exclude: ["*-share"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    },
    wide: { tool: "all", from: ["*"] },
  },
};

/** No reset times, so no cell depends on the clock. */
const snap = (five: number, seven: number): QuotaSnapshot => ({
  state: "ok",
  fetchedAt: NOW,
  session: { usedPercent: five, resetsAt: null },
  weekly: { usedPercent: seven, resetsAt: null },
});

const QUOTAS: Record<string, QuotaSnapshot> = {
  "claude:team": snap(5, 22),
  "claude:work": snap(12, 34),
  "claude:side": snap(88, 40),
  "claude:old": { state: "missing", fetchedAt: NOW },
  "claude:ops-share": snap(0, 64),
  "codex:x": snap(30, 10),
};

type Collect = RoutesScreenDeps["collectQuotas"];

function setup(options: { file?: RoutesFile; collect?: Collect; readError?: Error; columns?: number } = {}) {
  let current: RoutesFile = structuredClone(options.file ?? FILE);
  const deps = {
    loadRegistry: vi.fn(async () => REGISTRY),
    readRoutes: vi.fn(async () => {
      if (options.readError) throw options.readError;
      return structuredClone(current);
    }),
    updateRoutes: vi.fn<RoutesScreenDeps["updateRoutes"]>(async (update) => {
      const next = update(structuredClone(current));
      if (next) current = next;
      return structuredClone(current);
    }),
    collectQuotas: vi.fn<Collect>(options.collect ?? (async () => QUOTAS)),
    readPicks: vi.fn(async () => ({})),
    clock: () => NOW,
  } satisfies RoutesScreenDeps;
  const onExit = vi.fn();
  const tree = <RoutesScreen deps={deps} onExit={onExit} />;
  const instance: Instance = options.columns ? renderAt(tree, options.columns) : render(tree);
  return { deps, onExit, instance, file: () => current };
}

const text = (instance: Instance) => stripAnsi(instance.lastFrame() ?? "");
const until = (instance: Instance, check: (frame: string) => boolean) => waitForFrame(() => text(instance), check);
const lines = (frame: string) => frame.split("\n");

/** Waits until every route is ranked: the next pick of the first route is marked. */
const ranked = (instance: Instance) => until(instance, (f) => /next/.test(f) && !f.includes("loading…"));

/**
 * At 100 columns: the list pane's rows, between its borders, and the detail pane's lines, to the
 * right of it down to the footer's rule.
 */
function panes(frame: string): { list: string[]; detail: string[] } {
  const all = lines(frame);
  const top = all.findIndex((line) => line.includes("╭"));
  const bottom = all.findIndex((line) => line.includes("╰"));
  const left = all[top].indexOf("╭");
  const right = all[top].indexOf("╮");
  const footer = all.findIndex((line, i) => i > top && /^\s*─{10,}/.test(line));
  return {
    list: all
      .slice(top + 1, bottom)
      .map((line) => line.slice(left + 1, right).trim())
      .filter(Boolean),
    detail: all.slice(top, footer === -1 ? undefined : footer).map((line) => line.slice(right + 1).trim()),
  };
}

/** The detail's lines as one run of words, for text that wraps inside the pane. */
const prose = (detail: string[]) => detail.join(" ").replace(/\s+/g, " ");

const row = (detail: string[], id: string) => detail.find((line) => line.includes(id)) ?? "";

const ids = (targets: QuotaTarget[]) => targets.map((target) => target.id).sort();

describe("RoutesScreen", () => {
  it("paints the list at once, with loading rows until the quota arrives", async () => {
    let release: (quotas: Record<string, QuotaSnapshot>) => void = () => {};
    const { instance, deps } = setup({
      collect: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    const before = await until(instance, (f) => f.includes("loading…"));
    const { list, detail } = panes(before);
    expect(list[0]).toMatch(/^▸ main\s+claude\s+…\/4$/);
    expect(row(detail, "claude:team")).toContain("loading…");
    expect(row(detail, "claude:team")).not.toContain("▸");

    release(QUOTAS);
    const after = await ranked(instance);
    expect(row(panes(after).detail, "claude:team")).toMatch(/▸ claude:team.*next/);
    expect(deps.loadRegistry).toHaveBeenCalledTimes(1);
  });

  it("ranks every route from one quota read, without refreshing, and records no pick", async () => {
    const { instance, deps } = setup();
    await ranked(instance);

    expect(deps.collectQuotas).toHaveBeenCalledTimes(1);
    const [targets, options] = deps.collectQuotas.mock.calls[0];
    // The union of every route's members: main leaves ops-share out, wide takes it and codex:x.
    expect(ids(targets)).toEqual([
      "claude:old",
      "claude:ops-share",
      "claude:side",
      "claude:team",
      "claude:work",
      "codex:x",
    ]);
    expect(options?.refresh).not.toBe(true);
    expect(deps.readPicks).toHaveBeenCalled();
    expect(deps.updateRoutes).not.toHaveBeenCalled();
  });

  it("lists each route with its tool and how many of its accounts are free now", async () => {
    const { instance } = setup();
    const { list } = panes(await ranked(instance));

    expect(list).toEqual([
      expect.stringMatching(/^▸ main\s+claude\s+2\/4$/),
      expect.stringMatching(/^solo\s+claude\s+2\/2$/),
      expect.stringMatching(/^wide\s+all\s+4\/6$/),
    ]);
  });

  it("moves the selection with the arrows, and shows the selected route", async () => {
    const { instance } = setup();
    await ranked(instance);

    await press(instance, DOWN);
    const { list, detail } = panes(text(instance));
    expect(list[1]).toMatch(/^▸ solo/);
    expect(list[0]).toMatch(/^main/);
    expect(detail.find(Boolean)).toBe("solo");
    expect(detail).toContain("claude · headroom · skip at 80%, reserve to 95%");
    expect(detail).toContain("Accounts  work");
    expect(detail).toContain("Fallback  team");
    expect(row(detail, "claude:team")).toContain("claude:team (fallback)");

    await press(instance, "\u001B[A");
    expect(panes(text(instance)).list[0]).toMatch(/^▸ main/);
  });

  it("shows the route's settings, its members with their quota and status, and who is excluded", async () => {
    const { instance } = setup();
    const { detail } = panes(await ranked(instance));

    expect(detail.find(Boolean)).toBe("main");
    expect(detail).toContain("claude · round-robin · skip at 80%, reserve to 95%");
    expect(detail).toContain("Accounts  * except *-share");
    expect(detail).toContain("Fallback  none");
    expect(row(detail, "ACCOUNT")).toMatch(/ACCOUNT\s+5H\s+7D/);
    expect(row(detail, "claude:team")).toMatch(/^▸ claude:team\s.*5%.*22%\s+next$/);
    expect(row(detail, "claude:work")).toMatch(/^claude:work\s.*12%.*34%$/);
    expect(row(detail, "claude:side")).toMatch(/^claude:side\s.*88%.*40%\s+over 80%$/);
    expect(row(detail, "claude:old")).toMatch(/^claude:old\s+signed out$/);
    expect(detail).toContain("excluded  claude:ops-share (*-share)");
    // The next pick first, then by usage, then the skipped: as `csn route explain` orders them.
    const order = ["claude:team", "claude:work", "claude:side", "claude:old"].map((id) =>
      detail.findIndex((line) => line.includes(id)),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("explains routes, and how to make one, when there are none", async () => {
    const { instance } = setup({ file: { version: 1, routes: {} } });
    const frame = await until(instance, (f) => f.includes("Press n"));
    const detail = prose(panes(frame).detail);

    expect(detail).toContain(
      "A route picks the account for you: the next one in turn that is under 80% of its 5-hour and weekly limits.",
    );
    expect(detail).toContain("Press n to create your first route.");
  });

  // Review Focus 5: a hand-edited routes.json that does not check out.
  it("shows what is wrong with routes.json and where to fix it, and answers only esc", async () => {
    const error = new RoutesFileError("/home/u/.clausona/routes.json", [
      "routes.main.maxUsage: must be a number from 1 to 100",
    ]);
    const { instance, deps, onExit } = setup({ readError: error });
    const frame = await until(instance, (f) => f.includes("Fix it with"));

    expect(frame).toContain("/home/u/.clausona/routes.json cannot be used");
    expect(frame).toContain("routes.main.maxUsage: must be a number from 1 to 100");
    expect(frame).toContain("Fix it with csn route edit.");

    for (const key of ["d", "y", "r", "n", "e", DOWN, "\r"]) await type(instance, key);
    expect(text(instance)).toBe(frame);
    expect(deps.collectQuotas).not.toHaveBeenCalled();
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    await type(instance, ESC);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  // Review Focus 2: offline, or nothing readable.
  it("shows no quota reading on every member and nobody free when no quota can be read", async () => {
    const { instance } = setup({ collect: async () => ({}) });
    const frame = await until(instance, (f) => f.includes("no quota reading"));
    const { list, detail } = panes(frame);

    expect(list).toEqual([
      expect.stringMatching(/^▸ main\s+claude\s+0\/4$/),
      expect.stringMatching(/^solo\s+claude\s+0\/2$/),
      expect.stringMatching(/^wide\s+all\s+0\/6$/),
    ]);
    for (const id of ["claude:team", "claude:work", "claude:side", "claude:old"]) {
      expect(row(detail, id)).toMatch(new RegExp(`^${id}\\s+no quota reading$`));
    }
    expect(frame).not.toContain("▸ claude:");
  });

  it("does not throw when the quota read fails", async () => {
    const { instance } = setup({
      collect: async () => {
        throw new Error("offline");
      },
    });
    const frame = await until(instance, (f) => f.includes("no quota reading"));

    expect(panes(frame).list[0]).toMatch(/0\/4$/);
  });

  it("reads the quota again on r, refreshing it", async () => {
    const { instance, deps } = setup();
    await ranked(instance);

    await type(instance, "r");
    await vi.waitFor(() => expect(deps.collectQuotas).toHaveBeenCalledTimes(2));
    const [targets, options] = deps.collectQuotas.mock.calls[1];
    expect(ids(targets)).toEqual(ids(deps.collectQuotas.mock.calls[0][0]));
    expect(options).toEqual({ refresh: true });
  });

  it("asks before removing a route, removes it on y, and keeps the selection in the list", async () => {
    const { instance, deps, file } = setup();
    await ranked(instance);
    await press(instance, DOWN);
    await press(instance, DOWN);

    await press(instance, "d");
    expect(text(instance)).toContain("Remove route wide? (y/N)");

    await press(instance, "y");
    const frame = await until(instance, (f) => !f.includes("wide") && !f.includes("(y/N)"));
    expect(deps.updateRoutes).toHaveBeenCalledTimes(1);
    expect(Object.keys(file().routes).sort()).toEqual(["main", "solo"]);
    const { list, detail } = panes(frame);
    expect(list).toEqual([expect.stringMatching(/^main/), expect.stringMatching(/^▸ solo/)]);
    expect(detail.find(Boolean)).toBe("solo");
  });

  it.each([
    ["n", "n"],
    ["esc", ESC],
    ["enter", "\r"],
  ])("removes nothing when the question is answered with %s", async (_name, key) => {
    const { instance, deps, onExit } = setup();
    await ranked(instance);

    await press(instance, "d");
    expect(text(instance)).toContain("Remove route main? (y/N)");
    await press(instance, key);

    expect(text(instance)).not.toContain("(y/N)");
    expect(panes(text(instance)).list).toHaveLength(3);
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("goes back on esc", async () => {
    const { instance, onExit } = setup();
    await ranked(instance);

    await type(instance, ESC);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  it("names every key it answers in its hints", async () => {
    const { instance } = setup();
    const frame = await ranked(instance);

    for (const hint of ["↑↓ move", "n new", "e edit", "d delete", "r refresh", "esc back"]) {
      expect(frame).toContain(hint);
    }
  });

  it("puts the panes side by side at 100 columns, the list 30 wide", async () => {
    const { instance } = setup({ columns: 100 });
    const frame = await ranked(instance);
    const top = lines(frame).find((line) => line.includes("╭")) ?? "";

    expect(top.indexOf("╮") - top.indexOf("╭") + 1).toBe(30);
    // The detail starts level with the list's top border, and its lines sit beside the list's.
    expect(top).toMatch(/╮\s+main$/);
    expect(lines(frame).find((line) => line.includes("Accounts"))).toMatch(/│.*Accounts/);
  });

  it("stacks the detail under the list below 100 columns, without wrapping a row", async () => {
    const { instance } = setup({ columns: 80 });
    const frame = await ranked(instance);
    const all = lines(frame);
    const bottom = all.findIndex((line) => line.includes("╰"));
    const accounts = all.findIndex((line) => line.includes("Accounts"));

    expect(accounts).toBeGreaterThan(bottom);
    expect(all[accounts]).not.toContain("│");
    expect(all.find((line) => line.includes("claude:side"))).toMatch(/claude:side\s.*88%.*40%\s+over 80%/);
    for (const line of all) expect(line.length).toBeLessThanOrEqual(80);
  });
});
