import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { spawnCommand } from "../core/process.js";
import type { SecretSource } from "../types.js";

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const SECRETS_PATH = path.join(CLAUSONA_DIR, "secrets.json");

export type SecretBackend = "keychain" | "secret-tool" | "file";

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

export async function detectBackend(platform: NodeJS.Platform = process.platform): Promise<SecretBackend> {
  if (platform === "darwin") return "keychain";
  if (platform === "linux" && (await run("secret-tool", ["--version"])).code === 0) return "secret-tool";
  return "file";
}

async function readSecretsFile(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(SECRETS_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
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

export async function storeSecret(profileId: string, value: string, backend?: SecretBackend): Promise<void> {
  const resolvedBackend = backend ?? (await detectBackend());
  if (resolvedBackend === "keychain") {
    const { code } = await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      keychainItemFor(profileId),
      "-a",
      profileId,
      "-w",
      value,
    ]);
    if (code !== 0) throw new Error(`could not write Keychain item '${keychainItemFor(profileId)}'`);
    return;
  }
  if (resolvedBackend === "secret-tool") {
    const { code } = await run(
      "secret-tool",
      ["store", "--label", keychainItemFor(profileId), "clausona", profileId],
      value,
    );
    if (code !== 0) throw new Error(`could not store secret for '${profileId}' via secret-tool`);
    return;
  }
  const values = await readSecretsFile();
  values[profileId] = value;
  await writeSecretsFile(values);
}

export async function deleteSecret(profileId: string, backend?: SecretBackend): Promise<void> {
  const resolvedBackend = backend ?? (await detectBackend());
  if (resolvedBackend === "keychain") {
    await run("security", ["delete-generic-password", "-s", keychainItemFor(profileId)]);
    return;
  }
  if (resolvedBackend === "secret-tool") {
    await run("secret-tool", ["clear", "clausona", profileId]);
    return;
  }
  const values = await readSecretsFile();
  if (!(profileId in values)) return;
  delete values[profileId];
  await writeSecretsFile(values);
}

async function readStoredSecret(profileId: string, backend?: SecretBackend): Promise<string | null> {
  const resolvedBackend = backend ?? (await detectBackend());
  if (resolvedBackend === "keychain") {
    const { code, stdout } = await run("security", ["find-generic-password", "-s", keychainItemFor(profileId), "-w"]);
    return code === 0 && stdout.trim() !== "" ? stdout.trim() : null;
  }
  if (resolvedBackend === "secret-tool") {
    const { code, stdout } = await run("secret-tool", ["lookup", "clausona", profileId]);
    return code === 0 && stdout.trim() !== "" ? stdout.trim() : null;
  }
  const values = await readSecretsFile();
  return values[profileId] ?? null;
}

/**
 * Resolves the credential for one profile. Every failure path throws with a message the
 * user can act on — an empty string returned as if it were a credential would surface
 * much later as an opaque 401 from the provider.
 */
export async function resolveSecret(profileId: string, source: SecretSource, backend?: SecretBackend): Promise<string> {
  if (source.source === "env") {
    const value = process.env[source.name];
    if (!value) throw new Error(`environment variable ${source.name} is unset or empty`);
    return value;
  }

  if (source.source === "command") {
    const shell = process.platform === "win32" ? "powershell" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", source.run] : ["-c", source.run];
    const { code, stdout } = await run(shell, args);
    if (code !== 0) throw new Error(`secret command exited with ${code}: ${source.run}`);
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? "";
    if (first === "") throw new Error(`secret command produced no output: ${source.run}`);
    return first;
  }

  const stored = await readStoredSecret(profileId, backend);
  if (!stored) throw new Error(`no stored secret for '${profileId}' - run 'clausona config ${profileId} --key'`);
  return stored;
}
