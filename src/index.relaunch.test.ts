import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { relaunch } from "./index.js";
import { stripAnsi } from "./lib/cli-style.js";

const TARGET = "/home/u/.local/share/clausona/index.js";

function spawned(result: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null, ...result };
}

describe("relaunch", () => {
  it("starts the installed file on this node with the same arguments, and leaves with its code", () => {
    const spawn = vi.fn((_command: string, _args: string[], _options?: object) => spawned({ status: 7 }));

    expect(relaunch(TARGET, "0.3.1-beta", { argv: ["use"], spawn })).toBe(7);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [TARGET, "use"], { stdio: "inherit" });
  });

  it("says the update stands when the new version cannot be started", () => {
    const writes: string[] = [];
    const spawn = vi.fn((_command: string, _args: string[], _options?: object) =>
      spawned({ status: null, error: new Error("spawn ENOENT") }),
    );

    expect(relaunch(TARGET, "0.3.1-beta", { argv: [], spawn, out: { write: (s: string) => writes.push(s) } })).toBe(0);
    expect(stripAnsi(writes.join(""))).toContain("Updated to v0.3.1-beta. Run csn again.");
  });
});
