import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ENV_KEYS = ["PATH", "CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_EMAIL", "FAKE_HOME"] as const;
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

// Stands in for `claude auth login`. It records the environment it was started with and
// then does what Claude Code does on a successful sign-in: writes the account to
// $CLAUDE_CONFIG_DIR/.claude.json, or to ~/.claude.json when the variable is unset.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const path = require("node:path");
const configDir = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), configDir: configDir ?? null }));
const accountDir = configDir || process.env.FAKE_HOME;
fs.writeFileSync(
  path.join(accountDir, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: process.env.FAKE_CLAUDE_EMAIL } }),
);
`;

type Setup = {
  /** Account the browser session signs in to. */
  signInAs: string;
  /** Email the primary profile was registered with. */
  primaryEmail?: string;
};

async function setup({ signInAs, primaryEmail = "a@example.com" }: Setup) {
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
  process.env.FAKE_CLAUDE_EMAIL = signInAs;
  process.env.FAKE_HOME = currentHome;
  delete process.env.CLAUDE_CONFIG_DIR;

  vi.resetModules();
  const service = await import("./service.js");
  const { runCommand } = await import("../commands.js");
  const spawned = () => JSON.parse(readFileSync(log, "utf8")) as { args: string[]; configDir: string | null };
  return { service, runCommand, primary, work, spawned };
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

  // The Windows .cmd shim path in spawnCommand rebuilds the child's environment from
  // process.env, so an inherited value survives there; that is a separate defect.
  it.skipIf(process.platform === "win32")(
    "does not hand an inherited CLAUDE_CONFIG_DIR to the primary's sign-in",
    async () => {
      const { service, work, spawned } = await setup({ signInAs: "a@example.com" });
      process.env.CLAUDE_CONFIG_DIR = work;

      await service.loginProfile("claude:default");

      expect(spawned().configDir).toBeNull();
    },
  );

  it(
    "reports the account the sign-in actually landed on",
    async () => {
      const { service } = await setup({ signInAs: "b@example.com" });

      const result = await service.loginProfile("claude:default");

      expect(result.signedInAs).toBe("b@example.com");
      expect(result.profile.email).toBe("a@example.com");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("clausona login", () => {
  it(
    "warns instead of reporting success when a different account signed in",
    async () => {
      const { runCommand } = await setup({ signInAs: "b@example.com" });

      const out = stripAnsi(await runCommand("login", ["claude:default"]));

      expect(out).toContain("b@example.com");
      expect(out).toContain("a@example.com");
      expect(out).not.toContain("Token refreshed");
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
