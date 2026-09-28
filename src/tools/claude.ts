import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { claudeJsonPathForConfigDir, isDefaultClaudeConfigDir, keychainServiceForConfigDir } from "../core/paths.js";
import { spawnCommand } from "../core/process.js";
import { parseClaudeQuota, QuotaHttpError } from "../core/quota.js";
import { writeKeychainItem } from "../lib/secrets.js";
import type { QuotaWindows } from "../types.js";
import type { SignInCheck, ToolAdapter, ToolCredential } from "./types.js";

// `.credentials.json` is the OAuth token store Claude Code uses wherever there is no
// system keychain — on macOS the tokens live in the Keychain under a per-config-dir
// service name instead, so the primary has no such file and nothing was ever linked.
// That is why sharing it went unnoticed: on Linux and Windows a shared link makes every
// profile read the primary's token, so all accounts authenticate and spend quota as the
// primary no matter what `/status` reports.
//
// `.last-update-result.json` (the last auto-update's outcome), `gh-pr-status-cache.json`
// (the PR status shown in the prompt) and `.session-stats.json` (written by a hook or
// status line, not by Claude Code itself) are state or a cache for one config dir. Each
// writer replaces a shared link with a regular file — Claude Code's atomic write, or the
// hook's — so the link never stays in place, and while it does, one account's data shows
// in another's profile.
const BASE_SHARED_LINK_SKIP = new Set([
  ".claude.json",
  ".credentials.json",
  "image-cache",
  "statsig",
  "plugins",
  ".last-update-result.json",
  "gh-pr-status-cache.json",
  ".session-stats.json",
]);

// State keyed by session id. `jobs/` holds the background-session records that the
// background list reads (state, respawn flags, resume target) and `teams/` holds team
// membership; both are addressed by the same session id as the transcripts under
// `projects/`, and the tool derives all three from one CLAUDE_CONFIG_DIR. Sharing them
// out of step with `projects/` splits a record from its transcript and resume breaks,
// so they follow the session-separation choice rather than being shared unconditionally.
const SESSION_SCOPED = ["projects", "jobs", "teams"] as const;

// Undocumented endpoint that backs Claude Code's own /usage view. Anonymous requests
// are rejected with a flat one-hour Retry-After, so it is never called without a token.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

async function hasKeychain(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise<boolean>((resolve) => {
    const child = spawnCommand("security", ["find-generic-password", "-s", service], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function readAccount(configDir: string): Promise<{ email: string; orgName?: string } | null> {
  const jsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir });
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string; organizationName?: string } };
    const email = parsed.oauthAccount?.emailAddress;
    if (!email) return null;
    return { email, orgName: parsed.oauthAccount?.organizationName };
  } catch {
    return null;
  }
}

type OauthBlock = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

// The stored blob also carries unrelated state (mcpOAuth), so it is always read and
// rewritten whole — only claudeAiOauth is replaced.
type StoredCredentials = { claudeAiOauth?: OauthBlock } & Record<string, unknown>;

