import { RESERVED_ENV_KEYS } from "../lib/profile-env.js";

export type EnvGroup = "model" | "context" | "limits" | "timeouts" | "compat" | "transport";

export type EnvCatalogEntry = {
  key: string;
  label: string;
  hint: string;
  kind: "number" | "bool" | "string" | "json";
  group: EnvGroup;
};

/**
 * The advanced settings clausona surfaces with a label and validation. This is a
 * convenience layer, never a whitelist: `validateEnvEntry` accepts keys that are absent
 * here, so a variable introduced by a future Claude Code release works without a
 * clausona release.
 *
 * Verified against Claude Code 2.1.278.
 */
export const CLAUDE_ENV_CATALOG: EnvCatalogEntry[] = [
  { key: "ANTHROPIC_MODEL", label: "Model", hint: "Model id this profile sends", kind: "string", group: "model" },
  {
    key: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    label: "Opus alias",
    hint: "Model used when opus is selected",
    kind: "string",
    group: "model",
  },
  {
    key: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    label: "Sonnet alias",
    hint: "Model used when sonnet is selected",
    kind: "string",
    group: "model",
  },
  {
    key: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    label: "Haiku alias",
    hint: "Model used for fast background calls",
    kind: "string",
    group: "model",
  },
  {
    key: "CLAUDE_CODE_SUBAGENT_MODEL",
    label: "Subagent model",
    hint: "Model subagents run on",
    kind: "string",
    group: "model",
  },
  {
    key: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    label: "Context window",
    hint: "Real window size; unknown models otherwise get a conservative guess and compact early",
    kind: "number",
    group: "context",
  },
  {
    key: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    label: "Auto-compact window",
    hint: "Token budget auto-compact keeps a session within",
    kind: "number",
    group: "context",
  },
  {
    key: "DISABLE_AUTO_COMPACT",
    label: "Disable auto-compact",
    hint: "Set to 1 to turn off automatic compaction of a full context window",
    kind: "bool",
    group: "context",
  },
  {
    key: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    label: "Max output tokens",
    hint: "Per-response output cap",
    kind: "number",
    group: "limits",
  },
  {
    key: "MAX_THINKING_TOKENS",
    label: "Max thinking tokens",
    hint: "Extended thinking budget",
    kind: "number",
    group: "limits",
  },
  {
    key: "API_TIMEOUT_MS",
    label: "Request timeout",
    hint: "Milliseconds to wait for one request; raise for gateways that hold responses until complete",
    kind: "number",
    group: "timeouts",
  },
  {
    key: "CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS",
    label: "First-byte timeout",
    hint: "Milliseconds to wait for the first streamed byte; raise for cold self-hosted servers",
    kind: "number",
    group: "timeouts",
  },
  {
    key: "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
    label: "Stream idle timeout",
    hint: "Gap allowed between streamed chunks",
    kind: "number",
    group: "timeouts",
  },
  {
    key: "CLAUDE_CODE_MAX_RETRIES",
    label: "Max retries",
    hint: "Retry attempts per request",
    kind: "number",
    group: "timeouts",
  },
  {
    key: "DISABLE_PROMPT_CACHING",
    label: "Disable prompt caching",
    hint: "Set to 1 to stop sending cache markers, for endpoints without cache support",
    kind: "bool",
    group: "compat",
  },
  {
    key: "DISABLE_INTERLEAVED_THINKING",
    label: "Disable interleaved thinking",
    hint: "Set to 1 to stop requesting interleaved thinking, for endpoints that reject thinking blocks",
    kind: "bool",
    group: "compat",
  },
  {
    key: "CLAUDE_CODE_DISABLE_1M_CONTEXT",
    label: "Disable 1M context",
    hint: "Set to 1 to never request the 1M-token context beta",
    kind: "bool",
    group: "compat",
  },
  {
    key: "ANTHROPIC_BETAS",
    label: "Beta headers",
    hint: "Comma-separated beta feature names",
    kind: "string",
    group: "compat",
  },
  {
    key: "ANTHROPIC_CUSTOM_HEADERS",
    label: "Custom headers",
    hint: "Extra request headers, one per line",
    kind: "string",
    group: "transport",
  },
  {
    key: "CLAUDE_CODE_EXTRA_BODY",
    label: "Extra request body",
    hint: "JSON object merged into each request body",
    kind: "json",
    group: "transport",
  },
  {
    key: "HTTPS_PROXY",
    label: "HTTPS proxy",
    hint: "Proxy URL for outbound requests",
    kind: "string",
    group: "transport",
  },
];

const BY_KEY = new Map(CLAUDE_ENV_CATALOG.map((entry) => [entry.key, entry]));

export function catalogEntry(key: string): EnvCatalogEntry | undefined {
  return BY_KEY.get(key);
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validateEnvEntry(key: string, value: string): { ok: true } | { ok: false; error: string } {
  if (RESERVED_ENV_KEYS.has(key)) {
    return { ok: false, error: `${key} is managed by clausona and cannot be set on a profile` };
  }

  const entry = BY_KEY.get(key);
  if (!entry) return { ok: true };

  if (entry.kind === "number" && !/^(?:0|[1-9]\d*)$/.test(value)) {
    return { ok: false, error: `${key} expects a whole number, got '${value}'` };
  }
  if (entry.kind === "bool" && value !== "0" && value !== "1") {
    return { ok: false, error: `${key} expects 0 or 1, got '${value}'` };
  }
  if (entry.kind === "json") {
    // Unlike the number and bool branches above, this one never echoes the value. A json
    // entry is where someone pastes a request-body fragment for a self-hosted gateway,
    // auth field included, so a malformed paste must not land in an error string the CLI
    // prints. A JSON type name carries no content, so naming the shape is safe. Do not
    // harmonise these three branches.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: `${key} expects a JSON object` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `${key} expects a JSON object, got ${jsonTypeName(parsed)}` };
    }
  }
  return { ok: true };
}
