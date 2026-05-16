import type { ToolName } from "../types.js";

export type AccountInfo = {
  email: string;
  orgName?: string;
};

export type ToolAdapter = {
  name: ToolName;
  binary: string;
  configEnvVar: string;

  defaultConfigDir(homeDir: string): string;
  configDirPattern: RegExp; // e.g. /^\.claude(-.+)?$/

  readAccountInfo(configDir: string): Promise<AccountInfo | null>;

  // Optional Keychain probe (Claude only on macOS).
  keychainServiceName?(args: { homeDir: string; configDir: string }): string;
  hasKeychainCredential?(service: string): Promise<boolean>;

  // Files/dirs under the profile's config dir that must NOT be symlinked to primary.
  sharedSkipSet(mergeSessions: boolean): Set<string>;

  // Optional per-name predicate for skip patterns the Set can't express
  // (e.g. sqlite WAL/SHM siblings of state_*.sqlite).
  shouldSkipName?(name: string, mergeSessions: boolean): boolean;

  // Per-tool post-link setup (e.g. Claude's plugins JSON path-rewrite).
  postSetup?(profileDir: string, primaryDir: string): Promise<void>;

  // Spawns the tool's interactive login with the given config dir as its env-var target.
  runLogin(configDir: string): Promise<boolean>;
};
