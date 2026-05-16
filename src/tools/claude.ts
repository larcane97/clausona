import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { claudeJsonPathForConfigDir } from "../core/paths.js";
import type { ToolAdapter } from "./types.js";

const BASE_SHARED_LINK_SKIP = new Set([".claude.json", "image-cache", "statsig", "plugins"]);

function keychainService(args: { homeDir: string; configDir: string }): string {
  const primary = path.join(args.homeDir, ".claude");
  if (args.configDir === primary) return "Claude Code-credentials";
  const hash = crypto.createHash("sha256").update(args.configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

async function hasKeychain(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise<boolean>((resolve) => {
    const child = spawn("security", ["find-generic-password", "-s", service], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function readAccount(configDir: string): Promise<{ email: string; orgName?: string } | null> {
  const jsonPath = claudeJsonPathForConfigDir({ homeDir: process.env.HOME ?? "", configDir });
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string; organizationName?: string } };
    const email = parsed.oauthAccount?.emailAddress;
    if (!email) return null;
    return { email, orgName: parsed.oauthAccount?.organizationName };
  } catch {
    return null;
  }
}

async function runLoginInteractive(configDir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("claude", ["auth", "login"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export const claudeAdapter: ToolAdapter = {
  name: "claude",
  binary: "claude",
  configEnvVar: "CLAUDE_CONFIG_DIR",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".claude"),
  configDirPattern: /^\.claude(-.+)?$/,
  readAccountInfo: readAccount,
  keychainServiceName: keychainService,
  hasKeychainCredential: hasKeychain,
  sharedSkipSet: (mergeSessions) =>
    mergeSessions ? new Set(BASE_SHARED_LINK_SKIP) : new Set([...BASE_SHARED_LINK_SKIP, "projects"]),
  // postSetup is left undefined here — service.ts's syncPluginsJson is wired into the
  // Claude code path explicitly because it has cross-cutting plugin marketplace state.
  // We will keep that wiring during Task 11 refactor; the adapter is not the place for it.
  runLogin: runLoginInteractive,
};
