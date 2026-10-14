import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { carriesCredentialToken } from "../core/credential-token.js";
import { isKnownSecretSource } from "../core/key-source.js";
import { spawnCommand, spawnCommandSync } from "../core/process.js";
import { isPosixEnvName } from "../core/shell.js";
import type { SecretSource } from "../types.js";

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const SECRETS_PATH = path.join(CLAUSONA_DIR, "secrets.json");

export type SecretBackend = "keychain" | "file";

/** Namespaced so a clausona item is never confused with one Claude Code itself wrote. */
export function keychainItemFor(profileId: string): string {
  return `clausona-${profileId}`;
}

/** `timedOut` when the command was ended at its limit (run()'s `limitMs`). */
type RunResult = { code: number; stdout: string; timedOut?: true };

/**
 * Whether a child is still running. Until Node has seen it exit its pid is its own, and nothing
 * else can be given it; once it has exited, its pid can be another process's.
 */
function running(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/**
 * Kills a running child. On POSIX, with `group`, the child is the sh that leads the command's
 * process group (run() starts a detached command so, ENDS_ITS_GROUP), and the whole group is
 * killed: the command, and a `sh -c` command's own children, which would outlive the shell, among
 * them. Without, the child keeps the terminal in clausona's own process group, so only the child
 * is killed. Windows kills the tree under its pid. Only while the child is still running: once it
 * has exited, its pid can be another process's. By then the sh has sent what the command left in
 * the group a TERM.
 */
function killRunning(child: ChildProcess, group: boolean): void {
  if (!running(child)) return;
  if (process.platform === "win32") {
    spawnCommand("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(group ? -child.pid : child.pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

/** How long a command interrupted at its limit has to end before it is killed. */
const KILL_GRACE_MS = 2_000;

/**
 * `pid` and every process under it - its children, theirs, and so on - from one listing of every
 * process (`ps`, run without a shell). Just `pid` when that cannot be listed.
 */
function processTree(pid: number): number[] {
  let listed: string;
  try {
    const ps = spawnCommandSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (ps.status !== 0 || typeof ps.stdout !== "string") return [pid];
    listed = ps.stdout;
  } catch {
    return [pid];
  }
  const children = new Map<number, number[]>();
  for (const line of listed.split("\n")) {
    const [each, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(each) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), each]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const each of children.get(tree[i]) ?? []) if (!tree.includes(each)) tree.push(each);
  }
  return tree;
}

/** Sends `signal` to each pid that is still there. */
function signalEach(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Gone already.
    }
  }
}

/**
 * Ends a command that keeps the terminal, at its limit, with what it started: a `sh -c` command's
 * children - a pipeline's, or `cmd1; cmd2`'s - are in clausona's own process group, and can hold
 * the prompt. On POSIX they are sent SIGINT, as Ctrl-C would send: a prompt that turned the
 * terminal's echo off for a passphrase or a PIN turns it back on when interrupted, which SIGKILL
 * and SIGTERM leave it no chance to do. If the command is still running after KILL_GRACE_MS, its
 * tree, listed again, is killed. Each pid is signalled alone, never the group, which is clausona's,
 * and only while the command is still running: once it has exited, nothing is, not even a pid
 * listed before, which can be another process's by then. So a child that ignored SIGINT and
 * outlived the command is left running. Windows kills its tree at once, as killRunning does.
 */
function interrupt(child: ChildProcess): void {
  if (process.platform === "win32") {
    killRunning(child, false);
    return;
  }
  if (!running(child)) return;
  signalEach(processTree(child.pid), "SIGINT");
  const grace = setTimeout(() => {
    if (running(child)) signalEach(processTree(child.pid), "SIGKILL");
  }, KILL_GRACE_MS);
  child.once("exit", () => clearTimeout(grace));
}

/** The signals that end clausona from outside: Ctrl-C, a kill, a terminal closing. */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The detached children clausona is waiting on: a signal that ends clausona ends each of them. */
const detachedChildren = new Set<ChildProcess>();

const killDetached = () => {
  for (const child of detachedChildren) killRunning(child, true);
};

/**
 * A signal that ends clausona: it kills every detached child still running, then takes its
 * course - with no other handler for it, it is raised again, and clausona ends as it would have.
 */
