/**
 * Keeping a screen inside the terminal's height. Once ink's frame is as tall as the terminal,
 * ink 6 clears the terminal, scrollback included, and writes the whole frame again on every
 * render: a taller frame loses its top for good, the title and the list's cursor with it, and one
 * exactly as tall flickers on every key (#179). So a screen works out the lines it may take before
 * ink draws it - a measurement comes a frame late, and that frame is the one redrawn whole - and
 * each list shows what fits.
 */

/** The lines a frame keeps short of the terminal's height, as the Extensions screen's does. */
export const SPARE_ROWS = 2;

export type ListWindow = {
  /** The first item shown. */
  start: number;
  /** The item after the last one shown. */
  end: number;
  /** The items left out above, which a line says when there are any. */
  above: number;
  /** The items left out below, which a line says when there are any. */
  below: number;
};

/**
 * The items a list `room` lines tall shows of `total`, each `size` lines: all of them when they
 * fit, else a window, after a line saying how many are above it when any are and before one
 * saying how many are below. The window keeps `cursor` in it and moves from `start`, where it
 * began last time, only as far as the cursor takes it, and never ends short of the last item
 * while there are items above it. It shows one item however little room there is: the cursor's
 * row is what the list is for.
 */
export function listWindow(total: number, room: number, cursor: number | null, start: number, size = 1): ListWindow {
  if (total * size <= room) return { start: 0, end: total, above: 0, below: 0 };
  /** The items a window from `from` holds: to the end with no line below, or one line fewer. */
  const shown = (from: number) => {
    const up = from > 0 ? 1 : 0;
    const toEnd = Math.floor((room - up) / size);
    if (from + toEnd >= total) return total - from;
    return Math.max(1, Math.floor((room - up - 1) / size));
  };
  let from = Math.max(0, Math.min(start, total - 1));
  if (cursor !== null) {
    const at = Math.max(0, Math.min(cursor, total - 1));
    if (at < from) from = at;
    while (at >= from + shown(from)) from += 1;
  }
  while (from > 0 && from - 1 + shown(from - 1) >= total) from -= 1;
  const end = Math.min(total, from + shown(from));
  return { start: from, end, above: from, below: total - end };
}
