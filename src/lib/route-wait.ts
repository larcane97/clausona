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
 * plus WAKE_MARGIN_MS, reading quota again at least every RECHECK_MS. Each check after a sleep
 * reads again what was read before it (a tool cooling down after a 429 keeps its cached reading,
 * and a reading another wait took since is used as it is) and ranks from the start. It gives up
 * at once, returning the last ranking, when that reset is past `capMs` from now or none is known;
 * after a sleep, an account a refused or failed read left with no usable reading keeps it waiting
 * until the cap. Nothing is recorded until it picks, and then under the pick-record lock as any
 * pick is, so waits that wake together still take different accounts.
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
  // Quota fetched before this is read again. Unset on the first check, which takes the cache as
  // any run does.
  let refreshBefore: number | undefined;
  let slept = false;
  try {
    for (;;) {
      const ranking = await rankRouteNow(resolved, deps, {
        resume: options.resume,
        record: true,
        model: options.model,
        refreshBefore,
        signal: controller.signal,
      });
      // A pick that was recorded runs, even with a Ctrl-C just after it.
      if (ranking.outcome.kind === "picked") return { ranking };
      controller.signal.throwIfAborted();
      const now = deps.clock();
      if (now >= deadline) return { ranking, gaveUp: "past-cap" };

      const { soonest } = ranking.outcome;
      const retry = Math.min(now + RETRY_MS, deadline);
      let next: { wake: number; id: string; window?: string } | undefined;
      if (soonest && Date.parse(soonest.at) <= deadline) {
        const resetAt = Date.parse(soonest.at);
        const row = ranking.rows.find((each) => each.id === soonest.id);
        // A reset already past whose account still reads as full is an old reading: read again
        // now if this check did not, else give the read a while.
        next =
          resetAt + WAKE_MARGIN_MS > now
            ? { wake: resetAt + WAKE_MARGIN_MS, id: soonest.id, window: row && resettingWindow(row, FULL, soonest.at) }
            : { wake: refreshBefore === undefined ? now : retry, id: soonest.id };
      }
      // After a sleep, an account left without a usable reading - a read refused with a 429, or
      // failed, while its last one aged past the hour it is trusted - may come free like any
      // other: it is read again a while later, until the cap, rather than taken for one whose
      // reset nobody knows.
      const unread = slept ? ranking.rows.find((row) => row.skip === "no-reading") : undefined;
      if (unread && (!next || retry < next.wake)) next = { wake: retry, id: unread.id };
      if (!next) return { ranking, gaveUp: soonest ? "past-cap" : "no-reset" };
      if (next.wake <= now) {
        refreshBefore = now;
        continue;
      }

      const line = renderWaiting(next.id, next.window, { until: next.wake, now });
      if (line !== said) deps.progress(line);
      said = line;
      stopListening ??= deps.onInterrupt(() => controller.abort(new WaitInterrupted()));
      const until = Math.min(next.wake, now + RECHECK_MS);
      await deps.sleep(until - now, controller.signal);
      controller.signal.throwIfAborted();
      slept = true;
      // What was read before the wake, less the margin - before the reset it waited for - is read
      // again; one another wait read since then, often the moment before, is used as it is.
      refreshBefore = until - WAKE_MARGIN_MS;
    }
  } finally {
    stopListening?.();
  }
}
