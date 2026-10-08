import { useStdout } from "ink";
import { useEffect, useReducer } from "react";

/**
 * The terminal's size, drawn again on resize: the screen picks its layout from it. ink lays a
 * resized terminal out again without rendering, so a layout chosen from the old width would
 * stay until something else re-rendered - the Usage table's bug, told in use-width.ts. A stream
 * that gives no size is read as 80 by 24, as `pickLayout` reads one.
 */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    stdout.on("resize", rerender);
    return () => {
      stdout.off("resize", rerender);
    };
  }, [stdout]);
  return { columns: stdout.columns || 80, rows: stdout.rows || 24 };
}
