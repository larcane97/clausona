import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuotaHttpError } from "../core/quota.js";
import { collectQuotas } from "../core/quota-store.js";
import { withDefaults } from "../core/route-config.js";
import { routesPaths } from "../core/routes-store.js";
import type { ToolAdapter } from "../tools/types.js";
import type { QuotaSnapshot, QuotaWindow, QuotaWindows, Registry } from "../types.js";
import { stripAnsi } from "./cli-style.js";
import { clockTime } from "./route-render.js";
import type { RouteDeps } from "./route-service.js";
import { RECHECK_MS, RETRY_MS, rankWaiting, WAKE_MARGIN_MS, WaitInterrupted } from "./route-wait.js";
import { DEFAULT_WAIT_MS } from "./run-args.js";

// The real quota cache is read in a few cases below, against a stand-in for the usage endpoint.
const getAdapter = vi.hoisted(() => vi.fn());
vi.mock("../tools/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/registry.js")>()),
  getAdapter,
}));

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const MINUTE = 60_000;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REGISTRY: Registry = {
  version: 2,
  primarySources: { claude: "/home/u/.claude" },
  activeProfiles: { claude: "claude:a" },
  profiles: {
    "claude:a": { tool: "claude", configDir: "/home/u/.claude", email: "a@example.com", isPrimary: true },
    "claude:b": { tool: "claude", configDir: "/home/u/.claude-b", email: "b@example.com" },
  },
};

const MAIN = { route: withDefaults({ tool: "claude", from: ["*"] }) };
/** A route of claude:a alone, for readings that leave claude:b out. */
const ONLY_A = { route: withDefaults({ tool: "claude", from: ["a"] }) };

/** A reading whose 5H window is at `percent`, resetting `resetIn` ms after NOW (null: unknown). */
function five(percent: number, resetIn: number | null, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  const session: QuotaWindow = { usedPercent: percent, resetsAt: resetIn === null ? null : iso(resetIn) };
  return { state: "ok", fetchedAt: NOW, session, ...extra };
}
const iso = (afterNow: number) => new Date(NOW + afterNow).toISOString();

/**
 * Deps on a fake clock that only sleeping moves. `readings` answers each quota read from the time
 * it is read at, and whether it was asked to refresh. Sleeps, reads and what is said are kept.
 */
function setup(readings: (now: number, refresh: boolean) => Record<string, QuotaSnapshot>) {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-route-wait-"));
  temps.push(dir);
  const paths = routesPaths(dir);
  const state = { now: NOW, listening: false, interrupt: () => {} };
  const sleeps: number[] = [];
  const reads: boolean[] = [];
  const said: string[] = [];
  const deps: RouteDeps = {
    loadRegistry: async () => REGISTRY,
    collectQuotas: async (_targets, options) => {
      const refresh = options?.refreshBefore !== undefined;
      reads.push(refresh);
      return readings(state.now, refresh);
    },
    paths,
    clock: () => state.now,
    editText: async () => "",
    cwd: dir,
    home: dir,
    // Two waits that sleep from the same moment for the same time wake at the same moment.
    sleep: async (ms) => {
      sleeps.push(ms);
      const until = state.now + ms;
      await Promise.resolve();
      state.now = Math.max(state.now, until);
    },
    onInterrupt: (handler) => {
      state.interrupt = handler;
      state.listening = true;
      return () => {
        state.listening = false;
      };
    },
    progress: (text) => said.push(stripAnsi(text)),
  };
  const picks = () =>
    existsSync(paths.picksPath) ? JSON.parse(readFileSync(paths.picksPath, "utf8")).lastPicked : undefined;
  return { deps, state, sleeps, reads, said, paths, picks };
}

