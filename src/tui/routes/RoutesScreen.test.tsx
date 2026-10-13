import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { QuotaTarget } from "../../core/quota-store.js";
import type { BrokenRoute, RoutesFile } from "../../core/route-config.js";
import type { PathSystem } from "../../core/route-rules.js";
import { RoutesFileError } from "../../core/routes-store.js";
import { stripAnsi } from "../../lib/cli-style.js";
import type { QuotaSnapshot, Registry, ScopedQuotaWindow } from "../../types.js";
import { DOWN, ENTER, ESC, type Instance, press, renderAt, type, typeSlowly, waitForFrame } from "../test-drive.js";
import { RoutesScreen } from "./RoutesScreen.js";
import type { RoutesListDeps, RoutesScreenDeps } from "./routes-deps.js";

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

function setup(
  options: {
    file?: RoutesFile;
    collect?: Collect;
    readError?: Error;
    /** Routes routes.json holds that cannot be used, set apart from `file`. */
    broken?: BrokenRoute[];
    columns?: number;
    rows?: number;
    /** profiles.json as `loadRegistry` reads it, and why it cannot be used when it reads as none. */
    registry?: { loads: Registry | null; problem: string | null };
  } = {},
) {
  let current: RoutesFile = structuredClone(options.file ?? FILE);
  const deps = {
    loadRegistry: vi.fn(async () => (options.registry ? options.registry.loads : REGISTRY)),
    registryProblem: vi.fn(async (): Promise<string | null> => options.registry?.problem ?? null),
    loadRoutes: vi.fn(async () => {
      if (options.readError) throw options.readError;
      return {
        filePath: "/home/u/.clausona/routes.json",
        file: structuredClone(current),
        broken: options.broken ?? [],
      };
    }),
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
    // Read as on Linux, every directory there and its own real path, so the paths below hold anywhere.
    cwd: "/home/u/work/app",
    system: { platform: "linux", home: "/home/u", realpath: (p: string) => p } satisfies PathSystem,
  } satisfies RoutesListDeps;
  const onExit = vi.fn();
  const tree = <RoutesScreen deps={deps} onExit={onExit} />;
  const instance: Instance = options.columns
    ? renderAt(tree, options.columns, options.rows === undefined ? {} : { rows: options.rows })
    : render(tree);
  return {
    deps,
    onExit,
    instance,
    file: () => current,
    /** routes.json changed by another terminal. */
    replace: (file: RoutesFile) => {
      current = structuredClone(file);
    },
  };
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

/** The lines between the header's rule and the footer's, trimmed, blank ones left out. */
function body(frame: string): string[] {
  const all = lines(frame);
  const rules = all.flatMap((line, i) => (/^\s*─{10,}\s*$/.test(line) ? [i] : []));
  return all
    .slice(rules[0] + 1, rules[1])
    .map((line) => line.trim())
    .filter(Boolean);
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
    expect(detail).toContain("claude · headroom · skip at 80%");
    expect(detail.join("\n")).not.toContain("reserve");
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
    expect(detail).toContain("claude · round-robin · skip at 80%");
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

  it("never reads the cut for a member under it", async () => {
    const near = { ...QUOTAS, "claude:team": snap(5, 79.6), "claude:work": snap(80, 34) };
    const { instance } = setup({ collect: async () => near });
    const { detail } = panes(await ranked(instance));
    expect(row(detail, "claude:team")).toMatch(/^▸ claude:team\s.*5%.*79%\s+next$/);
    expect(row(detail, "claude:work")).toMatch(/^claude:work\s.*80%.*34%\s+over 80%$/);
  });

  it("says at 100% for a member no stage can pick", async () => {
    const full = { ...QUOTAS, "claude:work": snap(100, 34) };
    const { instance } = setup({ collect: async () => full });
    const { detail } = panes(await ranked(instance));
    expect(row(detail, "claude:work")).toMatch(/^claude:work\s.*100%.*34%\s+at 100%$/);
    expect(row(detail, "claude:side")).toMatch(/^claude:side\s.*88%.*40%\s+over 80%$/);
  });

  it("explains routes, the route n would make, and n, in one column when there are none", async () => {
    for (const columns of [80, 120]) {
      const { instance } = setup({ file: { version: 1, routes: {} }, columns });
      const frame = await until(instance, (f) => f.includes("Press n"));

      expect(body(frame), `${columns}`).toEqual([
        "No routes yet",
        "A route picks an account for each run, so",
        "you don't have to. Run on one with:",
        "clausona run --route <name>",
        "A new route, unless you change it:",
        "Accounts  all 5 Claude accounts",
        "Order     the next one in turn",
        "Skip at   80% of the 5-hour or weekly limit",
        "Press n to create one.",
      ]);
      instance.unmount();
    }
  });

  it("counts the accounts a new route would take, API profiles not among them", async () => {
    const one: Registry = {
      ...REGISTRY,
      profiles: {
        "claude:solo": profile("claude", "solo"),
        "claude:glm": profile("claude", "glm", { kind: "api" }),
        "codex:x": profile("codex", "x"),
      },
    };
    const single = setup({ file: { version: 1, routes: {} }, registry: { loads: one, problem: null } });
    expect(body(await until(single.instance, (f) => f.includes("Press n")))).toContain(
      "Accounts  your one Claude account",
    );
    single.instance.unmount();

    const none = setup({ file: { version: 1, routes: {} }, registry: { loads: null, problem: null } });
    expect(body(await until(none.instance, (f) => f.includes("Press n")))).toContain(
      "Accounts  every Claude account (none yet)",
    );
  });

  it("hints only the keys that do something while there are no routes", async () => {
    const { instance } = setup({ file: { version: 1, routes: {} } });
    const frame = await until(instance, (f) => f.includes("Press n"));

    expect(frame).toContain("n new");
    expect(frame).toContain("esc back");
    for (const hint of ["↑↓ move", "e edit", "d delete", "r refresh"]) expect(frame).not.toContain(hint);
  });

  it("leaves the keys it does not hint unanswered while there are no routes", async () => {
    const { instance, deps } = setup({ file: { version: 1, routes: {} } });
    const frame = await until(instance, (f) => f.includes("Press n"));
    const reads = deps.collectQuotas.mock.calls.length;

    for (const key of ["r", "e", "d", DOWN]) await type(instance, key);
    expect(text(instance)).toBe(frame);
    expect(deps.collectQuotas).toHaveBeenCalledTimes(reads);
  });

  // A hand-edited routes.json that does not check out.
  it("shows what is wrong with routes.json and where to fix it, and answers only esc", async () => {
    const error = new RoutesFileError("/home/u/.clausona/routes.json", [
      "routes.main.maxUsage: must be a number from 1 to 100",
    ]);
    const { instance, deps, onExit } = setup({ readError: error });
    const frame = await until(instance, (f) => f.includes("Fix it with"));

    expect(frame).toContain("/home/u/.clausona/routes.json cannot be used");
    expect(frame).toContain("routes.main.maxUsage: must be a number from 1 to 100");
    expect(frame).toContain("Fix it with clausona route edit.");

    for (const key of ["d", "y", "r", "n", "e", DOWN, "\r"]) await type(instance, key);
    expect(text(instance)).toBe(frame);
    expect(deps.collectQuotas).not.toHaveBeenCalled();
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    await type(instance, ESC);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  // One route's problem must not take the screen down: the others work, and one line says so.
  it("lists the routes that can be used, and says in one line that one cannot and where to see why", async () => {
    const broken: BrokenRoute[] = [
      { name: "bad", spec: { tool: "x" }, problems: ['routes.bad.tool: must be "claude", "codex" or "all"'] },
    ];
    const { instance } = setup({ broken });
    const frame = await ranked(instance);
    const { list } = panes(frame);
    expect(list).toHaveLength(3);
    expect(list.some((line) => line.includes("bad"))).toBe(false);
    expect(frame).toContain("⚠ routes.json has a route that cannot be used: clausona route list says why.");
  });

  // A typo in an exclude leaves in the account it was meant to leave out, so it is pointed out.
  it("points out an exclude that matches nobody, as route explain does", async () => {
    const file: RoutesFile = { version: 1, routes: { main: { tool: "claude", exclude: ["persnal"] } } };
    const { instance } = setup({ file });
    const { detail } = panes(await ranked(instance));
    expect(detail).toContain("persnal           excludes nobody");
  });

  // Offline, or nothing readable. Nothing read says nothing about who is free: a dash, as
  // `clausona route list` prints, not 0.
  it("shows no quota reading on every member and a dash for who is free when no quota can be read", async () => {
    const { instance } = setup({ collect: async () => ({}) });
    const frame = await until(instance, (f) => f.includes("no quota reading"));
    const { list, detail } = panes(frame);

    expect(list).toEqual([
      expect.stringMatching(/^▸ main\s+claude\s+—\/4$/),
      expect.stringMatching(/^solo\s+claude\s+—\/2$/),
      expect.stringMatching(/^wide\s+all\s+—\/6$/),
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

    expect(panes(frame).list[0]).toMatch(/—\/4$/);
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

  // Another window removed it first: nothing is written, so the routes that cannot be used are still there.
  it("keeps the notice of a route that cannot be used when the route removed was already gone", async () => {
    const broken: BrokenRoute[] = [
      { name: "bad", spec: { tool: "x" }, problems: ['routes.bad.tool: must be "claude", "codex" or "all"'] },
    ];
    const { instance, replace } = setup({ broken });
    await ranked(instance);
    const { main: _gone, ...others } = FILE.routes;
    replace({ version: 1, routes: others });

    await press(instance, "d");
    await press(instance, "y");
    const frame = await until(instance, (f) => panes(f).list.length === 2 && !f.includes("(y/N)"));
    expect(frame).toContain("⚠ routes.json has a route that cannot be used: clausona route list says why.");
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

  // Everyone at the cut or over it: the one with the most left is next, and says why.
  it("says when the next pick is the one with the most left, within 80 columns", async () => {
    const busy = { ...QUOTAS, "claude:team": snap(85, 22), "claude:work": snap(12, 97) };
    const { instance } = setup({ columns: 80, collect: async () => busy });
    const all = lines(await ranked(instance));
    expect(all.find((line) => line.includes("claude:team"))).toMatch(
      /▸ claude:team\s.*85%.*22%\s+next \(most room left\)$/,
    );
    expect(all.find((line) => line.includes("claude:work"))).toMatch(/claude:work\s.*12%.*97%\s+over 80%$/);
    for (const line of all) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("opens a new route form on n, and lists and selects the route it saves", async () => {
    const { instance, file } = setup();
    await ranked(instance);

    await press(instance, "n");
    await until(instance, (f) => f.includes("New route"));
    await press(instance, "daily");
    await type(instance, ENTER);

    const frame = await until(instance, (f) => /▸ daily/.test(f) && !f.includes("New route"));
    expect(file().routes.daily).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
    });
    const { list, detail } = panes(frame);
    expect(list.map((line) => line.split(/\s+/).filter((word) => word !== "▸")[0])).toEqual([
      "daily",
      "main",
      "solo",
      "wide",
    ]);
    expect(detail.find(Boolean)).toBe("daily");
  });

  it("opens the selected route on e, and goes back to the list on esc", async () => {
    const { instance, deps, onExit } = setup();
    await ranked(instance);
    await press(instance, DOWN);

    await press(instance, "e");
    const form = await until(instance, (f) => f.includes("Edit solo"));
    expect(form).toMatch(/Name\s+solo/);
    expect(form).toMatch(/\[x\] claude:work/);

    await type(instance, ESC);
    const frame = await until(instance, (f) => !f.includes("Edit solo"));
    expect(panes(frame).list[1]).toMatch(/^▸ solo/);
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("reads the quota of the accounts no route takes yet when the form opens", async () => {
    const { instance, deps } = setup({ file: { version: 1, routes: { solo: FILE.routes.solo } } });
    await ranked(instance);
    expect(ids(deps.collectQuotas.mock.calls[0][0])).toEqual(["claude:team", "claude:work"]);

    await press(instance, "n");
    await vi.waitFor(() => expect(deps.collectQuotas).toHaveBeenCalledTimes(2));
    const [targets, options] = deps.collectQuotas.mock.calls[1];
    expect(ids(targets)).toEqual(["claude:old", "claude:ops-share", "claude:side", "codex:x"]);
    expect(options?.refresh).not.toBe(true);
    const frame = await until(instance, (f) => /claude:side\s+88%\s+40%/.test(f));
    expect(frame).toContain("Now: 3 of 5 accounts under 80% · next claude:team");
  });

  // I1: profiles.json that cannot be read loads as no registry at all.
  it("shows why profiles.json cannot be used, and answers only esc", async () => {
    const problem =
      "~/.clausona/profiles.json could not be read: it is not valid JSON. Fix it by hand, or move it aside and run 'clausona init' to set clausona up again.";
    const { instance, deps, onExit } = setup({ registry: { loads: null, problem } });
    const frame = await until(instance, (f) => f.includes("could not be read"));

    expect(prose(lines(frame))).toContain(problem);
    expect(frame).not.toContain("0/0");
    for (const key of ["n", "e", "d", "y", "r", DOWN, "\r"]) await type(instance, key);
    expect(text(instance)).toBe(frame);
    expect(deps.collectQuotas).not.toHaveBeenCalled();
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    await type(instance, ESC);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  it("asks why profiles.json reads as nothing only when it does", async () => {
    const { instance, deps } = setup();
    await ranked(instance);

    expect(deps.registryProblem).not.toHaveBeenCalled();
  });

  it("lands in the empty state when the only route is deleted", async () => {
    const { instance, file } = setup({ file: { version: 1, routes: { solo: FILE.routes.solo } } });
    await ranked(instance);

    await press(instance, "d");
    await press(instance, "y");
    const frame = await until(instance, (f) => f.includes("No routes yet"));
    expect(body(frame)).toContain("Press n to create one.");
    expect(file().routes).toEqual({});
  });

  it("says why a delete failed, and keeps the route", async () => {
    const { instance, deps, file } = setup();
    await ranked(instance);
    deps.updateRoutes.mockRejectedValueOnce(new Error("Timed out waiting for another clausona process."));

    await press(instance, "d");
    await press(instance, "y");
    const frame = await until(instance, (f) => f.includes("Timed out"));
    expect(frame).toContain("✘ Timed out waiting for another clausona process.");
    expect(panes(frame).list).toHaveLength(3);
    expect(Object.keys(file().routes)).toHaveLength(3);
  });

  // M4: the form found its route changed and reloaded it; the list behind it must be read again too.
  it("shows routes.json as it is now after a form that found it changed is left", async () => {
    const { instance, replace } = setup();
    await ranked(instance);
    await press(instance, DOWN);
    await press(instance, "e");
    await until(instance, (f) => f.includes("Edit solo"));
    replace({
      ...FILE,
      routes: { ...FILE.routes, solo: { ...FILE.routes.solo, maxUsage: 70 }, other: { tool: "codex" } },
    });

    await type(instance, ENTER);
    await until(instance, (f) => f.includes("changed in another window"));
    await type(instance, ESC);

    const frame = await until(instance, (f) => !f.includes("Edit solo") && /other/.test(f));
    expect(panes(frame).list.map((line) => line.split(/\s+/).filter((word) => word !== "▸")[0])).toEqual([
      "main",
      "other",
      "solo",
      "wide",
    ]);
    // Still on the route the form was opened on.
    expect(panes(frame).detail.find(Boolean)).toBe("solo");
  });
});

describe("dir rules and defaults", () => {
  const TAB = "\t";
  const RIGHT = "\u001B[C";
  const RULES: RoutesFile = {
    ...FILE,
    dirs: { "~/work": { claude: "main", codex: "gone" } },
    defaults: { claude: "solo" },
  };

  it("lists them on tab, with a rule whose route is gone pointed out, and goes back on tab", async () => {
    const { instance } = setup({ file: RULES });
    expect(await ranked(instance)).toContain("⚠ A dir rule or default needs a look: tab shows it.");

    await press(instance, TAB);
    const frame = text(instance);
    expect(frame).toContain("Dir rules");
    expect(frame).toMatch(/DIRECTORY\s+CLAUDE\s+CODEX/);
    expect(frame).toMatch(/▸ ~\/work\s+main\s+gone/);
    expect(frame).toMatch(/default\s+solo\s+—/);
    expect(frame).toContain("⚠ ~/work names route 'gone' for codex, which does not exist.");
    for (const hint of ["n new", "e edit", "d clear", "tab routes", "esc back"]) expect(frame).toContain(hint);

    await press(instance, TAB);
    expect(panes(text(instance)).list).toHaveLength(3);
  });

  it("adds a dir rule from its form, the directory read from where clausona started", async () => {
    const { instance, file } = setup();
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "n");
    await until(instance, (f) => f.includes("New dir rule"));

    await typeSlowly(instance, ".");
    expect(text(instance)).toContain("In ~/work/app and below, clausona run claude or codex takes these.");
    await press(instance, TAB);
    await press(instance, RIGHT);
    await press(instance, TAB);
    await press(instance, RIGHT);
    await type(instance, ENTER);

    await until(instance, (f) => f.includes("Dir rules") && f.includes("~/work/app"));
    expect(file().dirs).toEqual({ "~/work/app": { claude: "main", codex: "wide" } });
  });

  it("adds a new rule's slot to the rule the directory has, keeping the other tool's", async () => {
    const { instance, file } = setup({ file: { ...FILE, dirs: { "~/work": { codex: "wide" } } } });
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "n");
    await typeSlowly(instance, "~/work");
    await press(instance, TAB);
    await press(instance, RIGHT);
    await type(instance, ENTER);

    await until(instance, (f) => f.includes("Dir rules") && /~\/work\s+main\s+wide/.test(f));
    expect(file().dirs).toEqual({ "~/work": { codex: "wide", claude: "main" } });
  });

  it("moves a rule onto a directory that has one, clearing nothing of that one's", async () => {
    const { instance, file } = setup({
      file: { ...FILE, dirs: { "~/oss": { claude: "solo" }, "~/work": { codex: "wide" } } },
    });
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "e");
    await until(instance, (f) => f.includes("Edit ~/oss"));
    await typeSlowly(instance, "\b\b\bwork");
    await type(instance, ENTER);

    await until(instance, (f) => f.includes("Dir rules") && !f.includes("~/oss"));
    expect(file().dirs).toEqual({ "~/work": { codex: "wide", claude: "solo" } });
  });

  it("shows a slot whose route is gone, and keeps it while the other slot changes", async () => {
    const { instance, file } = setup({
      file: { ...FILE, dirs: { "~/work": { claude: "main", codex: "gone" } }, defaults: { claude: "gone" } },
    });
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "e");
    const form = await until(instance, (f) => f.includes("Edit ~/work"));
    expect(form).toMatch(/Codex\s+○ none\s+○ wide\s+● gone \(missing\)/);

    await press(instance, TAB);
    await press(instance, RIGHT);
    await type(instance, ENTER);
    await until(instance, (f) => f.includes("Dir rules") && /~\/work\s+solo\s+gone/.test(f));
    expect(file().dirs).toEqual({ "~/work": { claude: "solo", codex: "gone" } });

    await press(instance, DOWN);
    await press(instance, "e");
    await until(instance, (f) => f.includes("Defaults"));
    await press(instance, TAB);
    await press(instance, RIGHT);
    await type(instance, ENTER);
    await until(instance, (f) => /default\s+gone\s+wide/.test(f));
    expect(file().defaults).toEqual({ claude: "gone", codex: "wide" });
  });

  const LONG = "team-shared-claude-pool-for-everyone";

  it.each([60, 50])("keeps the dir rules inside a %i-column terminal, with a long route name", async (columns) => {
    const file: RoutesFile = {
      ...FILE,
      routes: { ...FILE.routes, [LONG]: { tool: "claude" } },
      dirs: {
        "~/work": { claude: LONG, codex: "wide" },
        "~/repos/clausona/a/long/path/to/a/project": { codex: "wide" },
      },
      defaults: { claude: "main" },
    };
    const { instance } = setup({ file, columns });
    await ranked(instance);
    await press(instance, TAB);
    const frame = text(instance);

    for (const line of lines(frame)) expect(line.length, line).toBeLessThanOrEqual(columns);
    expect(frame).toMatch(/DIRECTORY\s+CLAUDE\s+CODEX/);
    expect(frame).toMatch(/▸ ~\/work\s+team-shared-\S*…\s+wide/);
    expect(frame).toMatch(/default\s+main/);
  });

  it("keeps its form one line a tool, however many routes there are", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, n) => [`route-${String(n).padStart(2, "0")}`, { tool: "claude" as const }]),
    );
    const { instance } = setup({ file: { ...FILE, routes: { ...FILE.routes, ...many } }, columns: 60, rows: 24 });
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "n");
    await press(instance, TAB);
    for (let step = 0; step < 20; step++) await press(instance, RIGHT);
    const frame = text(instance);

    expect(lines(frame).length).toBeLessThan(24);
    for (const line of lines(frame)) expect(line.length, line).toBeLessThanOrEqual(60);
    expect(frame).toMatch(/Claude\s+… ● route-18 .* …/);
  });

  it("writes no dir rule that names no route, and says so", async () => {
    const { instance, deps } = setup();
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "n");
    await typeSlowly(instance, "~/oss");
    await press(instance, ENTER);

    expect(text(instance)).toContain("✘ Choose a route for claude or codex.");
    expect(deps.updateRoutes).not.toHaveBeenCalled();
  });

  it("names the rules that go with a route it asks to remove, and removes them on y", async () => {
    const { instance, file } = setup({
      file: {
        ...RULES,
        dirs: { ...(RULES.dirs as object), "~/oss": { claude: "main" } },
        defaults: { claude: "main" },
      },
    });
    await ranked(instance);

    await press(instance, "d");
    expect(text(instance)).toContain("Remove route main, the 2 dir rules and the claude default that name it? (y/N)");
    await press(instance, "y");
    await until(instance, (f) => panes(f).list.length === 2 && !f.includes("(y/N)"));
    expect(file().dirs).toEqual({ "~/work": { codex: "gone" } });
    expect(file()).not.toHaveProperty("defaults");

    await press(instance, "d");
    expect(text(instance)).toContain("Remove route solo? (y/N)");
  });

  it("changes the defaults from their row, and clears them once asked", async () => {
    const { instance, file } = setup({ file: { ...FILE, defaults: { claude: "solo" } } });
    await ranked(instance);
    await press(instance, TAB);
    await press(instance, "e");
    await until(instance, (f) => f.includes("Defaults"));

    await press(instance, RIGHT);
    await type(instance, ENTER);
    await until(instance, (f) => /default\s+wide/.test(f));
    expect(file().defaults).toEqual({ claude: "wide" });

    await press(instance, "d");
    expect(text(instance)).toContain("Clear the defaults? (y/N)");
    await press(instance, "y");
    await until(instance, (f) => /default\s+—\s+—/.test(f));
    expect(file()).not.toHaveProperty("defaults");
  });
});

describe("API profiles and their budgets", () => {
  const TAB = "\t";
  const SPACE = " ";
  const api = (name: string) =>
    profile("claude", name, {
      kind: "api",
      email: "",
      api: { baseUrl: `https://${name}.example.com`, authScheme: "bearer", secret: { source: "env", name: "GW_KEY" } },
    });
  const WITH_API: Registry = {
    ...REGISTRY,
    profiles: {
      ...REGISTRY.profiles,
      "claude:gw": api("gw"),
      "claude:bare": api("bare"),
      "claude:proxy": api("proxy"),
    },
  };
  const window = (usedPercent: number, limitUsd: number, source: "budget" | "provider") => ({
    usedPercent,
    resetsAt: null,
    spentUsd: (usedPercent * limitUsd) / 100,
    limitUsd,
    source,
    per: "month" as const,
  });
  /** Each API profile's spend as the cache serves it: against the budget its target carries, if any. */
  const collect: Collect = async (targets) =>
    Object.fromEntries(
      targets.map((target): [string, QuotaSnapshot] => {
        if (target.id === "claude:gw") {
          const budget = target.api?.budget;
          return [
            target.id,
            {
              state: "ok",
              fetchedAt: NOW,
              budget: budget ? window(35, budget.usd, "budget") : window(10, 50, "provider"),
            },
          ];
        }
        if (target.id === "claude:bare") return [target.id, { state: "ok", fetchedAt: NOW }];
        if (target.id === "claude:proxy") return [target.id, { state: "error", fetchedAt: NOW, noSpendReading: true }];
        return [target.id, QUOTAS[target.id] ?? { state: "error", fetchedAt: NOW }];
      }),
    );
  const withApi = (file: RoutesFile = FILE) =>
    setup({ file, collect, registry: { loads: WITH_API, problem: null }, columns: 100 });

  it("lists every API profile on b, with its usage and whose limit counts it, or why it has none", async () => {
    const { instance, deps } = withApi();
    await ranked(instance);
    await press(instance, "b");
    const frame = await until(instance, (f) => f.includes("Budgets") && f.includes("$5.00 of $50/month"));
    expect(frame).toMatch(/▸ claude:bare\s+—\s+no spend limit; e sets a budget/);
    expect(frame).toMatch(/ {3}claude:gw\s+10%\s+\$5\.00 of \$50\/month \(provider limit\)/);
    expect(frame).toMatch(/claude:proxy\s+—\s+the provider does not report spend/);
    for (const hint of ["e set budget", "d clear", "tab routes", "esc back"]) expect(frame).toContain(hint);
    // Only the API profiles' spend was read for it, and no key was asked for here.
    expect(ids(deps.collectQuotas.mock.calls.at(-1)?.[0] ?? [])).toEqual(["claude:bare", "claude:gw", "claude:proxy"]);
    await press(instance, TAB);
    await ranked(instance);
  });

  it("shows an API member's budget in the route's detail, with its spend", async () => {
    const { instance } = withApi({ version: 1, routes: { paid: { tool: "claude", from: ["gw", "team"] } } });
    const frame = await ranked(instance);
    const { detail } = panes(frame);
    expect(detail.find((line) => line.includes("ACCOUNT"))).toMatch(/ACCOUNT\s+5H\s+7D\s+BUDGET/);
    // The spend is cut to the pane, not the account's id.
    expect(row(detail, "claude:gw")).toMatch(/^▸ claude:gw\s+—\s+—\s+10%\s+next · \$5\.00 of \$50\/month/);
  });

  it("says loading, not that a key cannot be read, while the budgets view reads the spend", async () => {
    let release: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deferred: Collect = async (targets) => {
      if (targets.some((target) => target.api)) await answered;
      return collect(targets);
    };
    const { instance } = setup({ collect: deferred, registry: { loads: WITH_API, problem: null }, columns: 100 });
    await ranked(instance);
    await press(instance, "b");
    const loading = await until(instance, (f) => f.includes("Budgets") && f.includes("claude:gw"));
    expect(loading).toMatch(/claude:gw\s+—\s+loading…/);
    expect(loading).not.toContain("could not be read");
    release();
    await until(instance, (f) => f.includes("$5.00 of $50/month (provider limit)"));
  });

  it("sets a budget from its editor, and clears it once asked", async () => {
    const { instance, file } = withApi();
    await ranked(instance);
    await press(instance, "b");
    await until(instance, (f) => f.includes("Budgets"));
    await press(instance, DOWN);
    await press(instance, "e");
    await until(instance, (f) => f.includes("Budget for claude:gw"));
    await typeSlowly(instance, "20");
    await press(instance, TAB);
    expect(text(instance)).toContain("Its usage is its spend in a month as a share of $20.");
    await type(instance, ENTER);

    await until(instance, (f) => f.includes("Budgets") && f.includes("$7.00 of $20/month (clausona budget)"));
    expect(file().budgets).toEqual({ "claude:gw": { usd: 20, per: "month" } });

    await press(instance, "d");
    expect(text(instance)).toContain("Clear the budget for claude:gw? (y/N)");
    await press(instance, "y");
    await until(instance, (f) => f.includes("$5.00 of $50/month (provider limit)"));
    expect(file()).not.toHaveProperty("budgets");
  });

  it("refuses a budget that is not dollars above 0", async () => {
    const { instance, deps } = withApi();
    await ranked(instance);
    await press(instance, "b");
    await press(instance, "e");
    await until(instance, (f) => f.includes("Budget for claude:bare"));
    await typeSlowly(instance, "0");
    await type(instance, ENTER);
    await until(instance, (f) => f.includes("Type a number of dollars above 0, such as 20 or 12.50."));
    expect(deps.updateRoutes).not.toHaveBeenCalled();
  });

  it("offers in the form the API profiles that have a limit, and saves one ticked by its name", async () => {
    const { instance, file } = withApi();
    await ranked(instance);
    await press(instance, "n");
    const form = await until(instance, (f) => f.includes("New route") && f.includes("claude:gw"));
    expect(form).toMatch(/\[ \] claude:gw\s+API\s+10%\s+\$5\.00 of \$50\/month \(provider limit\)/);
    // No limit, or no spend reading: not offered.
    expect(form).not.toContain("claude:bare");
    expect(form).not.toContain("claude:proxy");

    await typeSlowly(instance, "paid");
    await press(instance, TAB);
    await press(instance, TAB);
    const row = lines(text(instance)).findIndex((line) => line.includes("claude:gw"));
    const first = lines(text(instance)).findIndex((line) => line.includes("every account (*)"));
    for (let step = 0; step < row - first; step++) await press(instance, DOWN);
    await press(instance, SPACE);
    await type(instance, ENTER);

    await until(instance, (f) => !f.includes("New route"));
    expect(file().routes.paid).toMatchObject({ tool: "claude", from: ["*", "gw"] });
  });
});

describe("ranked as a run of one model", () => {
  const UP = "\u001B[A";
  const WEEK = 7 * 24 * 60 * 60;
  const FIVE_HOURS = 5 * 60 * 60;
  /** A limit on one model, as Claude reports it; a Codex one says how long its window is. */
  const limit = (label: string, usedPercent: number, windowSeconds?: number): ScopedQuotaWindow => ({
    label,
    usedPercent,
    resetsAt: null,
    ...(windowSeconds ? { windowSeconds } : {}),
  });
  const limited = (snapshot: QuotaSnapshot, ...limits: ScopedQuotaWindow[]): QuotaSnapshot => ({
    ...snapshot,
    scopedLimits: limits,
  });
  // claude:team's 7D is the lowest of route main, but its Opus limit is nearly used up.
  const OPUS: Record<string, QuotaSnapshot> = {
    ...QUOTAS,
    "claude:team": limited(snap(5, 22), limit("Opus", 95)),
    "claude:work": limited(snap(12, 34), limit("Opus", 10), limit("Sonnet", 20)),
  };

  it("ranks the selected route as a run of the model m picks: one over that model's limit is not next", async () => {
    const { instance } = setup({ collect: async () => OPUS });
    const before = panes(await ranked(instance));
    expect(row(before.detail, "ACCOUNT")).toMatch(/ACCOUNT\s+5H\s+7D$/);
    expect(row(before.detail, "claude:team")).toMatch(/^▸ claude:team\s.*5%.*22%\s+next$/);
    expect(before.list[0]).toMatch(/^▸ main\s+claude\s+2\/4$/);

    await press(instance, "m");
    const { list, detail } = panes(text(instance));
    expect(detail).toContain("Model     ranked as --model opus");
    expect(row(detail, "ACCOUNT")).toMatch(/ACCOUNT\s+5H\s+7D\s+OPUS$/);
    expect(row(detail, "claude:work")).toMatch(/^▸ claude:work\s.*12%.*34%\s+10%\s+next$/);
    expect(row(detail, "claude:team")).toMatch(/^claude:team\s.*5%.*22%\s+95%\s+over 80%$/);
    // No limit on Opus reported: a dash, as in `route explain --model opus`.
    expect(row(detail, "claude:side")).toMatch(/^claude:side\s.*88%.*40%\s+—\s+over 80%$/);
    // Who is free follows it; the routes not selected are ranked as before.
    expect(list).toEqual([
      expect.stringMatching(/^▸ main\s+claude\s+1\/4$/),
      expect.stringMatching(/^solo\s+claude\s+2\/2$/),
      expect.stringMatching(/^wide\s+all\s+4\/6$/),
    ]);
  });

  it("goes through each model the accounts have a limit on, then none, and hints m only where it does that", async () => {
    const { instance } = setup({ collect: async () => OPUS });
    const none = await ranked(instance);
    expect(none).toContain("m model");
    expect(panes(none).detail).toContain("Model limits: Opus, Sonnet · m to rank by one");

    await press(instance, "m");
    expect(text(instance)).toContain("ranked as --model opus");
    expect(text(instance)).not.toContain("Model limits");
    await press(instance, "m");
    const sonnet = panes(text(instance)).detail;
    expect(sonnet).toContain("Model     ranked as --model sonnet");
    expect(row(sonnet, "ACCOUNT")).toMatch(/ACCOUNT\s+5H\s+7D\s+SONNET$/);
    expect(row(sonnet, "claude:team")).toMatch(/^▸ claude:team\s.*5%.*22%\s+—\s+next$/);
    await press(instance, "m");
    expect(text(instance)).toBe(none);
    instance.unmount();

    // No account reports a limit on a model: nothing to rank by, so no hint, no line, and m does nothing.
    const plain = setup();
    const frame = await ranked(plain.instance);
    expect(frame).not.toContain("m model");
    expect(frame).not.toContain("Model limits");
    await type(plain.instance, "m");
    expect(text(plain.instance)).toBe(frame);
  });

  it("ranks a route selected next as a run that names no model", async () => {
    const { instance } = setup({ collect: async () => OPUS });
    await ranked(instance);
    await press(instance, "m");
    await press(instance, DOWN);
    expect(text(instance)).not.toContain("--model");

    await press(instance, UP);
    const { list, detail } = panes(text(instance));
    expect(detail).toContain("Model limits: Opus, Sonnet · m to rank by one");
    expect(row(detail, "claude:team")).toMatch(/^▸ claude:team\s.*next$/);
    expect(list[0]).toMatch(/^▸ main\s+claude\s+2\/4$/);
  });

  const WITH_CODEX: Registry = {
    ...REGISTRY,
    profiles: { ...REGISTRY.profiles, "codex:personal-max": profile("codex", "personal-max") },
  };
  /** Sorted by name: cx, then main. */
  const BOTH: RoutesFile = { version: 1, routes: { cx: { tool: "codex", from: ["*"] }, main: FILE.routes.main } };
  // codex:personal-max is next on cx for a run that names no model, but the 5-hour window of its
  // limit on GPT-5.3-Codex-Spark is nearly used up.
  const LIMITS: Record<string, QuotaSnapshot> = {
    ...OPUS,
    "codex:x": limited(
      snap(30, 10),
      limit("GPT-5.3-Codex-Spark", 1, FIVE_HOURS),
      limit("GPT-5.3-Codex-Spark", 5, WEEK),
    ),
    "codex:personal-max": limited(
      snap(5, 8),
      limit("GPT-5.3-Codex-Spark", 90, FIVE_HOURS),
      limit("GPT-5.3-Codex-Spark", 30, WEEK),
    ),
  };

  it.each([60, 80, 120])("keeps a model's column inside a %i-column terminal", async (columns) => {
    const { instance } = setup({
      file: BOTH,
      registry: { loads: WITH_CODEX, problem: null },
      collect: async () => LIMITS,
      columns,
    });
    const line = (frame: string, id: string) => lines(frame).find((each) => each.includes(id)) ?? "";
    expect(line(await ranked(instance), "codex:personal-max")).toMatch(/▸ codex:personal-max\s.*next$/);

    await press(instance, "m");
    const codex = text(instance);
    for (const each of lines(codex)) expect(each.length, each).toBeLessThanOrEqual(columns);
    expect(codex).toContain("ranked as --model gpt-5.3-codex-spark");
    // The limit's whole name where it fits beside whole ids, else cut to its cells.
    expect(codex).toMatch(columns > 60 ? /ACCOUNT\s+5H\s+7D\s+GPT-5\.3-CODEX-SPARK/ : /ACCOUNT\s+5H\s+7D\s+GPT-5\.…/);
    // The higher of the limit's windows counts, and says which it is.
    expect(line(codex, "codex:personal-max")).toMatch(/codex:personal-max\s.*\s5H\s.*\b90%\s+over 80%$/);
    expect(line(codex, "codex:x")).toMatch(/▸ codex:x\s.*\s7D\s.*\b5%\s+next$/);

    await press(instance, DOWN);
    await press(instance, "m");
    const claude = text(instance);
    for (const each of lines(claude)) expect(each.length, each).toBeLessThanOrEqual(columns);
    expect(claude).toMatch(/ACCOUNT\s+5H\s+7D\s+OPUS/);
    expect(line(claude, "claude:work")).toMatch(/▸ claude:work\s.*\b10%\s+next$/);
    expect(line(claude, "claude:team")).toMatch(/claude:team\s.*\b95%\s+over 80%$/);
  });

  // A run on an all route that names a model names its tool, and only that tool's accounts are ranked.
  it("ranks an all route's accounts of the tool that reports the limit, and says so", async () => {
    const { instance } = setup({ registry: { loads: WITH_CODEX, problem: null }, collect: async () => LIMITS });
    await ranked(instance);
    await press(instance, DOWN);
    await press(instance, DOWN);
    expect(panes(text(instance)).list[2]).toMatch(/^▸ wide\s+all\s+5\/7$/);

    await press(instance, "m");
    const spark = panes(text(instance));
    expect(spark.detail).toContain("Model     ranked as --tool codex --model gpt-5.3-codex-spark");
    expect(row(spark.detail, "codex:x")).toMatch(/^▸ codex:x\s.*next$/);
    expect(row(spark.detail, "codex:personal-max")).toMatch(/over 80%$/);
    expect(spark.detail.some((line) => line.includes("claude:"))).toBe(false);
    expect(spark.list[2]).toMatch(/^▸ wide\s+all\s+1\/2$/);

    await press(instance, "m");
    const opus = panes(text(instance));
    expect(opus.detail).toContain("Model     ranked as --tool claude --model opus");
    expect(row(opus.detail, "claude:work")).toMatch(/^▸ claude:work\s.*10%\s+next$/);
    expect(opus.detail.some((line) => line.includes("codex:"))).toBe(false);
    expect(opus.list[2]).toMatch(/^▸ wide\s+all\s+2\/5$/);
  });

  // No run ranks both tools' accounts for one model: were a label reported by both, each tool's
  // accounts would be ranked for it in turn.
  it("ranks an all route by a label both tools report once for each tool", async () => {
    const quotas = {
      ...QUOTAS,
      "claude:work": limited(snap(12, 34), limit("Opus", 10)),
      "codex:x": limited(snap(30, 10), limit("Opus", 20, WEEK)),
    };
    const { instance } = setup({ collect: async () => quotas });
    await ranked(instance);
    await press(instance, DOWN);
    await press(instance, DOWN);
    expect(panes(text(instance)).detail).toContain("Model limits: Opus · m to rank by one");

    await press(instance, "m");
    const claude = panes(text(instance));
    expect(claude.detail).toContain("Model     ranked as --tool claude --model opus");
    // Each ranked by its own tool's limit on the model.
    expect(row(claude.detail, "claude:work")).toMatch(/12%\s+34%\s+10%/);
    expect(claude.detail.some((line) => line.includes("codex:"))).toBe(false);

    await press(instance, "m");
    const codex = panes(text(instance));
    expect(codex.detail).toContain("Model     ranked as --tool codex --model opus");
    expect(row(codex.detail, "codex:x")).toMatch(/30%\s+10%\s+7D\s+20%/);
    expect(codex.detail.some((line) => line.includes("claude:"))).toBe(false);

    await press(instance, "m");
    expect(text(instance)).not.toContain("--model");
  });

  it("cuts the model's name before the cells lose their reset times", async () => {
    // Reset times from the real clock, which the cells count from: each reads a whole number of hours.
    const inHours = (hours: number) => new Date(Date.now() + (hours + 0.5) * 3_600_000).toISOString();
    const timed = (five: number, seven: number, ...limits: ScopedQuotaWindow[]): QuotaSnapshot => ({
      state: "ok",
      fetchedAt: NOW,
      session: { usedPercent: five, resetsAt: inHours(1) },
      weekly: { usedPercent: seven, resetsAt: inHours(50) },
      scopedLimits: limits.map((each) => ({ ...each, resetsAt: inHours(3) })),
    });
    const quotas = {
      "codex:x": timed(30, 10, limit("GPT-5.3-Codex-Spark", 5, WEEK)),
      "codex:personal-max": timed(5, 8, limit("GPT-5.3-Codex-Spark", 90, FIVE_HOURS)),
    };
    const { instance } = setup({
      file: BOTH,
      registry: { loads: WITH_CODEX, problem: null },
      collect: async () => quotas,
    });
    await ranked(instance);
    await press(instance, "m");
    const { detail } = panes(text(instance));
    expect(row(detail, "ACCOUNT")).toMatch(/ACCOUNT\s+5H\s+7D\s+GPT-5\.3-C…$/);
    expect(row(detail, "codex:x")).toMatch(/^▸ codex:x\s+30% 1h\s+10% 2d\s+7D\s+5% 3h\s+next$/);
  });

  it("drops the model it ranked by once its route is removed", async () => {
    const removed = setup({ collect: async () => OPUS });
    await ranked(removed.instance);
    await press(removed.instance, "m");
    await press(removed.instance, "d");
    await press(removed.instance, "y");
    await until(removed.instance, (f) => panes(f).list.length === 2 && !f.includes("(y/N)"));
    // A route of the same name, made again, is ranked as a run that names no model.
    await press(removed.instance, "n");
    await until(removed.instance, (f) => f.includes("New route"));
    await press(removed.instance, "main");
    await type(removed.instance, ENTER);
    const again = await until(removed.instance, (f) => /▸ main/.test(f) && !f.includes("New route"));
    expect(again).not.toContain("--model");
    expect(panes(again).detail).toContain("Model limits: Opus, Sonnet · m to rank by one");
  });

  it("drops the model it ranked by once a refresh no longer reports it, so a later one cannot bring it back", async () => {
    // Read with Opus, then without it, then with it again.
    const readings = [OPUS, QUOTAS, OPUS];
    let reads = 0;
    const { instance, deps } = setup({ collect: async () => readings[Math.min(reads++, readings.length - 1)] });
    await ranked(instance);
    await press(instance, "m");
    expect(text(instance)).toContain("ranked as --model opus");
    await press(instance, "r");
    await until(instance, (f) => !f.includes("--model") && !f.includes("Reading quota again"));
    await press(instance, "r");
    await vi.waitFor(() => expect(deps.collectQuotas).toHaveBeenCalledTimes(3));
    const frame = await until(instance, (f) => !f.includes("Reading quota again"));
    expect(frame).not.toContain("--model");
    expect(panes(frame).detail).toContain("Model limits: Opus, Sonnet · m to rank by one");
  });

  it("starts a model cell's dash where the column starts, as the others do, beside a window's kind", async () => {
    const quotas = { ...LIMITS, "codex:personal-max": snap(5, 8) };
    const { instance } = setup({
      file: BOTH,
      registry: { loads: WITH_CODEX, problem: null },
      collect: async () => quotas,
    });
    await ranked(instance);
    await press(instance, "m");
    const all = lines(text(instance));
    const header = all.find((line) => line.includes("ACCOUNT")) ?? "";
    expect(all.find((line) => line.includes("codex:x"))).toMatch(/\s7D\s+5%/);
    expect((all.find((line) => line.includes("codex:personal-max")) ?? "").indexOf("—")).toBe(header.indexOf("GPT-5"));
  });
});
