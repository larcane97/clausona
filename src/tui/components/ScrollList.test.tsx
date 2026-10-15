import { Text } from "ink";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../lib/cli-style.js";
import { DOWN, press, renderAt } from "../test-drive.js";
import { ScrollList } from "./ScrollList.js";

const UP = "\u001B[A";

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => `row ${String(i).padStart(2, "0")}`).map((name) => (
    <Text key={name}>{name}</Text>
  ));

const lines = (frame: string | undefined) => stripAnsi(frame ?? "").split("\n");

// A list with no cursor - a table, a summary to read - in the lines the terminal leaves it (#180).
describe("ScrollList", () => {
  it("draws every item when they fit, and takes no keys", async () => {
    const app = renderAt(<ScrollList items={items(5)} rows={10} />, 40);
    const before = app.lastFrame();
    app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = app.lastFrame();
    app.unmount();

    expect(lines(before)).toHaveLength(5);
    expect(after).toBe(before);
  });

  it("keeps to its lines, and ↑↓ scroll it a row at a time to either end", async () => {
    const app = renderAt(<ScrollList items={items(14)} rows={6} />, 40);
    expect(lines(app.lastFrame())).toEqual(["row 00", "row 01", "row 02", "row 03", "row 04", "↓ 9 more"]);

    await press(app, DOWN);
    expect(lines(app.lastFrame())).toEqual(["↑ 1 more", "row 01", "row 02", "row 03", "row 04", "↓ 9 more"]);

    for (let i = 0; i < 20; i++) app.stdin.write(DOWN);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines(app.lastFrame())).toEqual(["↑ 9 more", "row 09", "row 10", "row 11", "row 12", "row 13"]);

    await press(app, UP);
    expect(lines(app.lastFrame())).toEqual(["↑ 8 more", "row 08", "row 09", "row 10", "row 11", "↓ 2 more"]);
    app.unmount();
  });

  it("counts items of more than one line as their lines", () => {
    const tall = Array.from({ length: 6 }, (_, i) => `name ${i}\nemail ${i}`).map((text) => (
      <Text key={text}>{text}</Text>
    ));
    const app = renderAt(<ScrollList items={tall} rows={7} size={2} />, 40);
    const drawn = lines(app.lastFrame());
    app.unmount();

    expect(drawn).toEqual(["name 0", "email 0", "name 1", "email 1", "name 2", "email 2", "↓ 3 more"]);
  });
});
