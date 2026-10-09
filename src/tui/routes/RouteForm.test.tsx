import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { checkRoutesFile, emptyRoutesFile, type RouteSpec, type RoutesFile } from "../../core/route-config.js";
import { parseRoutesText } from "../../core/routes-store.js";
import { stripAnsi } from "../../lib/cli-style.js";
import type { QuotaSnapshot, Registry } from "../../types.js";
import { DOWN, ENTER, ESC, focusedOn, type Instance, press, renderAt, type, waitForFrame } from "../test-drive.js";
import { windowsOnScreen } from "../test-frames.js";
import { formAccounts, RouteForm } from "./RouteForm.js";
import type { RoutesScreenDeps } from "./routes-deps.js";

vi.setConfig({ testTimeout: 15_000 });

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const PATH = "/home/u/.clausona/routes.json";

const TAB = "\t";
const SHIFT_TAB = "\u001B[Z";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const UP = "\u001B[A";
const ERASE = "\u007F";
const SPACE = " ";

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
    "claude:ops-share": profile("claude", "ops-share"),
    "codex:x": profile("codex", "x"),
    // Billed per use: never offered, and refused when a pattern names it.
    "claude:gateway": profile("claude", "gateway", {
      kind: "api",
      email: "",
      api: { baseUrl: "https://api.example.com", authScheme: "api-key", secret: { source: "keychain" } },
    }),
  },
};

