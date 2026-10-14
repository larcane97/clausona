import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { acquireDirLock, type ReleaseDirLock } from "../core/dir-lock.js";
import { claudeJsonPathForConfigDir, isDefaultClaudeConfigDir, keychainServiceForConfigDir } from "../core/paths.js";
import { spawnCommand } from "../core/process.js";
import { parseClaudeQuota, QuotaHttpError } from "../core/quota.js";
import { writeKeychainItem } from "../lib/secrets.js";
import type { QuotaWindows } from "../types.js";
import type { SignInCheck, ToolAdapter, ToolCredential, UnsharedRisk } from "./types.js";

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

// State Claude Code keeps for one account or one org (2.1.299), each name as it builds it:
//
// - `policy-limits.json` holds the org's policy limits. Beside it are the signature Claude Code
//   checks them by (`.signature.json`, `.signature-iat.json`) and `.stamp.json`, which names the
//   identity they were fetched for.
// - `remote-settings.json` holds the org's remote managed settings, with the same two signature
//   files and `.synced-at`, the time of the last sync. `remote-settings-helper-consent` and
//   `remote-settings-consent.json` record what this account agreed to apply from them.
// - `mcp-needs-auth-cache.json` lists the MCP servers and claude.ai connectors that need this
//   account's sign-in.
// - `state/` holds per-account records such as MCP discovery verdicts.
// - `chrome/` holds the Claude in Chrome native host wrapper, written for this config dir.
//
// A link to the primary's makes a profile read the primary account's: until Claude Code refetches,
// it can apply the primary org's policy limits and remote settings. Claude Code saves its own copy
// by writing a new file and renaming it over the link, so the link does not last either.
const ACCOUNT_STATE = [
  "policy-limits.json",
  "policy-limits.json.signature.json",
  "policy-limits.json.signature-iat.json",
  "policy-limits.json.stamp.json",
  "remote-settings.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.signature-iat.json",
  "remote-settings.json.synced-at",
  "remote-settings-helper-consent",
  "remote-settings-consent.json",
  "mcp-needs-auth-cache.json",
  "state",
  "chrome",
] as const;

// What Claude Code writes beside those files while it saves one: `<file>.tmp.<8 hex>` from its
// atomic writer and `<file>.lock` while it holds a signature's lock. Each starts with the name of
// the file it belongs to and a dot.
const ACCOUNT_STATE_SIBLING =
  /^(?:policy-limits\.json|remote-settings\.json|remote-settings-consent\.json|remote-settings-helper-consent)\../;

// The rest of what Claude Code keeps for one account in its config dir (2.1.299). Each is on its
// list of the entries it leaves out of a snapshot of the dir's configuration, as state:
//
// - Copies of the account file, which holds the signed-in account and its MCP servers:
//   `.claude.json.backup`, and `backups/`, where Claude Code saves a copy at most once a minute
//   and from where it offers the newest one to restore a lost `.claude.json`. Shared, that copy
//   could be another account's. `.claude-<env>-oauth.json` is the account file under a staging,
//   local or custom OAuth URL, and a `.config.json` beside it is the legacy one, which Claude Code
//   reads in place of `.claude.json` when it is there.
// - The background daemon: `daemon/` holds its control key, the roster of the sessions it runs,
//   their tokens, and the nonce its Windows pipe is named by. On Windows a profile linking the
//   primary's reaches the primary's daemon, which runs its sessions on the primary's sign-in;
//   elsewhere two accounts' daemons write one roster. `daemon-auth-status.json` says whether the
//   daemon's account must sign in again, and `daemon-auth-cooldown` when it may next ask.
// - `telemetry/` holds events that failed to send, stamped with the account and org. A later run
//   of the same session sends them again, on whichever account resumed it.
// - `.session_ingress_token` and `hfi-auth.json` hold tokens of hosted sessions.
const ACCOUNT_DIR_STATE = [
  ".claude.json.backup",
  ".claude-staging-oauth.json",
  ".claude-local-oauth.json",
  ".claude-custom-oauth.json",
  ".config.json",
  "backups",
  "daemon",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  "telemetry",
  ".session_ingress_token",
  "hfi-auth.json",
] as const;

