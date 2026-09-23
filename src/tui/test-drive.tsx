import { EventEmitter } from "node:events";

import { render as inkRender } from "ink";
import type { render } from "ink-testing-library";
import type { ReactElement } from "react";

/**
 * Driving the TUI from a test the way a person does: a key at a time, each one waited on
 * until the frame it produced has been drawn.
 *
 * Shared by the App's test files, which need the same timing rules; only for tests, and
 * nothing in the app imports it.
 */

/**
 * Waits for a frame that satisfies `check`, rather than for a fixed number of milliseconds.
 *
 * Every screen here paints from an async read, so a sleep is a guess at how long that
 * takes: too short and the suite flakes under load, too long and every test pays for it.
 * The timeout is a ceiling on failure, not the normal cost.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  check: (frame: string) => boolean,
  timeout = 3000,
) {
  const deadline = Date.now() + timeout;
  let frame = "";
  while (Date.now() < deadline) {
    frame = lastFrame() ?? "";
    if (check(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a matching frame; last was:\n${frame}`);
}

export const DOWN = "\u001B[B";
export const ENTER = "\r";
export const ESC = "\u001B";
export const CURSOR = "✦";

/** What the helpers below drive: ink-testing-library's instance, or `renderAt`'s. */
export type Instance = Pick<ReturnType<typeof render>, "stdin" | "lastFrame" | "frames" | "unmount">;

/** A stdin ink will read from, as ink-testing-library's is. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

/**
 * `render` at a terminal width of the test's choosing. ink-testing-library's is fixed at 100
 * columns, and what a one-line message loses at the panel's edge depends on exactly that.
 */
export function renderAt(tree: ReactElement, columns: number): Instance {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    write: (frame: string) => {
      frames.push(frame);
      return true;
    },
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const stdin = new FakeStdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin: stdin as unknown as Instance["stdin"],
    frames,
    lastFrame: () => frames.at(-1),
    unmount: instance.unmount,
  };
}

/**
 * Presses a key and waits for the frame it produced.
 *
 * Not politeness: a handler reads the state of the render it was registered in, so two
 * keys pressed inside one tick are both answered from the state before either of them - a
 * person's keystrokes are separated by a repaint, and the test has to be too.
 */
export async function press(instance: Instance, keys: string, timeout = 3000) {
  // One turn of the event loop before the key is sent. ink re-subscribes its input handler
  // in an effect, which runs after the frame has been written - so a key sent the instant a
  // frame appears is answered by the handler belonging to the frame before it, and a step
  // that has just been left swallows it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = instance.lastFrame();
  instance.stdin.write(keys);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (instance.lastFrame() !== before) return;
  }
  throw new Error(`pressing ${JSON.stringify(keys)} redrew nothing within ${timeout}ms`);
}

/**
 * Sends a key that is not expected to redraw anything.
 *
 * `press` insists on a redraw, which is what makes it safe everywhere else. The key field
 * is the one place where a keystroke deliberately changes nothing on screen - its mask is
 * a constant, so typing into a field that already holds something draws the same frame -
 * and a wait for a frame that is never coming cannot be a poll. What the keystroke did is
 * asserted where it is visible: in the value the save receives.
 */
export async function type(instance: Instance, keys: string) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  instance.stdin.write(keys);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Sends `text` one character at a time.
 *
 * `press` and `type` write a whole string, which ink delivers as one input event - that is
 * a paste, not typing, and the two take different paths through the key field's reader.
 * This is the typing one.
 */
export async function typeSlowly(instance: Instance, text: string) {
  for (const char of text) await type(instance, char);
}

/** Whether the cursor is on the row carrying `label`. */
export function focusedOn(frame: string, label: string): boolean {
  return frame.split("\n").some((line) => line.includes(label) && line.includes(CURSOR));
}

/** Walks the cursor down to the row carrying `label`, so a test does not count keystrokes. */
export async function moveTo(instance: Instance, label: string) {
  for (let step = 0; step < 40; step++) {
    if (focusedOn(instance.lastFrame() ?? "", label)) return;
    await press(instance, DOWN);
  }
  throw new Error(`the cursor never reached '${label}'`);
}
