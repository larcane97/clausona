import { useStdout } from "ink";
import { useEffect, useReducer } from "react";

/**
 * The terminal's size, drawn again on resize: the screen picks its layout from it. ink lays a
 * resized terminal out again without rendering, so a layout chosen from the old width would
 * stay until something else re-rendered (memory of the Usage table bug, use-width.ts).
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
  return { columns: stdout.columns || 100, rows: stdout.rows || 32 };
}
