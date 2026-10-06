import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
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

const resolveDir = (dir: string) => realpath(dir).catch(() => path.resolve(dir));

/**
 * The ids of running `codex` processes whose CODEX_HOME is `configDir`, by either spelling of
 * it. The native binary is named `codex` whichever way it was installed, and so is the
 * app-server daemon it starts; the npm launcher is a `node` that runs one.
 *
 * Linux reads /proc, macOS asks pgrep and `ps -E`, both for the user's own processes only.
 * Anywhere else, and whenever the check cannot run, none are found: callers only warn on it.
 */
export async function codexProcessesFor(configDir: string, platform = process.platform): Promise<number[]> {
  const homes = new Set([path.resolve(configDir), await resolveDir(configDir)]);
  try {
    if (platform === "linux") return await fromProc(homes);
    if (platform === "darwin") return await fromPs(homes);
  } catch {
    // An answer the check cannot give is no running Codex: repair goes on as before.
  }
  return [];
}

async function fromProc(homes: Set<string>): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const comm = await readFile(`/proc/${entry}/comm`, "utf8").catch(() => "");
    if (comm.trim() !== "codex") continue;
    const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(() => "");
    for (const variable of environ.split("\0")) {
      if (!variable.startsWith("CODEX_HOME=")) continue;
      if (homes.has(await resolveDir(variable.slice("CODEX_HOME=".length)))) found.push(Number(entry));
    }
  }
  return found;
}

async function fromPs(homes: Set<string>): Promise<number[]> {
  const pids = (await run("pgrep", ["-x", "codex"])).split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  if (pids.length === 0) return [];
  // `ps -E` appends the environment to the command, separated by spaces, so a value is told
  // apart by what follows it. Each home is looked for as it would be written there. One pid
  // at a time: ps reads that one process, where a list makes it read the whole process table.
  const commands = await Promise.all(pids.map((pid) => run("ps", ["-wwE", "-o", "command=", "-p", pid])));
  return pids
    .filter((_pid, index) => [...homes].some((home) => ` ${commands[index].trim()} `.includes(` CODEX_HOME=${home} `)))
    .map(Number);
}