describe("rankWaiting", () => {
  it("sleeps until 30 s after the soonest reset, reads quota afresh, and picks", async () => {
    const s = setup((now) => ({
      "claude:a": now >= NOW + 20 * MINUTE ? five(0, 5 * 60 * MINUTE) : five(100, 20 * MINUTE),
      "claude:b": five(100, 40 * MINUTE),
    }));
    const { ranking, gaveUp } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(gaveUp).toBeUndefined();
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(s.sleeps).toEqual([20 * MINUTE + WAKE_MARGIN_MS]);
    expect(s.reads).toEqual([false, true]);
    const until = clockTime(NOW + 20 * MINUTE + WAKE_MARGIN_MS, NOW);
    expect(s.said).toEqual([`  waiting until ${until} for claude:a (5H resets) …`]);
    expect(s.picks()).toEqual({ "claude:a": new Date(s.state.now).toISOString() });
    expect(s.state.listening).toBe(false);
  });

  it("checks again at least every 30 minutes, refreshing each time and saying it once", async () => {
    const s = setup((now) => ({
      "claude:a": now >= NOW + 100 * MINUTE ? five(0, null) : five(100, 100 * MINUTE),
      "claude:b": five(100, 200 * MINUTE),
    }));
    const { ranking } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(s.sleeps).toEqual([RECHECK_MS, RECHECK_MS, RECHECK_MS, 10 * MINUTE + WAKE_MARGIN_MS]);
    expect(s.reads).toEqual([false, true, true, true, true]);
    expect(s.said).toHaveLength(1);
  });

  it("gives up at once when the soonest reset is past the cap, and waits for one right at it", async () => {
    const far = setup(() => ({ "claude:a": five(100, 6 * 60 * MINUTE), "claude:b": five(100, 7 * 60 * MINUTE) }));
    const past = await rankWaiting(MAIN, far.deps, { resume: false, capMs: 5 * 60 * MINUTE });
    expect(past.gaveUp).toBe("past-cap");
    expect(past.ranking.outcome).toEqual({ kind: "none", soonest: { id: "claude:a", at: iso(6 * 60 * MINUTE) } });
    expect([far.sleeps, far.said, far.picks()]).toEqual([[], [], undefined]);

    const atCap = setup((now) => ({ "claude:a": five(now >= NOW + 30 * MINUTE ? 0 : 100, 30 * MINUTE) }));
    const reached = await rankWaiting(MAIN, atCap.deps, { resume: false, capMs: 30 * MINUTE });
    expect(reached.ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
  });

  it("gives up at once when no account held back has a known reset", async () => {
    const s = setup(() => ({ "claude:a": five(100, null), "claude:b": five(1, 1, { state: "missing" }) }));
    const { ranking, gaveUp } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(gaveUp).toBe("no-reset");
    expect(ranking.outcome).toEqual({ kind: "none" });
    expect(s.sleeps).toEqual([]);
  });

  it("keeps waiting on the cached reading while quota reads cool down, then picks on a fresh one", async () => {
    let cooling = true;
    const s = setup((now, refresh) => {
      if (now < NOW + 10 * MINUTE) return { "claude:a": five(100, 10 * MINUTE) };
      // The first read after the reset is refused (429): the cache's numbers come back as they were.
      if (refresh && cooling) {
        cooling = false;
        return { "claude:a": five(100, 10 * MINUTE, { state: "cooldown" }) };
      }
      return { "claude:a": five(2, 5 * 60 * MINUTE, { fetchedAt: now }) };
    });
    const { ranking } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(s.sleeps).toEqual([10 * MINUTE + WAKE_MARGIN_MS, RETRY_MS]);
    expect(s.reads).toEqual([false, true, true]);
    const capEnd = clockTime(NOW + DEFAULT_WAIT_MS, NOW);
    expect(s.said[1]).toBe(`  waiting until ${capEnd} for claude:a (for a new quota reading) …`);
  });

  it("gives up when the cap runs out on a reading that still shows the account full", async () => {
    const s = setup(() => ({ "claude:a": five(100, 10 * MINUTE, { state: "cooldown" }) }));
    const { gaveUp } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: 12 * MINUTE });
    expect(gaveUp).toBe("past-cap");
    // To the reset, then to the cap: never past it on a reading that is not coming.
    expect(s.sleeps).toEqual([10 * MINUTE + WAKE_MARGIN_MS, 90_000]);
  });

  it("after a sleep, still gives up at once when no account could come free", async () => {
    const s = setup((now) => ({
      "claude:a": now < NOW + 10 * MINUTE ? five(100, 10 * MINUTE) : five(1, 1, { state: "missing" }),
    }));
    const { gaveUp } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(gaveUp).toBe("no-reset");
    expect(s.sleeps).toEqual([10 * MINUTE + WAKE_MARGIN_MS]);
  });

  it("reads a reset that has already passed again at once, before sleeping on it", async () => {
    const s = setup((_now, refresh) => ({ "claude:a": refresh ? five(0, null) : five(100, -MINUTE) }));
    const { ranking } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect([s.sleeps, s.reads]).toEqual([[], [false, true]]);
  });

  it("waits for the reset of the limit on the run's model, and names it", async () => {
    const opus = (percent: number) => ({ label: "Opus", usedPercent: percent, resetsAt: iso(3 * 60 * MINUTE) });
    const s = setup((now) => {
      const limit = opus(now >= NOW + 3 * 60 * MINUTE ? 0 : 100);
      return { "claude:a": { ...five(10, MINUTE), scoped: limit, scopedLimits: [limit] } };
    });
    const { ranking } = await rankWaiting(MAIN, s.deps, { resume: false, model: "opus", capMs: DEFAULT_WAIT_MS });
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    expect(s.said[0]).toMatch(/for claude:a \(Opus resets\) …$/);
    // Six re-checks reach the reset itself, and the reading there already shows it free.
    expect(s.sleeps).toEqual(Array(6).fill(RECHECK_MS));
  });

  it("spreads two waits that wake together across accounts, as picks under the lock do", async () => {
    const s = setup((now) => {
      const free = now >= NOW + 10 * MINUTE;
      return { "claude:a": five(free ? 0 : 100, 10 * MINUTE), "claude:b": five(free ? 0 : 100, 10 * MINUTE) };
    });
    const both = await Promise.all([
      rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS }),
      rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS }),
    ]);
    const ids = both.map(({ ranking }) => (ranking.outcome.kind === "picked" ? ranking.outcome.id : null));
    expect(ids.sort()).toEqual(["claude:a", "claude:b"]);
    expect(Object.keys(s.picks()).sort()).toEqual(["claude:a", "claude:b"]);
  });

  it("stops with exit code 130 on Ctrl-C while it sleeps, leaving no record and no lock", async () => {
    const s = setup(() => ({ "claude:a": five(100, 10 * MINUTE) }));
    s.deps.sleep = async () => s.state.interrupt();
    const error = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitInterrupted);
    expect((error as WaitInterrupted).exitCode).toBe(130);
    expect([existsSync(s.paths.picksPath), existsSync(s.paths.picksLock), s.state.listening]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("records nothing and lets go of the lock on Ctrl-C while it reads quota after waking", async () => {
    const s = setup((now) => {
      if (now < NOW + 10 * MINUTE) return { "claude:a": five(100, 10 * MINUTE) };
      s.state.interrupt();
      return { "claude:a": five(0, null) };
    });
    const error = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitInterrupted);
    expect([existsSync(s.paths.picksPath), existsSync(s.paths.picksLock), s.state.listening]).toEqual([
      false,
      false,
      false,
    ]);
  });
});

