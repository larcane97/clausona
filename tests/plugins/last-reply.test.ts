import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../src/test-timeouts.js";

// Every case runs the script as a process of its own.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

// The script ships inside fleet-core and runs straight from Node, so it is tested the way the
// fleet skills run it: as a child process, against session files laid out as Claude Code lays
// them out.
const SCRIPT = path.resolve("plugins/fleet-core/skills/fleet-core/scripts/last-reply.mjs");

let dir: string;
let configDir: string;
let worktree: string;

type Result = { code: number; stdout: string; stderr: string };

function run(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: SPAWN_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

async function lastReply(extra: string[] = []): Promise<any> {
  const r = await run(["--worktree", worktree, "--config-dir", configDir, ...extra]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout);
}

function sessionDir(folder = worktree): string {
  return path.join(configDir, "projects", folder.replaceAll(/[^a-zA-Z0-9]/g, "-"));
}

/** Writes a session file of `entries`, one JSON object per line, as Claude Code does. */
function session(name: string, entries: object[], folder?: string): string {
  const d = sessionDir(folder);
  mkdirSync(d, { recursive: true });
  const file = path.join(d, `${name}.jsonl`);
  writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return file;
}

// Each entry a second after the one before, counted from the start of the case.
let entries = 0;
function at(): string {
  entries += 1;
  return new Date(Date.parse("2026-10-16T10:00:00Z") + entries * 1000).toISOString();
}
const prompt = (text: string) => ({ type: "user", timestamp: at(), message: { role: "user", content: text } });
const said = (id: string, text: string) => ({
  type: "assistant",
  timestamp: at(),
  message: { id, role: "assistant", content: [{ type: "text", text }] },
});
const toolCall = (id: string) => ({
  type: "assistant",
  timestamp: at(),
  message: { id, role: "assistant", content: [{ type: "tool_use", id: `tu-${id}`, name: "Bash", input: {} }] },
});
const toolResult = (id: string) => ({
  type: "user",
  timestamp: at(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${id}`, content: "ok" }] },
});
const system = (subtype: string) => ({ type: "system", subtype, timestamp: at() });
// What Claude Code writes when it compacts a worker that sits idle.
const compaction = () => [
  system("compact_boundary"),
  {
    type: "user",
    isCompactSummary: true,
    timestamp: at(),
    message: {
      role: "user",
      content:
        "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nThe worker ends with FLEET_WORKER_DONE: <summary>.",
    },
  },
  { type: "attachment", timestamp: at(), attachment: { type: "plan_mode" } },
  system("informational"),
];

beforeEach(() => {
  entries = 0;
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "last-reply-")));
  configDir = path.join(dir, "config");
  worktree = path.join(dir, "worktrees", "repo", "docs");
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("last-reply", () => {
  it("prints the worker's last reply, past the tool calls before it", async () => {
    const file = session("s1", [
      prompt("Read .fleet-brief.md in this folder and do what it says."),
      said("m1", "Reading the brief."),
      toolCall("m2"),
      toolResult("m2"),
      said("m3", "Wrote the guide.\nFLEET_WORKER_DONE: wrote docs/guide.md"),
      system("stop_hook_summary"),
      system("turn_duration"),
    ]);
    expect(await lastReply()).toEqual({
      session: file,
      at: "2026-10-16T10:00:05.000Z",
      reply: "Wrote the guide.\nFLEET_WORKER_DONE: wrote docs/guide.md",
    });
  });

  it("still finds it after the worker compacted while idle", async () => {
    session("s1", [
      prompt("Read .fleet-brief.md in this folder and do what it says."),
      said("m1", "FLEET_WORKER_DONE: wrote docs/guide.md"),
      system("turn_duration"),
      ...compaction(),
    ]);
    expect((await lastReply()).reply).toBe("FLEET_WORKER_DONE: wrote docs/guide.md");
  });

  it("joins the blocks of one message, which Claude Code writes one entry each", async () => {
    session("s1", [prompt("go"), said("m1", "First part."), said("m1", "FLEET_WORKER_DONE: two blocks")]);
    expect((await lastReply()).reply).toBe("First part.\nFLEET_WORKER_DONE: two blocks");
  });

  it("gives no reply when a prompt came after the last one, so an old DONE line is never taken for a new one", async () => {
    session("s1", [prompt("task one"), said("m1", "FLEET_WORKER_DONE: one"), prompt("task two")]);
    expect(await lastReply()).toMatchObject({ reply: null, why: "nothing since its last prompt" });
    session("s1", [
      prompt("task one"),
      said("m1", "FLEET_WORKER_DONE: one"),
      {
        type: "attachment",
        timestamp: at(),
        attachment: { type: "queued_command", commandMode: "prompt", prompt: "task two" },
      },
    ]);
    expect((await lastReply()).reply).toBeNull();
  });

  it("does not count a slash command or a note Claude Code adds for itself as a prompt", async () => {
    session("s1", [
      prompt("go"),
      said("m1", "FLEET_WORKER_DONE: done"),
      prompt("<command-name>/compact</command-name>\n<command-message>compact</command-message>"),
      { type: "user", isMeta: true, timestamp: at(), message: { role: "user", content: "Caveat: local command" } },
    ]);
    expect((await lastReply()).reply).toBe("FLEET_WORKER_DONE: done");
  });

  it("skips what a subagent said", async () => {
    session("s1", [
      prompt("go"),
      said("m1", "FLEET_WORKER_DONE: main"),
      { ...said("m2", "subagent text"), isSidechain: true },
    ]);
    expect((await lastReply()).reply).toBe("FLEET_WORKER_DONE: main");
  });

  it("reads the newest session, the one a hand-over started", async () => {
    const old = session("old", [prompt("go"), said("m1", "FLEET_WORKER_BLOCKED: out of quota")]);
    const handedOver = session("new", [prompt("continue"), said("m2", "FLEET_WORKER_DONE: finished")]);
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await lastReply()).toMatchObject({ session: handedOver, reply: "FLEET_WORKER_DONE: finished" });
  });

  it("reads past a long tail of entries that say nothing", async () => {
    const filler = Array.from({ length: 6000 }, () => ({ ...system("informational"), content: "x".repeat(300) }));
    session("s1", [prompt("go"), said("m1", "FLEET_WORKER_DONE: early"), ...filler]);
    expect((await lastReply()).reply).toBe("FLEET_WORKER_DONE: early");
  });

  it("keeps the end of a long reply, where the DONE line is", async () => {
    const long = `${"Report line.\n".repeat(1000)}FLEET_WORKER_DONE: long`;
    session("s1", [prompt("go"), said("m1", long)]);
    expect((await lastReply()).reply).toBe(`[${long.length - 8000} characters cut]\n${long.slice(-8000)}`);
    expect((await lastReply(["--max-chars", "20000"])).reply).toBe(long);
  });

  it("says why there is no reply: a turn still at work, or a session with none yet", async () => {
    session("s1", [prompt("go"), toolCall("m1"), toolResult("m1")]);
    expect(await lastReply()).toMatchObject({ reply: null, why: "nothing since its last prompt" });
    session("s1", [system("informational")]);
    expect(await lastReply()).toMatchObject({ reply: null, why: "no reply yet" });
  });

  it("names a long folder as Claude Code does: cut, with a hash of the path", async () => {
    worktree = path.join(dir, "d".repeat(120), "e".repeat(120));
    mkdirSync(worktree, { recursive: true });
    const name = worktree.replaceAll(/[^a-zA-Z0-9]/g, "-");
    let hash = 0;
    for (let i = 0; i < worktree.length; i++) hash = ((hash << 5) - hash + worktree.charCodeAt(i)) | 0;
    const d = path.join(configDir, "projects", `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "s1.jsonl"), `${JSON.stringify(said("m1", "FLEET_WORKER_DONE: deep"))}\n`);
    expect((await lastReply()).reply).toBe("FLEET_WORKER_DONE: deep");
  });

  it("fails clearly when the worktree has no Claude Code session under that config dir", async () => {
    const r = await run(["--worktree", worktree, "--config-dir", configDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^last-reply: no Claude Code session for .* Is it a Claude Code worker/);
  });

  it("needs a worktree, a config dir and a positive --max-chars", async () => {
    const none = await run(["--worktree", worktree]);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/usage: last-reply\.mjs/);
    const zero = await run(["--worktree", worktree, "--config-dir", configDir, "--max-chars", "0"]);
    expect(zero.stderr).toMatch(/--max-chars must be a positive integer/);
  });
});
