import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { splitSecurityLine } from "../lib/test-keychain.js";
import { claudeAdapter } from "./claude.js";

// A stand-in for macOS `security`, so these cases never reach a real Keychain and run the
// same on the Linux and Windows CI runners as on a Mac. `mode` decides how it answers:
// normally, as if the binary were not installed, or failing every secret read with the
// given exit status. `nextReadFails` fails only the next secret read, and `writeFails`
// every write, with the given status. A write arrives as `security -i` with the command on
// stdin, or in the arguments when it is too long for one line; `calls` logs each command
// as it would run. Items are keyed on service and account, as the Keychain's are. A lookup
// by service alone takes the first one added: the real order is undocumented, and the cases
// only need another account's item to be what such a lookup finds.
const keychain = vi.hoisted(() => ({
  items: [] as Array<{ service: string; account: string; secret: string }>,
  calls: [] as string[][],
  mode: "normal" as "normal" | "not-installed" | number,
  nextReadFails: undefined as number | undefined,
  writeFails: undefined as number | undefined,
}));

vi.mock("../core/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/process.js")>()),
  spawnCommand: (command: string, args: string[]) => fakeSecurity(command, args),
}));

/** Runs one command and returns its exit status and stdout. */
function runFake(args: string[]): { code: number; out: string } {
  keychain.calls.push(args);
  const [verb, ...rest] = args;
  const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  const service = option("-s") ?? "";
  const account = option("-a");
  // find takes the first item with the service, and with the account too when one is given.
  const at = keychain.items.findIndex(
    (item) => item.service === service && (account === undefined || item.account === account),
  );
  if (verb === "find-generic-password") {
    const wantsSecret = rest.includes("-w");
    if (wantsSecret && keychain.nextReadFails !== undefined) {
      const code = keychain.nextReadFails;
      keychain.nextReadFails = undefined;
      return { code, out: "" };
    }
    if (wantsSecret && typeof keychain.mode === "number") return { code: keychain.mode, out: "" };
    const item = keychain.items[at];
    if (item === undefined) return { code: 44, out: "" };
    return { code: 0, out: wantsSecret ? `${item.secret}\n` : "" };
  }
  if (verb === "add-generic-password") {
    if (keychain.writeFails !== undefined) return { code: keychain.writeFails, out: "" };
    const hex = option("-X");
    const secret = hex === undefined ? (option("-w") ?? "") : Buffer.from(hex, "hex").toString("utf8");
    // -U replaces the item with this service and account, and no other.
    const same = keychain.items.find((item) => item.service === service && item.account === (account ?? ""));
    if (same) same.secret = secret;
    else keychain.items.push({ service, account: account ?? "", secret });
    return { code: 0, out: "" };
  }
  return { code: 1, out: "" };
}

function fakeSecurity(command: string, args: string[]) {
  if (command !== "security") throw new Error(`unexpected spawn: ${command}`);
  let stdin = "";
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stdin: {
      end: (input: string) => {
        stdin = input;
      },
    },
  });

  setImmediate(() => {
    if (keychain.mode === "not-installed") {
      // What Node reports when the binary does not exist.
      child.emit("error", Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" }));
      child.emit("close", -2);
      return;
    }

    let result = { code: 0, out: "" };
    if (args[0] === "-i") {
      for (const line of stdin.split("\n").filter(Boolean)) result = runFake(splitSecurityLine(line));
    } else {
      result = runFake(args);
    }
    if (result.out) child.stdout.emit("data", result.out);
    child.emit("close", result.code);
  });

  return child;
}

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: platform, configurable: true });

// Claude Code files its item under the login name in USER, so every case runs as this one.
const ACCOUNT = "fixture-user";
beforeEach(() => {
  vi.stubEnv("USER", ACCOUNT);
});

const temps: string[] = [];
afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  keychain.items.length = 0;
  keychain.calls.length = 0;
  keychain.mode = "normal";
  keychain.nextReadFails = undefined;
  keychain.writeFails = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profileDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-credstore-"));
  temps.push(dir);
  return dir;
}

const serviceFor = (configDir: string) => claudeAdapter.keychainServiceName?.({ homeDir: homedir(), configDir }) ?? "";

/** Leaves an item for the profile's service, under Claude Code's account unless told otherwise. */
const seedItem = (configDir: string, secret: string, account = ACCOUNT) =>
  keychain.items.push({ service: serviceFor(configDir), account, secret });

/** What the profile's item under `account` holds, or undefined when there is no such item. */
const storedItem = (configDir: string, account = ACCOUNT) =>
  keychain.items.find((item) => item.service === serviceFor(configDir) && item.account === account)?.secret;

const blobWith = (accessToken: string) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: `${accessToken}-refresh`, expiresAt: 1 },
    mcpOAuth: { server: "kept" },
  });

const credentialsFile = (configDir: string) => path.join(configDir, ".credentials.json");
const readFileBlob = (configDir: string) => JSON.parse(readFileSync(credentialsFile(configDir), "utf8"));
const keychainWrites = () => keychain.calls.filter(([verb]) => verb === "add-generic-password");

