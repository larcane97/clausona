import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { press } from "../test-drive.js";
import { FieldInput } from "./FieldInput.js";

/** A field that keeps what it is given, as a form does, and reports every edit. */
function Field({ onChange }: { onChange: (value: string, cursor: number) => void }) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  return (
    <FieldInput
      value={value}
      cursor={cursor}
      focus
      showCursor={false}
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
});
