import type { QuotaWindows, ToolName } from "../types.js";

export type AccountInfo = {
  email: string;
  orgName?: string;
};

export type ToolCredential = {
  accessToken: string;
  /** Present when the stored credential can be renewed without a fresh login. */
  refreshToken?: string;
  /** ms epoch, when the credential format records one. */
  expiresAt?: number;
  /** Additional headers the tool's usage endpoint requires. */
  headers?: Record<string, string>;
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

  // Reads the profile's OAuth access token. Null when the profile has no usable
  // credential, which is the signal to skip the network entirely.
  readCredential?(configDir: string): Promise<ToolCredential | null>;

  // Fetches and normalizes the tool's quota endpoint. Only called with a credential
  // from readCredential; throws QuotaHttpError for non-2xx responses.
  fetchQuota?(credential: ToolCredential, signal: AbortSignal): Promise<QuotaWindows | null>;

  // Exchanges the stored refresh token for a fresh credential AND persists it.
  //
  // Rotation has no grace period: the moment the provider answers, the old refresh
  // token is dead. An implementation MUST therefore persist the response before it
  // returns, and MUST throw if it cannot — a caller that sees a return value is
  // entitled to assume the new credential survived the process.
  renewCredential?(configDir: string, credential: ToolCredential, signal: AbortSignal): Promise<ToolCredential>;

  // Spawns the tool's interactive login with the given config dir as its env-var target.
  runLogin(configDir: string): Promise<boolean>;
};
