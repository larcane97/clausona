import { Text } from "ink";
import { fitQuotaValue, NO_SESSION } from "../../lib/format.js";
import type { QuotaWindow } from "../../types.js";
import { color } from "../theme.js";

const EM_DASH = "—";

const QUOTA_CRITICAL = 90;
const QUOTA_WARNING = 75;

/**
 * A quota reading's colour, for every TUI surface that shows one: the profile panel and the
 * routes screens grade the same reading the same way. A reading that is not live is a
 * last-known value, so it is muted whatever it says.
 */
export function quotaColor(window: QuotaWindow, live: boolean): string {
  if (!live) return color.muted;
  if (window.usedPercent >= QUOTA_CRITICAL) return color.error;
  if (window.usedPercent >= QUOTA_WARNING) return color.warning;
  return color.text;
}

/**
 * One quota window cut to `width` by what it drops (`fitQuotaValue`), or a muted dash. `cut` is a
 * route's, on the routes screens: a reading under it never reads as it. Without one, the reading
 * is rounded as everywhere else. `none` is a 5H cell's on a plan with no 5-hour limit, which says
 * so, muted, where no reading is a dash.
 */
export function QuotaCell({
  window,
  live,
  width,
  bold,
  cut,
  none = false,
}: {
  window?: QuotaWindow;
  live: boolean;
  width: number;
  bold?: boolean;
  cut?: number;
  none?: boolean;
}) {
  if (!window) {
    return (
      <Text color={color.muted} bold={bold} wrap="truncate-end">
        {none ? NO_SESSION : EM_DASH}
      </Text>
    );
  }
  return (
    <Text color={quotaColor(window, live)} bold={bold} wrap="truncate-end">
      {fitQuotaValue(window, width, new Date(), cut)}
    </Text>
  );
}