function onEndingSignal(signal: NodeJS.Signals): void {
  killDetached();
  detachedChildren.clear();
  stopListening();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function stopListening(): void {
  for (const signal of ENDING_SIGNALS) process.off(signal, onEndingSignal);
  process.off("exit", killDetached);
}

/**
 * Ends a detached child with clausona. Detached, it is out of the terminal's process group, which
 * the terminal's Ctrl-C reaches, so a signal that ends clausona kills its group here, as
 * process.exit() does (the dashboard quitting). One set of handlers serves every child: put on
 * for the first, taken off with the last, however many keys are read at once. Returns what lets
 * this child go, once it is done with.
 */
function endWithClausona(child: ChildProcess): () => void {
  if (detachedChildren.size === 0) {
    for (const signal of ENDING_SIGNALS) process.on(signal, onEndingSignal);
    process.on("exit", killDetached);
  }
  detachedChildren.add(child);
  return () => {
    if (detachedChildren.delete(child) && detachedChildren.size === 0) stopListening();
  };
}

/**
 * The runs waiting on each signal, and the one listener that stops them all when it aborts: one
 * listener on a signal however many runs wait on it. An AbortSignal warns past ten, and one signal
 * given to every key read at once would pass that.
 */
type Waiting = { stops: Set<() => void>; listener: () => void };
const waitingOn = new WeakMap<AbortSignal, Waiting>();

/** Calls `stop` once `signal` aborts. Returns what forgets it; the last to go takes the listener off. */
function onAbort(signal: AbortSignal, stop: () => void): () => void {
  let waiting = waitingOn.get(signal);
  if (!waiting) {
    const stops = new Set<() => void>();
    const listener = () => {
      waitingOn.delete(signal);
      for (const each of [...stops]) each();
    };
    waiting = { stops, listener };
    waitingOn.set(signal, waiting);
    signal.addEventListener("abort", listener, { once: true });
  }
  const mine = waiting;
  mine.stops.add(stop);
  return () => {
    if (!mine.stops.delete(stop) || mine.stops.size > 0) return;
    if (waitingOn.get(signal) === mine) waitingOn.delete(signal);
    signal.removeEventListener("abort", mine.listener);
  };
}

/**
 * The sh a detached command runs under, as `sh -c ENDS_ITS_GROUP sh <command> <args...>`: it leads
 * the command's process group, runs the command, and once the command exits, sends TERM to the
 * group, which it ignores itself, and exits with the command's status. A job the command left
 * running in the group (`cmd &`) is ended so, and with it what held the output open. The TERM goes
 * from inside the group while its leader is alive, so the group id cannot be another's: a pid is
 * not reused while a group of that id has members. A helper that puts itself in a session of its
 * own (setsid, as gpg-agent and ssh-agent do) is not in the group, and keeps running.
 */
const ENDS_ITS_GROUP = '"$@"; s=$?; trap "" TERM; kill -TERM 0 2>/dev/null; exit $s';

/**
 * How long the output is still read once the command has exited. Normally it closes as the command
 * exits; a job the command left running can hold it open for as long as the job runs.
 */
const DRAIN_MS = 200;

type RunOptions = {
  /** Written to the command's stdin, which is otherwise not open. */
  input?: string;
  /** Bounds the run, the command started in a process group of its own for it. */
  signal?: AbortSignal;
  /**
   * How long a command that keeps the terminal may run: past it, the command and what it started
   * are ended (interrupt), if it is still running, and the result says so at once.
   */
  limitMs?: number;
};

/**
 * Runs `command` and resolves to its exit code and stdout, once the command has exited: what it
 * wrote is read for a short drain after that (DRAIN_MS), then taken, whether or not the output has
 * closed, so a job it left running does not hold the result up.
 *
 * With a `signal`, the command starts in a process group of its own, with no terminal, under an sh
 * that ends what the command left running in the group once it exits (ENDS_ITS_GROUP). Once the
 * signal aborts, the group is killed, if the sh is still running; the result is a failure at once.
 * Until then, clausona ending ends it too (endWithClausona). On Windows the command starts in no
 * group of its own, and what it leaves running when it exits keeps running.
 *
 * Without one, the command keeps the terminal, in clausona's own process group, where it can ask
 * for a PIN or a passphrase, and Ctrl-C stops it with clausona. What it leaves running when it
 * exits keeps running: nothing can end it alone without its pid, which the command never gives.
 */
function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, signal, limitMs } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: 1, stdout: "" });
      return;
    }
    const detached = signal !== undefined && process.platform !== "win32";
    const stdio: ["ignore" | "pipe", "pipe", "ignore"] = [input === undefined ? "ignore" : "pipe", "pipe", "ignore"];
    const child = detached
      ? spawnCommand("/bin/sh", ["-c", ENDS_ITS_GROUP, "sh", command, ...args], { stdio, detached: true })
      : spawnCommand(command, args, { stdio });
    const release = detached ? endWithClausona(child) : () => {};
    let out = "";
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(drain);
      forget();
      release();
      resolve(result);
    };
    /** Ends the run before the command has, once the command has been told to end: no key is read. */
    const stop = (result: RunResult) => {
      child.stdout?.destroy();
      finish(result);
    };
    const forget = signal
      ? onAbort(signal, () => {
          killRunning(child, detached);
          stop({ code: 1, stdout: "" });
        })
      : () => {};
    const limit =
      limitMs === undefined
        ? undefined
        : setTimeout(() => {
            interrupt(child);
            stop({ code: 1, stdout: "", timedOut: true });
          }, limitMs);
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("exit", (code) => {
      if (settled) return;
      clearTimeout(limit);
      // A turn of the event loop after the timer reads what is already in the pipe, however late
      // the timer ran.
      drain = setTimeout(
        () =>
          setImmediate(() => {
            child.stdout?.destroy();
            finish({ code: code ?? 1, stdout: out });
          }),
        DRAIN_MS,
      );
    });
    child.on("close", (code) => finish({ code: code ?? 1, stdout: out }));
    child.on("error", () => finish({ code: 1, stdout: "" }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * The Keychain on macOS, and ~/.clausona/secrets.json (0600) everywhere else - Linux
 * included. Not secret-tool: a probe for it cannot tell a working Secret Service from a
 * machine with the binary and no daemon behind it, and the one it had (`--version`) failed
 * on every real secret-tool, so the file was already where every Linux key went.
 */
export function detectBackend(platform: NodeJS.Platform = process.platform): SecretBackend {
  return platform === "darwin" ? "keychain" : "file";
}

/** Where a stored key is, as doctor says it. */
export function secretStoreName(platform: NodeJS.Platform = process.platform): string {
  return detectBackend(platform) === "keychain" ? "the macOS Keychain" : "~/.clausona/secrets.json";
}

/**
 * Only a missing file means "no secrets yet". Every other failure — unreadable
 * (EACCES), truncated, or otherwise not a JSON object — throws instead of being
 * treated as empty: storeSecret/deleteSecret read-modify-write this result, so
 * silently returning `{}` for a corrupt or unreadable file would make the next
 * write replace it with only the entry being touched, destroying every other
 * profile's stored credential without any error surfacing.
 */
async function readSecretsFile(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(SECRETS_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`could not read ${SECRETS_PATH}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SECRETS_PATH} is not valid JSON - fix or remove it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SECRETS_PATH} must contain a JSON object`);
  }
  return parsed as Record<string, string>;
}

async function writeSecretsFile(values: Record<string, string>): Promise<void> {
  await mkdir(CLAUSONA_DIR, { recursive: true });
  const tmpPath = `${SECRETS_PATH}.tmp.${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, SECRETS_PATH);
  // rename preserves the temp file's mode, but an already-existing target could predate
  // the mode argument, so the permission is asserted rather than assumed.
  await chmod(SECRETS_PATH, 0o600).catch(() => {});
}

/**
 * The longest line `security -i` reads whole. It reads each line into a 4096-byte buffer
 * (MAX_LINE_LEN in SecurityTool's security.c): a longer one is cut there and the rest run as
 * a second command, and one of 4095 leaves its newline behind as an empty command, whose
 * success would become the exit status.
 */
const SECURITY_MAX_LINE = 4094;

/**
 * One argument on a `security -i` line, read back by its split_line: inside double quotes
 * only a backslash and the closing quote are special, and a backslash takes the next
 * character as it is. A line break cannot be quoted - it ends the command, and whatever
 * follows would run as a command of its own.
 */
function securityLineArg(value: string): string {
  if (/[\n\0]/.test(value)) {
    throw new Error("could not write the Keychain item: its name has a line break or a NUL in it");
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** A generic password in the login Keychain: `security` finds one by its service and account. */
export type KeychainItem = { service: string; account: string };

function addGenericPasswordLine(item: KeychainItem, hex: string): string {
  return [
    "add-generic-password",
    "-U",
    "-s",
    securityLineArg(item.service),
    "-a",
    securityLineArg(item.account),
    "-X",
    hex,
  ].join(" ");
}

/**
 * How `find-generic-password -w` prints a password: as it is when every byte is printable,
 * and as lowercase hex when any byte is not, then a newline (do_password_item_printing in
 * keychain_find.c). Printable is isprint in the C locale - security never sets one - so
 * 0x20-0x7e: a tab, a line break or any non-ASCII character turns the whole value to hex.
 */
function printedPassword(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.every((byte) => byte >= 0x20 && byte <= 0x7e) ? value : bytes.toString("hex")}\n`;
}

/**
 * Writes `value` as the password of `item` - a new item, or with -U the one already there -
 * and reads it back.
 *
 * The value goes to `security` on stdin, never in its arguments, which `ps` shows to every
 * user on the machine. `security -i` reads commands from stdin, and exits with the status of
 * the last one it ran - so the write is the only line. The value travels as `-X <hex>`, which
 * add-generic-password has taken since macOS 10.15 (Node 20's floor): the line splitter sees
 * nothing of it but hex digits, and the item gets the same bytes `-w <value>` gave it.
 *
 * A line longer than `security -i` reads whole goes in the arguments instead, still as
 * `-X <hex>` - what Claude Code itself does with the same item (2.1.280 switches to the
 * arguments past 4032 characters). Claude Code's credentials are the one value that needs it:
 * its OAuth tokens and every MCP server's share one item, which outgrows the line, and
 * refusing would lose a token the provider has already replaced. clausona's own keys are
 * refused before they get here (storeKeychainSecret).
 *
 * The read-back is what makes the result trustworthy. The exit status is the OSStatus cut to
 * 8 bits, so a failure whose low byte is 0 reads as success, and `-i` turns a result of -1
 * into 0. It reads by service and account, prints the value on stdout, never in argv.
 */
export async function writeKeychainItem(item: KeychainItem, value: string): Promise<void> {
  const hex = Buffer.from(value, "utf8").toString("hex");
  const line = addGenericPasswordLine(item, hex);
  const { code } =
    Buffer.byteLength(line) <= SECURITY_MAX_LINE
      ? await run("security", ["-i"], { input: `${line}\n` })
      : await run("security", ["add-generic-password", "-U", "-s", item.service, "-a", item.account, "-X", hex]);
  if (code !== 0) throw new Error(`could not write Keychain item '${item.service}'`);

  const readBack = await run("security", ["find-generic-password", "-s", item.service, "-a", item.account, "-w"]);
  if (readBack.code !== 0 || readBack.stdout !== printedPassword(value)) {
    throw new Error(`Keychain item '${item.service}' did not take the new value`);
  }
}

async function storeKeychainSecret(profileId: string, value: string): Promise<void> {
  const item = { service: keychainItemFor(profileId), account: profileId };
  const line = addGenericPasswordLine(item, Buffer.from(value, "utf8").toString("hex"));
  if (Buffer.byteLength(line) > SECURITY_MAX_LINE) {
    throw new Error(
      'the key is too long to store in the Keychain - keep it elsewhere and point at it with --key-from env:NAME or --key-from command:"<command>"',
    );
  }
  await writeKeychainItem(item, value);
}

export async function storeSecret(profileId: string, value: string, backend?: SecretBackend): Promise<void> {
  if ((backend ?? detectBackend()) === "keychain") {
    await storeKeychainSecret(profileId, value);
    return;
  }
  const values = await readSecretsFile();
  values[profileId] = value;
  await writeSecretsFile(values);
}

/** Resolves true when a stored key was there and is gone, false when there was none to delete. */
export async function deleteSecret(profileId: string, backend?: SecretBackend): Promise<boolean> {
  if ((backend ?? detectBackend()) === "keychain") {
    const { code } = await run("security", ["delete-generic-password", "-s", keychainItemFor(profileId)]);
    return code === 0;
  }
  const values = await readSecretsFile();
  if (!(profileId in values)) return false;
  delete values[profileId];
  await writeSecretsFile(values);
  return true;
}

async function readStoredSecret(
  profileId: string,
  backend: SecretBackend | undefined,
  options: Pick<RunOptions, "signal" | "limitMs">,
): Promise<string | null> {
  if ((backend ?? detectBackend()) === "keychain") {
    const item = keychainItemFor(profileId);
    const { code, stdout, timedOut } = await run("security", ["find-generic-password", "-s", item, "-w"], options);
    if (timedOut) {
      throw new Error(
        `the Keychain did not answer in ${(options.limitMs ?? 0) / 1000} s - answer its prompt if it shows one, or run 'clausona config ${profileId} --key' to store the key again`,
      );
    }
    return code === 0 && stdout.trim() !== "" ? stdout.trim() : null;
  }
  const values = await readSecretsFile();
  return values[profileId] ?? null;
}

/**
 * Resolves the credential for one profile. Every failure path throws with a message the
 * user can act on — an empty string returned as if it were a credential would surface
 * much later as an opaque 401 from the provider.
 *
 * No message quotes the reference, only what went wrong with it. These reach doctor, the
 * dashboard and the warning printed at every launch, and a command line can carry a vault
 * path, a token argument or the key itself - see src/lib/redact.ts, which hides it on
 * every path. A variable's name is quoted only when it is a name: a hand edit can put a
 * key in that slot.
 *
 * `signal` bounds a key that a command or the Keychain gives: once it aborts, what was started
 * for it is killed, and the key is not read. Without one, a key command keeps the terminal, where
 * it can prompt, and `limitMs` bounds it instead: past it, the command and what it started are
 * interrupted, and killed if it goes on running (interrupt), and the key is not read. `limitMs`
 * bounds the Keychain's answer the same way.
 */
export async function resolveSecret(
  profileId: string,
  source: SecretSource,
  backend?: SecretBackend,
  options: { signal?: AbortSignal; limitMs?: number } = {},
): Promise<string> {
  const { signal, limitMs } = options;
  // A hand edit can leave anything in the slot, or nothing. Doctor calls such a source unknown
  // and never resolves it, so launch does not read the store for it either: a profile would
  // otherwise work while doctor reported it broken. Not quoted, since it can hold anything.
  if (!isKnownSecretSource(source)) {
    throw new Error(
      `the key source in ~/.clausona/profiles.json is not keychain, env or command, so no key was read - run 'clausona config ${profileId} --key' to store one, or 'clausona config ${profileId} --key-from env:<NAME>' to read one`,
    );
  }

  if (source.source === "env") {
    if (!isPosixEnvName(source.name)) {
      throw new Error(
        `the key's environment variable is not a valid name - run 'clausona config ${profileId} --key-from env:<NAME>'`,
      );
    }
    const value = process.env[source.name];
    // Read even when the name looks like a key, since a name the shape check is wrong about
    // must go on working; only the message, which every launch prints, leaves it out.
    if (!value && carriesCredentialToken(source.name)) {
      throw new Error(
        `the key's environment variable is unset, and its name looks like an API key - run 'clausona config ${profileId} --key-from env:<NAME>' with the name of the variable that holds the key`,
      );
    }
    if (!value) throw new Error(`environment variable ${source.name} is unset or empty`);
    return value;
  }

  if (source.source === "command") {
    const shell = process.platform === "win32" ? "powershell" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", source.run] : ["-c", source.run];
    const { code, stdout, timedOut } = await run(shell, args, { signal, limitMs });
    if (signal?.aborted) throw new Error("the key was not read in time");
    // The command line is not quoted, so the message says where it is instead - profiles.json,
    // the one place it is shown - and what replaces it. Not `config --edit`: that opens the
    // env map, and the command lives in the endpoint block.
    const remedy = `run it yourself to see why - it is in ~/.clausona/profiles.json - or replace it with 'clausona config ${profileId} --key-from command:"<command>"'`;
    if (timedOut) throw new Error(`secret command did not finish in ${(limitMs ?? 0) / 1000} s - ${remedy}`);
    if (code !== 0) throw new Error(`secret command exited with ${code} - ${remedy}`);
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (first === "") throw new Error(`secret command produced no output - ${remedy}`);
    return first;
  }

  const stored = await readStoredSecret(profileId, backend, { signal, limitMs });
  if (signal?.aborted) throw new Error("the key was not read in time");
  if (!stored) throw new Error(`no stored secret for '${profileId}' - run 'clausona config ${profileId} --key'`);
  return stored;
}
