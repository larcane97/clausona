import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnCommand } from "../core/process.js";
import { parseCodexQuota, QuotaHttpError } from "../core/quota.js";
import type { QuotaWindows } from "../types.js";
import { decodeJwtPayload } from "./codex-jwt.js";
import type { AccountInfo, ToolAdapter, ToolCredential } from "./types.js";

// Files/dirs under $CODEX_HOME that are credential or per-account state and must not be shared.
const BASE_SKIP = new Set([
  "auth.json",
  "sessions",
  "session_index.jsonl",
  "history.jsonl",
  "log",
  "logs",
  "shell_snapshots",
  "installation_id",
  ".codex-global-state.json",
  ".codex-global-state.json.bak",
  "cloud-requirements-cache.json",
  "external_agent_session_imports.json",
  "models_cache.json",
  "cache",
  "tmp",
  ".tmp",
  "computer-use",
  "sqlite",
  "version.json",
]);

// Name prefixes that indicate per-profile state (sqlite WAL/SHM siblings, log/state DBs).
const SKIP_PREFIXES = ["state_", "logs_", "sessions_"];

const SESSION_SKIP = new Set(["sessions", "session_index.jsonl", "history.jsonl"]);

/**
 * Returns the skip set for symlinking decisions.
 * Literal set members are exact filenames; prefix-based names (e.g. state_5.sqlite)
 * must be checked via shouldSkipForCodex().
 */
function buildSkipSet(mergeSessions: boolean): Set<string> {
  const set = new Set(BASE_SKIP);
  if (mergeSessions) {
    for (const item of SESSION_SKIP) set.delete(item);
  }
  return set;
}

async function readCodexAccount(configDir: string): Promise<AccountInfo | null> {
  const authPath = path.join(configDir, "auth.json");
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: { tokens?: { id_token?: string; account_id?: string } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  const idToken = parsed.tokens?.id_token;
  const accountId = parsed.tokens?.account_id;

  // Try JWT id_token path first
  if (idToken) {
    const payload = decodeJwtPayload(idToken);
    if (payload) {
      const email = typeof payload.email === "string" ? payload.email : null;
      const oai = (payload["https://api.openai.com/auth"] ?? null) as {
        organizations?: Array<{ title?: string }>;
      } | null;
      const orgName = oai?.organizations?.[0]?.title;
      if (email) return { email, orgName };
    }
  }

  // Fallback: use account_id (API-key auth, or JWT-without-email edge case)
  if (accountId) return { email: accountId, orgName: undefined };
  return null;
}

const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// chatgpt.com serves a bot-check page to unrecognized clients, so the request has to
// identify itself the way the Codex CLI does.
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/clausona (${process.platform}; ${process.arch})`;

type CodexTokens = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

// auth.json also holds auth_mode and OPENAI_API_KEY, so it is rewritten whole.
type CodexAuth = { tokens?: CodexTokens; last_refresh?: string } & Record<string, unknown>;

const authFilePath = (configDir: string) => path.join(configDir, "auth.json");

async function readCodexAuth(configDir: string): Promise<CodexAuth | null> {
  try {
    const parsed = JSON.parse(await readFile(authFilePath(configDir), "utf8")) as CodexAuth;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function toCodexCredential(auth: CodexAuth | null): ToolCredential | null {
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) return null;

  const expSeconds = decodeJwtPayload(accessToken)?.exp;
  const accountId = auth?.tokens?.account_id;

  return {
    accessToken,
    refreshToken: auth?.tokens?.refresh_token,
    expiresAt: typeof expSeconds === "number" ? expSeconds * 1000 : undefined,
    headers: accountId ? { "chatgpt-account-id": accountId } : undefined,
  };
}

async function readCodexCredential(configDir: string): Promise<ToolCredential | null> {
  return toCodexCredential(await readCodexAuth(configDir));
}

/**
 * Renews via the OAuth refresh grant and stores the result before returning, for the
 * same reason as the Claude adapter: the previous refresh token stops working the
 * moment the provider answers.
 */
async function renewCodexCredential(
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
      scope: "openid profile email",
    }),
    signal,
  });

  if (!response.ok) {
    throw new QuotaHttpError(response.status, response.headers.get("retry-after"));
  }

  const data = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!data.access_token) throw new Error("refresh response carried no access token");

  const auth = (await readCodexAuth(configDir)) ?? {};
  auth.tokens = {
    ...auth.tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? credential.refreshToken,
    ...(data.id_token ? { id_token: data.id_token } : {}),
  };
  auth.last_refresh = new Date().toISOString();

  const target = authFilePath(configDir);
  const tmpPath = `${target}.tmp.${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, target);

  const readBack = await readCodexAuth(configDir);
  if (readBack?.tokens?.access_token !== data.access_token) {
    throw new Error(`${target} did not take the renewed credential`);
  }

  return toCodexCredential(auth) ?? { accessToken: data.access_token };
}

async function fetchCodexQuota(credential: ToolCredential, signal: AbortSignal): Promise<QuotaWindows | null> {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "User-Agent": CODEX_USER_AGENT,
      originator: CODEX_ORIGINATOR,
      ...credential.headers,
    },
    signal,
  });

  if (!response.ok) {
    throw new QuotaHttpError(response.status, response.headers.get("retry-after"));
  }

  return parseCodexQuota(await response.json());
}

async function runCodexLogin(configDir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawnCommand("codex", ["login"], {
      env: { ...process.env, CODEX_HOME: configDir },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export const codexAdapter: ToolAdapter = {
  name: "codex",
  binary: "codex",
  configEnvVar: "CODEX_HOME",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".codex"),
  configDirPattern: /^\.codex(-.+)?$/,
  readAccountInfo: readCodexAccount,
  sharedSkipSet: buildSkipSet,
  shouldSkipName: (name, _mergeSessions) => SKIP_PREFIXES.some((p) => name.startsWith(p)),
  readCredential: readCodexCredential,
  fetchQuota: fetchCodexQuota,
  renewCredential: renewCodexCredential,
  runLogin: runCodexLogin,
};