function parseStored(raw: string): StoredCredentials | null {
  try {
    const parsed = JSON.parse(raw) as StoredCredentials;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function toCredential(stored: StoredCredentials | null): ToolCredential | null {
  const oauth = stored?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

function runSecurity(args: string[]): Promise<{ code: number; stdout: string; launched: boolean }> {
  return new Promise((resolve) => {
    const child = spawnCommand("security", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    // spawnCommand widens stdout to nullable; an absent pipe just leaves `out` empty,
    // which parseStored already treats as "no credential".
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out, launched: true }));
    child.on("error", () => resolve({ code: 1, stdout: "", launched: false }));
  });
}

/**
 * `security find-generic-password -w` prints the data as hex once any byte is outside
 * printable ASCII, which a single non-ASCII character anywhere in the blob (an MCP
 * server's entry, say) is enough for. A JSON object printed as-is starts with `{`, never
 * with the hex digits `7b`, so the two cannot be mistaken for each other.
 */
function decodeKeychainOutput(stdout: string): string {
  const trimmed = stdout.trim();
  return /^7b(?:[0-9a-f]{2})*$/i.test(trimmed) ? Buffer.from(trimmed, "hex").toString("utf8") : stdout;
}

// `security` exit statuses that Claude Code's strict read, the one it makes before a write,
// takes for an empty Keychain: errSecItemNotFound, and errSecInteractionNotAllowed — a
// Keychain that cannot be opened without a prompt, as over SSH, which is also what makes
// its own writes fall back to the file.
const KEYCHAIN_ABSENT_CODES = new Set([44, 36]);

type KeychainLookup =
  | { state: "found"; blob: StoredCredentials }
  | { state: "absent" }
  // Any other failure, such as a denied access prompt, says nothing about the item.
  // Claude Code's everyday read moves on to the file after any failure, but its strict
  // read counts these as failures rather than as an empty Keychain, and so does this: the
  // failure can be this process's alone, with the item Claude Code reads first still
  // there - the file would then be stale, and a renewed token written to it never read.
  | { state: "unreadable" };

async function readKeychainBlob(service: string): Promise<KeychainLookup> {
  const { code, stdout, launched } = await runSecurity(["find-generic-password", "-s", service, "-w"]);
  if (code === 0) {
    // Claude Code falls through on an item it cannot parse as well.
    const blob = parseStored(decodeKeychainOutput(stdout));
    return blob ? { state: "found", blob } : { state: "absent" };
  }
  // Without a `security` binary there is no Keychain to hold the item.
  if (!launched || KEYCHAIN_ABSENT_CODES.has(code)) return { state: "absent" };
  return { state: "unreadable" };
}

/**
 * `security add-generic-password -U` keys on both service and account, so writing
 * under a different account would add a second entry instead of replacing the entry
 * Claude Code reads.
 */
async function keychainAccount(service: string): Promise<string> {
  const { code, stdout } = await runSecurity(["find-generic-password", "-s", service]);
  const match = code === 0 ? /"acct"<blob>="([^"]*)"/.exec(stdout) : null;
  return match?.[1] || userInfo().username;
}

const credentialsFilePath = (configDir: string) => path.join(configDir, ".credentials.json");

async function readFileBlob(configDir: string): Promise<StoredCredentials | null> {
  try {
    return parseStored(await readFile(credentialsFilePath(configDir), "utf8"));
  } catch {
    return null;
  }
}

async function hasFallbackCredential(configDir: string): Promise<boolean> {
  return toCredential(await readFileBlob(configDir)) !== null;
}

type CredentialStore = "keychain" | "file";

type StoredBlob = { blob: StoredCredentials; store: CredentialStore };

/**
 * Reads in Claude Code's order. On macOS its store is the Keychain wrapped with a
 * plaintext fallback: a Keychain write that fails for any reason but a timeout, or a
 * locked Keychain it knows holds the item, lands in .credentials.json instead, and reads
 * try the Keychain first, then that file. Elsewhere the file is the only store. The store
 * comes back with the blob so a renewal can put its result where Claude Code will look
 * for it, and "unreadable" when the Keychain failed in a way that leaves the store
 * unknown.
 */
async function lookupStoredBlob(configDir: string): Promise<StoredBlob | "unreadable" | null> {
  if (process.platform === "darwin") {
    const lookup = await readKeychainBlob(keychainServiceForConfigDir({ homeDir: homedir(), configDir }));
    if (lookup.state === "found") return { blob: lookup.blob, store: "keychain" };
    if (lookup.state === "unreadable") return "unreadable";
  }
  const blob = await readFileBlob(configDir);
  return blob ? { blob, store: "file" } : null;
}

async function readStoredBlob(configDir: string): Promise<StoredBlob | null> {
  const stored = await lookupStoredBlob(configDir);
  return stored === "unreadable" ? null : stored;
}

