import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { claudeJsonPathForConfigDir, isDefaultClaudeConfigDir, keychainServiceForConfigDir } from "../core/paths.js";
import { spawnCommand } from "../core/process.js";
import { parseClaudeQuota, QuotaHttpError } from "../core/quota.js";
import type { QuotaWindows } from "../types.js";
import type { ToolAdapter, ToolCredential } from "./types.js";

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

function runSecurity(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawnCommand("security", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    // spawnCommand widens stdout to nullable; an absent pipe just leaves `out` empty,
    // which parseStored already treats as "no credential".
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out }));
    child.on("error", () => resolve({ code: 1, stdout: "" }));
  });
}

async function readKeychainBlob(service: string): Promise<StoredCredentials | null> {
  const { code, stdout } = await runSecurity(["find-generic-password", "-s", service, "-w"]);
  return code === 0 ? parseStored(stdout) : null;
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

async function readStoredBlob(configDir: string): Promise<StoredCredentials | null> {
  if (process.platform === "darwin") {
    return readKeychainBlob(keychainServiceForConfigDir({ homeDir: homedir(), configDir }));
  }
  return readFileBlob(configDir);
}

/**
 * Persists the blob and reads it back. The read-back is not paranoia: a refresh has
 * already invalidated the previous token by this point, so a write that silently did
 * not land would leave the profile with no usable credential at all.
 */
async function writeStoredBlob(configDir: string, blob: StoredCredentials): Promise<void> {
  const serialized = JSON.stringify(blob);

  if (process.platform === "darwin") {
    const service = keychainServiceForConfigDir({ homeDir: homedir(), configDir });
    const account = await keychainAccount(service);
    const { code } = await runSecurity(["add-generic-password", "-U", "-s", service, "-a", account, "-w", serialized]);
    if (code !== 0) throw new Error(`could not write Keychain item '${service}'`);

    const readBack = await readKeychainBlob(service);
    if (readBack?.claudeAiOauth?.accessToken !== blob.claudeAiOauth?.accessToken) {
      throw new Error(`Keychain item '${service}' did not take the renewed credential`);
    }
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
 * service name the rest of clausona already derives. Everywhere else Claude Code
 * writes them next to the config as .credentials.json.
 */
async function readClaudeCredential(configDir: string): Promise<ToolCredential | null> {
  return toCredential(await readStoredBlob(configDir));
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

  // Re-read rather than reusing an earlier copy: another process may have rewritten
  // unrelated parts of the blob (mcpOAuth) while the request was in flight.
  const blob = (await readStoredBlob(configDir)) ?? {};
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

  await writeStoredBlob(configDir, blob);

  return {
    accessToken: data.access_token,
    refreshToken: blob.claudeAiOauth.refreshToken,
    expiresAt: blob.claudeAiOauth.expiresAt,
  };
}

/**
 * Environment for `claude auth login` that signs in to the stores clausona reads for
 * `configDir`: CLAUDE_CONFIG_DIR unset for the default dir, set to the dir otherwise.
 *
 * The variable is cleared by assigning undefined rather than deleting it. spawnCommand
 * merges this over process.env on the Windows .cmd shim path, so only an explicit key can
 * override an inherited value, and Node drops undefined entries when it spawns. Windows
 * also treats names case-insensitively, so any other spelling is cleared there as well.
 */
export function claudeLoginEnv(
  configDir: string,
  { homeDir, env, platform }: { homeDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (platform === "win32") {
    for (const key of Object.keys(out)) {
      if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") out[key] = undefined;
    }
  }
  out.CLAUDE_CONFIG_DIR = isDefaultClaudeConfigDir(homeDir, configDir) ? undefined : configDir;
  return out;
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
  sharedSkipSet: (mergeSessions) =>
    mergeSessions ? new Set(BASE_SHARED_LINK_SKIP) : new Set([...BASE_SHARED_LINK_SKIP, ...SESSION_SCOPED]),
  // postSetup is left undefined here — service.ts's syncPluginsJson is wired into the
  // Claude code path explicitly because it has cross-cutting plugin marketplace state.
  // We will keep that wiring during Task 11 refactor; the adapter is not the place for it.
  readCredential: readClaudeCredential,
  fetchQuota: fetchClaudeQuota,
  renewCredential: renewClaudeCredential,
  runLogin: runLoginInteractive,
};
