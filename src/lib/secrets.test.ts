import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretSource } from "../types.js";
import { detectBackend, keychainItemFor, resolveSecret, secretStoreName, storeSecret } from "./secrets.js";
import { keychainStandIn, splitSecurityLine } from "./test-keychain.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUSONA_TEST_KEY;
  vi.unstubAllEnvs();
});

describe("keychainItemFor", () => {
  it("namespaces the item by profile id", () => {
    expect(keychainItemFor("claude:glm")).toBe("clausona-claude:glm");
  });
});

describe("detectBackend", () => {
  it("uses the Keychain on macOS", () => {
    expect(detectBackend("darwin")).toBe("keychain");
  });

  it("falls back to a file on Windows", () => {
    expect(detectBackend("win32")).toBe("file");
  });

  // The secret-tool probe it had failed on every real secret-tool, so Linux keys were in the
  // file all along; one that answered would have sent them to a Secret Service that may not
  // be running. A secret-tool that answers everything with success is first on PATH here.
  it.skipIf(process.platform === "win32")("keeps Linux keys in the file even where secret-tool answers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clausona-secret-tool-"));
    temps.push(dir);
    writeFileSync(path.join(dir, "secret-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);

    expect(detectBackend("linux")).toBe("file");
  });

  it("names the store doctor reports", () => {
    expect(secretStoreName("darwin")).toBe("the macOS Keychain");
    expect(secretStoreName("linux")).toBe("~/.clausona/secrets.json");
    expect(secretStoreName("win32")).toBe("~/.clausona/secrets.json");
  });
});

describe("resolveSecret", () => {
  it("reads an env source", async () => {
    process.env.CLAUSONA_TEST_KEY = "sk-from-env";
    await expect(resolveSecret("claude:x", { source: "env", name: "CLAUSONA_TEST_KEY" })).resolves.toBe("sk-from-env");
  });

  it("throws when the env source is unset", async () => {
    await expect(resolveSecret("claude:x", { source: "env", name: "CLAUSONA_TEST_KEY" })).rejects.toThrow(
      /CLAUSONA_TEST_KEY/,
    );
  });

  // The command runs in sh -c on macOS and Linux and in powershell -NoProfile -Command on
  // Windows, so each is written for its shell. PowerShell's own cmdlets there: -Command exits 1
  // for a native command that failed, whatever its code, so `node -e "process.exit(3)"` could
  // never report 3.
  const windows = process.platform === "win32";

  it("reads the first line of a command source", async () => {
    const run = windows
      ? "Write-Output 'S3CRET'; Write-Output 'ignored'"
      : "node -e \"console.log('S3CRET'); console.log('ignored')\"";
    await expect(resolveSecret("claude:x", { source: "command", run })).resolves.toBe("S3CRET");
  });

  it("throws when the command fails", async () => {
    const run = windows ? "exit 3" : 'node -e "process.exit(3)"';
    await expect(resolveSecret("claude:x", { source: "command", run })).rejects.toThrow(/exited with 3/);
  });
});

/**
 * A stand-in `security` put first on PATH, so the real one - and the user's Keychain - is
 * never reached. It keeps its items in a file and logs every call's argv and stdin.
 */
function security(writes?: "store" | "drop" | "fail") {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-security-stand-in-"));
  temps.push(dir);
  const standIn = keychainStandIn(dir, { writes });
  vi.stubEnv("PATH", `${standIn.bin}${path.delimiter}${process.env.PATH ?? ""}`);
  return standIn;
}

