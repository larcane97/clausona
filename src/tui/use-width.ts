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
