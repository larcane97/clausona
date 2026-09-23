import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keychainServiceForConfigDir } from "../core/paths.js";
import { keychainStandIn, splitSecurityLine } from "../lib/test-keychain.js";
import { claudeAdapter, claudeLoginEnv } from "./claude.js";

/** Entries a child would actually receive for the variable, in any spelling. */
function configDirEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env).filter(
    (entry): entry is [string, string] => entry[0].toUpperCase() === "CLAUDE_CONFIG_DIR" && entry[1] !== undefined,
  );
}

describe("claudeLoginEnv", () => {
  const homeDir = "/h";
  const primary = path.join(homeDir, ".claude");
  const work = path.join(homeDir, ".claude-work");

  it("drops an inherited CLAUDE_CONFIG_DIR in any spelling for the default dir on Windows", () => {
    // Windows treats variable names case-insensitively, and Node passes the first
    // spelling it finds, so clearing only the upper-case key would let this one through.
    const env = claudeLoginEnv(primary, { homeDir, env: { claude_config_dir: work, PATH: "p" }, platform: "win32" });

    expect(configDirEntries(env)).toEqual([]);
    expect(env.PATH).toBe("p");
  });

  it("replaces an inherited CLAUDE_CONFIG_DIR in any spelling for another dir on Windows", () => {
    const other = path.join(homeDir, ".claude-other");
    const env = claudeLoginEnv(other, { homeDir, env: { Claude_Config_Dir: work }, platform: "win32" });

    expect(configDirEntries(env)).toEqual([["CLAUDE_CONFIG_DIR", other]]);
  });

  it("leaves a differently spelled variable alone where names are case-sensitive", () => {
    const env = claudeLoginEnv(primary, { homeDir, env: { claude_config_dir: work }, platform: "linux" });

    expect(env.claude_config_dir).toBe(work);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("claudeAdapter.sharedSkipSet", () => {
  it("isolates the OAuth credential file regardless of session mode", () => {
    // Claude Code keeps the tokens in the Keychain on macOS, but everywhere else it
    // writes them to $CLAUDE_CONFIG_DIR/.credentials.json. Sharing that file makes every
    // profile authenticate as the primary account.
    expect(claudeAdapter.sharedSkipSet(false).has(".credentials.json")).toBe(true);
    expect(claudeAdapter.sharedSkipSet(true).has(".credentials.json")).toBe(true);
  });

  it("isolates per-account config regardless of session mode", () => {
    expect(claudeAdapter.sharedSkipSet(false).has(".claude.json")).toBe(true);
    expect(claudeAdapter.sharedSkipSet(true).has(".claude.json")).toBe(true);
  });

  it("isolates session-keyed state when sessions are separated", () => {
    const skip = claudeAdapter.sharedSkipSet(false);
    for (const name of ["projects", "jobs", "teams"]) {
      expect(skip.has(name), `expected skip.has("${name}") to be true`).toBe(true);
    }
  });

  it("shares session-keyed state when sessions are merged", () => {
    const skip = claudeAdapter.sharedSkipSet(true);
    for (const name of ["projects", "jobs", "teams"]) {
      expect(skip.has(name), `expected skip.has("${name}") to be false`).toBe(false);
    }
  });
});

/**
 * The one place clausona writes Claude Code's own credentials: a renewal on macOS, into the
 * Keychain item Claude Code reads. It is the user's live subscription login, so the item must
 * come out exactly as the `security add-generic-password -U ... -w <blob>` it replaces left
 * it - same service, same account, same bytes - with the blob kept out of `security`'s
 * arguments, which `ps` shows to every user on the machine.
 *
 * `security` is a stand-in first on PATH that keeps its items in a file, and the platform is
 * forced to darwin, so this runs wherever sh does. The token endpoint is a stubbed fetch.
 */
describe.skipIf(process.platform === "win32")("renewing a Claude credential in the macOS Keychain", () => {
  const temps: string[] = [];
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const NOW = 1_790_000_000_000;
  // Put together here, so no line of this file holds a token a secret scanner would match.
  const token = (kind: "oat01" | "ort01", body: string) => ["sk", "ant", kind, "fixture", body].join("-");
  const OLD = { accessToken: token("oat01", "old-access"), refreshToken: token("ort01", "old-refresh") };
  const RENEWED = {
    access_token: token("oat01", "renewed-access-0123456789"),
    refresh_token: token("ort01", "renewed-refresh-0123456789"),
    expires_in: 28_800,
  };
  const OAUTH = {
    ...OLD,
    expiresAt: 1,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  };
  /** An MCP server's OAuth state, which Claude Code keeps in the same item. */
  const mcpServer = (accessToken: string) => ({
    serverName: "tracker",
    serverUrl: "https://mcp.example.com/sse",
    accessToken,
    expiresAt: NOW,
    discoveryState: { authorizationServerUrl: "https://mcp.example.com/" },
  });

  /** Renews against an item Claude Code left under `fixture-user`; returns what -w would have stored. */
  async function renew(stored: Record<string, unknown>) {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-claude-renew-"));
    temps.push(home);
    const configDir = path.join(home, ".claude-work");
    mkdirSync(configDir);
    const keychain = keychainStandIn(path.join(home, "keychain"));
    const service = keychainServiceForConfigDir({ homeDir: home, configDir });
    keychain.seed(service, "fixture-user", JSON.stringify(stored));
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${keychain.bin}${path.delimiter}${process.env.PATH ?? ""}`);
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(RENEWED), { status: 200 }));

    await claudeAdapter.renewCredential?.(configDir, { ...OLD, expiresAt: 1 }, new AbortController().signal);

    // The serialization renewal has always handed `-w`, and so the bytes it stored.
    const expected = JSON.stringify({
      ...stored,
      claudeAiOauth: {
        ...OAUTH,
        accessToken: RENEWED.access_token,
        refreshToken: RENEWED.refresh_token,
        expiresAt: NOW + RENEWED.expires_in * 1000,
      },
    });
    return { keychain, service, expected };
  }

  it("stores the same bytes under the same item, with nothing of the blob in security's arguments", async () => {
    const { keychain, service, expected } = await renew({
      claudeAiOauth: OAUTH,
      mcpOAuth: { "tracker|0123456789abcdef": mcpServer("mcp-fixture-token") },
    });

    // Updated in place (-U) under the account Claude Code wrote it with, not a second item.
    expect(keychain.items().map(({ service: s, account }) => [s, account])).toEqual([[service, "fixture-user"]]);
    expect(keychain.stored(service, "fixture-user")).toBe(expected);

    const hex = Buffer.from(expected, "utf8").toString("hex");
    for (const { argv } of keychain.calls()) {
      for (const arg of argv) {
        for (const secret of [RENEWED.access_token, RENEWED.refresh_token, "mcp-fixture-token"]) {
          expect(arg).not.toContain(secret);
          expect(arg).not.toContain(Buffer.from(secret, "utf8").toString("hex"));
        }
        expect(arg).not.toContain(hex.slice(0, 64));
      }
    }
    const writes = keychain.calls().filter(({ argv }) => argv[0] === "-i");
    expect(writes).toHaveLength(1);
    const lines = (writes[0]?.stdin ?? "").split("\n");
    expect(lines).toHaveLength(2);
    expect(splitSecurityLine(lines[0] ?? "")).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      "fixture-user",
      "-X",
      hex,
    ]);
  });

  // Claude Code's item holds every MCP server's tokens too, and a few of them outgrow the
  // line `security -i` reads (4094 bytes, the blob as hex). Refusing would lose tokens the
  // provider has already replaced, so the write goes in the arguments, as -X <hex> - what
  // Claude Code does with the same item - and still stores the same bytes.
  it("stores a blob too long for one security line through its arguments, as Claude Code does", async () => {
    const { keychain, service, expected } = await renew({
      claudeAiOauth: OAUTH,
      mcpOAuth: { "tracker|0123456789abcdef": mcpServer(`mcp-fixture-${"t".repeat(2400)}`) },
    });

    expect(keychain.stored(service, "fixture-user")).toBe(expected);
    const writes = keychain.calls().filter(({ argv }) => argv[0] === "add-generic-password");
    expect(writes.map(({ argv }) => argv)).toEqual([
      [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        "fixture-user",
        "-X",
        Buffer.from(expected, "utf8").toString("hex"),
      ],
    ]);
  });
});
