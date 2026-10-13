import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { press } from "../test-drive.js";
import { FieldInput } from "./FieldInput.js";

const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const ERASE = "\u007F";

/** A field that keeps what it is given, as a form does, and reports every edit. */
function Field({
  onChange,
  showCursor = false,
}: {
  onChange: (value: string, cursor: number) => void;
  showCursor?: boolean;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  return (
    <FieldInput
      value={value}
      cursor={cursor}
      focus
      showCursor={showCursor}
      onChange={(next, at) => {
        setValue(next);
        setCursor(at);
        onChange(next, at);
      }}
    />
  );
}

describe("FieldInput", () => {
  // Fast typing or a paste arrives as one read, which ink hands over as one input: a tab or a
  // line break inside it is not a key, and drawn as text it broke the form's border.
  it.each([
    ["a tab", "ab\tc", "abc"],
    ["a line break", "x\r\ny", "xy"],
    ["DEL and NUL", "p\u007fq\u0000r", "pqr"],
  ])("drops %s inside typed text and inserts the rest", async (_what, typed, kept) => {
    const onChange = vi.fn();
    const instance = render(<Field onChange={onChange} />);

    await press(instance, typed);

    expect(onChange).toHaveBeenLastCalledWith(kept, kept.length);
    expect(instance.lastFrame()).toBe(kept);
  });

  // Keys a millisecond apart are reads of their own. The handler of the frame before the last
  // key's answers the next one when that frame has not subscribed its own yet, and when it has
  // not been drawn yet either: an edit worked out from the value drawn lost the key before it.
  it.each([
    ["once its frame is drawn", () => new Promise((resolve) => setImmediate(resolve))],
    ["before its frame is drawn", async () => {}],
  ])("builds each edit on the one before when the next key comes %s", async (_when, between) => {
    const onChange = vi.fn();
    const instance = render(<Field onChange={onChange} showCursor />);
    await press(instance, "a");

    for (const key of ["b", "c", ERASE, LEFT, "x", RIGHT, "y"]) {
      instance.stdin.write(key);
      await between();
    }

    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith("axby", 4));
    expect(onChange).toHaveBeenCalledTimes(8);
  });
});