/**
 * `setup`, but quota is read through the real collectQuotas - its cache, its freshness and its
 * 429 cooldown - from an endpoint stand-in that `answer` plays at the fake clock's time, for the
 * account whose config dir it is given. `fetched` is when each request was made; `asked`, whose.
 */
function setupReads(answer: (now: number, configDir: string) => QuotaWindows) {
  const s = setup(() => ({}));
  const cachePath = path.join(path.dirname(s.paths.picksPath), "quota.json");
  const fetched: number[] = [];
  const asked: string[] = [];
  const adapter: Partial<ToolAdapter> = {
    // The stand-in's token is the account's config dir, so that a fetch knows whose it is.
    readCredential: async (configDir) => ({ accessToken: configDir }),
    fetchQuota: async (credential) => {
      fetched.push(s.state.now - NOW);
      asked.push(credential.accessToken);
      return answer(s.state.now, credential.accessToken);
    },
  };
  getAdapter.mockReturnValue(adapter);
  s.deps.collectQuotas = (targets, options) => collectQuotas(targets, { ...options, now: s.state.now, cachePath });
  const writeCache = (profiles: Record<string, QuotaSnapshot>) =>
    writeFileSync(cachePath, JSON.stringify({ version: 1, cooldowns: {}, profiles }));
  return { ...s, fetched, asked, writeCache };
}

