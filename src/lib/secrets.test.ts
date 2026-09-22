import { mkdtempSync, rmSync } from "node:fs";
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
});
