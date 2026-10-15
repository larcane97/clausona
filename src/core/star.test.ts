import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimStarPrompt,
  giveStar,
  type NoticesDeps,
  type RunCommand,
  type RunOptions,
  recordStarAsked,
  runCommand,
  STAR_URL,
  type StarDeps,
} from "./star.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-01T09:00:00.000Z");

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clausona-star-"));
  file = path.join(dir, "notices.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function notices(now: number, env: NodeJS.ProcessEnv = {}): NoticesDeps {
  return { path: file, now: () => now, env };
}

async function stored(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

describe("claimStarPrompt", () => {
  it("only notes the first day the dashboard opens, and does not ask then", async () => {
    expect(await claimStarPrompt(notices(START))).toBe(false);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString() });
  });

  it("does not ask before three days have passed", async () => {
    await claimStarPrompt(notices(START));

    expect(await claimStarPrompt(notices(START + 3 * DAY - 1))).toBe(false);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString() });
  });

  it("asks once three days have passed, and never again", async () => {
    await claimStarPrompt(notices(START));

    expect(await claimStarPrompt(notices(START + 3 * DAY))).toBe(true);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString(), starAsked: true });
    expect(await claimStarPrompt(notices(START + 30 * DAY))).toBe(false);
  });

  it("keeps what else the file holds", async () => {
    await writeFile(file, JSON.stringify({ firstDashboardAt: new Date(START).toISOString(), other: 1 }));

    expect(await claimStarPrompt(notices(START + 4 * DAY))).toBe(true);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString(), other: 1, starAsked: true });
  });

  it("does not ask when the file cannot be read as a record, and leaves it as it is", async () => {
    for (const body of ["{ not json", "[]", "null"]) {
      await writeFile(file, body);

      expect(await claimStarPrompt(notices(START + 30 * DAY))).toBe(false);
      expect(await readFile(file, "utf8")).toBe(body);
    }
  });

  it("starts the count again from a first day it cannot read", async () => {
    await writeFile(file, JSON.stringify({ firstDashboardAt: "yesterday" }));

    expect(await claimStarPrompt(notices(START))).toBe(false);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString() });
  });

  it("does not ask when the asking cannot be written down", async () => {
    await writeFile(file, JSON.stringify({ firstDashboardAt: new Date(START).toISOString() }));
    // A directory where the write goes aside first: the file reads, and the write fails.
    await mkdir(`${file}.tmp.${process.pid}`);

    expect(await claimStarPrompt(notices(START + 30 * DAY))).toBe(false);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString() });
  });

  it("never asks, or writes anything, on CI", async () => {
    await writeFile(file, JSON.stringify({ firstDashboardAt: new Date(START).toISOString() }));

    expect(await claimStarPrompt(notices(START + 30 * DAY, { CI: "true" }))).toBe(false);
    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString() });
  });

  it("asks when CI is set to a value that means no", async () => {
    await writeFile(file, JSON.stringify({ firstDashboardAt: new Date(START).toISOString() }));

    expect(await claimStarPrompt(notices(START + 30 * DAY, { CI: "false" }))).toBe(true);
  });
});

describe("recordStarAsked", () => {
  it("stops the dashboard from asking, before its first day is even noted", async () => {
    await recordStarAsked(notices(START));

    expect(await stored()).toEqual({ starAsked: true });
    expect(await claimStarPrompt(notices(START + 30 * DAY))).toBe(false);
  });

  it("keeps the first day", async () => {
    await claimStarPrompt(notices(START));
    await recordStarAsked(notices(START + DAY));

    expect(await stored()).toEqual({ firstDashboardAt: new Date(START).toISOString(), starAsked: true });
  });

  it("replaces a file it cannot read", async () => {
    await writeFile(file, "{ not json");
    await recordStarAsked(notices(START));

    expect(await stored()).toEqual({ starAsked: true });
  });

  it("never throws", async () => {
    await expect(recordStarAsked({ ...notices(START), path: dir })).resolves.toBeUndefined();
  });
});

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv; output: boolean; signal?: AbortSignal };

/** A stand-in for running commands: each answer is taken in turn, and every call is kept. */
function runner(answers: Array<{ code: number | null; stdout?: string } | null>) {
  const calls: Call[] = [];
  const run: RunCommand = vi.fn(async (command, args, { env, output, signal }: RunOptions) => {
    calls.push({ command, args, env, output, signal });
    const answer = answers[calls.length - 1];
    return answer === undefined || answer === null ? null : { code: answer.code, stdout: answer.stdout ?? "" };
  });
  return { run, calls };
}

function deps(run: RunCommand, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): StarDeps {
  return { run, platform, env };
}

