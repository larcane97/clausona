import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * How long pgrep and ps each get. On a busy machine (a load average of 13 to 68) ps ran into the
 * 3 s this was before 39 times in 806 runs, one in eight in the busiest stretch, and pgrep once
 * in 49, where an idle machine answers in milliseconds. Over three times that, for a busier one.
 */
const CHECK_TIMEOUT_MS = 10_000;

/** What the look runs, for tests: the platform's way, pgrep and ps, Linux's /proc, and how long each gets. */
export type ProcessCheck = {
  platform?: NodeJS.Platform;
  pgrep?: string;
  ps?: string;
  proc?: string;
  timeoutMs?: number;
};

/** What `command` printed; null when it ran out of time, or was stopped, before it finished. */
function run(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error?.killed || error?.signal) return resolve(null);
      // pgrep exits 1 when nothing matches: that is an answer, not a failure.
      resolve(error && !stdout ? "" : String(stdout));
    });
  });
}

/**
 * A CODEX_HOME as one spelling: `~` expanded, relative parts and a trailing separator resolved,
 * and links followed where the directory is there to follow them.
 */
export async function normalizeHome(value: string): Promise<string> {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
  const resolved = path.resolve(expanded);
  return realpath(resolved).catch(() => resolved);
}

/**
 * The CODEX_HOME values in a line `ps -E` prints: the command, then the environment, each
 * variable `NAME=value` and separated by a space. A value runs to the next ` NAME=`, so one
 * with spaces in it is read whole unless a space in it is followed by what looks like a name.
 */
export function codexHomesInPsLine(line: string): string[] {
  const homes: string[] = [];
  const marker = " CODEX_HOME=";
  const text = ` ${line.trim()}`;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const rest = text.slice(at + marker.length);
    const end = rest.search(/ [A-Za-z_][A-Za-z0-9_]*=/);
    homes.push(end === -1 ? rest : rest.slice(0, end));
  }
  return homes;
}

/**
 * The ids of running `codex` processes whose CODEX_HOME is `configDir`, however either is
 * spelled. The native binary is named `codex` whichever way it was installed, and so is the
 * app-server daemon it starts; the npm launcher is a `node` that runs one.
 *
 * Linux reads /proc, macOS asks pgrep and `ps -E`, both for the user's own processes only.
 * Anywhere else, and whenever the check cannot run, none are found. Null when pgrep or ps ran
 * out of time: a check that did not finish is no answer, and Codex may be running.
 */
export async function codexProcessesFor(configDir: string, check: ProcessCheck = {}): Promise<number[] | null> {
  const home = await normalizeHome(configDir);
  const platform = check.platform ?? process.platform;
  try {
    if (platform === "linux") return await fromProc(home, check.proc ?? "/proc");
    if (platform === "darwin") {
      return await fromPs(home, check.pgrep ?? "pgrep", check.ps ?? "ps", check.timeoutMs ?? CHECK_TIMEOUT_MS);
    }
  } catch {
    // An answer the check cannot give is no running Codex.
  }
  return [];
}

async function fromProc(home: string, proc: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    const comm = await readFile(path.join(proc, entry, "comm"), "utf8").catch(() => "");
    if (comm.trim() !== "codex") continue;
    const environ = await readFile(path.join(proc, entry, "environ"), "utf8").catch(() => "");
    for (const variable of environ.split("\0")) {
      if (!variable.startsWith("CODEX_HOME=")) continue;
      if ((await normalizeHome(variable.slice("CODEX_HOME=".length))) === home) found.push(Number(entry));
    }
  }
  return found;
}

async function fromPs(home: string, pgrep: string, ps: string, timeoutMs: number): Promise<number[] | null> {
  const listed = await run(pgrep, ["-x", "codex"], timeoutMs);
  if (listed === null) return null;
  const pids = listed.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  // One pid at a time: ps reads that one process, where a list makes it read the whole
  // process table, which took seconds on a loaded machine.
  const lines = await Promise.all(pids.map((pid) => run(ps, ["-wwE", "-o", "command=", "-p", pid], timeoutMs)));
  const found: number[] = [];
  for (const [index, pid] of pids.entries()) {
    const line = lines[index];
    // Any process ps did not answer for could be a Codex in this home.
    if (line === null || line === undefined) return null;
    for (const value of codexHomesInPsLine(line)) {
      if ((await normalizeHome(value)) === home) found.push(Number(pid));
    }
  }
  return found;
}
