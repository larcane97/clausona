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
