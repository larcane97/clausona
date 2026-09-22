import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectBackend, keychainItemFor, resolveSecret } from "./secrets.js";

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
  it("uses the Keychain on macOS", async () => {
    await expect(detectBackend("darwin")).resolves.toBe("keychain");
  });

  it("falls back to a file on Windows", async () => {
    await expect(detectBackend("win32")).resolves.toBe("file");
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

  it.skipIf(process.platform === "win32")("reads the first line of a command source", async () => {
    const source = { source: "command", run: "node -e \"console.log('S3CRET'); console.log('ignored')\"" } as const;
    await expect(resolveSecret("claude:x", source)).resolves.toBe("S3CRET");
  });

  it.skipIf(process.platform === "win32")("throws when the command fails", async () => {
    const source = { source: "command", run: 'node -e "process.exit(3)"' } as const;
    await expect(resolveSecret("claude:x", source)).rejects.toThrow(/exited with 3/);
  });
});

// detectBackend() reports "keychain" on macOS, so exercising the file backend on this
// platform requires forcing it explicitly via the optional `backend` override on
// storeSecret/resolveSecret/deleteSecret. The module also resolves its secrets.json path
// from homedir() at load time, so a fresh module graph is required after HOME is stubbed.
describe("file backend (forced via the backend override)", () => {
  it("stores, resolves, and deletes a secret", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "clausona-secrets-home-"));
    temps.push(home);
    vi.stubEnv("HOME", home);
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
    vi.resetModules();
    const { resolveSecret: resolveSecretFresh } = await import("./secrets.js");

    await expect(resolveSecretFresh("claude:missing", { source: "keychain" }, "file")).rejects.toThrow(
      /no stored secret/,
    );
  });
});
