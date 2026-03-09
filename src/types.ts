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

export type Profile = {
  configDir: string;
  email: string;
  orgName?: string;
  isPrimary?: boolean;
  mergeSessions?: boolean;
};

export type Registry = {
  primarySource: string;
  activeProfile: string;
  profiles: Record<string, Profile>;
};

export type DiscoveredAccount = {
  configDir: string;
  jsonPath: string;
  email: string;
  orgName?: string;
  keychainService: string;
  isPrimary: boolean;
};

export type ProfileListItem = {
  name: string;
  email: string;
  orgName?: string;
  configDir: string;
  isPrimary: boolean;
  isActive: boolean;
  mergeSessions?: boolean;
  today: UsageSummary;
  week: UsageSummary;
  month: UsageSummary;
  total: UsageSummary;
};

export type DoctorIssue = {
  kind: "missing_json" | "missing_oauth" | "missing_keychain" | "broken_symlink" | "local_override" | "stale_symlink";
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
