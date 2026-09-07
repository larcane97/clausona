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

export type Profile = {
  tool: ToolName;
  configDir: string;
  email: string;
  orgName?: string;
  isPrimary?: boolean;
  mergeSessions?: boolean;
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

export type ProfileListItem = {
  name: string;
  tool: ToolName;
  email: string;
  orgName?: string;
  configDir: string;
  isPrimary: boolean;
  isActive: boolean;
  mergeSessions?: boolean;
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
    | "plugins_out_of_sync";
  message: string;
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