// Every other copy or companion of those files: `.claude.json.backup.<ms>`, `.corrupted.<ms>`,
// a `.bak` of the user's, and a token's temp file.
const ACCOUNT_DIR_STATE_SIBLING =
  /^(?:\.claude(?:-staging-oauth|-local-oauth|-custom-oauth)?\.json|\.config\.json|\.session_ingress_token)\../;

// Caches and ledgers Claude Code keeps for the account it runs as (2.1.299): `cache/` (the models
// this account was refused or served, its catalog's confidential ids, team discovery),
// `mcp-discovery-cache/`, `stats-cache.json` (the /stats numbers, which two profiles would
// overwrite in turn), `feedback/` (drafts queued to be sent, which could go out on another
// account) and `active-time.json`. A profile whose copy stops following the primary's loses
// nothing by it.
const ACCOUNT_CACHES = ["cache", "mcp-discovery-cache", "stats-cache.json", "feedback", "active-time.json"] as const;

// A temp file a save writes beside its target and renames over it, left behind when the save
// stopped part way. Claude Code's atomic writer names it `<file>.tmp.<8 hex>` and its synchronous
// one `<file>.tmp.<pid>.<12 hex>` (2.1.299; the two shapes it recognises as its own). The writer
// of `.session-stats.json`, which is not Claude Code, leaves `<file>.tmp.<pid>.<ms>.<base 36>`.
// Linked into a profile, a leftover in the primary stays there for good, and holds nothing a
// profile reads.
const TEMP_LEFTOVER = /^.+\.tmp\.(?:[0-9a-f]{8}|\d+\.[0-9a-f]{12}|\d+\.\d+\.[0-9a-z]+)$/;

/**
 * What a profile's link to the primary's `name` does, for the state Claude Code keeps for one
 * account or org, each with its siblings. Nothing for the rest of the skip set: a temp file, a
 * cache for one config dir, or session state while sessions are kept apart.
 */
function claudeUnsharedRisk(name: string): UnsharedRisk | undefined {
  // A sibling is said as the file it belongs to; `.claude.json` itself is the profile's account
  // file, which the skip set has kept apart since the first release.
  const family = name.startsWith(".claude.json.")
    ? ".claude.json."
    : name.match(/^(?:policy-limits\.json|remote-settings\.json|\.session_ingress_token)/)?.[0];
  switch (family ?? name) {
    case "policy-limits.json":
      return {
        risk: "isolation",
        why: "so this profile reads the primary account's org policy limits, and can apply them",
      };
    case "remote-settings.json":
      return {
        risk: "isolation",
        why: "so this profile reads the primary account's org remote managed settings, and can apply them",
      };
    case "remote-settings-consent.json":
    case "remote-settings-helper-consent":
      return {
        risk: "isolation",
        why: "so this profile reads what the primary account agreed to apply from its org's remote settings",
      };
    case "mcp-needs-auth-cache.json":
      return {
        risk: "isolation",
        why: "so this profile reads which MCP servers the primary account has to sign in to",
      };
    case "state":
      return {
        risk: "isolation",
        why: "so this profile reads the primary account's records, such as MCP discovery verdicts",
      };
    case "chrome":
      return {
        risk: "isolation",
        why: "so Claude in Chrome in this profile runs the native host Claude Code wrote for the primary's config dir",
      };
    case ".claude.json.":
      return {
        risk: "isolation",
        why: "so this profile's copies of its account file are the primary account's, which Claude Code can offer to restore",
      };
    case "backups":
      return {
        risk: "isolation",
        why: "so this profile keeps its copies of .claude.json with the primary account's, and Claude Code can offer the primary's to restore a lost one",
      };
    case ".claude-staging-oauth.json":
    case ".claude-local-oauth.json":
    case ".claude-custom-oauth.json":
    case ".config.json":
      return {
        risk: "wrong_account",
        why: "so this profile reads the primary's account file, and Claude Code runs as the primary's account",
      };
    case "daemon":
      return {
        risk: "wrong_account",
        why: "so this profile uses the primary's daemon directory: its control key, roster and session tokens, and on Windows the primary's daemon itself, which runs on the primary's account",
      };
    case "daemon-auth-cooldown":
    case "daemon-auth-status.json":
      return {
        risk: "isolation",
        why: "so this profile reads whether the primary account's daemon has to sign in again",
      };
    case "telemetry":
      return {
        risk: "isolation",
        why: "so this profile can send the primary account's queued events, on its own sign-in",
      };
    case ".session_ingress_token":
    case "hfi-auth.json":
      return { risk: "wrong_account", why: "so this profile reads the primary's session tokens" };
    case "cache":
      return { risk: "isolation", why: "so this profile reads the primary account's model access and catalog" };
    case "mcp-discovery-cache":
      return { risk: "isolation", why: "so this profile reads the primary account's MCP discovery cache" };
    case "stats-cache.json":
      return { risk: "isolation", why: "so this profile reads and overwrites the primary account's /stats numbers" };
    case "feedback":
      return {
        risk: "isolation",
        why: "so this profile reads the primary account's feedback drafts, and can send one on its own account",
      };
    case "active-time.json":
      return { risk: "isolation", why: "so this profile reads and writes the primary account's active time" };
    default:
      return undefined;
  }
}

