import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./codex.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function withTmpAuth(payload: Record<string, unknown> | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-test-"));
  if (payload) {
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ tokens: { id_token: makeJwt(payload), account_id: "uuid-123" } }),
    );
  }
  return dir;
}

describe("codexAdapter.readAccountInfo", () => {
  it("returns email + orgName from JWT id_token", async () => {
    const dir = withTmpAuth({
      email: "u@example.com",
      name: "Example User",
      "https://api.openai.com/auth": { organizations: [{ title: "Example Org" }] },
    });
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toEqual({ email: "u@example.com", orgName: "Example Org" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to account_id when email claim is absent", async () => {
    const dir = withTmpAuth({ name: "anon" });
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toEqual({ email: "uuid-123", orgName: undefined });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when auth.json is missing", async () => {
    const dir = withTmpAuth(null);
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns account_id when id_token is missing entirely (API-key auth)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-test-"));
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "ApiKey",
        OPENAI_API_KEY: "sk-...",
        tokens: { account_id: "uuid-api-key-456" },
      }),
    );
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toEqual({ email: "uuid-api-key-456", orgName: undefined });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("codexAdapter.sharedAllow", () => {
  const shared = (name: string, mergeSessions = false) => codexAdapter.sharedAllow?.(name, mergeSessions);

  it("shares the configuration the user writes, and what it names", () => {
    for (const name of [
      "config.toml",
      "work.config.toml",
      "hooks.json",
      "AGENTS.md",
      "AGENTS.override.md",
      "rules",
      ".sandbox_migration",
      "skills",
      "plugins",
      "agents",
      "prompts",
      "vendor_imports",
      "pets",
      ".personality_migration",
    ]) {
      expect(shared(name), name).toBe(true);
      expect(shared(name, true), name).toBe(true);
    }
  });

  it("keeps every other entry for the profile, including names it has never seen", () => {
    for (const name of [
      "auth.json",
      ".credentials.json",
      "secrets",
      "app-server-control",
      "app-server-daemon",
      "memories",
      ".chatgpt-projects",
      "browser",
      "mcp-oauth-locks",
      "project-metadata-locks",
      "ipc",
      "node_repl",
      "code-review-plugin",
      "packages",
      "cloud-config-bundle-cache.json",
      "claude-cowork-import-history.json",
      "chrome-native-hosts-v2.json",
      "installation_id",
      "log",
      "cache",
      "config.toml.tmp-123",
      "something-codex-0.200-adds",
    ]) {
      expect(shared(name), name).toBe(false);
      expect(shared(name, true), name).toBe(false);
    }
  });

  it("keeps every SQLite database and its companion files, by suffix rather than by name", () => {
    for (const db of [
      "memories_1",
      "memories_v2_1",
      "goals_1",
      "queue_1",
      "thread_history_1",
      "state_5",
      "logs_2",
      "new_9",
    ]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        expect(shared(`${db}.sqlite${suffix}`), `${db}.sqlite${suffix}`).toBe(false);
        expect(shared(`${db}.sqlite${suffix}`, true), `${db}.sqlite${suffix}`).toBe(false);
      }
    }
  });

  it("shares conversation history only with mergeSessions", () => {
    for (const name of [
      "sessions",
      "archived_sessions",
      "session_index.jsonl",
      "history.jsonl",
      "attachments",
      "visualizations",
      "thread-writer-locks",
    ]) {
      expect(shared(name, false), name).toBe(false);
      expect(shared(name, true), name).toBe(true);
    }
  });

  it("names no skip set, so nothing reads one for codex", () => {
    expect(codexAdapter.sharedSkipSet).toBeUndefined();
    expect(codexAdapter.shouldSkipName).toBeUndefined();
  });
});

describe("codexAdapter wiring", () => {
  it("uses CODEX_HOME env var", () => {
    expect(codexAdapter.configEnvVar).toBe("CODEX_HOME");
  });
  it("default dir is ~/.codex", () => {
    const homeDir = path.join(path.parse(process.cwd()).root, "h");
    expect(codexAdapter.defaultConfigDir(homeDir)).toBe(path.join(homeDir, ".codex"));
  });
  it("matches ~/.codex and ~/.codex-foo via configDirPattern", () => {
    expect(codexAdapter.configDirPattern.test(".codex")).toBe(true);
    expect(codexAdapter.configDirPattern.test(".codex-work")).toBe(true);
    expect(codexAdapter.configDirPattern.test(".claude")).toBe(false);
  });
});
