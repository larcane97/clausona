import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { type RouteSpec, withDefaults } from "../core/route-config.js";
import type { Member } from "../core/route-patterns.js";
import { rankRoute } from "../core/routing.js";
import type { QuotaSnapshot, ToolName } from "../types.js";
import { askTool, confirmNewRoute, type RouteIo, terminalIo, toggleSelection } from "./route-create.js";

const NOW = Date.parse("2026-10-09T00:00:00.000Z");
const member = (id: string): Member => {
  const [tool, name] = id.split(":") as [ToolName, string];
  return {
    id,
    tool,
    name,
    email: `${name}@example.com`,
    kind: "subscription",
    sharesSessions: true,
    configDir: `/h/${name}`,
  };
};
const members = ["claude:a", "claude:b", "claude:c"].map(member);
const ok = (n: number): QuotaSnapshot => ({ state: "ok", fetchedAt: NOW, session: { usedPercent: n, resetsAt: null } });
const preview = async (spec: RouteSpec) =>
  rankRoute({
    route: withDefaults(spec),
    members,
    quotas: { "claude:a": ok(10), "claude:b": ok(20), "claude:c": ok(30) },
    lastPicked: {},
    now: NOW,
    resume: false,
  });

function scripted(answers: Array<string | null>): RouteIo & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    interactive: true,
    said,
    asked,
    ask: async (question) => {
      asked.push(question);
      return answers.length ? (answers.shift() as string | null) : null;
    },
    say: (text) => said.push(text),
  };
}

describe("toggleSelection", () => {
  it("flips the numbered entries", () => {
    expect(toggleSelection([true, true, true], "2 3")).toEqual([true, false, false]);
    expect(toggleSelection([true, false], "2,1")).toEqual([false, true]);
  });

  it("refuses a number out of range", () => {
    expect(toggleSelection([true], "2")).toBeNull();
    expect(toggleSelection([true], "x")).toBeNull();
  });
});

describe("confirmNewRoute", () => {
  const spec: RouteSpec = { tool: "claude", from: ["*"] };

  it("creates as shown on an empty answer or y", async () => {
    expect(await confirmNewRoute("work", spec, scripted([""]), preview, true)).toEqual(spec);
    expect(await confirmNewRoute("work", spec, scripted(["Y"]), preview, false)).toEqual(spec);
  });

  it("creates nothing on n, Ctrl-D or Ctrl-C", async () => {
    expect(await confirmNewRoute("work", spec, scripted(["n"]), preview, true)).toBeNull();
    expect(await confirmNewRoute("work", spec, scripted([null]), preview, true)).toBeNull();
  });

  it("asks again on an answer it does not know", async () => {
    const io = scripted(["maybe", "y"]);
    expect(await confirmNewRoute("work", spec, io, preview, true)).toEqual(spec);
    expect(io.said).toContain("Answer y, e or n.");
  });

  it("edits the accounts and the strategy", async () => {
    // e, then untick b, then Enter, then headroom, then y on the screen shown again.
    const io = scripted(["e", "2", "", "headroom", "y"]);
    expect(await confirmNewRoute("work", spec, io, preview, true)).toEqual({
      tool: "claude",
      from: ["a", "c"],
      strategy: "headroom",
    });
  });

  it("keeps * when every account stays ticked, so accounts added later join too", async () => {
    const io = scripted(["e", "", "", "y"]);
    expect(await confirmNewRoute("work", spec, io, preview, true)).toEqual(spec);
  });

  it("lists every account with its usage, ticked if it is in the pool", async () => {
    const io = scripted(["e", "", "", "y"]);
    await confirmNewRoute("work", { tool: "claude", from: ["*"], exclude: ["b"] }, io, preview, true);
    expect(io.said).toContain(
      ["   1 [x] claude:a  10% 5H", "   2 [ ] claude:b  20% 5H", "   3 [x] claude:c  30% 5H"].join("\n"),
    );
  });

  it("keeps the patterns as they are when the checklist is left alone", async () => {
    const excluding: RouteSpec = { tool: "claude", from: ["*"], exclude: ["b"] };
    const io = scripted(["e", "", "headroom", "y"]);
    expect(await confirmNewRoute("work", excluding, io, preview, true)).toEqual({ ...excluding, strategy: "headroom" });
  });

  it("drops the exclude when an excluded account is ticked back", async () => {
    const io = scripted(["e", "2", "", "", "y"]);
    expect(await confirmNewRoute("work", { tool: "claude", from: ["*"], exclude: ["b"] }, io, preview, true)).toEqual(
      spec,
    );
  });

  it("creates nothing on Ctrl-D or Ctrl-C in the checklist or at the strategy", async () => {
    // The answers after the null are never asked for: the screen is not shown again.
    const inChecklist = scripted(["e", null, "", "y"]);
    expect(await confirmNewRoute("work", spec, inChecklist, preview, true)).toBeNull();
    expect(inChecklist.asked).toHaveLength(2);
    const atStrategy = scripted(["e", "", null, "y"]);
    expect(await confirmNewRoute("work", spec, atStrategy, preview, true)).toBeNull();
    expect(atStrategy.asked).toHaveLength(3);
  });

  it("says what it cannot take and keeps what it had", async () => {
    const io = scripted(["e", "9", "1 2 3", "", "fastest", "y"]);
    expect(await confirmNewRoute("work", spec, io, preview, true)).toEqual(spec);
    expect(io.said).toContain("Numbers from 1 to 3.");
    expect(io.said).toContain("A route needs at least one account; keeping the pool as it was.");
    expect(io.said).toContain("Unknown strategy; keeping round-robin.");
  });
});

describe("askTool", () => {
  it("takes claude or codex and nothing else", async () => {
    expect(await askTool(scripted(["codex"]))).toBe("codex");
    expect(await askTool(scripted(["gpt"]))).toBeUndefined();
  });
});

describe("terminalIo", () => {
  const streams = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => {
      written += String(chunk);
    });
    const io = terminalIo(output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    return { input, io, written: () => written };
  };

  it("is not interactive without a terminal", () => {
    expect(streams().io.interactive).toBe(false);
  });

  it("asks on the stream and resolves to the answer, trimmed", async () => {
    const { input, io, written } = streams();
    const answer = io.ask("Create? ");
    input.write("  e  \n");
    expect(await answer).toBe("e");
    io.say("done");
    expect(written()).toBe("Create? done\n");
  });

  it("resolves null once the input closes, and for every question after it", async () => {
    const { input, io } = streams();
    const first = io.ask("Create? ");
    input.end();
    expect(await first).toBeNull();
    expect(await io.ask("Again? ")).toBeNull();
  });
});