// State keyed by session id. `jobs/` holds the background-session records that the
// background list reads (state, respawn flags, resume target) and `teams/` holds team
// membership; both are addressed by the same session id as the transcripts under
// `projects/`, and the tool derives all three from one CLAUDE_CONFIG_DIR. Sharing them
// out of step with `projects/` splits a record from its transcript and resume breaks,
// so they follow the session-separation choice rather than being shared unconditionally.
const SESSION_SCOPED = ["projects", "jobs", "teams"] as const;

// Shared files Claude Code saves whole: its writer puts a temp file beside the target and
// renames it over it (2.1.291), whether the save is a settings change or an edit Claude makes
// to the user's own CLAUDE.md or keybindings.json. Caches it saves the same way are left out:
// a profile whose copy of a cache stops following the primary's loses nothing by it.
const REWRITTEN_WHOLE = new Set(["settings.json", "CLAUDE.md", "keybindings.json"]);

// Undocumented endpoint that backs Claude Code's own /usage view. Anonymous requests
// are rejected with a flat one-hour Retry-After, so it is never called without a token.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";

/**
 * The account Claude Code keeps its Keychain item under, derived the way it derives it
 * (2.1.283): the login name in USER, else the OS's name for the user, and
 * "claude-code-user" when neither can be had or the name has a character outside
 * [a-zA-Z0-9._-]. Claude Code reads, writes and deletes the item by service and this
 * account, so clausona names both wherever it touches that item. By service alone
 * `security` takes the first item it finds, which can be another account's when two share
 * the service, and `add-generic-password -U` replaces only the item with the same service
 * and account. A renewal read from or written to another account's item would leave Claude
 * Code's own holding a refresh token the provider has already rotated out.
 */
export function claudeKeychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    // userInfo throws for a user with no entry in the user database, as in some containers.
    name = CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
}