/**
 * Persists the blob and reads it back. The read-back is not paranoia: a refresh has
 * already invalidated the previous token by this point, so a write that silently did
 * not land would leave the profile with no usable credential at all.
 *
 * For the Keychain both happen in writeKeychainItem, which hands the blob to `security` on
 * stdin rather than in its arguments, where `ps` would show the tokens to every user on the
 * machine - the same bytes, item and account the `-w <blob>` it replaces wrote. A blob too
 * long for one `security -i` line still goes in the arguments, as Claude Code's own does.
 */
async function writeStoredBlob(configDir: string, blob: StoredCredentials, store: CredentialStore): Promise<void> {
  const serialized = JSON.stringify(blob);

  if (store === "keychain") {
    const service = keychainServiceForConfigDir({ homeDir: homedir(), configDir });
    await writeKeychainItem({ service, account: await keychainAccount(service) }, serialized);
    return;
  }

  const target = credentialsFilePath(configDir);
  const tmpPath = `${target}.tmp.${process.pid}`;
  await writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, target);

  const readBack = await readFileBlob(configDir);
  if (readBack?.claudeAiOauth?.accessToken !== blob.claudeAiOauth?.accessToken) {
    throw new Error(`${target} did not take the renewed credential`);
  }
}

/**
 * macOS keeps the OAuth tokens in the Keychain, keyed by the same per-config-dir
 * service name the rest of clausona already derives, or in .credentials.json when the
 * Keychain refused Claude Code's write. Everywhere else Claude Code writes them next to
 * the config as .credentials.json.
 */
async function readClaudeCredential(configDir: string): Promise<ToolCredential | null> {
  return toCredential((await readStoredBlob(configDir))?.blob ?? null);
}

async function fetchClaudeQuota(credential: ToolCredential, signal: AbortSignal): Promise<QuotaWindows | null> {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "Content-Type": "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new QuotaHttpError(response.status, response.headers.get("retry-after"));
  }

  return parseClaudeQuota(await response.json());
}

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
};

/**
 * Renews via the OAuth refresh grant and stores the result.
 *
 * The provider rotates the refresh token and rejects the previous one immediately —
 * there is no reuse window — so the response is persisted before this returns and any
 * persistence failure is raised rather than swallowed.
 */
async function renewClaudeCredential(
  configDir: string,
  credential: ToolCredential,
  signal: AbortSignal,
): Promise<ToolCredential> {
  if (!credential.refreshToken) {
    throw new Error("no refresh token stored for this profile");
  }

  // Kept in case the re-read after the refresh fails, since writing back an empty blob
  // would drop everything besides claudeAiOauth, the profile's MCP OAuth tokens included.
  const before = await readStoredBlob(configDir);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
    signal,
  });

  if (!response.ok) {
    // The refresh token itself has lapsed or been revoked; only a fresh login helps.
    throw new QuotaHttpError(response.status, response.headers.get("retry-after"));
  }

  const data = (await response.json()) as RefreshResponse;
  if (!data.access_token) throw new Error("refresh response carried no access token");

  // Re-read rather than reusing the earlier copy: another process may have rewritten
  // unrelated parts of the blob (mcpOAuth) while the request was in flight. The earlier
  // copy stands in only when this read fails, and it brings the store it was read from,
  // unless it was the Keychain that failed.
  const reread = await lookupStoredBlob(configDir);
  const stored = (reread === "unreadable" ? null : reread) ?? before;
  const blob = stored?.blob ?? {};
  const previous = blob.claudeAiOauth ?? {};
  const now = Date.now();

  blob.claudeAiOauth = {
    ...previous,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credential.refreshToken,
    ...(data.expires_in ? { expiresAt: now + data.expires_in * 1000 } : {}),
    ...(data.refresh_token_expires_in ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 } : {}),
    ...(data.scope ? { scopes: data.scope.split(" ") } : {}),
  };

  // Back to the store it came from. On macOS a blob read from the plaintext file means the
  // Keychain held no item: Claude Code keeps reading the file for as long as that stays
  // true, and the Keychain is the store that refused its write in the first place. That
  // holds for the earlier copy as well - a file that is mid-rewrite when it is re-read
  // does not make the Keychain the right place. With nothing stored at all, the
  // platform's primary store is the one it reads first.
  //
  // A Keychain that failed the re-read is different: the credential can have moved into it
  // since the earlier copy was read, and Claude Code reads it before the file, so the
  // earlier copy's store proves nothing. Write the way Claude Code does - the Keychain,
  // and the file only when the Keychain refuses the write.
  if (reread === "unreadable") {
    try {
      await writeStoredBlob(configDir, blob, "keychain");
    } catch {
      await writeStoredBlob(configDir, blob, "file");
    }
  } else {
    await writeStoredBlob(configDir, blob, stored?.store ?? (process.platform === "darwin" ? "keychain" : "file"));
  }

  return {
    accessToken: data.access_token,
    refreshToken: blob.claudeAiOauth.refreshToken,
    expiresAt: blob.claudeAiOauth.expiresAt,
  };
}

