import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A string as one single-quoted sh word. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Logs its name and arguments as one line - one write, so parallel workers' calls never interleave - then answers. */
function writeStandIn(bin: string, name: string, log: string, answer: string[]): void {
  const script = [
    "#!/bin/sh",
    `line=${shQuote(name)}`,
    'for arg in "$@"; do line="$line $arg"; done',
    `printf '%s\\n' "$line" >> ${shQuote(log)}`,
    ...answer,
    "",
  ];
  writeFileSync(path.join(bin, name), script.join("\n"), { mode: 0o755 });
}

/**
 * Puts stand-ins for `security` and `secret-tool` first on PATH for the whole run, so no test -
 * today's or a future one - reaches the real binaries, and through them the user's Keychain
 * or Secret Service. Vitest starts its workers after this has run and hands each one a copy
 * of this process's environment (runFiles awaits initializeGlobalSetup before pool.runTests
 * builds that copy), so the PATH set here is every test file's from its first line.
 *
 * Each stand-in answers as the real binary does for an item that is not there - `security`
 * exits 44 with its "could not be found" message, `secret-tool` exits 1 - and logs its
 * arguments, one call per line, to calls.log in this run's temp dir, or to
 * CLAUSONA_TEST_SHIM_LOG when that is set. A test that puts a stand-in of its own ahead of
 * these on PATH still gets its own.
 *
 * Windows uses neither binary (secrets go to a file there), so nothing is changed on it.
 */
export default function setup(): (() => void) | undefined {
  if (process.platform === "win32") return undefined;
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-test-shims-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = process.env.CLAUSONA_TEST_SHIM_LOG || path.join(dir, "calls.log");
  writeStandIn(bin, "security", log, [
    "echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2",
    "exit 44",
  ]);
  writeStandIn(bin, "secret-tool", log, ["exit 1"]);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.CLAUSONA_TEST_SHIM_DIR = bin;
  return () => rmSync(dir, { recursive: true, force: true });
}
