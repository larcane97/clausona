import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnCommandSync } from "../core/process.js";

/**
 * Splits $VISUAL or $EDITOR into a command and its arguments. `code -w` and `emacsclient -nw` are
 * ordinary values for it, and the whole string as one command name would look for a
 * program called "code -w". Quotes group a path with spaces in it; nothing else is
 * interpreted, because this is not a shell and the value is never handed to one.
 */
export function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

/**
 * Opens `initial` in $VISUAL or $EDITOR as `fileName`, in a temp directory only this user can
 * read, and resolves to what was saved.
 *
 * The scratch file lives in a directory of its own made by mkdtemp (0700) and is written
 * 0600. A fixed name in the shared temp directory would be world-readable and something
 * anyone on the machine could point at another file with a symlink first - and what is
 * edited can hold a credential (an ANTHROPIC_CUSTOM_HEADERS value, say). The directory goes
 * on every way out: a failed editor, a successful save, and a Ctrl-C while the editor is
 * open, which reaches clausona too (the editor shares its process group) and would
 * otherwise kill it before any `finally` ran.
 */
export async function editInEditor(initial: string, fileName: string): Promise<string> {
  // A blank $VISUAL is as good as an unset one; `??` would take "" and stop there.
  const editor = [process.env.VISUAL, process.env.EDITOR].find((value) => (value ?? "").trim() !== "");
  const [command, ...editorArgs] = splitCommandLine(editor ?? "");
  if (!command) throw new Error("Set $EDITOR (or $VISUAL) to edit.");

  const dir = await mkdtemp(path.join(tmpdir(), "clausona-edit-"));
  const scratchPath = path.join(dir, fileName);

  const onSignal = (signal: NodeJS.Signals) => {
    // Synchronous: the process is on its way out and an awaited rm would not finish.
    rmSync(dir, { force: true, recursive: true });
    detachSignals();
    // Re-raised with our listener gone, so the signal decides the exit status as it would
    // have. A handler that just returned would swallow the Ctrl-C instead.
    process.kill(process.pid, signal);
  };
  const detachSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await writeFile(scratchPath, initial, { encoding: "utf8", mode: 0o600 });
    // No env is passed, so the editor inherits this process's own - the spawn helpers
    // treat a given env as a replacement, and a partial one would start the editor
    // without a PATH, a HOME or a TERM.
    const result = spawnCommandSync(command, [...editorArgs, scratchPath], { stdio: "inherit" });
    if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`${command} exited with ${result.status ?? "a signal"}, so nothing was changed.`);
    }
    return await readFile(scratchPath, "utf8");
  } finally {
    detachSignals();
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
}