type EnvOptions = { homeDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform };

/**
 * Clears each of `keys` in `env`, in place, by assigning undefined rather than deleting it.
 * spawnCommand merges the env over process.env on the Windows .cmd shim path, so only an
 * explicit key can override an inherited value, and Node drops undefined entries when it
 * spawns. Windows also treats names case-insensitively, so any other spelling is cleared
 * there as well.
 */
function clearEnv(env: NodeJS.ProcessEnv, keys: readonly string[], platform: NodeJS.Platform): void {
  if (platform === "win32") {
    const upper = new Set(keys.map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) {
      if (upper.has(key.toUpperCase())) env[key] = undefined;
    }
  }
  for (const key of keys) env[key] = undefined;
}

/**
 * Environment for `claude auth login` that signs in to the stores clausona reads for
 * `configDir`: CLAUDE_CONFIG_DIR unset for the default dir, set to the dir otherwise.
 * Unset means cleared as clearEnv clears, in any spelling on Windows.
 */
export function claudeLoginEnv(configDir: string, { homeDir, env, platform }: EnvOptions): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  clearEnv(out, ["CLAUDE_CONFIG_DIR"], platform);
  if (!isDefaultClaudeConfigDir(homeDir, configDir)) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

/**
 * Environment for `claude auth status` after a sign-in: the login's own, so it reads the
 * stores the login wrote, with every variable in `clearKeys` cleared as well. An inherited
 * ANTHROPIC_API_KEY, OAuth token or provider switch would otherwise answer "logged in" for
 * a profile with nothing stored. Bare mode (`--bare` sets CLAUDE_CODE_SIMPLE) goes too: it
 * skips the stored sign-in altogether, so it would answer "not logged in" whatever is stored.
 */
export function claudeAuthStatusEnv(
  configDir: string,
  { clearKeys, ...options }: EnvOptions & { clearKeys: readonly string[] },
): NodeJS.ProcessEnv {
  const out = claudeLoginEnv(configDir, options);
  clearEnv(out, [...clearKeys, "CLAUDE_CODE_SIMPLE"], options.platform);
  return out;
}

// Reading the Keychain can wait on a prompt; an answer that has not come by then is treated
// as no answer, not as a pass.
const AUTH_STATUS_TIMEOUT_MS = 30_000;

type AuthStatusRun = { code: number | null; stdout: string } | { error: string };

