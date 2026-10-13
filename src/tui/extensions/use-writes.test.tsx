import { Text, useInput } from "ink";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplyResult } from "../../extensions/apply.js";
import { loadInventory } from "../../extensions/inventory.js";
import { type ScreenWrites, writesFor } from "../../extensions/load.js";
import type { Inventory } from "../../extensions/model.js";
import { plan } from "../../extensions/plan.js";
import { TestHome } from "../../extensions/test-home.js";
import { stripAnsi } from "../../lib/cli-style.js";
import { type Instance, press, renderAt, type, waitForFrame } from "../test-drive.js";
import { buildTable } from "./screen-model.js";
import { useWrites } from "./use-writes.js";

/**
 * The write flow on its own, with writes the test answers: what the screen's tests cannot reach
 * through real files - a plan, an apply or an undo that fails, and keys that come while one runs.
 */

const NOW = Date.UTC(2026, 9, 10, 4, 36, 48);
const OPERATION = { id: "op", dir: "op", command: "skills", summary: "", createdAt: "2026-10-10T04:36:48Z" } as const;

const homes: TestHome[] = [];
const instances: Instance[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  for (const home of homes.splice(0)) home.dispose();
});

/** One account, a Global skill eli5, seen from the project app. */
async function seed(): Promise<{ h: TestHome; app: string; inv: Inventory }> {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  h.claude("default", ".claude", { projects: { [app]: {} } });
  h.skill(".claude/skills", "eli5");
  const inv = await loadInventory(h.inventoryOptions(app));
  return { h, app, inv };
}

/**
 * The home's writes, with the plan made purely - no git run - and `over` in place of the rest,
 * so a case decides what a plan, an apply or an undo answers.
 */
function writesOf(h: TestHome, over: Partial<ScreenWrites> = {}): ScreenWrites {
  const real = writesFor(h.home, { now: () => NOW });
  return {
    ...real,
    planChecked: async (ctx, command, action) => ({
      plan: plan({ ...ctx, tracked: new Set(), stashDir: real.stashDir }, command, action),
      tracked: new Set(),
    }),
    ...over,
  };
}

type FlowProps = { inv: Inventory; project: string; writes: ScreenWrites; reload: (after: string) => void };

/**
 * The flow in Global's table, the cursor on its first row, keys handed on as the screen hands
 * them; it draws the status line, the dialog's lines and its hints.
 */
function Flow({ inv, project, writes, reload }: FlowProps) {
  const [status, setStatus] = useState("");
  const rows = buildTable(inv, "claude", "skill", "global", project, NOW, 80, "").rows;
  const changes = useWrites({
    writes,
    inventory: inv,
    kind: "skill",
    project,
    loadedAt: NOW,
    rows,
    selected: rows[0],
    focus: "table",
    reload,
    setStatus,
    width: 80,
    height: 20,
  });
  useInput((input, key) => {
    if (changes.waiting()) return;
    setStatus("");
    if (changes.dialogKey(input, key)) return;
    changes.actionKey(input, key);
  });
  const dialog = changes.dialog;
  const lines = [
    `status: ${status}`,
    ...(dialog
      ? [...dialog.lines.map((line) => line.text), `hints: [${dialog.hints.map((h) => h.keys).join(" ")}]`]
      : []),
  ];
  return <Text>{lines.join("\n")}</Text>;
}

function mount(props: FlowProps): Instance {
  const instance = renderAt(<Flow {...props} />, 80);
  instances.push(instance);
  return instance;
}

async function seen(instance: Instance, check: (text: string) => boolean): Promise<string> {
  return stripAnsi(await waitForFrame(instance.lastFrame, (frame) => check(stripAnsi(frame))));
}

describe("useWrites", () => {
  it("applies a plan once, however many y come while it runs, and reads the files again after", async () => {
    const { h, app, inv } = await seed();
    let done: (result: ApplyResult) => void = () => {};
    const apply = vi.fn(() => new Promise<ApplyResult>((resolve) => (done = resolve)));
    const reload = vi.fn();
    const instance = mount({ inv, project: app, writes: writesOf(h, { apply }), reload });
    await seen(instance, (f) => f.includes("status:"));
    await press(instance, " ");
    await seen(instance, (f) => f.includes("Turn off eli5 in this project?") && f.includes("hints: [y"));
    await press(instance, "y");
    // Busy: the dialog offers no keys, and every key waits for the apply.
    await seen(instance, (f) => f.includes("hints: []"));
    for (const key of ["y", "y", "n"]) await type(instance, key);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    done({ status: "nothing" });
    await seen(instance, (f) => !f.includes("Turn off eli5"));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("Nothing changed.");
  });

  it("says why a plan could not be made, and opens no dialog", async () => {
    const { h, app, inv } = await seed();
    const planChecked = vi.fn(async () => {
      throw new Error("git went away");
    });
    const instance = mount({ inv, project: app, writes: writesOf(h, { planChecked }), reload: vi.fn() });
    await seen(instance, (f) => f.includes("status:"));
    await press(instance, " ");
    const frame = await seen(instance, (f) => f.includes("Could not plan the change: git went away"));
    expect(frame).not.toContain("Turn off eli5");
    // The keys are the flow's again: the next one plans again, and says the same.
    await type(instance, " ");
    await vi.waitFor(() => expect(planChecked).toHaveBeenCalledTimes(2));
    await seen(instance, (f) => f.includes("Could not plan the change: git went away"));
  });

  it.each([
    ["an apply", " ", { apply: async () => Promise.reject(new Error("disk full")) }, "Could not apply it: disk full"],
    [
      "an undo",
      "u",
      {
        lastOperation: async () => ({ operation: { ...OPERATION, summary: "Turned off eli5" }, files: [], kept: [] }),
        undo: async () => Promise.reject(new Error("disk full")),
      },
      "Could not undo it: disk full",
    ],
  ] as const)("says why %s failed, closing the dialog, under the files read again", async (_, first, over, says) => {
    const { h, app, inv } = await seed();
    const reload = vi.fn();
    const instance = mount({ inv, project: app, writes: writesOf(h, over as Partial<ScreenWrites>), reload });
    await seen(instance, (f) => f.includes("status:"));
    await press(instance, first);
    await seen(instance, (f) => f.includes("hints: [y"));
    await press(instance, "y");
    await seen(instance, (f) => !f.includes("hints:"));
    expect(reload).toHaveBeenCalledWith(says);
  });

  it("says why the newest change could not be read, and opens no dialog", async () => {
    const { h, app, inv } = await seed();
    const lastOperation = async () => Promise.reject(new Error("manifest unreadable"));
    const instance = mount({ inv, project: app, writes: writesOf(h, { lastOperation }), reload: vi.fn() });
    await seen(instance, (f) => f.includes("status:"));
    await press(instance, "u");
    const frame = await seen(instance, (f) => f.includes("Could not read the last change: manifest unreadable"));
    expect(frame).not.toContain("hints:");
  });
});
