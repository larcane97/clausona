import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// discoverAccounts scans the home directory, so the whole module graph has to see a
// temporary one. The mock is read through `currentHome`, set before each import.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const realPlatform = process.platform;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.resetModules();
});

/**
 * Seeds two signed-in-looking Claude config dirs and discovers them. Only `.claude-file`
 * has a token, in .credentials.json. Neither is the primary: the primary's Keychain
 * service name is fixed, so on a Mac it would find the real one, whereas these names
 * derive from a throwaway path and never exist in any Keychain.
 */
async function discover(platform: NodeJS.Platform): Promise<string[]> {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-discoverhome-"));
  temps.push(currentHome);

  for (const [name, credential] of [
    [".claude-file", JSON.stringify({ claudeAiOauth: { accessToken: "F" } })],
    [".claude-none", null],
  ] as const) {
    const dir = path.join(currentHome, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `${name}@x.com` } }));
    if (credential !== null) writeFileSync(path.join(dir, ".credentials.json"), credential);
  }

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  const { discoverAccounts } = await import("./service.js");
  return (await discoverAccounts()).map((account) => path.basename(account.configDir));
}

describe("discoverAccounts credential gate", () => {
  it("includes an account whose token is only in Claude Code's plaintext fallback on macOS", async () => {
    const found = await discover("darwin");

    expect(found).toContain(".claude-file");
    // No Keychain item and no file: nothing Claude Code could sign in with.
    expect(found).not.toContain(".claude-none");
  });

  it.each(["linux", "win32"] as const)("does not gate on a credential on %s", async (platform) => {
    const found = await discover(platform);

    expect(found).toEqual([".claude-file", ".claude-none"]);
  });
});