function runAuthStatus(env: NodeJS.ProcessEnv): Promise<AuthStatusRun> {
  // The first of the three outcomes wins; a later resolve is a no-op.
  return new Promise((resolve) => {
    const child = spawnCommand("claude", ["auth", "status", "--json"], { env, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      resolve({ error: `'claude auth status' did not answer within ${AUTH_STATUS_TIMEOUT_MS / 1000}s` });
      child.kill();
      // On Windows the kill ends the shim, not the claude it started, which would hold the
      // pipe - and with it clausona's exit - open until it ends.
      child.stdout?.destroy();
    }, AUTH_STATUS_TIMEOUT_MS);
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error: `could not run 'claude auth status': ${error.message}` });
    });
  });
}

/** The JSON object `claude auth status --json` printed, taken from its first `{` to its last `}`. */
function parseAuthStatus(stdout: string): { loggedIn?: unknown; authMethod?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `claude auth login` is no proof of a stored token. Claude Code writes the account to
 * .claude.json before it stores the token, and a failed store - on macOS a Keychain write
 * that times out on a locked keychain skips the plaintext fallback - still prints "Login
 * successful." and exits 0. So Claude Code is asked, through the same stores the login
 * used, and only a claude.ai sign-in passes: with no token but an API key it would answer
 * `loggedIn: true` with `authMethod: "api_key"`.
 */
async function verifyClaudeSignIn(
  configDir: string,
  { clearEnvKeys }: { clearEnvKeys: readonly string[] },
): Promise<SignInCheck> {
  const env = claudeAuthStatusEnv(configDir, {
    homeDir: homedir(),
    env: process.env,
    platform: process.platform,
    clearKeys: clearEnvKeys,
  });
  const run = await runAuthStatus(env);
  if ("error" in run) return { ok: false, reason: "unknown", detail: run.error };
  const status = parseAuthStatus(run.stdout);
  if (!status) {
    return { ok: false, reason: "unknown", detail: `'claude auth status' exited ${run.code} with no JSON answer` };
  }
  // Only an answer that says so is taken as no credential: it deletes a new profile's dir.
  if (status.loggedIn === false) {
    return { ok: false, reason: "signed_out", detail: "'claude auth status' reports it is not logged in" };
  }
  if (status.loggedIn !== true) {
    return { ok: false, reason: "unknown", detail: "'claude auth status' did not say whether it is logged in" };
  }
  if (status.authMethod !== "claude.ai") {
    return {
      ok: false,
      reason: "unknown",
      detail: `'claude auth status' reports sign-in method ${JSON.stringify(status.authMethod ?? null)}, not claude.ai`,
    };
  }
  if (run.code !== 0) {
    return { ok: false, reason: "unknown", detail: `'claude auth status' exited ${run.code}` };
  }
  return { ok: true };
}

async function runLoginInteractive(configDir: string): Promise<boolean> {
  const env = claudeLoginEnv(configDir, { homeDir: homedir(), env: process.env, platform: process.platform });
  return new Promise<boolean>((resolve) => {
    const child = spawnCommand("claude", ["auth", "login"], { env, stdio: "inherit" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export const claudeAdapter: ToolAdapter = {
  name: "claude",
  binary: "claude",
  configEnvVar: "CLAUDE_CONFIG_DIR",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".claude"),
  configDirPattern: /^\.claude(-.+)?$/,
  readAccountInfo: readAccount,
  keychainServiceName: keychainServiceForConfigDir,
  hasKeychainCredential: hasKeychain,
  hasFallbackCredential,
  sharedSkipSet: (mergeSessions) =>
    mergeSessions ? new Set(BASE_SHARED_LINK_SKIP) : new Set([...BASE_SHARED_LINK_SKIP, ...SESSION_SCOPED]),
  // postSetup is left undefined here — service.ts's syncPluginsJson is wired into the
  // Claude code path explicitly because it has cross-cutting plugin marketplace state.
  // We will keep that wiring during Task 11 refactor; the adapter is not the place for it.
  readCredential: readClaudeCredential,
  fetchQuota: fetchClaudeQuota,
  renewCredential: renewClaudeCredential,
  runLogin: runLoginInteractive,
  verifySignIn: verifyClaudeSignIn,
};