const FILE: RoutesFile = {
  version: 1,
  routes: {
    main: {
      tool: "claude",
      from: ["*"],
      exclude: ["*-share"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    },
    solo: { tool: "claude", from: ["work"], fallback: ["team"], strategy: "headroom" },
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
  "claude:ops-share": snap(0, 64),
  "codex:x": snap(30, 10),
};

const toText = (file: RoutesFile) => `${JSON.stringify(file, null, 2)}\n`;

/** routes.json in memory: read and written as the store reads and writes it, checks included. */
function memoryDisk(initial: RoutesFile | null) {
  const disk = {
    text: initial === null ? null : toText(initial),
    file: (): RoutesFile => (disk.text === null ? emptyRoutesFile() : parseRoutesText(disk.text, PATH)),
  };
  return disk;
}

function setup(
  options: {
    edit?: string;
    spec?: RouteSpec;
    file?: RoutesFile | null;
    columns?: number;
    /** The terminal's height; without it stdout does not say, and the form lists every account. */
    rows?: number;
    registry?: Registry;
    quotas?: Record<string, QuotaSnapshot>;
  } = {},
) {
  const disk = memoryDisk(options.file === undefined ? FILE : options.file);
  const registry = options.registry ?? REGISTRY;
  const deps = {
    loadRegistry: vi.fn(async () => registry),
    registryProblem: vi.fn(async () => null),
    readRoutes: vi.fn(async () => disk.file()),
    updateRoutes: vi.fn<RoutesScreenDeps["updateRoutes"]>(async (update) => {
      const current = disk.file();
      const next = update(structuredClone(current));
      if (next === null) return current;
      const check = checkRoutesFile(next);
      if (!check.ok) throw new Error(check.problems.join("\n"));
      disk.text = toText(check.file);
      return check.file;
    }),
    collectQuotas: vi.fn<RoutesScreenDeps["collectQuotas"]>(async () => QUOTAS),
    readPicks: vi.fn(async () => ({})),
    clock: () => NOW,
  } satisfies RoutesScreenDeps;
  const onDone = vi.fn();
  const name = options.edit;
  const tree = (
    <RouteForm
      mode={name === undefined ? "new" : "edit"}
      name={name}
      spec={name === undefined ? undefined : (options.spec ?? disk.file().routes[name])}
      accounts={formAccounts(registry)}
      quotas={options.quotas ?? QUOTAS}
      lastPicked={{}}
      registry={registry}
      deps={deps}
      now={NOW}
      onDone={onDone}
    />
  );
  const sized = options.columns !== undefined || options.rows !== undefined;
  const watched = sized ? renderAt(tree, options.columns ?? 80, { rows: options.rows }) : undefined;
  const instance: Instance = watched ?? render(tree);
  return { instance, watched, deps, onDone, disk };
}

const text = (instance: Instance) => stripAnsi(instance.lastFrame() ?? "");
const until = (instance: Instance, check: (frame: string) => boolean) => waitForFrame(() => text(instance), check);
const lines = (frame: string) => frame.split("\n");
/** A line of the box without its borders and padding. */
const inside = (line: string) => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "");
const row = (frame: string, label: string) => inside(lines(frame).find((line) => line.includes(label)) ?? "");

/** Painted: the form reads nothing before its first save. */
async function opened(instance: Instance) {
  await until(instance, (f) => f.includes("Name"));
}

/** Tabs to the field on the line carrying `label`. */
async function tabTo(instance: Instance, label: string) {
  for (let step = 0; step < 20; step++) {
    if (focusedOn(text(instance), label)) return;
    await press(instance, TAB);
  }
  throw new Error(`focus never reached '${label}'`);
}

/** Moves the row cursor (`▸`) down to the line matching `target`. */
async function downTo(instance: Instance, target: RegExp) {
  for (let step = 0; step < 20; step++) {
    if (lines(text(instance)).some((line) => target.test(inside(line)))) return;
    await press(instance, DOWN);
  }
  throw new Error(`the cursor never reached ${target}`);
}

const accountRow = (id: string) => new RegExp(`▸ \\[.\\] ${id}\\b`);
/** The picker's one line, offering `id`: `Add to fallback  ‹ claude:side ›  2 of 4`. */
const pickerRow = (id: string) => new RegExp(`^\\s*Add to fallback\\s+(‹ )?${id}( ›)?\\s+\\d+ of \\d+$`);

/** Replaces what a text field holds, the cursor being at its end as it is when the field is reached. */
async function retype(instance: Instance, length: number, value: string) {
  for (let i = 0; i < length; i++) await press(instance, ERASE);
  await press(instance, value);
}

/**
 * Unticks `every account (*)`, which leaves every account ticked as the from list, then each of
 * `ids`: what makes room for a fallback.
 */
async function untickEvery(instance: Instance, ids: string[]) {
  await tabTo(instance, "Accounts");
  await press(instance, SPACE);
  for (const id of ids) {
    await downTo(instance, accountRow(id));
    await press(instance, SPACE);
  }
}

async function save(instance: Instance) {
  await type(instance, ENTER);
}

const routes = (disk: ReturnType<typeof memoryDisk>) => disk.file().routes;

const TAIL = "tab next field │ enter save │ esc cancel";

/** What is under the footer's rule: the question, if one is asked, and the hints. */
function hintLines(frame: string): string[] {
  const all = lines(frame);
  const rule = all.length - 1 - [...all].reverse().findIndex((line) => /^\s*─{10,}/.test(line));
  return all
    .slice(rule + 1)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("RouteForm", () => {
  it("creates a route with the defaults from a name and enter", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);

    await press(instance, "daily");
    await save(instance);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("daily"));
    expect(routes(disk).daily).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    });
    expect(Object.keys(routes(disk))).toEqual(["main", "solo", "daily"]);
  });

  it("lays out every field, with the subscription accounts of the tool and their quota", async () => {
    const { instance } = setup();
    await opened(instance);
    const frame = text(instance);

    expect(frame).toContain("New route");
    expect(row(frame, "Tool")).toMatch(/Tool\s+● claude\s+○ codex\s+○ claude \+ codex$/);
    expect(row(frame, "every account")).toMatch(/Accounts\s+\[x\] every account \(\*\), new ones join$/);
    expect(row(frame, "claude:team")).toMatch(/^\s+\[x\] claude:team\s+5%\s+22%$/);
    expect(row(frame, "claude:side")).toMatch(/^\s+\[x\] claude:side\s+88%\s+40%$/);
    expect(frame).not.toContain("gateway");
    expect(frame).not.toContain("codex:x");
    expect(row(frame, "from")).toMatch(/Patterns\s+from$/);
    expect(row(frame, "exclude ")).toMatch(/^\s+exclude$/);
    expect(row(frame, "Strategy")).toMatch(/Strategy\s+● round-robin\s+○ headroom\s+○ expiring$/);
    expect(frame).toContain("takes accounts in turn");
    expect(row(frame, "skip at")).toMatch(/Limits\s+skip at\s+\[80\]%$/);
    expect(row(frame, "reserve up to")).toMatch(/reserve up to\s+\[95\]%$/);
    expect(row(frame, "Fallback")).toMatch(/Fallback\s+\(\+ add\)$/);
    expect(frame).toContain("Now: 3 of 4 accounts under 80% · next claude:team");
    expect(hintLines(frame)).toEqual([TAIL]);
  });

  // The hints follow the focus, so each set fits on one line where all of them did not.
  it("shows the keys of the focused field, on one line at 80 columns", async () => {
    const { instance } = setup({ edit: "solo", columns: 80 });
    await opened(instance);
    const expected: Array<[string, string]> = [
      ["Name", TAIL],
      ["Tool", `←→ choose │ ${TAIL}`],
      ["Accounts", `↑↓ move │ space toggle │ ${TAIL}`],
      ["from", TAIL],
      ["exclude ", TAIL],
      ["Strategy", `←→ choose │ ${TAIL}`],
      ["skip at", TAIL],
      ["reserve up to", TAIL],
      ["Fallback", `a add │ x remove │ [ ] reorder │ ${TAIL}`],
    ];
    for (const [label, hints] of expected) {
      await tabTo(instance, label);
      expect(hintLines(text(instance)), label).toEqual([hints]);
    }

    await press(instance, "a");
    expect(hintLines(text(instance))).toEqual(["←→ choose │ enter add │ esc close"]);
    await press(instance, ESC);
    await press(instance, "x");
    await press(instance, ESC);
    expect(hintLines(text(instance))).toEqual(["Discard changes? (y/N)", "y discard │ n/esc keep editing"]);
  });

  // As `clausona route list` and the screen say it: offline is not "nobody can be picked".
  it("says there is no quota reading, not that nobody can be picked, when none was read", async () => {
    const { instance } = setup({ edit: "main", quotas: {} });
    await opened(instance);
    expect(text(instance)).toContain("Now: no quota reading");
    expect(text(instance)).not.toContain("nobody can be picked");

    // Read, and everyone over the reserve: nobody can be picked.
    const full = Object.fromEntries(Object.keys(QUOTAS).map((id) => [id, snap(99, 99)]));
    const busy = setup({ edit: "main", quotas: full });
    await opened(busy.instance);
    expect(text(busy.instance)).toContain("Now: nobody can be picked");
  });

  it("says why an account has no quota, as the Routes screen does, and excluded before that", async () => {
    const quotas: Record<string, QuotaSnapshot> = {
      ...QUOTAS,
      "claude:side": { state: "missing", fetchedAt: NOW },
      "claude:work": { state: "expired", fetchedAt: NOW },
      "claude:ops-share": { state: "missing", fetchedAt: NOW },
    };
    const { instance } = setup({ edit: "main", quotas, columns: 80 });
    await opened(instance);
    const frame = text(instance);

    expect(row(frame, "claude:side")).toMatch(/\[x\] claude:side\s+—\s+—\s+signed out$/);
    expect(row(frame, "claude:work")).toMatch(/\[x\] claude:work\s+—\s+—\s+sign-in expired$/);
    expect(row(frame, "claude:ops-share")).toMatch(/\[ \] claude:ops-share\s+—\s+—\s+excluded$/);
    expect(row(frame, "claude:team")).toMatch(/\[x\] claude:team\s+5%\s+22%$/);
  });

  // Focused and empty, a pattern field said nothing about what it takes.
  it("says what a pattern field takes while it is focused and empty, within 80 columns", async () => {
    const { instance } = setup({ columns: 80 });
    await opened(instance);
    expect(text(instance)).not.toContain("comma-separated");

    await tabTo(instance, "from");
    expect(row(text(instance), "from")).toMatch(/Patterns\s+from\s+\S?\s+globs or emails, comma-separated$/);
    for (const line of lines(text(instance))) expect(line.length).toBeLessThanOrEqual(80);
    await press(instance, "*@work.example");
    expect(row(text(instance), "from")).toMatch(/from\s+\*@work\.example\s*$/);

    await tabTo(instance, "exclude ");
    expect(row(text(instance), "exclude ")).toMatch(/^✦\s+exclude\s+\S?\s+names or globs, comma-separated$/);
    expect(row(text(instance), "from")).not.toContain("comma-separated");
    for (const line of lines(text(instance))) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("moves the focus with tab and back with shift+tab", async () => {
    const { instance } = setup();
    await opened(instance);
    expect(focusedOn(text(instance), "Name")).toBe(true);

    await press(instance, TAB);
    expect(focusedOn(text(instance), "Tool")).toBe(true);
    await press(instance, SHIFT_TAB);
    await press(instance, SHIFT_TAB);
    // Round from the first field to the last.
    expect(focusedOn(text(instance), "Fallback")).toBe(true);
  });

  it("saves an account unticked under every account as an exclude, and says who is left", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "daily");

    await tabTo(instance, "Accounts");
    await downTo(instance, accountRow("claude:team"));
    await press(instance, SPACE);
    expect(row(text(instance), "claude:team")).toMatch(/\[ \] claude:team\s+5%\s+22%\s+excluded$/);
    expect(text(instance)).toContain("Now: 2 of 3 accounts under 80% · next claude:work");

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("daily"));
    expect(routes(disk).daily).toMatchObject({ from: ["*"], exclude: ["team"] });
  });

  it("lists both tools' accounts for claude + codex, and saves the route as all", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "both");

    await tabTo(instance, "Tool");
    await press(instance, RIGHT);
    expect(row(text(instance), "Tool")).toMatch(/○ claude\s+● codex/);
    expect(text(instance)).not.toContain("claude:team");
    await press(instance, RIGHT);
    expect(row(text(instance), "Tool")).toMatch(/● claude \+ codex$/);
    expect(row(text(instance), "codex:x")).toMatch(/\[x\] codex:x\s+30%\s+10%$/);
    expect(text(instance)).toContain("claude:team");

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("both"));
    expect(routes(disk).both).toEqual({
      tool: "all",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    });
  });

  it("changes the strategy with the arrows, and says what the new one does", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "roomy");

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    expect(row(text(instance), "Strategy")).toMatch(/○ round-robin\s+● headroom\s+○ expiring$/);
    expect(text(instance)).toContain("picks the account with the most room");

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("roomy"));
    expect(routes(disk).roomy.strategy).toBe("headroom");
  });

  it("shows the reserve's problem when the limit is raised above it, and writes nothing", async () => {
    const { instance, deps, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "tight");

    await tabTo(instance, "skip at");
    await retype(instance, 2, "90");
    await tabTo(instance, "reserve up to");
    await retype(instance, 2, "85");
    expect(row(text(instance), "skip at")).toMatch(/\[90\]%$/);
    // Still focused: the text cursor sits after the value.
    expect(row(text(instance), "reserve up to")).toMatch(/\[85 ?\]%$/);

    await save(instance);
    const frame = await until(instance, (f) => f.includes("must be a number"));
    expect(frame).toContain("Reserve up to: must be a number from maxUsage (90) to 100");
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(routes(disk).tight).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("adds fallback accounts from a picker, reorders and removes them, and saves their order", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "spare");
    // The pool is ops-share alone, which leaves three accounts to fall back on.
    await untickEvery(instance, ["claude:side", "claude:team", "claude:work"]);
    await tabTo(instance, "Fallback");

    await press(instance, "a");
    expect(row(text(instance), "Add to fallback")).toMatch(/^\s*Add to fallback\s+claude:side ›\s+1 of 3$/);
    await press(instance, ENTER);
    expect(text(instance)).not.toContain("Add to fallback");
    expect(row(text(instance), "Fallback")).toMatch(/▸1\. claude:side\s+\(\+ add\)$/);

    await press(instance, "a");
    // What is in the fallback already is not offered again.
    expect(row(text(instance), "Add to fallback")).toMatch(/claude:team ›\s+1 of 2$/);
    await press(instance, RIGHT);
    expect(row(text(instance), "Add to fallback")).toMatch(/‹ claude:work\s+2 of 2$/);
    await press(instance, LEFT);
    await press(instance, ENTER);
    await press(instance, "a");
    await downTo(instance, pickerRow("claude:work"));
    await press(instance, ENTER);
    expect(row(text(instance), "Fallback")).toMatch(/1\. claude:side\s+2\. claude:team\s+3\. claude:work/);

    // team up to the front, then work removed.
    await press(instance, DOWN);
    await press(instance, "[");
    expect(row(text(instance), "Fallback")).toMatch(/▸1\. claude:team\s+2\. claude:side\s+3\. claude:work/);
    await press(instance, DOWN);
    await press(instance, DOWN);
    await press(instance, "x");
    expect(row(text(instance), "Fallback")).toMatch(/1\. claude:team\s+▸2\. claude:side\s+\(\+ add\)$/);
    // The last entry has nowhere further down to go.
    await type(instance, "]");
    expect(row(text(instance), "Fallback")).toMatch(/1\. claude:team\s+▸2\. claude:side/);

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("spare"));
    expect(routes(disk).spare).toMatchObject({ from: ["ops-share"], fallback: ["team", "side"] });
  });

  // The pool comes first, and a member already in it is skipped as a fallback: under every
  // account (*), which a new route starts on, each account the picker offered did nothing.
  it("offers only accounts outside the pool and its excludes, and says what makes room when there are none", async () => {
    const { instance } = setup({ columns: 80 });
    await opened(instance);
    await tabTo(instance, "Fallback");

    await press(instance, "a");
    const message = "The pool takes every account; untick every account (*) or narrow it.";
    expect(text(instance)).toContain(message);
    expect(text(instance)).not.toContain("Add to fallback");
    for (const line of lines(text(instance))) expect(line.length).toBeLessThanOrEqual(80);
    await press(instance, ENTER);
    expect(text(instance)).not.toContain(message);
    expect(row(text(instance), "Fallback")).toMatch(/Fallback\s+\(\+ add\)$/);

    // Unticked, every account leaves them all ticked: still nobody outside the pool.
    await untickEvery(instance, []);
    await tabTo(instance, "Fallback");
    await press(instance, "a");
    expect(text(instance)).toContain(message);
    await press(instance, ESC);
    // Unticked from the from list, side is outside the pool: the one account to offer.
    await tabTo(instance, "Accounts");
    await downTo(instance, accountRow("claude:side"));
    await press(instance, SPACE);
    await tabTo(instance, "Fallback");
    await press(instance, "a");
    expect(row(text(instance), "Add to fallback")).toMatch(/^\s*Add to fallback\s+claude:side\s+1 of 1$/);
  });

  it("leaves out of the picker an account the exclude takes, and one in the pool by name", async () => {
    // main takes every account but ops-share, which its exclude takes: nothing to offer.
    const main = setup({ edit: "main", columns: 80 });
    await opened(main.instance);
    await tabTo(main.instance, "Fallback");
    await press(main.instance, "a");
    expect(text(main.instance)).toContain("The pool takes every account; untick every account (*) or narrow it.");

    // solo's pool is work, and team is its fallback already.
    const solo = setup({ edit: "solo" });
    await opened(solo.instance);
    await tabTo(solo.instance, "Fallback");
    await press(solo.instance, "a");
    expect(row(text(solo.instance), "Add to fallback")).toMatch(/claude:ops-share ›\s+1 of 2$/);
    await press(solo.instance, RIGHT);
    expect(row(text(solo.instance), "Add to fallback")).toMatch(/‹ claude:side\s+2 of 2$/);
  });

  it("marks a fallback entry the pool takes already, as one written with the CLI can be", async () => {
    const file: RoutesFile = {
      version: 1,
      routes: { cli: { tool: "claude", from: ["*"], fallback: ["side", "nobody"] } },
    };
    const { instance } = setup({ edit: "cli", file, columns: 80 });
    await opened(instance);
    expect(row(text(instance), "Fallback")).toMatch(
      /Fallback\s+1\. claude:side in the pool\s+2\. nobody\s+\(\+ add\)$/,
    );
  });

  // The 8 accounts of a claude + codex form listed under the fallback ran the form off a
  // 34-row terminal, the title first; the picker is one line, whatever the number of accounts.
  it("offers the fallback accounts on one line, one at a time, so the picker adds a single line", async () => {
    // A claude + codex route of one account: the four others are offered.
    const { instance } = setup({ edit: "pair", spec: { tool: "all", from: ["claude:team"] } });
    await opened(instance);
    await tabTo(instance, "Fallback");
    const closed = lines(text(instance)).length;

    await press(instance, "a");
    expect(lines(text(instance))).toHaveLength(closed + 1);
    const picker = () => row(text(instance), "Add to fallback");
    // The first has nothing before it, the last nothing after it.
    expect(picker()).toMatch(/^\s*Add to fallback\s+claude:ops-share ›\s+1 of 4$/);
    await type(instance, LEFT);
    expect(picker()).toMatch(/\s+claude:ops-share ›\s+1 of 4$/);
    await press(instance, RIGHT);
    expect(picker()).toMatch(/‹ claude:side ›\s+2 of 4$/);
    await press(instance, DOWN);
    await press(instance, DOWN);
    expect(picker()).toMatch(/‹ codex:x\s+4 of 4$/);
    await type(instance, RIGHT);
    expect(picker()).toMatch(/‹ codex:x\s+4 of 4$/);
    await press(instance, UP);
    expect(picker()).toMatch(/‹ claude:work ›\s+3 of 4$/);
    expect(lines(text(instance))).toHaveLength(closed + 1);

    await press(instance, ENTER);
    expect(text(instance)).not.toContain("Add to fallback");
    expect(row(text(instance), "Fallback")).toMatch(/1\. claude:work\s+\(\+ add\)$/);
  });

  it("closes the picker on esc without leaving the form or adding anything", async () => {
    const { instance, onDone } = setup();
    await opened(instance);
    await tabTo(instance, "Fallback");

    await press(instance, "a");
    await press(instance, ESC);
    expect(text(instance)).not.toContain("Add to fallback");
    expect(text(instance)).not.toContain("Discard changes?");
    expect(row(text(instance), "Fallback")).toMatch(/Fallback\s+\(\+ add\)$/);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("opens an edit with the route as it is, the pattern-excluded account painted excluded", async () => {
    const { instance } = setup({ edit: "main" });
    await opened(instance);
    const frame = text(instance);

    expect(frame).toContain("Edit main");
    expect(row(frame, "Name")).toMatch(/Name\s+main$/);
    expect(row(frame, "claude:ops-share")).toMatch(/\[ \] claude:ops-share\s+0%\s+64%\s+excluded$/);
    expect(row(frame, "claude:team")).toMatch(/\[x\] claude:team/);
    expect(row(frame, "exclude ")).toMatch(/exclude\s+\*-share$/);
    expect(frame).toContain("Now: 2 of 3 accounts under 80% · next claude:team");
  });

  it("renames a route: the new key is written and the old one removed", async () => {
    const { instance, deps, onDone, disk } = setup({ edit: "solo" });
    await opened(instance);

    await press(instance, "-2");
    expect(row(text(instance), "Name")).toMatch(/Name\s+solo-2$/);
    await save(instance);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("solo-2"));
    // One write under one lock: the old key goes and the new one comes in the same update.
    expect(deps.updateRoutes).toHaveBeenCalledTimes(1);
    expect(Object.keys(routes(disk))).toEqual(["main", "solo-2"]);
    expect(routes(disk)["solo-2"]).toEqual(FILE.routes.solo);
  });

  it("says why a write failed, keeps the inputs, and saves the next time", async () => {
    const { instance, deps, onDone, disk } = setup();
    await opened(instance);
    deps.updateRoutes.mockRejectedValueOnce(new Error("Timed out waiting for another clausona process."));

    await press(instance, "daily");
    await save(instance);

    const frame = await until(instance, (f) => f.includes("Timed out"));
    expect(frame).toContain("✘ Timed out waiting for another clausona process.");
    expect(row(frame, "Name")).toMatch(/Name\s+daily$/);
    expect(routes(disk).daily).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("daily"));
  });

  it("refuses to rename a route onto another route's name", async () => {
    const { instance, onDone, disk } = setup({ edit: "solo" });
    await opened(instance);

    await retype(instance, 4, "main");
    await save(instance);

    const frame = await until(instance, (f) => f.includes("already exists"));
    expect(frame).toContain("Name: Route 'main' already exists.");
    expect(routes(disk)).toEqual(FILE.routes);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("refuses a new route under a name that is taken", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);

    await press(instance, "main");
    await save(instance);

    await until(instance, (f) => f.includes("Route 'main' already exists."));
    expect(routes(disk)).toEqual(FILE.routes);
    expect(onDone).not.toHaveBeenCalled();
  });

  // Review Focus 3: routes.json changed by another terminal while the form is open. Only the
  // route the form edits is its business: a change to another route is kept, and so are the inputs.
  it("saves a new route at once when another window changed other routes, keeping their change", async () => {
    const { instance, onDone, disk } = setup();
    await opened(instance);
    const changed = { ...FILE, routes: { ...FILE.routes, other: { tool: "codex" as const } } };
    disk.text = toText(changed);

    await press(instance, "daily");
    await save(instance);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("daily"));
    expect(Object.keys(routes(disk))).toEqual(["main", "solo", "other", "daily"]);
    expect(routes(disk).other).toEqual({ tool: "codex" });
  });

  it("saves an edit, its inputs as they are, when another window changed only other routes", async () => {
    const { instance, onDone, disk } = setup({ edit: "main" });
    await opened(instance);
    const changed = {
      ...FILE,
      routes: { ...FILE.routes, solo: { ...FILE.routes.solo, maxUsage: 70 }, other: { tool: "codex" as const } },
    };
    disk.text = toText(changed);

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    await save(instance);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("main"));
    expect(routes(disk)).toEqual({ ...changed.routes, main: { ...FILE.routes.main, strategy: "headroom" } });
  });

  it("says an edited route was removed in another window, and writes it again only on a second enter", async () => {
    const { instance, onDone, disk } = setup({ edit: "main" });
    await opened(instance);
    const { main: _gone, ...rest } = FILE.routes;
    disk.text = toText({ ...FILE, routes: rest });

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    await save(instance);

    const frame = await until(instance, (f) => f.includes("removed"));
    expect(frame).toContain("✘ Route main was removed in another window.");
    expect(hintLines(frame)).toEqual(["←→ choose │ tab next field │ enter save it again │ esc cancel"]);
    // Nothing written, and the inputs kept.
    expect(routes(disk)).toEqual(rest);
    expect(row(frame, "Strategy")).toMatch(/● headroom/);
    expect(onDone).not.toHaveBeenCalled();

    await save(instance);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("main"));
    expect(routes(disk)).toEqual({ ...rest, main: { ...FILE.routes.main, strategy: "headroom" } });
  });

  it("leaves a route removed in another window removed when the form is left with esc", async () => {
    const { instance, onDone, disk } = setup({ edit: "main" });
    await opened(instance);
    const { main: _gone, ...rest } = FILE.routes;
    disk.text = toText({ ...FILE, routes: rest });

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    await save(instance);
    await until(instance, (f) => f.includes("Route main was removed in another window."));

    await press(instance, ESC);
    expect(text(instance)).toContain("Discard changes? (y/N)");
    await type(instance, "y");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(routes(disk)).toEqual(rest);
  });

  it("reloads an edited route that changed on disk after the form opened, and does not overwrite it", async () => {
    const { instance, onDone, disk } = setup({ edit: "main" });
    await opened(instance);
    const changed = { ...FILE, routes: { ...FILE.routes, main: { ...FILE.routes.main, maxUsage: 70 } } };
    disk.text = toText(changed);

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    await save(instance);

    const frame = await until(instance, (f) => f.includes("changed in another window"));
    expect(frame).toContain("✘ Route main was changed in another window; it was reloaded. Review and save again.");
    // The route as it is now, the edit gone: the user reviews it and saves again.
    expect(row(frame, "Strategy")).toMatch(/● round-robin/);
    expect(row(frame, "skip at")).toMatch(/\[70\]%$/);
    expect(routes(disk)).toEqual(changed.routes);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not overwrite a route that changed before the form opened on it", async () => {
    // The screen read the route earlier, and it has changed on disk since: the spec the form was
    // given is not the one on disk, though nothing changed while the form was open.
    const onDisk = { ...FILE, routes: { ...FILE.routes, main: { ...FILE.routes.main, maxUsage: 70 } } };
    const { instance, onDone, disk } = setup({ edit: "main", spec: FILE.routes.main, file: onDisk });
    await opened(instance);

    await tabTo(instance, "Strategy");
    await press(instance, RIGHT);
    await save(instance);

    const frame = await until(instance, (f) => f.includes("changed in another window"));
    expect(row(frame, "skip at")).toMatch(/\[70\]%$/);
    expect(routes(disk)).toEqual(onDisk.routes);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("asks before discarding changes on esc: n keeps the form, y leaves it", async () => {
    const { instance, deps, onDone } = setup();
    await opened(instance);
    await press(instance, "d");

    await press(instance, ESC);
    expect(text(instance)).toContain("Discard changes? (y/N)");
    await press(instance, "n");
    expect(text(instance)).not.toContain("Discard changes?");
    // The answer is not typed into the field.
    expect(row(text(instance), "Name")).toMatch(/Name\s+d$/);
    expect(onDone).not.toHaveBeenCalled();

    await press(instance, ESC);
    expect(text(instance)).toContain("Discard changes? (y/N)");
    await type(instance, "y");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(deps.updateRoutes).not.toHaveBeenCalled();
  });

  it("leaves at once on esc when nothing changed", async () => {
    const { instance, onDone } = setup({ edit: "main" });
    await opened(instance);

    await type(instance, ESC);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(text(instance)).not.toContain("Discard changes?");
  });

  it("refuses an API profile named by a pattern", async () => {
    const { instance, deps, onDone, disk } = setup();
    await opened(instance);
    await press(instance, "paid");
    await tabTo(instance, "from");
    await press(instance, "gateway");

    await save(instance);
    const frame = await until(instance, (f) => f.includes("API profile"));
    expect(frame).toContain("claude:gateway is an API profile.");
    expect(deps.updateRoutes).not.toHaveBeenCalled();
    expect(routes(disk).paid).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("never draws a key typed as the name, and refuses it", async () => {
    // Built from pieces, so the file carries nothing a secret scanner takes for a key.
    const key = ["sk", "ant", "api03", ["Qm7", "Zt4", "Wb9", "Lp2"].join("").repeat(4)].join("-");
    const { instance, onDone, disk } = setup();
    await opened(instance);

    await press(instance, key);
    expect(row(text(instance), "Name")).toMatch(/Name\s+•{8}$/);
    await save(instance);

    await until(instance, (f) => f.includes("That looks like an API key, not a route name."));
    expect(windowsOnScreen(instance.frames, key)).toEqual([]);
    expect(routes(disk)).toEqual(FILE.routes);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("never draws a key pasted into a pattern field, and refuses it", async () => {
    const key = ["sk", "ant", "api03", ["Hd5", "Rk8", "Vn3", "Jc6"].join("").repeat(4)].join("-");
    const { instance, onDone } = setup();
    await opened(instance);
    await press(instance, "keyed");
    await tabTo(instance, "from");

    await press(instance, `team, ${key}`);
    expect(row(text(instance), "from")).toMatch(/from\s+•{8}$/);
    await save(instance);

    await until(instance, (f) => f.includes("looks like an API key"));
    expect(windowsOnScreen(instance.frames, key)).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows a long list of patterns as it is: only a key is hidden", async () => {
    const { instance } = setup();
    await opened(instance);
    await tabTo(instance, "from");

    const emails = "alice@work.example.com, bob@work.example.com, carol@work.example.com";
    await press(instance, emails);
    expect(row(text(instance), "from")).toContain(emails);
  });

  describe("in a terminal shorter than the account list", () => {
    /** Twenty claude accounts and twenty codex ones: an `all` route lists forty. */
    const MANY: Registry = {
      ...REGISTRY,
      profiles: Object.fromEntries(
        (["claude", "codex"] as const).flatMap((tool) =>
          Array.from({ length: 20 }, (_, i) => {
            const name = `acct-${String(i + 1).padStart(2, "0")}`;
            return [`${tool}:${name}`, profile(tool, name)];
          }),
        ),
      ),
    };
    const ids = (tool: "claude" | "codex") => Object.keys(MANY.profiles).filter((id) => id.startsWith(`${tool}:`));
    /** The account rows on screen: a `[ ]` or `[x]` and an id. */
    const shownIds = (frame: string) =>
      lines(frame).flatMap((line) => /\[[ x]\] ((?:claude|codex):\S+)/.exec(line)?.[1] ?? []);
    const more = (frame: string, arrow: "↑" | "↓") => Number(new RegExp(`${arrow} (\\d+) more`).exec(frame)?.[1] ?? 0);

    // Once ink's output reached the terminal's height it cleared the screen and rewrote the
    // frame on every render: the form flickered, the scrollback went, Name and Tool off the top.
    it("lists only the accounts that fit, the cursor's always among them, and scrolls with it", async () => {
      const ROWS = 34;
      const { instance } = setup({ registry: MANY, rows: ROWS, columns: 80 });
      await opened(instance);
      const first = text(instance);
      expect(lines(first).length).toBeLessThan(ROWS);
      expect(first).toContain("Name");
      expect(first).toContain("every account (*)");
      const shown = shownIds(first);
      expect(shown.length).toBeGreaterThanOrEqual(3);
      expect(shown).toEqual(ids("claude").slice(0, shown.length));
      expect(more(first, "↓")).toBe(20 - shown.length);
      expect(first).not.toMatch(/↑ \d+ more/);

      await tabTo(instance, "Accounts");
      for (const [index, id] of ids("claude").entries()) {
        await press(instance, DOWN);
        const frame = text(instance);
        expect(lines(frame).length, id).toBeLessThan(ROWS);
        expect(frame, id).toMatch(accountRow(id));
        expect(frame).toContain("every account (*)");
        const now = shownIds(frame);
        // What is above and below the window is counted, and the window is a run of the list.
        expect(more(frame, "↑") + now.length + more(frame, "↓"), id).toBe(20);
        expect(now).toEqual(ids("claude").slice(more(frame, "↑"), more(frame, "↑") + now.length));
        if (index === 19) expect(more(frame, "↓")).toBe(0);
      }
      expect(more(text(instance), "↑")).toBeGreaterThan(0);
      // Back up to the top: the first account comes back into the window.
      for (let i = 0; i < 20; i++) await press(instance, UP);
      expect(text(instance)).toMatch(/▸ \[x\] every account/);
      await press(instance, DOWN);
      expect(shownIds(text(instance))[0]).toBe("claude:acct-01");
      expect(text(instance)).not.toMatch(/↑ \d+ more/);

      // The picker's line and an error's take room from the accounts, not past the terminal.
      await tabTo(instance, "Fallback");
      await press(instance, "a");
      expect(text(instance)).toContain("The pool takes every account");
      expect(lines(text(instance)).length).toBeLessThan(ROWS);
      await press(instance, ESC);
      await save(instance);
      const refused = await until(instance, (f) => f.includes("Give the route a name."));
      expect(lines(refused).length).toBeLessThan(ROWS);
      expect(shownIds(refused).length).toBe(shown.length - 1);
    });

    it("lists fewer when the terminal is resized smaller, and both tools' accounts in the same room", async () => {
      const { instance, watched } = setup({ registry: MANY, rows: 40, columns: 80 });
      await opened(instance);
      const tall = shownIds(text(instance)).length;

      watched?.resize(80, 30);
      const frame = await until(instance, (f) => shownIds(f).length < tall);
      expect(lines(frame).length).toBeLessThan(30);
      expect(shownIds(frame).length).toBe(tall - 10);

      await tabTo(instance, "Tool");
      await press(instance, RIGHT);
      await press(instance, RIGHT);
      expect(lines(text(instance)).length).toBeLessThan(30);
      expect(more(text(instance), "↓")).toBe(40 - shownIds(text(instance)).length);
    });

    it("keeps three accounts on screen however short the terminal", async () => {
      const { instance } = setup({ registry: MANY, rows: 12, columns: 80 });
      await opened(instance);
      // Two accounts and the count below them: three lines.
      expect(shownIds(text(instance))).toHaveLength(2);
      expect(more(text(instance), "↓")).toBe(18);
    });
  });

  it("fits 80 columns without wrapping a line", async () => {
    const { instance } = setup({ edit: "main", columns: 80 });
    await opened(instance);
    const frame = text(instance);

    expect(row(frame, "claude:ops-share")).toMatch(/\[ \] claude:ops-share\s+0%\s+64%\s+excluded$/);
    expect(row(frame, "Tool")).toMatch(/○ claude \+ codex$/);
    for (const line of lines(frame)) expect(line.length).toBeLessThanOrEqual(80);
  });
});