describe("rankWaiting on real quota reads", () => {
  it("keeps waiting through a 429 at the 30-minute re-check, and runs once the account frees", async () => {
    const s = setupReads((now) => {
      // Refused once, at the re-check: a 429 with no Retry-After pauses reads for an hour.
      if (now === NOW + 30 * MINUTE) throw new QuotaHttpError(429);
      const free = now >= NOW + 60 * MINUTE;
      return { session: { usedPercent: free ? 0 : 100, resetsAt: free ? null : iso(60 * MINUTE) } };
    });
    const { ranking, gaveUp } = await rankWaiting(ONLY_A, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(gaveUp).toBeUndefined();
    expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
    // Read at the start, refused at the re-check, then nothing asked until the cooldown lifts. At
    // 60 minutes the reading kept from the start is an hour old and no longer used: no reset is
    // known, yet the wait goes on, asking every 5 minutes.
    expect(s.fetched).toEqual([0, 30 * MINUTE, 90 * MINUTE]);
    expect(s.sleeps).toEqual([RECHECK_MS, RECHECK_MS, ...Array(6).fill(RETRY_MS)]);
    // Said once while it reads again every 5 minutes, with the latest it waits until: the cap.
    const until = clockTime(NOW + DEFAULT_WAIT_MS, NOW);
    expect(s.said.filter((line) => line.includes("new quota reading"))).toEqual([
      `  waiting until ${until} for claude:a (for a new quota reading) …`,
    ]);
  });

  it("is not kept waiting by an account it never read, and gives up at once past the cap", async () => {
    const s = setupReads((now, dir) => {
      // claude:b's usage endpoint fails every time: it has never had a reading.
      if (dir === "/home/u/.claude-b") throw new QuotaHttpError(500);
      // claude:a's 5H resets at 20 minutes, and then its week reads full until 3 days on.
      return now < NOW + 20 * MINUTE
        ? { session: { usedPercent: 100, resetsAt: iso(20 * MINUTE) } }
        : {
            session: { usedPercent: 0, resetsAt: null },
            weekly: { usedPercent: 100, resetsAt: iso(72 * 60 * MINUTE) },
          };
    });
    const { gaveUp } = await rankWaiting(MAIN, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
    expect(gaveUp).toBe("past-cap");
    expect(s.sleeps).toEqual([20 * MINUTE + WAKE_MARGIN_MS]);
    expect(s.asked.filter((dir) => dir === "/home/u/.claude-b")).toHaveLength(2);
    expect(s.said).toEqual([expect.stringMatching(/for claude:a \(5H resets\) …$/)]);
  });

  it("reuses a reading another wait took since the reset, and reads again one taken before it", async () => {
    for (const [siblingAt, reads] of [
      [10 * MINUTE + 15_000, [0]],
      [5 * MINUTE, [0, 10 * MINUTE + WAKE_MARGIN_MS]],
    ] as const) {
      const s = setupReads((now) => ({
        session: { usedPercent: now >= NOW + 10 * MINUTE ? 0 : 100, resetsAt: iso(10 * MINUTE) },
      }));
      const sleep = s.deps.sleep;
      // While this wait sleeps, another one reads the account and caches what it got.
      s.deps.sleep = async (ms, signal) => {
        const free = siblingAt >= 10 * MINUTE;
        s.writeCache({ "claude:a": five(free ? 0 : 100, 10 * MINUTE, { fetchedAt: NOW + siblingAt }) });
        await sleep(ms, signal);
      };
      const { ranking } = await rankWaiting(ONLY_A, s.deps, { resume: false, capMs: DEFAULT_WAIT_MS });
      expect(ranking.outcome).toMatchObject({ kind: "picked", id: "claude:a" });
      expect(s.fetched).toEqual(reads);
    }
  });
});

describe("clockTime", () => {
  // Built from local fields, so the expectation holds in any time zone.
  const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime();

  it("is the time of day, with the date when it is another day", () => {
    expect(clockTime(local(13, 14, 5), local(13, 9, 0))).toBe("14:05");
    expect(clockTime(local(13, 0, 0), local(13, 23, 59))).toBe("00:00");
    expect(clockTime(local(15, 9, 30), local(13, 9, 0))).toBe("Oct 15 09:30");
  });
});
