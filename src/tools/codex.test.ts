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

describe("codexAdapter.sharedSkipSet", () => {
  it("isolates auth + sessions + state DB by default", () => {
    const skip = codexAdapter.sharedSkipSet(false);
    // Literal members in the set
    for (const item of [
      "auth.json",
      "sessions",
      "session_index.jsonl",
      "history.jsonl",
      "log",
      "logs",
      "shell_snapshots",
      "installation_id",
      ".codex-global-state.json",
      "models_cache.json",
      "cache",
      "tmp",
      ".tmp",
      "version.json",
    ]) {
      expect(skip.has(item), `expected skip.has("${item}") to be true`).toBe(true);
    }
    // Prefix-pattern members — checked via shouldSkipName
    expect(codexAdapter.shouldSkipName?.("state_5.sqlite", false)).toBe(true);
    expect(codexAdapter.shouldSkipName?.("logs_2.sqlite", false)).toBe(true);
  });

  it("with mergeSessions=true, removes sessions/history from skip", () => {
    const skip = codexAdapter.sharedSkipSet(true);
    expect(skip.has("sessions")).toBe(false);
    expect(skip.has("history.jsonl")).toBe(false);
    expect(skip.has("session_index.jsonl")).toBe(false);
    // auth.json is still always isolated
    expect(skip.has("auth.json")).toBe(true);
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
