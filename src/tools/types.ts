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

/**
 * Whether a finished sign-in left a credential the tool itself can use. `signed_out` is the
 * tool's own answer that it has none; `unknown` is every case where no usable answer came
 * back (the check failed to run, timed out, could not be read, or named another sign-in
 * method). `detail` says which, for the error the caller raises.
 */
export type SignInCheck = { ok: true } | { ok: false; reason: "signed_out" | "unknown"; detail: string };

/**
 * What a profile's link to one of the primary's entries does when the entry is not one to
 * share. `wrong_account`: the tool acts as the primary's account through it - its credential,
 * or a daemon signed in as it. `isolation`: one account's state reaches the other's.
 */
export type UnsharedRisk = { risk: "wrong_account" | "isolation"; why: string };

export type ToolAdapter = {
  name: ToolName;
  binary: string;
  configEnvVar: string;

  defaultConfigDir(homeDir: string): string;
  configDirPattern: RegExp; // e.g. /^\.claude(-.+)?$/

  readAccountInfo(configDir: string): Promise<AccountInfo | null>;

  // Optional Keychain probe (Claude only on macOS).
  keychainServiceName?(args: { homeDir: string; configDir: string }): string;
  // The account the tool files its item under: the probe looks for the service under it only.
  keychainAccount?(): string;
  hasKeychainCredential?(service: string): Promise<boolean>;
  // The plaintext file Claude Code falls back to on macOS when a Keychain write fails,
  // and reads whenever the Keychain has no item. A profile whose token landed there is
  // signed in, so a caller gating on the Keychain probe has to accept this too.
  hasFallbackCredential?(configDir: string): Promise<boolean>;

  // A tool names either what a profile does not share (sharedSkipSet, with shouldSkipName) or
  // the only entries it shares (sharedAllow), never both. The second is for a tool whose
  // releases keep adding state of one account's to its config dir: a name no one has looked
  // at yet stays the profile's own, rather than being linked into the primary's.
  //
  // Whether the primary's entry `name` is linked into a profile. Every other entry is the
  // profile's own, and one linked by an earlier clausona is unlinked by repair.
  sharedAllow?(name: string, mergeSessions: boolean): boolean;

  // With sharedAllow: what linking `name` into the primary's does - acting as the primary's
  // account, or sharing one account's state with another - for doctor to say when a profile
  // links it. `why` follows "<name> links to the primary's, ".
  unsharedRisk?(name: string): UnsharedRisk;

  // With sharedAllow: entries the profile keeps for itself - setup the tool reads, which may
  // hold an account's own keys - that a profile which linked the primary's keeps as a copy of
  // it, in place of the link. No other profile gets one.
  copiedWhenUnlinked?: readonly string[];

  // Files/dirs under the profile's config dir that must NOT be symlinked to primary.
  sharedSkipSet?(mergeSessions: boolean): Set<string>;

  // Optional per-name predicate for skip patterns the Set can't express
  // (e.g. sqlite WAL/SHM siblings of state_*.sqlite).
  shouldSkipName?(name: string, mergeSessions: boolean): boolean;

  // Shared files the tool saves whole: it writes a new file and renames it over the old one.
  // A hard link does not survive that - the profile keeps the old file and stops following
  // the primary's at the first save - so these are shared by a symbolic link or not at all.
  rewritesWhole?(name: string): boolean;

  // Unix sockets the tool binds inside its config dir, relative to it, and what each is for.
  // A socket's whole path has to fit in sun_path, so a config dir that is too long stops the
  // tool binding it.
  unixSockets?: ReadonlyArray<{ path: string; purpose: string }>;

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
  // entitled to assume the new credential survived the process. Null means it changed
  // nothing because the tool itself was renewing the same credential at the time.
  renewCredential?(configDir: string, credential: ToolCredential, signal: AbortSignal): Promise<ToolCredential | null>;

  // Spawns the tool's interactive login so that it signs in to the same stores the adapter
  // reads for `configDir`. That is usually the dir as the env-var target, but for Claude's
  // default dir the variable must be unset (see isDefaultClaudeConfigDir).
  runLogin(configDir: string): Promise<boolean>;

  // Asks the tool, after runLogin returned true, whether `configDir` now holds a stored
  // credential. The login's exit code is not enough where the tool can report success
  // without having stored its token (Claude Code: #24). `clearEnvKeys` are the variables that
  // would let the tool authenticate without that credential; the check runs with each one
  // unset, so only the stored credential can pass it. Passed in rather than imported: the
  // list lives in src/lib/profile-env, which imports this adapter through the registry.
  // Optional: Codex reads its account from the same auth.json that holds its tokens, so an
  // account read back there already proves the store.
  verifySignIn?(configDir: string, options: { clearEnvKeys: readonly string[] }): Promise<SignInCheck>;
};
