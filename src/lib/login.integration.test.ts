import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../types.js";
import { stripAnsi } from "./cli-style.js";

// service.ts resolves ~/.clausona/profiles.json at module load, so the whole module
// graph has to see a temporary home. The mock is read through `currentHome`, which each
// case sets before re-importing the modules.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

// A cold powershell.exe start for the .cmd shim took over 20s on a contended runner.
const SPAWN_TEST_TIMEOUT_MS = 60_000;

const ENV_KEYS = [
  "PATH",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "FAKE_CLAUDE_LOG",
  "FAKE_CLAUDE_EMAIL",
  "FAKE_CLAUDE_STATUS",
  "FAKE_HOME",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const temps: string[] = [];
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

// Stands in for `claude auth login` and `claude auth status --json`. Each records the
// environment it was started with, the login to FAKE_CLAUDE_LOG and the status check next to
// it. The login then does what Claude Code does on a sign-in: writes the account to
// $CLAUDE_CONFIG_DIR/.claude.json, or to ~/.claude.json when the variable is unset. The
// status check answers as Claude Code 2.1.278 does in the state FAKE_CLAUDE_STATUS names.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (args[1] === "status") {
  fs.writeFileSync(
    process.env.FAKE_CLAUDE_LOG + ".status",
    JSON.stringify({ args, configDir: configDir ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null }),
  );
  const answers = {
    signed_in: [{ loggedIn: true, authMethod: "claude.ai", email: process.env.FAKE_CLAUDE_EMAIL }, 0],
    no_token: [{ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, 1],
    api_key: [{ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, 0],
    // Not a shape Claude Code 2.1.278 prints: one that no longer says whether it is logged in.
    no_login_field: [{ authMethod: "none" }, 1],
  };
  const [answer, code] = answers[process.env.FAKE_CLAUDE_STATUS || "signed_in"];
  process.stdout.write(JSON.stringify(answer, null, 2) + "\\n");
  process.exitCode = code;
  return;
}
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, configDir: configDir ?? null }));
const accountDir = configDir || process.env.FAKE_HOME;
if (process.env.FAKE_CLAUDE_EMAIL) {
  fs.writeFileSync(
    path.join(accountDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: process.env.FAKE_CLAUDE_EMAIL } }),
  );
}
`;

type Setup = {
  /** Account the browser session signs in to; null leaves no account file behind. */
  signInAs: string | null;
  /** Email the primary profile was registered with. */
  primaryEmail?: string;
  /** What `claude auth status` finds after the sign-in; a stored claude.ai token by default. */
  status?: "signed_in" | "no_token" | "api_key" | "no_login_field";
};

async function setup({ signInAs, primaryEmail = "a@example.com", status = "signed_in" }: Setup) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-loginhome-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  const bin = path.join(currentHome, "bin");
  for (const dir of [path.join(currentHome, ".clausona"), primary, work, bin]) mkdirSync(dir, { recursive: true });

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: primaryEmail, isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "work@example.com" },
    },
  };
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  const script = path.join(bin, "fake-claude.cjs");
  writeFileSync(script, FAKE_CLAUDE);
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec node "${script}" "$@"\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  writeFileSync(path.join(bin, "claude.cmd"), `@echo off\r\nnode "${script}" %*\r\n`);

  const log = path.join(currentHome, "fake-claude.log");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_CLAUDE_LOG = log;
  if (signInAs === null) delete process.env.FAKE_CLAUDE_EMAIL;
  else process.env.FAKE_CLAUDE_EMAIL = signInAs;
  process.env.FAKE_CLAUDE_STATUS = status;
  process.env.FAKE_HOME = currentHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ANTHROPIC_API_KEY;

  vi.resetModules();
  const service = await import("./service.js");
  const { runCommand } = await import("../commands.js");
  const spawned = () => JSON.parse(readFileSync(log, "utf8")) as { args: string[]; configDir: string | null };
  const probed = () =>
    JSON.parse(readFileSync(`${log}.status`, "utf8")) as {
      args: string[];
      configDir: string | null;
      apiKey: string | null;
    };
  const registered = async () => (await service.loadRegistry())?.profiles ?? {};
  return { service, runCommand, primary, work, spawned, probed, registered };
}

describe("loginProfile", () => {
  it(
    "starts the primary's sign-in with CLAUDE_CONFIG_DIR unset",
    async () => {
      // Claude Code picks its credential store by whether the variable is set, not by its
      // value: set to ~/.claude it signs in to a separate Keychain item and account file
      // that nothing in clausona reads.
      const { service, spawned } = await setup({ signInAs: "a@example.com" });

      await service.loginProfile("claude:default");

      expect(spawned()).toEqual({ args: ["auth", "login"], configDir: null });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "starts a secondary profile's sign-in in its own config dir",
    async () => {
      const { service, work, spawned } = await setup({ signInAs: "work@example.com" });

      await service.loginProfile("claude:work");

      expect(spawned().configDir).toBe(work);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "does not hand an inherited CLAUDE_CONFIG_DIR to the primary's sign-in",
    async () => {
      // On Windows the .cmd shim is started through PowerShell with an environment that
      // spawnCommand rebuilds from process.env, so merely leaving the key out of the
      // child's env would let the inherited value back in.
      const { service, work, spawned } = await setup({ signInAs: "a@example.com" });
      process.env.CLAUDE_CONFIG_DIR = work;

      await service.loginProfile("claude:default");

      expect(spawned().configDir).toBeNull();
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "reports the account the sign-in landed on when it is not the registered one",
    async () => {
      const { service } = await setup({ signInAs: "b@example.com" });

      const result = await service.loginProfile("claude:default");

      expect(result).toMatchObject({
        status: "other_account",
        signedInAs: "b@example.com",
        profile: { email: "a@example.com" },
      });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "does not claim the registered account when the account cannot be read back",
    async () => {
      // No account file where clausona reads it: the sign-in may have gone anywhere, so
      // "Token refreshed for <registered email>" would be the unverified claim #23 was about.
      const { service } = await setup({ signInAs: null });

      const result = await service.loginProfile("claude:default");

      expect(result.status).toBe("unverified");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "fails instead of reporting success when Claude Code stored no token (#24)",
    async () => {
      // `claude auth login` writes the account, fails to store the token, and still exits 0.
      const { service } = await setup({ signInAs: "a@example.com", status: "no_token" });

      await expect(service.loginProfile("claude:default")).rejects.toThrow(
        "The sign-in finished, but Claude Code stored no credential for claude:default",
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "reports, without failing, a sign-in whose stored credential Claude Code could not confirm",
    async () => {
      const { service } = await setup({ signInAs: "a@example.com", status: "api_key" });

      const result = await service.loginProfile("claude:default");

      expect(result).toMatchObject({ status: "ok", credentialUnconfirmed: expect.stringContaining('"api_key"') });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "takes only an explicit loggedIn: false as no credential",
    async () => {
      const { service } = await setup({ signInAs: "a@example.com", status: "no_login_field" });

      const result = await service.loginProfile("claude:default");

      expect(result).toMatchObject({ status: "ok", credentialUnconfirmed: expect.any(String) });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "still names the other account when the stored credential could not be confirmed either",
    async () => {
      const { runCommand } = await setup({ signInAs: "b@example.com", status: "api_key" });

      const out = stripAnsi(await runCommand("login", ["claude:default"]));

      expect(out).toContain("b@example.com");
      expect(out).toContain("To switch back, sign in to a@example.com");
      expect(out).toMatch(/could not confirm that Claude Code stored a credential for claude:default/);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "asks the primary's stored credential only: CLAUDE_CONFIG_DIR and the caller's API key cleared",
    async () => {
      // Either one inherited would make `auth status` answer for something other than the
      // store the sign-in just wrote: another dir, or a key that logs in without any token.
      const { service, work, probed } = await setup({ signInAs: "a@example.com" });
      process.env.CLAUDE_CONFIG_DIR = work;
      process.env.ANTHROPIC_API_KEY = "key-from-the-callers-shell";

      await service.loginProfile("claude:default");

      expect(probed()).toEqual({ args: ["auth", "status", "--json"], configDir: null, apiKey: null });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("addProfile", () => {
  it(
    "removes the new dir and registers nothing when Claude Code stored no token (#24)",
    async () => {
      const { service, registered } = await setup({ signInAs: "new@example.com", status: "no_token" });
      const configDir = path.join(currentHome, ".claude-new");

      await expect(service.addProfile({ tool: "claude", name: "new" })).rejects.toThrow(
        "The sign-in finished, but Claude Code stored no credential for claude:new",
      );

      expect(existsSync(configDir)).toBe(false);
      expect(Object.keys(await registered())).not.toContain("claude:new");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "adds the profile but warns when Claude Code answers with another sign-in method",
    async () => {
      // Not proof the token is missing - an apiKeyHelper in managed settings answers this way
      // with the token stored - so it is reported, not fatal. Still not taken as a pass.
      const { runCommand, registered } = await setup({ signInAs: "new@example.com", status: "api_key" });

      const out = stripAnsi(await runCommand("add", ["claude:new"]));

      expect(out).toContain("Added claude:new (new@example.com)");
      expect(out).toMatch(/could not confirm that Claude Code stored a credential for claude:new \(.*"api_key"/);
      expect(out).toContain("If claude asks you to sign in, run clausona login claude:new");
      expect(Object.keys(await registered())).toContain("claude:new");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "registers the profile when Claude Code confirms the sign-in, asking in the new dir",
    async () => {
      const { service, registered, probed } = await setup({ signInAs: "new@example.com" });
      const configDir = path.join(currentHome, ".claude-new");

      await service.addProfile({ tool: "claude", name: "new" });

      expect(probed().configDir).toBe(configDir);
      expect((await registered())["claude:new"]).toMatchObject({ configDir, email: "new@example.com" });
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("isOtherAccount", () => {
  it.each([
    ["a@example.com", "b@example.com", true],
    // Addresses are case-insensitive in practice, and Claude Code does not normalise them.
    ["A@Example.com", "a@example.com", false],
    // Codex falls back to the account id when its id_token carries no email, so the two
    // forms of the same account must not read as different accounts.
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "a@example.com", false],
    ["a@example.com", "1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", false],
    // Two account ids are the same form, so they can be compared exactly.
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a", true],
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", false],
  ])("registered %s, signed in as %s: %s", async (registered, signedInAs, expected) => {
    const { isOtherAccount } = await import("./service.js");

    expect(isOtherAccount(registered, signedInAs)).toBe(expected);
  });
});

describe("clausona login", () => {
  it(
    "warns, naming both accounts, instead of reporting success when a different account signed in",
    async () => {
      // Not an error: the sign-in completed and is now in use, and a profile whose account
      // legitimately changed would otherwise fail on every login with no way to update it.
      const { runCommand } = await setup({ signInAs: "b@example.com" });

      const out = stripAnsi(await runCommand("login", ["claude:default"]));

      expect(out).toContain("b@example.com");
      expect(out).toContain("a@example.com");
      expect(out).not.toContain("Token refreshed");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "does not report a refreshed token for an account it could not read back",
    async () => {
      const { runCommand } = await setup({ signInAs: null });

      const out = stripAnsi(await runCommand("login", ["claude:default"]));

      expect(out).not.toContain("Token refreshed");
      expect(out).toContain("claude:default");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  it(
    "reports success when the registered account signed in",
    async () => {
      // Email addresses are compared case-insensitively; only the casing differs here.
      const { runCommand } = await setup({ signInAs: "a@example.com", primaryEmail: "A@Example.com" });

      const out = stripAnsi(await runCommand("login", ["claude:default"]));

      expect(out).toContain("Token refreshed for A@Example.com");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