/** Answers the refresh grant with a rotated token pair, after running `inFlight`. */
function stubRefresh(inFlight?: () => void) {
  const fetchMock = vi.fn(async () => {
    inFlight?.();
    return new Response(
      JSON.stringify({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * What Claude Code does once a Keychain write succeeds for a profile whose credential was
 * in the file: the blob, with an MCP token it has added since, goes to the Keychain, and
 * the file is deleted.
 */
function moveToKeychain(configDir: string) {
  seedItem(configDir, JSON.stringify({ ...readFileBlob(configDir), mcpOAuth: { server: "moved" } }));
  rmSync(credentialsFile(configDir));
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
    seedItem(dir, blobWith("from-keychain"));
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
    // A denied access prompt says nothing about whether the item exists. Claude Code's
    // strict read counts it as a failure too, not as an empty Keychain: it can be this
    // process's alone, with the item Claude Code reads first still there.
    setPlatform("darwin");
    keychain.mode = 51;
    const dir = profileDir();
    seedItem(dir, blobWith("from-keychain"));
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect(await claudeAdapter.readCredential?.(dir)).toBeNull();
  });

  it("falls back when the Keychain item cannot be parsed", async () => {
    // Claude Code's read of such an item comes back empty, so it moves on to the file.
    setPlatform("darwin");
    const dir = profileDir();
    seedItem(dir, "not a credential");
    writeFileSync(credentialsFile(dir), blobWith("from-file"));

    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-file");
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
    expect(keychain.items.length).toBe(0);
    // Read back from where it was written, so the next reading uses the renewed token.
    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("renewed");
  });

  it("keeps a file-sourced renewal in the file when the file cannot be re-read after the refresh", async () => {
    // The earlier copy stands in for a failed re-read, so the MCP tokens survive, and it
    // brings its store with it: the Keychain still has no item, and Claude Code would go
    // on reading the file.
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Half-written while the request is in flight.
        writeFileSync(credentialsFile(dir), "{");
        return Response.json({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3600 });
      }),
    );

    await renew(dir, "from-file-refresh");

    const stored = readFileBlob(dir);
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    expect(stored.mcpOAuth).toEqual({ server: "kept" });
    expect(keychainWrites()).toEqual([]);
    expect(keychain.items.length).toBe(0);
  });

  it("renews into the Keychain when the credential moves there while the request is in flight", async () => {
    // The re-read decides the store, not the earlier read: Claude Code reads the Keychain
    // first, so a renewal written back to the file would never be read.
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    stubRefresh(() => moveToKeychain(dir));

    await renew(dir, "from-file-refresh");

    const stored = JSON.parse(storedItem(dir) ?? "{}");
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    // The blob it re-read, with what was added to it in the meantime.
    expect(stored.mcpOAuth).toEqual({ server: "moved" });
    expect(existsSync(credentialsFile(dir))).toBe(false);
  });

  it("renews into the Keychain when the Keychain cannot be read after the refresh", async () => {
    // The credential moves into the Keychain in flight, and the re-read then fails with a
    // status that says nothing about the item. The earlier copy came from the file, but
    // Claude Code reads the Keychain first, so that is where the renewal has to go.
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    stubRefresh(() => {
      moveToKeychain(dir);
      keychain.nextReadFails = 51;
    });

    await renew(dir, "from-file-refresh");

    const stored = JSON.parse(storedItem(dir) ?? "{}");
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    // The earlier copy stands in for the blob that could not be read, MCP tokens and all.
    expect(stored.mcpOAuth).toEqual({ server: "kept" });
    expect(existsSync(credentialsFile(dir))).toBe(false);
    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("renewed");
  });

  it("renews into the file when the Keychain can be neither read after the refresh nor written", async () => {
    // Where Claude Code's own write goes when the Keychain refuses it.
    setPlatform("darwin");
    const dir = profileDir();
    writeFileSync(credentialsFile(dir), blobWith("from-file"), { mode: 0o600 });
    stubRefresh(() => {
      keychain.nextReadFails = 51;
      keychain.writeFails = 51;
    });

    await renew(dir, "from-file-refresh");

    expect(keychainWrites()).toHaveLength(1);
    expect(keychain.items.length).toBe(0);
    const stored = readFileBlob(dir);
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "renewed-refresh" });
    expect(stored.mcpOAuth).toEqual({ server: "kept" });
  });

  it("renews a Keychain-sourced credential into the Keychain, not the file", async () => {
    setPlatform("darwin");
    const dir = profileDir();
    seedItem(dir, blobWith("from-keychain"));
    stubRefresh();

    await renew(dir, "from-keychain-refresh");

    expect(keychainWrites()).toHaveLength(1);
    expect(JSON.parse(storedItem(dir) ?? "{}").claudeAiOauth.accessToken).toBe("renewed");
    expect(existsSync(credentialsFile(dir))).toBe(false);
  });

  it("reads and renews the item under Claude Code's account when another account has one for the service", async () => {
    // Another account's item, added first so that a lookup by service alone finds it. It is
    // not the profile's credential, and renewing it instead would leave Claude Code's own
    // item holding the refresh token the provider has just rotated out.
    setPlatform("darwin");
    const dir = profileDir();
    seedItem(dir, blobWith("other-account"), "other-user");
    expect(await claudeAdapter.hasKeychainCredential?.(serviceFor(dir))).toBe(false);

    seedItem(dir, blobWith("from-keychain"));
    expect(await claudeAdapter.hasKeychainCredential?.(serviceFor(dir))).toBe(true);
    expect((await claudeAdapter.readCredential?.(dir))?.accessToken).toBe("from-keychain");
    stubRefresh();

    await renew(dir, "from-keychain-refresh");

    expect(JSON.parse(storedItem(dir) ?? "{}").claudeAiOauth).toMatchObject({
      accessToken: "renewed",
      refreshToken: "renewed-refresh",
    });
    expect(storedItem(dir, "other-user")).toBe(blobWith("other-account"));
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