describe("giveStar", () => {
  it("stars the repository through gh, on github.com, and says as whom", async () => {
    const { run, calls } = runner([{ code: 0 }, { code: 0, stdout: "octocat\n" }]);

    expect(await giveStar(deps(run, "darwin", { PATH: "/bin" }))).toEqual({ kind: "starred", login: "octocat" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("gh");
    expect(calls[0]?.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "PUT",
      "/user/starred/larcane97/clausona",
      "--silent",
    ]);
    // gh never stops to ask a question the TUI would hide.
    expect(calls[0]?.env).toMatchObject({ PATH: "/bin", GH_PROMPT_DISABLED: "1" });
    expect(calls[0]?.output).toBe(true);
    expect(calls[1]?.args).toEqual(["api", "--hostname", "github.com", "user", "--jq", ".login"]);
  });

  it("still says it starred when the account name cannot be read", async () => {
    const { run } = runner([{ code: 0 }, { code: 1 }]);

    expect(await giveStar(deps(run, "darwin"))).toEqual({ kind: "starred", login: null });
  });

  it("opens the page in the browser on macOS when gh is not there", async () => {
    const { run, calls } = runner([null, { code: 0 }]);

    expect(await giveStar(deps(run, "darwin"))).toEqual({ kind: "opened", url: STAR_URL });
    // No output to hold: a browser the opener starts could keep a pipe open past clausona's exit.
    expect(calls[1]).toMatchObject({ command: "open", args: [STAR_URL], output: false });
  });

  it("opens the page on Windows when gh is not signed in", async () => {
    const { run, calls } = runner([{ code: 4 }, { code: 0 }]);

    expect(await giveStar(deps(run, "win32"))).toEqual({ kind: "opened", url: STAR_URL });
    expect(calls[1]).toMatchObject({ command: "rundll32", args: ["url.dll,FileProtocolHandler", STAR_URL] });
  });

  it("opens the page on Linux with a display", async () => {
    const { run, calls } = runner([null, { code: 0 }]);

    expect(await giveStar(deps(run, "linux", { DISPLAY: ":0" }))).toEqual({ kind: "opened", url: STAR_URL });
    expect(calls[1]).toMatchObject({ command: "xdg-open", args: [STAR_URL] });
  });

  it("counts an opener that is still running when its time is up as opened", async () => {
    const { run } = runner([null, { code: null }]);

    expect(await giveStar(deps(run, "linux", { WAYLAND_DISPLAY: "wayland-0" }))).toEqual({
      kind: "opened",
      url: STAR_URL,
    });
  });

  it.each([
    ["Linux with no display", "linux" as const, {}],
    ["an SSH session", "darwin" as const, { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }],
  ])("only gives the address on %s, where a browser would open nowhere useful", async (_name, platform, env) => {
    const { run, calls } = runner([null]);

    expect(await giveStar(deps(run, platform, env))).toEqual({ kind: "manual", url: STAR_URL });
    expect(calls).toHaveLength(1);
  });

  it("hands its signal to every command, and opens no browser once called off", async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    const run: RunCommand = async (command, args, { env, output, signal }) => {
      calls.push({ command, args, env, output, signal });
      // The TUI quits while gh runs.
      controller.abort();
      return null;
    };

    expect(await giveStar(deps(run, "darwin"), controller.signal)).toEqual({ kind: "manual", url: STAR_URL });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("gives the address when the browser cannot be opened", async () => {
    const { run } = runner([null, { code: 1 }]);

    expect(await giveStar(deps(run, "darwin"))).toEqual({ kind: "manual", url: STAR_URL });
  });
});

describe("runCommand", () => {
  const node = process.execPath;
  const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
    env: process.env,
    timeoutMs: 5_000,
    output: true,
    ...overrides,
  });

  it("gives the exit code and what was printed", async () => {
    expect(await runCommand(node, ["-e", "console.log('octocat'); process.exit(3)"], options())).toEqual({
      code: 3,
      stdout: "octocat\n",
    });
  });

  it("reads nothing from a command whose output is not wanted", async () => {
    expect(await runCommand(node, ["-e", "console.log('x')"], options({ output: false }))).toEqual({
      code: 0,
      stdout: "",
    });
  });

  it("answers null for a command that is not there", async () => {
    expect(await runCommand(path.join(dir, "no-such-command"), [], options())).toBeNull();
  });

  it("answers code null for one still running when its time is up", async () => {
    const started = Date.now();
    expect(await runCommand(node, ["-e", "setTimeout(() => {}, 10000)"], options({ timeoutMs: 200 }))).toEqual({
      code: null,
      stdout: "",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops the command when called off", async () => {
    const controller = new AbortController();
    const running = runCommand(node, ["-e", "setTimeout(() => {}, 10000)"], options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);

    expect(await running).toBeNull();
  });
});
