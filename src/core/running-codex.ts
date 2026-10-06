import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Long enough for pgrep and ps on a loaded machine; a check that runs out finds nothing. */
const CHECK_TIMEOUT_MS = 3_000;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
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
 * Anywhere else, and whenever the check cannot run, none are found.
 */
export async function codexProcessesFor(configDir: string, platform = process.platform): Promise<number[]> {
  const home = await normalizeHome(configDir);
  try {
    if (platform === "linux") return await fromProc(home);
    if (platform === "darwin") return await fromPs(home);
  } catch {
    // An answer the check cannot give is no running Codex.
  }
  return [];
}

async function fromProc(home: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const comm = await readFile(`/proc/${entry}/comm`, "utf8").catch(() => "");
    if (comm.trim() !== "codex") continue;
    const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
    for (const variable of environ.split("\0")) {
      if (!variable.startsWith("CODEX_HOME=")) continue;
      if ((await normalizeHome(variable.slice("CODEX_HOME=".length))) === home) found.push(Number(entry));
    }
  }
  return found;
}

async function fromPs(home: string): Promise<number[]> {
  const pids = (await run("pgrep", ["-x", "codex"])).split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  // One pid at a time: ps reads that one process, where a list makes it read the whole
  // process table, which took seconds on a loaded machine.
  const lines = await Promise.all(pids.map((pid) => run("ps", ["-wwE", "-o", "command=", "-p", pid])));
  const found: number[] = [];
  for (const [index, pid] of pids.entries()) {
    for (const value of codexHomesInPsLine(lines[index])) {
      if ((await normalizeHome(value)) === home) found.push(Number(pid));
    }
  }
  return found;
}
