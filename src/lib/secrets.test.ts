import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { detectBackend, keychainItemFor, resolveSecret, storeSecret } from "./secrets.js";

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

/**
 * A stand-in `security` put first on PATH, so the real one - and the user's Keychain - is
 * never reached. It records its arguments (NUL-separated, so a space inside one shows) and
 * whatever it was given on stdin, and exits with `exitCode`.
 */
function securityShim(exitCode: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-security-shim-"));
  temps.push(dir);
  const argvPath = path.join(dir, "argv");
  const stdinPath = path.join(dir, "stdin");
  writeFileSync(
    path.join(dir, "security"),
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\0' "$arg" >> '${argvPath}'; done`,
      `cat > '${stdinPath}'`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
  return {
    called: () => existsSync(argvPath) || existsSync(stdinPath),
    argv: () => (existsSync(argvPath) ? readFileSync(argvPath, "utf8").split("\0").slice(0, -1) : []),
    stdin: () => readFileSync(stdinPath, "utf8"),
  };
}

/**
 * How `security -i` splits each line it reads into arguments: split_line in Apple's
 * SecurityTool/macOS/security.c. Whitespace separates; an argument that starts with `"` or
 * `'` runs to the same quote; a backslash takes the next character literally, quoted or not.
 */
function splitSecurityLine(line: string): string[] {
  const args: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (current === null) {
      if (/[ \t\n\v\f\r]/.test(ch)) continue;
      current = "";
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
    }
    if (ch === "\\") {
      i++;
      current += line[i] ?? "";
    } else if (quote === null ? /[ \t\n\v\f\r]/.test(ch) : ch === quote) {
      args.push(current);
      current = null;
      quote = null;
    } else {
      current += ch;
    }
  }
  if (current !== null) args.push(current);
  return args;
}

describe.skipIf(process.platform === "win32")("storeSecret on the Keychain backend", () => {
  // Everything `security -i`'s line splitter treats specially, and `$` for good measure.
  const KEY = `sk-fixture-13b a"b'c\\d$HOME-end`;

  // `ps` shows every process's arguments to every user on the machine.
  it("never puts the key in security's arguments", async () => {
    const shim = securityShim(0);
    await storeSecret("claude:x", KEY, "keychain");
    expect(shim.called()).toBe(true);
    for (const arg of shim.argv()) expect(arg).not.toContain(KEY);
  });

  it("hands security the key intact, as one add-generic-password line on stdin", async () => {
    const shim = securityShim(0);
    await storeSecret("claude:x", KEY, "keychain");
    expect(shim.argv()).toEqual(["-i"]);
    const input = shim.stdin();
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
  });

  it("quotes a profile id the line splitter would otherwise break apart", async () => {
    const shim = securityShim(0);
    const id = `claude:we"ird\\ 'id`;
    await storeSecret(id, KEY, "keychain");
    const args = splitSecurityLine(shim.stdin().slice(0, -1));
    expect(args.slice(0, 6)).toEqual(["add-generic-password", "-U", "-s", `clausona-${id}`, "-a", id]);
  });

  it("throws when security reports the write failed", async () => {
    securityShim(44);
    await expect(storeSecret("claude:x", KEY, "keychain")).rejects.toThrow(/could not write Keychain item/);
  });

  // A line break would end the command there and hand the rest of the id to `security` as
  // a command of its own.
  it("refuses an id with a line break, without running security", async () => {
    const shim = securityShim(0);
    await expect(storeSecret("claude:x\ndelete-keychain", KEY, "keychain")).rejects.toThrow(/line break/);
    expect(shim.called()).toBe(false);
  });

  // `security -i` cuts a longer line and runs the rest as a second command, so the item
  // would be overwritten with a truncated key.
  it("refuses a key too long for one security line, without running security", async () => {
    const shim = securityShim(0);
    await expect(storeSecret("claude:x", `sk-fixture-${"k".repeat(2100)}`, "keychain")).rejects.toThrow(/too long/);
    expect(shim.called()).toBe(false);
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
});
