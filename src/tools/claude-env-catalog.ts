import { redactUrlsIn } from "../core/api-url.js";
import { carriesCredentialToken, looksLikeCredential } from "../core/credential-token.js";
import { isPosixEnvName } from "../core/shell.js";
import { isReservedEnvKey, isSecretEnvName, printable, shownEnvName } from "../lib/profile-env.js";
import type { Profile } from "../types.js";

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
 * clausona release. Key *format* is checked even though key *membership* is not - a key
 * that is not a POSIX environment variable name is rejected however the catalog reads,
 * because no shell could export it.
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

/**
 * A name whose value is never printed, in part or whole: any name that says it holds a
 * secret (`isSecretEnvName`, which is wider than the clear list), and a json setting. The API
 * form draws these masked for the same reason, so a value is on screen exactly where it would
 * be in `config --show`. Here rather than beside `redactProfile`, which re-exports it, because
 * `validateEnvEntry` needs it too and redact.ts already reads this catalog.
 */
export function hidesEnvValue(key: string): boolean {
  return isSecretEnvName(key) || catalogEntry(key)?.kind === "json" || shownEnvName(key) !== key;
}

/**
 * Whether a setting's value is a key in the wrong field: shaped like one, under a name whose
 * value output does not hide - a header or a request body is where a gateway takes a key.
 * Judged as output shows it, so a proxy's long random password, which output hides and `--set`
 * stores, is not taken for a key.
 */
export function misplacedKeyValue(key: string, value: string): boolean {
  return !hidesEnvValue(key) && carriesCredentialToken(redactUrlsIn(printable(value)));
}

/** `validateEnvEntry`'s refusal of one. The value is not quoted: it is the key. */
export const MISPLACED_KEY_VALUE =
  "That setting's value is shaped like an API key, so it was not stored. A key never goes in the env map: an API profile takes it through --key or --key-from";

/**
 * How a refused number or bool entry names what it was given: quoted, so it can be corrected,
 * unless it could be a key - one too short for the shape check that still begins like one.
 */
function quotedValue(value: string): string {
  return looksLikeCredential(value) ? "." : `, got '${value}'`;
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether a name is the base URL's variable, in any case. An API profile's endpoint is its
 * `api.baseUrl`, which `list`, `config --show` and doctor show and `--base-url` checks; the env
 * map is applied after it, so the variable there would move the key to a host none of them
 * name, past every note `--base-url` prints.
 */
export function isBaseUrlEnvKey(key: string): boolean {
  return key.toUpperCase() === "ANTHROPIC_BASE_URL";
}

/**
 * `kind` is the profile's: an API profile refuses its endpoint as a setting. Any other kind
 * has no endpoint of clausona's, and a user who points a subscription at a proxy may set it.
 */
export function validateEnvEntry(
  key: string,
  value: string,
  kind?: Profile["kind"],
): { ok: true } | { ok: false; error: string } {
  // Before the name rule, whose message quotes the name: this one is a key.
  if (shownEnvName(key) !== key) {
    return {
      ok: false,
      error: "That setting's name is shaped like an API key. A key never goes in the env map: use --key or --key-from",
    };
  }
  // Before anything that could quote the value: no route may print a key back, and on
  // `--edit` the value was never on a command line, so the message would be where it shows.
  if (misplacedKeyValue(key, value)) return { ok: false, error: MISPLACED_KEY_VALUE };
  if (!isPosixEnvName(key)) {
    return {
      ok: false,
      error: `'${key}' is not a valid environment variable name - use letters, digits and underscores, starting with a letter or underscore`,
    };
  }

  if (isReservedEnvKey(key)) {
    return { ok: false, error: `${key} is managed by clausona and cannot be set on a profile` };
  }
  if (kind === "api" && isBaseUrlEnvKey(key)) {
    return { ok: false, error: `${key} is this profile's endpoint - set the endpoint with --base-url` };
  }

  const entry = BY_KEY.get(key);
  if (!entry) return { ok: true };

  if (entry.kind === "number" && !/^(?:0|[1-9]\d*)$/.test(value)) {
    return { ok: false, error: `${key} expects a whole number${quotedValue(value)}` };
  }
  if (entry.kind === "bool" && value !== "0" && value !== "1") {
    return { ok: false, error: `${key} expects 0 or 1${quotedValue(value)}` };
  }
  if (entry.kind === "json") {
    // Unlike the number and bool branches above, this one never echoes any value. A json
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
