import { FULL, type Ranking } from "../core/routing.js";
import { renderWaiting, resettingWindow } from "./route-render.js";
import { type ResolvedRoute, type RouteDeps, rankRouteNow } from "./route-service.js";

/** A wait wakes this long after a reset, by when the window has rolled over and a reading says so. */
export const WAKE_MARGIN_MS = 30 * 1000;

/** A wait reads quota again at least this often, so an account that frees up early is seen. */
export const RECHECK_MS = 30 * 60 * 1000;

/**
 * How long a wait gives a reading that still shows an account full after its reset - a read
 * cooling down after a 429, or failing - before it reads again.
 */
export const RETRY_MS = 5 * 60 * 1000;

/** Exit code 130: Ctrl-C while waiting. Nothing was picked or recorded, and no lock is left. */
export class WaitInterrupted extends Error {
  readonly exitCode = 130;
  constructor() {
    super("Stopped waiting. No account was picked.");
    this.name = "WaitInterrupted";
  }
}

/**
 * Why a wait gave up without waiting (more): the soonest reset is past the cap (or the cap ran
 * out), or no account held back by its usage has a known reset.
 */
export type GaveUp = "past-cap" | "no-reset";

/**
 * `--wait`: picks as a run does, and while nobody can be picked, sleeps until the soonest moment an
 * account held back by its usage can run again - the latest reset among its windows at 100% -
 * plus WAKE_MARGIN_MS, reading quota again at least every RECHECK_MS. Each check after the first
 * refreshes quota (a tool cooling down after a 429 keeps its cached reading) and ranks from the
 * start. It gives up at once, returning the last ranking, when that reset is past `capMs` from
 * now or none is known. Nothing is recorded until it picks, and then under the pick-record lock as
 * any pick is, so waits that wake together still take different accounts.
 */
export async function rankWaiting(
  resolved: Pick<ResolvedRoute, "route" | "onlyTool">,
  deps: RouteDeps,
  options: { resume: boolean; model?: string; capMs: number },
): Promise<{ ranking: Ranking; gaveUp?: GaveUp }> {
  const deadline = deps.clock() + options.capMs;
  const controller = new AbortController();
  let stopListening: (() => void) | undefined;
  let said: string | undefined;
  let refresh = false;
  try {
    for (;;) {
      const ranking = await rankRouteNow(resolved, deps, {
        resume: options.resume,
        record: true,
        model: options.model,
        refresh,
        signal: controller.signal,
      });
      // A pick that was recorded runs, even with a Ctrl-C just after it.
      if (ranking.outcome.kind === "picked") return { ranking };
      controller.signal.throwIfAborted();
      const now = deps.clock();
      const { soonest } = ranking.outcome;
      if (!soonest) return { ranking, gaveUp: "no-reset" };
      const resetAt = Date.parse(soonest.at);
      if (resetAt > deadline || now >= deadline) return { ranking, gaveUp: "past-cap" };

      // A reset already past whose account still reads as full is an old reading: read again
      // now if this check did not, else give the read a while.
      const passed = resetAt + WAKE_MARGIN_MS <= now;
      const wake = passed ? (refresh ? Math.min(now + RETRY_MS, deadline) : now) : resetAt + WAKE_MARGIN_MS;
      refresh = true;
      if (wake <= now) continue;

      const row = ranking.rows.find((each) => each.id === soonest.id);
      const line = renderWaiting(soonest.id, row && !passed ? resettingWindow(row, FULL, soonest.at) : undefined, {
        until: wake,
        now,
      });
      if (line !== said) deps.progress(line);
      said = line;
      stopListening ??= deps.onInterrupt(() => controller.abort(new WaitInterrupted()));
      await deps.sleep(Math.min(wake, now + RECHECK_MS) - now, controller.signal);
      controller.signal.throwIfAborted();
    }
  } finally {
    stopListening?.();
  }
}
