import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { decodeJwtPayload } from "./codex-jwt.js";
import type { AccountInfo, ToolAdapter } from "./types.js";

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

async function runCodexLogin(configDir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("codex", ["login"], {
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
  runLogin: runCodexLogin,
};
