import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { spawnCommand } from "../core/process.js";
import { isPosixEnvName } from "../core/shell.js";
import type { SecretSource } from "../types.js";

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const SECRETS_PATH = path.join(CLAUSONA_DIR, "secrets.json");

export type SecretBackend = "keychain" | "file";

/** Namespaced so a clausona item is never confused with one Claude Code itself wrote. */
export function keychainItemFor(profileId: string): string {
  return `clausona-${profileId}`;
}

type RunResult = { code: number; stdout: string };

function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnCommand(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out }));
    child.on("error", () => resolve({ code: 1, stdout: "" }));
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
      ? await run("security", ["-i"], `${line}\n`)
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

export async function deleteSecret(profileId: string, backend?: SecretBackend): Promise<void> {
  if ((backend ?? detectBackend()) === "keychain") {
    await run("security", ["delete-generic-password", "-s", keychainItemFor(profileId)]);
    return;
  }
  const values = await readSecretsFile();
  if (!(profileId in values)) return;
  delete values[profileId];
  await writeSecretsFile(values);
}

async function readStoredSecret(profileId: string, backend?: SecretBackend): Promise<string | null> {
  if ((backend ?? detectBackend()) === "keychain") {
    const { code, stdout } = await run("security", ["find-generic-password", "-s", keychainItemFor(profileId), "-w"]);
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
 */
export async function resolveSecret(profileId: string, source: SecretSource, backend?: SecretBackend): Promise<string> {
  if (source.source === "env") {
    if (!isPosixEnvName(source.name)) {
      throw new Error(
        `the key's environment variable is not a valid name - run 'clausona config ${profileId} --key-from env:<NAME>'`,
      );
    }
    const value = process.env[source.name];
    if (!value) throw new Error(`environment variable ${source.name} is unset or empty`);
    return value;
  }

  if (source.source === "command") {
    const shell = process.platform === "win32" ? "powershell" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", source.run] : ["-c", source.run];
    const { code, stdout } = await run(shell, args);
    // The command line is not quoted, so the message says where it is instead - profiles.json,
    // the one place it is shown - and what replaces it. Not `config --edit`: that opens the
    // env map, and the command lives in the endpoint block.
    const remedy = `run it yourself to see why - it is in ~/.clausona/profiles.json - or replace it with 'clausona config ${profileId} --key-from command:"<command>"'`;
    if (code !== 0) throw new Error(`secret command exited with ${code} - ${remedy}`);
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (first === "") throw new Error(`secret command produced no output - ${remedy}`);
    return first;
  }

  const stored = await readStoredSecret(profileId, backend);
  if (!stored) throw new Error(`no stored secret for '${profileId}' - run 'clausona config ${profileId} --key'`);
  return stored;
}
