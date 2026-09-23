import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeAdapter } from "./claude.js";

// A stand-in for macOS `security`, so these cases never reach a real Keychain and run the
// same on the Linux and Windows CI runners as on a Mac. `mode` decides how it answers:
// normally, as if the binary were not installed, or failing every secret read with the
// given exit status.
const keychain = vi.hoisted(() => ({
  items: new Map<string, string>(),
  calls: [] as string[][],
  mode: "normal" as "normal" | "not-installed" | number,
}));

vi.mock("../core/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/process.js")>()),
  spawnCommand: (command: string, args: string[]) => fakeSecurity(command, args),
}));

function fakeSecurity(command: string, args: string[]) {
  if (command !== "security") throw new Error(`unexpected spawn: ${command}`);
  keychain.calls.push(args);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });

  setImmediate(() => {
    if (keychain.mode === "not-installed") {
      // What Node reports when the binary does not exist.
      child.emit("error", Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" }));
      child.emit("close", -2);
      return;
    }

    const [verb, ...rest] = args;
    const service = rest[rest.indexOf("-s") + 1] ?? "";
    const wantsSecret = rest.includes("-w");
    let code = 0;
    let out = "";
    if (verb === "find-generic-password") {
      const secret = keychain.items.get(service);
      if (wantsSecret && typeof keychain.mode === "number") code = keychain.mode;
      else if (secret === undefined) code = 44;
      else out = wantsSecret ? `${secret}\n` : `    "acct"<blob>="tester"\n`;
    } else if (verb === "add-generic-password") {
      keychain.items.set(service, rest[rest.indexOf("-w") + 1] ?? "");
    } else {
      code = 1;
    }
    if (out) child.stdout.emit("data", out);
    child.emit("close", code);
  });

  return child;
}

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

const temps: string[] = [];
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllGlobals();
  keychain.items.clear();
  keychain.calls.length = 0;
  keychain.mode = "normal";
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profileDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-credstore-"));
  temps.push(dir);
  return dir;
}

const serviceFor = (configDir: string) => claudeAdapter.keychainServiceName?.({ homeDir: homedir(), configDir }) ?? "";

const blobWith = (accessToken: string) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: `${accessToken}-refresh`, expiresAt: 1 },
    mcpOAuth: { server: "kept" },
  });

const credentialsFile = (configDir: string) => path.join(configDir, ".credentials.json");
const readFileBlob = (configDir: string) => JSON.parse(readFileSync(credentialsFile(configDir), "utf8"));
const keychainWrites = () => keychain.calls.filter(([verb]) => verb === "add-generic-password");

/** Answers the refresh grant with a rotated token pair. */
function stubRefresh() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renew(configDir: string, refreshToken: string) {
  const renewCredential = claudeAdapter.renewCredential;
  if (!renewCredential) throw new Error("claudeAdapter has no renewCredential");
  return renewCredential(configDir, { accessToken: "stale", refreshToken }, new AbortController().signal);
}

describe("Claude credential store on macOS", () => {
  it("reads the Keychain item when there is one", async () => {
    setPlatform("darwin");
    const dir = profileDir();
    keychain.items.set(serviceFor(dir), blobWith("from-keychain"));
    // Claude Code reads the Keychain first, so a leftover file must not win.
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-keychain");
  });

  it("falls back to .credentials.json when the Keychain has no item", async () => {
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect(await claudeAdapter.readCredential?.(dir)).toEqual({
      accessToken: "from-file",
      refreshToken: "from-file-refresh",
      expiresAt: 1,
    });
  });

  it("falls back when the security binary cannot be launched", async () => {
    setPlatform("darwin");
    keychain.mode = "not-installed";
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-file");
  });

  it("falls back when the Keychain cannot be opened without a prompt", async () => {
    // errSecInteractionNotAllowed, as over SSH: Claude Code reads the file here too, and
    // it is the situation in which its own write ended up there.
    setPlatform("darwin");
    keychain.mode = 36;
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-file");
  });

  it("does not fall back when the Keychain read fails for another reason", async () => {
    // A denied access prompt says nothing about whether the item exists, and Claude Code
    // would still read that item first.
    setPlatform("darwin");
    keychain.mode = 51;
    const dir = profileDir();
    keychain.items.set(serviceFor(dir), blobWith("from-keychain"));
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect(await claudeAdapter.readCredential?.(dir)).toBeNull();
  });

  it("reports no credential when neither store holds one", async () => {
    setPlatform("darwin");
    expect(await claudeAdapter.readCredential?.(profileDir())).toBeNull();
  });

  it("renews a file-sourced credential into the file, not the Keychain", async () => {
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    const fetchMock = stubRefresh();

    const renewed = await renew(dir, "from-file-refresh");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(renewed).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    const stored = readFileBlob(dir);
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    // The rest of the blob is carried over untouched.
    expect(stored.mcpOAuth).toEqual({ server: "kept" });
    expect(keychainWrites()).toEqual([]);
    expect(keychain.items.size).toBe(0);
    // Read back from where it was written, so the next reading uses the renewed token.
    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("renewed");
  });

  it("renews a Keychain-sourced credential into the Keychain, not the file", async () => {
    setPlatform("darwin");
    const dir = profileDir();
    const service = serviceFor(dir);
    keychain.items.set(service, blobWith("from-keychain"));
    stubRefresh();

    await renew(dir, "from-keychain-refresh");

    expect(keychainWrites()).toHaveLength(1);
    expect(JSON.parse(keychain.items.get(service) ?? "{}").claudeAiOauth.accessToken).toBe("renewed");
    expect(existsSync(credentialsFile(dir))).toBe(false);
  });

  it("probes the fallback file for an access token", async () => {
    const dir = profileDir();
    expect(await claudeAdapter.hasFallbackCredential?.(dir)).toBe(false);

    writeFileSync(credentialsFile(dir), JSON.stringify({ claudeAiOauth: {} }));
    expect(await claudeAdapter.hasFallbackCredential?.(dir)).toBe(false);

    writeFileSync(credentialsFile(dir), blobWith("from-file"));
    expect(await claudeAdapter.hasFallbackCredential?.(dir)).toBe(true);
    // A file probe only; the Keychain is not consulted.
    expect(keychain.calls).toEqual([]);
  });
});

describe.each(["linux", "win32"] as const)("Claude credential store on %s", (platform) => {
  it("reads .credentials.json without touching the Keychain", async () => {
    setPlatform(platform);
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-file");
    expect(keychain.calls).toEqual([]);
  });

  it("renews into .credentials.json without touching the Keychain", async () => {
    setPlatform(platform);
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    stubRefresh();

    await renew(dir, "from-file-refresh");

    expect(readFileBlob(dir).claudeAiOauth.accessToken).toBe("renewed");
    expect(keychain.calls).toEqual([]);
  });
});
