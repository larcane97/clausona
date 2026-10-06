import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { spawnCommand } from "../core/process.js";
import { parseCodexQuota, QuotaHttpError } from "../core/quota.js";
import type { QuotaWindows } from "../types.js";
import { decodeJwtPayload } from "./codex-jwt.js";
import type { AccountInfo, ToolAdapter, ToolCredential, UnsharedRisk } from "./types.js";

// What a Codex profile shares with the primary's CODEX_HOME, and nothing else (#74). Codex
// keeps adding state of one account's there - 0.148 to 0.159 added the app-server daemon's
// control and pid directories, the memories databases, goal and queue databases, browser and
// lock directories - and a list of what not to share linked each of them into every profile
// until someone added it. A list of what to share leaves a name nobody has looked at in the
// profile it belongs to: a new config file is not shared until it is added here, which is
// the safe way to be wrong.

// The configuration the user writes, and what it names: shared by every profile.
const SHARED = new Set([
  "config.toml",
  "hooks.json",
  "rules",
  ".sandbox_migration",
  "skills",
  "plugins",
  "agents",
  "prompts",
  "vendor_imports",
  "pets",
  ".personality_migration",
]);

// Config profiles beside config.toml (`<name>.config.toml`), and AGENTS.md with its variants
// (AGENTS.override.md).
const SHARED_PATTERNS = [/\.config\.toml$/, /^AGENTS.*\.md$/];

// Conversation history, shared only by a profile that merges sessions with the primary.
const SESSION_SET = new Set([
  "sessions",
  "archived_sessions",
  "session_index.jsonl",
  "history.jsonl",
  "attachments",
  "visualizations",
  "thread-writer-locks",
]);

/**
 * Codex writes its config files to a temp file and renames that over the original (checked
 * against codex-cli 0.159.3): config.toml, the `<name>.config.toml` files beside it, and
 * hooks.json.
 */
function codexRewritesWhole(name: string): boolean {
  return name === "config.toml" || name.endsWith(".config.toml") || name === "hooks.json";
}

/**
 * The app-server daemon's updater binds this socket under CODEX_HOME (codex-cli 0.159.3). The
 * daemon's auto-update stops, with nothing said, when the path does not fit in sun_path.
 */
const CODEX_UNIX_SOCKETS = [
  { path: "app-server-daemon/daemon-updater.sock", purpose: "the app-server daemon's auto-update" },
] as const;

// Every SQLite database and the files SQLite keeps beside one, whatever the database is
// named: threads, goals, queues, memories, logs, state. Matched by suffix, since each
// release brings databases under new names.
const SQLITE_FILE = /\.sqlite(-wal|-shm|-journal)?$/;

// Databases that belong with the conversation history, and are shared with it: only with
// merged sessions, and with their -wal, -shm and -journal. Named one by one; none yet.
const SESSION_DATABASES: ReadonlySet<string> = new Set([]);

function codexSharedAllow(name: string, mergeSessions: boolean): boolean {
  if (SQLITE_FILE.test(name)) return mergeSessions && SESSION_DATABASES.has(name.replace(/-(wal|shm|journal)$/, ""));
  if (SHARED.has(name) || SHARED_PATTERNS.some((pattern) => pattern.test(name))) return true;
  return mergeSessions && SESSION_SET.has(name);
}

// Codex loads $CODEX_HOME/.env into its environment at start (codex-rs arg0, rust-v0.159.3),
// so it can carry an account's own API keys and is never shared. A profile that has none
// starts from a copy of the primary's, as it had the primary's through a link before.
const SEEDED_FROM_PRIMARY = [".env"] as const;

// Where Codex keeps credentials: its sign-in in auth.json, and other tokens and secrets in
// the other two.
const CREDENTIAL_STORES = new Set(["auth.json", ".credentials.json", "secrets"]);

/** What a profile's link to the primary's `name` does, for an entry Codex keeps for each CODEX_HOME. */
function codexUnsharedRisk(name: string): UnsharedRisk {
  if (CREDENTIAL_STORES.has(name)) {
    return { risk: "wrong_account", why: "so Codex in this profile uses the primary's credentials" };
  }
  if (name === ".env") {
    return {
      risk: "wrong_account",
      why: "so Codex in this profile loads the primary's .env, and any API keys in it, at start",
    };
  }
  // Codex finds the daemon's control socket through $CODEX_HOME/app-server-control/: its path
  // is a hash of that directory's real path, so a link to the primary's leads to the daemon
  // the primary started, which serves the primary's auth.json and quota (codex-cli 0.159.3).
  if (name === "app-server-control") {
    return {
      risk: "wrong_account",
      why: "so Codex in this profile talks to the primary's app-server daemon and runs on the primary's account and quota",
    };
  }
  if (name === "app-server-daemon") {
    return {
      risk: "wrong_account",
      why: "so this profile and the primary share one app-server daemon's pid files and lock, and stopping or starting the daemon in one does it to the other's",
    };
  }
  if (name.startsWith("memories")) {
    return {
      risk: "isolation",
      why: "so the conversation summaries Codex adds to future prompts are shared: one account's conversations reach the other account's prompts",
    };
  }
  if (SQLITE_FILE.test(name)) {
    return {
      risk: "isolation",
      why: "so this profile reads and writes the primary's Codex database (threads, goals, queues) instead of its own",
    };
  }
  if (SESSION_SET.has(name)) {
    return { risk: "isolation", why: "but this profile keeps its sessions separate from the primary's" };
  }
  return {
    risk: "isolation",
    why: "but Codex keeps it for each CODEX_HOME, so this profile shares it with the primary's account",
  };
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
  sharedAllow: codexSharedAllow,
  unsharedRisk: codexUnsharedRisk,
  seededFromPrimary: SEEDED_FROM_PRIMARY,
  rewritesWhole: codexRewritesWhole,
  unixSockets: CODEX_UNIX_SOCKETS,
  readCredential: readCodexCredential,
  fetchQuota: fetchCodexQuota,
  renewCredential: renewCodexCredential,
  runLogin: runCodexLogin,
};