async function hasKeychain(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise<boolean>((resolve) => {
    const args = ["find-generic-password", "-s", service, "-a", claudeKeychainAccount()];
    const child = spawnCommand("security", args, { stdio: "ignore" });
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
  const account = claudeKeychainAccount();
  const { code, stdout, launched } = await runSecurity(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (code === 0) {
    // Claude Code falls through on an item it cannot parse as well.
    const blob = parseStored(decodeKeychainOutput(stdout));
    return blob ? { state: "found", blob } : { state: "absent" };
  }
  // Without a `security` binary there is no Keychain to hold the item.
  if (!launched || KEYCHAIN_ABSENT_CODES.has(code)) return { state: "absent" };
  return { state: "unreadable" };
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
    await writeKeychainItem({ service, account: claudeKeychainAccount() }, serialized);
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

// Claude Code's own locks on a config dir's credential, which it takes with proper-lockfile
// (2.1.283) and acquireDirLock takes the same way; the stale and update times are its own.
// It refreshes under two, taken in this order: `.oauth_refresh.lock` in the config dir,
// then the legacy `<config dir>.lock` next to it. Every write to the store - its own
// renewal's, an MCP server's token - is a re-read, merge and write under a third,
// `.storage-write.lock` in the config dir.
const REFRESH_LOCK = { staleMs: 60_000, updateMs: 5_000 };
// Claude Code holds this one for a single store write at a time. A renewal waits for it long
// enough for a dead holder's lock to go stale and be taken over: a holder refreshes the mtime
// 7.5 s after taking the lock and every 7.5 s after that, so one that dies just after a
// refresh leaves it fresh for up to 22.5 s from when the wait began, and a second more where
// the filesystem keeps whole seconds.
const STORAGE_WRITE_LOCK = { staleMs: 15_000, updateMs: 7_500, waitMs: 25_000, retryMs: 100 };

/**
 * Takes Claude Code's two refresh locks in its order, resolving to the function that
 * releases both, or to null while another process holds either. The legacy lock sits in the
 * config dir's parent, which need not be writable, so one that cannot be created at all is
 * done without, as Claude Code does.
 */
async function acquireRefreshLocks(configDir: string): Promise<ReleaseDirLock | null> {
  const releaseCurrent = await acquireDirLock(path.join(configDir, ".oauth_refresh.lock"), REFRESH_LOCK);
  if (!releaseCurrent) return null;

  const legacyPath = `${await realpath(configDir).catch(() => configDir)}.lock`;
  // Undefined, as opposed to null for a held lock, when it could not be created.
  const releaseLegacy = await acquireDirLock(legacyPath, REFRESH_LOCK).catch(() => undefined);
  if (releaseLegacy === null) {
    await releaseCurrent();
    return null;
  }

  return async () => {
    await releaseLegacy?.();
    await releaseCurrent();
  };
}

/**
 * Renews via the OAuth refresh grant and stores the result, or resolves to null, having
 * changed nothing, while a running Claude Code holds its refresh lock for this config dir.
 *
 * The provider rotates the refresh token and rejects the previous one immediately —
 * there is no reuse window — so the response is persisted before this returns and any
 * persistence failure is raised rather than swallowed. The same goes for a running Claude
 * Code: if it spends the same refresh token at the same moment, whichever of the two comes
 * second is refused, and a Claude Code that loses can lose its session's sign-in. So the
 * renewal happens under Claude Code's own refresh locks, and backs off while it holds them.
 */
async function renewClaudeCredential(
  configDir: string,
  credential: ToolCredential,
  signal: AbortSignal,
): Promise<ToolCredential | null> {
  if (!credential.refreshToken) {
    throw new Error("no refresh token stored for this profile");
  }

  const releaseRefreshLocks = await acquireRefreshLocks(configDir);
  if (!releaseRefreshLocks) return null;
  try {
    return await renewUnderRefreshLocks(configDir, credential, signal);
  } finally {
    await releaseRefreshLocks();
  }
}

async function renewUnderRefreshLocks(
  configDir: string,
  credential: ToolCredential,
  signal: AbortSignal,
): Promise<ToolCredential> {
  // Read again under the locks, as Claude Code does. An access token other than the one
  // being renewed means another process renewed it since it was read: its refresh token is
  // spent, and what is stored now is the credential to use. A store that cannot be read, or
  // that holds nothing, cannot say, and a signed-out profile must stay signed out, so
  // neither is renewed.
  //
  // Also kept in case the re-read after the refresh fails, since writing back an empty blob
  // would drop everything besides claudeAiOauth, the profile's MCP OAuth tokens included.
  const before = await lookupStoredBlob(configDir);
  if (before === "unreadable") throw new Error("the stored credential could not be read to check it before renewal");
  const current = toCredential(before?.blob ?? null);
  if (!before || !current) throw new Error("no credential is stored for this profile any more");
  if (current.accessToken !== credential.accessToken) return current;
  // The refresh token posted is the one stored now, which the save below checks is still there.
  const postedRefreshToken = current.refreshToken;
  if (!postedRefreshToken) throw new Error("no refresh token stored for this profile");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: postedRefreshToken,
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

  // The re-read, merge and write happen under Claude Code's write lock, so no write of its
  // own - an MCP server's token, say - lands between them and is overwritten. It is not held
  // across the request above, which would hold up every such write for as long as that took.
  //
  // A lock that is still held after the wait, or that cannot be taken at all, is written
  // without. The refresh token has rotated by now, so a write given up loses the sign-in for
  // certain, while one made without the lock risks at most a write of Claude Code's that
  // lands at the same moment.
  const releaseWriteLock = await acquireDirLock(path.join(configDir, ".storage-write.lock"), STORAGE_WRITE_LOCK).catch(
    () => null,
  );
  try {
    // Re-read rather than reusing the earlier copy: another process may have rewritten
    // unrelated parts of the blob (mcpOAuth) while the request was in flight. The earlier
    // copy stands in only when this read fails, and it brings the store it was read from,
    // unless it was the Keychain that failed.
    const reread = await lookupStoredBlob(configDir);

    // Saved only over the sign-in that was renewed, as Claude Code's own save after a refresh
    // is. A stored refresh token other than the one posted - from a `/login` that saved new
    // tokens while the request was in flight, which takes the write lock alone - is newer
    // than this renewal, so it is kept and used instead. An empty one is how Claude Code
    // marks a refresh token the provider refused, and the renewal does replace that.
    if (reread && reread !== "unreadable") {
      const storedRefreshToken = reread.blob.claudeAiOauth?.refreshToken;
      if (storedRefreshToken !== postedRefreshToken && storedRefreshToken !== "") {
        const newer = toCredential(reread.blob);
        if (!newer) throw new Error("the sign-in was removed while it was being renewed");
        return newer;
      }
    }

    const stored = (reread === "unreadable" ? null : reread) ?? before;
    const blob = stored.blob;
    const previous = blob.claudeAiOauth ?? {};
    const now = Date.now();

    blob.claudeAiOauth = {
      ...previous,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? postedRefreshToken,
      ...(data.expires_in ? { expiresAt: now + data.expires_in * 1000 } : {}),
      ...(data.refresh_token_expires_in ? { refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000 } : {}),
      ...(data.scope ? { scopes: data.scope.split(" ") } : {}),
    };

    // Back to the store it came from. On macOS a blob read from the plaintext file means the
    // Keychain held no item: Claude Code keeps reading the file for as long as that stays
    // true, and the Keychain is the store that refused its write in the first place. That
    // holds for the earlier copy as well - a file that is mid-rewrite when it is re-read
    // does not make the Keychain the right place.
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
      await writeStoredBlob(configDir, blob, stored.store);
    }

    return {
      accessToken: data.access_token,
      refreshToken: blob.claudeAiOauth.refreshToken,
      expiresAt: blob.claudeAiOauth.expiresAt,
    };
  } finally {
    await releaseWriteLock?.();
  }
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

// Claude names what it does not share, and keeps sharedSkipSet for every caller to read.
export const claudeAdapter: ToolAdapter & Required<Pick<ToolAdapter, "sharedSkipSet">> = {
  name: "claude",
  binary: "claude",
  configEnvVar: "CLAUDE_CONFIG_DIR",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".claude"),
  configDirPattern: /^\.claude(-.+)?$/,
  readAccountInfo: readAccount,
  keychainServiceName: keychainServiceForConfigDir,
  keychainAccount: claudeKeychainAccount,
  hasKeychainCredential: hasKeychain,
  hasFallbackCredential,
  sharedSkipSet: (mergeSessions) =>
    new Set([
      ...BASE_SHARED_LINK_SKIP,
      ...ACCOUNT_STATE,
      ...ACCOUNT_DIR_STATE,
      ...ACCOUNT_CACHES,
      ...(mergeSessions ? [] : SESSION_SCOPED),
    ]),
  shouldSkipName: (name) =>
    ACCOUNT_STATE_SIBLING.test(name) || ACCOUNT_DIR_STATE_SIBLING.test(name) || TEMP_LEFTOVER.test(name),
  unsharedRisk: claudeUnsharedRisk,
  rewritesWhole: (name) => REWRITTEN_WHOLE.has(name),
  // postSetup is left undefined here — service.ts's syncPluginsJson is wired into the
  // Claude code path explicitly because it has cross-cutting plugin marketplace state.
  // We will keep that wiring during Task 11 refactor; the adapter is not the place for it.
  readCredential: readClaudeCredential,
  fetchQuota: fetchClaudeQuota,
  renewCredential: renewClaudeCredential,
  runLogin: runLoginInteractive,
  verifySignIn: verifyClaudeSignIn,
};
