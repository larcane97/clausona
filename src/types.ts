export type UsageRecord = {
  ts: string;
  tz?: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
};

export type UsagePeriod = "today" | "week" | "month" | "all";

export type UsageSummary = {
  cost: number;
  inputTokens: number;
  outputTokens: number;
};

export type QuotaWindow = {
  /** Consumed share of the window, 0-100. */
  usedPercent: number;
  /** ISO 8601 instant the window rolls over, or null when the API omits it. */
  resetsAt: string | null;
};

export type QuotaWindows = {
  /** Short rolling window: Claude's 5-hour session, Codex's sub-day window. */
  session?: QuotaWindow;
  /** Seven-day window. */
  weekly?: QuotaWindow;
  /** Most-consumed model-scoped weekly limit, when the tool reports one. */
  scoped?: QuotaWindow & { label: string };
};

/**
 * Anything other than `ok` means the numbers (if any) are a last-known reading rather
 * than a current one; `fetchedAt` says how old they are.
 *
 * `ok`      - fetched just now, or cached and still within the freshness window
 * `expired` - credential exists but the API rejected it (401/403)
 * `missing` - no credential on disk for this profile
 * `cooldown`- the endpoint returned 429; requests are paused until it lifts
 * `error`   - network, timeout, or unparseable response
 */
export type QuotaState = "ok" | "expired" | "missing" | "cooldown" | "error";

export type QuotaSnapshot = QuotaWindows & {
  state: QuotaState;
  /** ms epoch of the fetch that produced these windows. */
  fetchedAt: number;
};

export type ToolName = "claude" | "codex";

export type SecretSource =
  | { source: "keychain" }
  | { source: "env"; name: string }
  | { source: "command"; run: string };

export type ApiEndpoint = {
  baseUrl: string;
  /** bearer -> ANTHROPIC_AUTH_TOKEN, api-key -> ANTHROPIC_API_KEY */
  authScheme: "bearer" | "api-key";
  secret: SecretSource;
};

export type Profile = {
  tool: ToolName;
  /** undefined means "subscription" — existing registries carry no kind. */
  kind?: "subscription" | "api";
  configDir: string;
  email: string;
  /** Display name for profiles that have no account email. */
  label?: string;
  orgName?: string;
  isPrimary?: boolean;
  mergeSessions?: boolean;
  api?: ApiEndpoint;
  /** Free-form environment overrides. The advanced UI is a view over this map. */
  env?: Record<string, string>;
};

export type Registry = {
  version: 2;
  primarySources: Partial<Record<ToolName, string>>;
  activeProfiles: Partial<Record<ToolName, string>>;
  profiles: Record<string, Profile>;
};

export type RegistryV1 = {
  primarySource: string;
  activeProfile: string;
  profiles: Record<
    string,
    {
      configDir: string;
      email: string;
      orgName?: string;
      isPrimary?: boolean;
      mergeSessions?: boolean;
    }
  >;
};

export type DiscoveredAccount = {
  tool: ToolName;
  configDir: string;
  jsonPath: string;
  email: string;
  orgName?: string;
  keychainService: string;
  isPrimary: boolean;
};

/** A profile's kind as printed: `unknown` for a stored one that is neither, which only a hand edit leaves. */
export type ShownKind = "subscription" | "api" | "unknown";

export type ProfileListItem = {
  name: string;
  tool: ToolName;
  /** undefined means "subscription", as on Profile. */
  kind?: ShownKind;
  email: string;
  /** Display name for profiles that have no account email. */
  label?: string;
  orgName?: string;
  configDir: string;
  isPrimary: boolean;
  isActive: boolean;
  mergeSessions?: boolean;
  /**
   * The model the profile pins: its env map's ANTHROPIC_MODEL, worked out by `profileModel`.
   * Always listed, unlike `env` - it is what `list` is asked to show, and not a credential.
   * Absent when none is pinned.
   */
  model?: string;
  /**
   * Present for API profiles, with `listProfiles({ detail: true })` only, and redacted by
   * `redactProfile`: `secret` names where the key is read from, never the key or a command.
   */
  api?: ApiEndpoint;
  /** The env map, with `detail` only, and redacted by `redactProfile`. */
  env?: Record<string, string>;
  quota?: QuotaSnapshot;
  today: UsageSummary;
  week: UsageSummary;
  month: UsageSummary;
  total: UsageSummary;
};

export type DoctorIssue = {
  kind:
    | "missing_json"
    | "missing_oauth"
    | "missing_keychain"
    | "broken_symlink"
    | "local_override"
    | "stale_symlink"
    | "missing_shared_link"
    | "plugins_out_of_sync"
    // API profiles only. The first three are the profile's own configuration; the next
    // three are about a second key reaching the profile's endpoint by a route clausona
    // does not clear, or about not being able to tell; the last, about this profile's key
    // reaching another profile's endpoint.
    | "missing_config_dir"
    | "missing_api_secret"
    | "invalid_api_config"
    | "shared_api_key_helper"
    | "unreadable_settings"
    | "plaintext_env_secret"
    | "shared_key_source"
    // Any profile: an env map a hand edit left as something other than a map, or a kind
    // that is neither subscription nor api.
    | "invalid_env_map"
    | "invalid_profile_kind";
  message: string;
  /**
   * Absent means this is an error: the profile does not work until it is resolved, and
   * `healthy` is false. `"warning"` means the profile works and the finding is advice.
   *
   * There is deliberately no `"error"` to write. An error must carry no `severity` key at
   * all, so the report a registry without warnings produces - every subscription-only one -
   * is byte-identical to the report it produced before warnings existed.
   */
  severity?: "warning";
};

export type DoctorProfileResult = {
  name: string;
  email: string;
  configDir: string;
  isPrimary: boolean;
  healthy: boolean;
  issues: DoctorIssue[];
};

export type UsageStore = Record<
  string,
  {
    records: UsageRecord[];
    seenSessions?: Record<string, string>;
  }
>;

export type ParsedCommand =
  | { kind: "tui"; command: "dashboard" }
  | { kind: "command"; command: string; args: string[] }
  | { kind: "exec"; profile: string; args: string[] };