describe.skipIf(process.platform === "win32")("storeSecret on the Keychain backend", () => {
  // Everything `security -i`'s line splitter treats specially, and `$` for good measure.
  const KEY = `sk-fixture-13b a"b'c\\d$HOME-end`;

  // `ps` shows every process's arguments to every user on the machine.
  it("never puts the key in security's arguments", async () => {
    const keychain = security();
    await storeSecret("claude:x", KEY, "keychain");
    expect(keychain.calls().length).toBeGreaterThan(0);
    for (const { argv } of keychain.calls()) for (const arg of argv) expect(arg).not.toContain(KEY);
  });

  it("hands security the key intact, as one add-generic-password line on stdin", async () => {
    const keychain = security();
    await storeSecret("claude:x", KEY, "keychain");
    const [write] = keychain.calls();
    expect(write?.argv).toEqual(["-i"]);
    const input = write?.stdin ?? "";
    expect(input.endsWith("\n")).toBe(true);
    expect(input.split("\n")).toHaveLength(2);
    const args = splitSecurityLine(input.slice(0, -1));
    expect(args.slice(0, -1)).toEqual([
      "add-generic-password",
      "-U",
      "-s",
      "clausona-claude:x",
      "-a",
      "claude:x",
      "-X",
    ]);
    expect(Buffer.from(args.at(-1) as string, "hex").toString("utf8")).toBe(KEY);
    expect(keychain.stored("clausona-claude:x", "claude:x")).toBe(KEY);
  });

  it("quotes a profile id the line splitter would otherwise break apart", async () => {
    const keychain = security();
    const id = `claude:we"ird\\ 'id`;
    await storeSecret(id, KEY, "keychain");
    const args = splitSecurityLine((keychain.calls()[0]?.stdin ?? "").slice(0, -1));
    expect(args.slice(0, 6)).toEqual(["add-generic-password", "-U", "-s", `clausona-${id}`, "-a", id]);
    expect(keychain.stored(`clausona-${id}`, id)).toBe(KEY);
  });

  it("throws when security reports the write failed", async () => {
    security("fail");
    await expect(storeSecret("claude:x", KEY, "keychain")).rejects.toThrow(/could not write Keychain item/);
  });

  // security's exit status is the OSStatus cut to 8 bits, and `-i` reports a result of -1 as
  // 0: a write can fail and still exit 0. Reading the item back is what catches it.
  it("throws when the write did not land although security exited 0", async () => {
    const keychain = security("drop");
    const outcome = await storeSecret("claude:x", KEY, "keychain").catch((error: Error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("Keychain item 'clausona-claude:x' did not take the new value");
    // Read back by service and account, the value on stdout: the key is in no argument.
    expect(keychain.calls().map(({ argv }) => argv)).toEqual([
      ["-i"],
      ["find-generic-password", "-s", "clausona-claude:x", "-a", "claude:x", "-w"],
    ]);
  });

  // find-generic-password -w prints the whole value as hex when any byte is not printable
  // ASCII, so the read-back compares against that, not against the key as typed.
  it("accepts the hex security prints back for a key with a non-ASCII character", async () => {
    const keychain = security();
    const key = ["sk", "fixture", "\u00e9t\u00e9"].join("-");
    await expect(storeSecret("claude:x", key, "keychain")).resolves.toBeUndefined();
    expect(keychain.stored("clausona-claude:x", "claude:x")).toBe(key);
  });

  // A line break would end the command there and hand the rest of the id to `security` as
  // a command of its own.
  it("refuses an id with a line break, without running security", async () => {
    const keychain = security();
    await expect(storeSecret("claude:x\ndelete-keychain", KEY, "keychain")).rejects.toThrow(/line break/);
    expect(keychain.calls()).toEqual([]);
  });

  // `security -i` cuts a longer line and runs the rest as a second command, so the item
  // would be overwritten with a truncated key.
  it("refuses a key too long for one security line, without running security", async () => {
    const keychain = security();
    await expect(storeSecret("claude:x", `sk-fixture-${"k".repeat(2100)}`, "keychain")).rejects.toThrow(/too long/);
    expect(keychain.calls()).toEqual([]);
  });
});

// detectBackend() reports "keychain" on macOS, so exercising the file backend on this
// platform requires forcing it explicitly via the optional `backend` override on
// storeSecret/resolveSecret/deleteSecret. The module also resolves its secrets.json path
// from homedir() at load time, so a fresh module graph is required after HOME is stubbed -
// and USERPROFILE with it, which is where homedir() looks on Windows.
describe("file backend (forced via the backend override)", () => {
  it("stores, resolves, and deletes a secret", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret, resolveSecret: resolveSecretFresh, deleteSecret } = await import("./secrets.js");

    await storeSecret("claude:file-test", "sk-file-secret", "file");
    await expect(resolveSecretFresh("claude:file-test", { source: "keychain" }, "file")).resolves.toBe(
      "sk-file-secret",
    );

    await deleteSecret("claude:file-test", "file");
    await expect(resolveSecretFresh("claude:file-test", { source: "keychain" }, "file")).rejects.toThrow(
      /no stored secret/,
    );
  });

  // Off macOS this file is all that keeps a stored key from other users on the machine, and
  // nothing else pinned it: a writer without the mode shipped with every test green. Windows has
  // no mode bits to check; there the file is private because it sits in the user's profile.
  it.skipIf(process.platform === "win32")(
    "writes secrets.json for its owner alone, and rewrites a looser one so",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
      temps.push(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.resetModules();
      const { storeSecret } = await import("./secrets.js");
      const secretsPath = path.join(home, ".clausona", "secrets.json");

      await storeSecret("claude:a", "secret-a", "file");
      const written = statSync(secretsPath).mode & 0o777;
      chmodSync(secretsPath, 0o644);
      await storeSecret("claude:b", "secret-b", "file");
      const rewritten = statSync(secretsPath).mode & 0o777;

      expect(written.toString(8)).toBe("600");
      expect(rewritten.toString(8)).toBe("600");
    },
  );

  // Regression test for a data-loss bug: readSecretsFile used to collapse every read
  // failure (corrupt file, EACCES, ...) into `{}`, and storeSecret/deleteSecret do a
  // read-modify-write over that result — so a corrupt file made the next store/delete
  // silently rewrite secrets.json with only the entry being touched, destroying every
  // other profile's credential with no error. The corruption here appends garbage after
  // valid JSON (a truncated/partial-write is a realistic way this happens), which keeps
  // "secret-a" present in the raw bytes but makes the file fail to parse - so this test
  // can tell "rejected without touching the file" apart from "silently lost the data".
  it("does not destroy existing secrets when the file is corrupt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret } = await import("./secrets.js");

    await storeSecret("claude:a", "secret-a", "file");

    const secretsPath = path.join(home, ".clausona", "secrets.json");
    const validContent = readFileSync(secretsPath, "utf8");
    writeFileSync(secretsPath, `${validContent.trimEnd()}not json`);

    await expect(storeSecret("claude:b", "secret-b", "file")).rejects.toThrow();
    expect(readFileSync(secretsPath, "utf8")).toContain("secret-a");
  });

  it("rejects when the stored JSON is not an object", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { resolveSecret: resolveSecretFresh } = await import("./secrets.js");

    const secretsPath = path.join(home, ".clausona", "secrets.json");
    mkdirSync(path.dirname(secretsPath), { recursive: true });
    writeFileSync(secretsPath, "[]");

    await expect(resolveSecretFresh("claude:x", { source: "keychain" }, "file")).rejects.toThrow(secretsPath);
  });

  it("treats a missing file as no stored secret, not a read error", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { resolveSecret: resolveSecretFresh } = await import("./secrets.js");

    await expect(resolveSecretFresh("claude:missing", { source: "keychain" }, "file")).rejects.toThrow(
      /no stored secret/,
    );
  });

  // Doctor reports a source it does not know as an error and never resolves one; launch
  // reading the store for it anyway would work while doctor calls the profile broken.
  it.each([
    ["a source clausona does not know", { source: "vault" }],
    ["no source at all", undefined],
  ])("refuses %s rather than reading the store", async (_label, source) => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.resetModules();
    const { storeSecret, resolveSecret: resolveSecretFresh } = await import("./secrets.js");
    const stored = ["sk-", "stored-", "0f3a", "9c21"].join("");
    await storeSecret("claude:x", stored, "file");

    const outcome = await resolveSecretFresh("claude:x", source as unknown as SecretSource, "file").then(
      (value) => value,
      (error: Error) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    const message = (outcome as Error).message;
    expect(message).toMatch(/not keychain, env or command/);
    expect(message).toContain("clausona config claude:x --key");
    expect(message).not.toContain(stored);
  });
});
