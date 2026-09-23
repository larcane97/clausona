import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every spawned command goes through this stub, so no test here can reach the real
// `security` and with it the Keychain of the machine running the suite.
const spawnCommand = vi.hoisted(() => vi.fn());
vi.mock("../core/process.js", () => ({ spawnCommand }));

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

const realPlatform = process.platform;

function forcePlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// Key-shaped literals trip push protection, so fixture tokens are assembled.
const token = (kind: string, body: string) => ["sk", "ant", kind, body].join("-");

let tmp: string;

beforeEach(() => {
  spawnCommand.mockReset();
  spawnCommand.mockImplementation((command: string) => {
    throw new Error(`unexpected spawn of ${command}`);
  });
  tmp = mkdtempSync(path.join(tmpdir(), "clausona-claude-"));
});

afterEach(() => {
  forcePlatform(realPlatform);
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

describe("claudeAdapter.renewCredential", () => {
  it("keeps the MCP OAuth tokens when the stored blob cannot be re-read after the refresh", async () => {
    forcePlatform("linux");
    const credentialsPath = path.join(tmp, ".credentials.json");
    const oldAccess = token("oat01", "old");
    const oldRefresh = token("ort01", "old");
    const newAccess = token("oat01", "new");
    const newRefresh = token("ort01", "new");
    const mcpOAuth = { "linear|abc123": { accessToken: "mcp-token", expiresAt: 1 } };
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: oldAccess, refreshToken: oldRefresh, subscriptionType: "max" },
        mcpOAuth,
      }),
    );

    // The stored blob turns unreadable while the request is in flight, as a busy
    // Keychain or a half-written file would make it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        writeFileSync(credentialsPath, "{");
        return Response.json({ access_token: newAccess, refresh_token: newRefresh, expires_in: 3600 });
      }),
    );

    const renewed = await claudeAdapter.renewCredential?.(
      tmp,
      { accessToken: oldAccess, refreshToken: oldRefresh },
      new AbortController().signal,
    );

    expect(renewed?.accessToken).toBe(newAccess);
    const stored = JSON.parse(readFileSync(credentialsPath, "utf8"));
    expect(stored.mcpOAuth).toEqual(mcpOAuth);
    expect(stored.claudeAiOauth).toMatchObject({
      accessToken: newAccess,
      refreshToken: newRefresh,
      subscriptionType: "max",
    });
  });
});

describe("claudeAdapter.readCredential on macOS", () => {
  it("reads a Keychain blob that `security` prints as hex", async () => {
    forcePlatform("darwin");
    const accessToken = token("oat01", "hex");
    // One non-ASCII character anywhere is enough for `security -w` to print hex.
    const blob = { claudeAiOauth: { accessToken }, mcpOAuth: { "café|abc123": { accessToken: "mcp-token" } } };
    spawnCommand.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
      setImmediate(() => {
        child.stdout.emit("data", `${Buffer.from(JSON.stringify(blob), "utf8").toString("hex")}\n`);
        child.emit("close", 0);
      });
      return child;
    });

    const credential = await claudeAdapter.readCredential?.(tmp);

    expect(spawnCommand).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", expect.stringMatching(/^Claude Code-credentials-/), "-w"],
      expect.anything(),
    );
    expect(credential?.accessToken).toBe(accessToken);
  });
});
