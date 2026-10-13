import { type DOMElement, measureElement, useStdout } from "ink";
import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

/**
 * The width ink laid an element out at, for a component that fits its own text to it rather than
 * leaving the cut to ink - which cuts from the end, and cuts every child of a row at once.
 *
 * Measured, not worked out from the terminal's width: the same component sits in screens that lay
 * it out differently, and a width derived from an estimate of those was a column off. ink knows the
 * width only once it has laid a frame out, so until then this is infinite and the component draws
 * all of its text; the measurement, taken after every render, redraws it at once.
 *
 * A resized terminal is laid out again by ink without rendering anything, so it is made a render
 * here. Without that the widths of the old terminal stayed until something else re-rendered: the
 * Usage table, measured at 100 columns and resized to 60, cut its counts to `70,959,95`.
 */
export function useWidth(): [RefObject<DOMElement | null>, number] {
  const element = useRef<DOMElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const { stdout } = useStdout();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    stdout.on("resize", rerender);
    return () => {
      stdout.off("resize", rerender);
    };
  }, [stdout]);
  useLayoutEffect(() => {
    if (!element.current) return;
    const measured = measureElement(element.current).width;
    if (measured !== width) setWidth(measured);
  });
  return [element, width ?? Number.POSITIVE_INFINITY];
}

/**
 * The lines a wrapping row of boxes that do not shrink takes `width` columns wide, the boxes
 * `widths` wide with `gap` between two on a line, as ink lays such a row out: a box goes on the
 * line it is on when it fits there after the gap, and starts the next line when it does not.
 *
 * Worked out rather than measured, for a screen that fits itself to the terminal's height: a
 * measurement comes a frame late, and that frame, as tall as the terminal, is redrawn whole.
 */
export function wrappedLines(widths: readonly number[], gap: number, width: number): number {
  let lines = 0;
  let used = 0;
  for (const each of widths) {
    if (lines > 0 && used + gap + each <= width) used += gap + each;
    else {
      lines += 1;
      used = each;
    }
  }
  return lines;
}

/**
 * The lines a Text that wraps, as ink's does unless told otherwise, takes for `text` `width`
 * columns wide. This is wrap-ansi's rule as ink calls it (hard, untrimmed), step for step: a line
 * breaks before a word that does not fit, the space before the word kept at the end of the line,
 * and a word longer than a whole line is cut across lines, from where the line is when that takes
 * no more lines than starting a new one. Every character is taken to be a column wide.
 */
export function textLines(text: string, width: number): number {
  const columns = Math.max(1, width);
  let lines = 1;
  /** The columns the last line holds. */
  let used = 0;
  const newLine = () => {
    lines += 1;
    used = 0;
  };
  for (const [index, word] of text.split(" ").entries()) {
    const length = [...word].length;
    if (index > 0) {
      if (used >= columns) newLine();
      used += 1;
    }
    if (length > columns) {
      const fromHere = 1 + Math.floor((length - (columns - used) - 1) / columns);
      const fromNext = Math.floor((length - 1) / columns);
      if (fromNext < fromHere) newLine();
      for (let at = 0; at < length; at++) {
        if (used >= columns) newLine();
        used += 1;
        if (used === columns && at < length - 1) newLine();
      }
      continue;
    }
    if (used + length > columns && used > 0 && length > 0) newLine();
    used += length;
  }
  return lines;
}

/**
 * The terminal's size, read again when it is resized; either is undefined when stdout does not
 * say (a test's, or a pipe). A screen that can outgrow the height fits its lists to it: once ink's
 * output reaches the terminal's height, ink 6 clears the terminal and writes the whole frame again
 * on every render, which flickers, wipes the scrollback and pushes the top off.
 */
export function useTerminalSize(): { columns?: number; rows?: number } {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns, rows: stdout.rows });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}
