import { describe, expect, it } from "vitest";

import { RESERVED_ENV_KEYS } from "../lib/profile-env.js";
import { CLAUDE_ENV_CATALOG, catalogEntry, validateEnvEntry } from "./claude-env-catalog.js";

const KINDS = new Set(["number", "bool", "string", "json"]);
const GROUPS = new Set(["model", "context", "limits", "timeouts", "compat", "transport"]);

describe("CLAUDE_ENV_CATALOG", () => {
  it("has no duplicate keys", () => {
    const keys = CLAUDE_ENV_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the variables that self-hosted endpoints need", () => {
    for (const key of ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "API_TIMEOUT_MS", "ANTHROPIC_MODEL"]) {
      expect(catalogEntry(key), key).toBeDefined();
    }
  });

  it("holds a well-formed, reachable entry in every row", () => {
    const seen = new Set<string>();
    for (const entry of CLAUDE_ENV_CATALOG) {
      expect(entry.key, JSON.stringify(entry)).not.toBe("");
      expect(entry.label, entry.key).not.toBe("");
      expect(entry.hint, entry.key).not.toBe("");
      expect(KINDS.has(entry.kind), `${entry.key} kind ${entry.kind}`).toBe(true);
      expect(GROUPS.has(entry.group), `${entry.key} group ${entry.group}`).toBe(true);
      // A row clausona itself manages would be one the user can never set.
      expect(RESERVED_ENV_KEYS.has(entry.key), entry.key).toBe(false);
      expect(seen.has(entry.key), entry.key).toBe(false);
      seen.add(entry.key);
      expect(catalogEntry(entry.key), entry.key).toBe(entry);
    }
  });
});

describe("validateEnvEntry", () => {
  it("accepts a key it has never heard of", () => {
    expect(validateEnvEntry("SOME_FUTURE_CLAUDE_VAR", "anything")).toEqual({ ok: true });
  });

  it("rejects a reserved key", () => {
    const result = validateEnvEntry("CLAUDE_CONFIG_DIR", "/tmp/x");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/managed by clausona/) });
  });

  it("rejects a non-numeric value for a number entry", () => {
    expect(validateEnvEntry("API_TIMEOUT_MS", "soon").ok).toBe(false);
  });

  it("accepts a numeric value for a number entry", () => {
    expect(validateEnvEntry("API_TIMEOUT_MS", "600000")).toEqual({ ok: true });
  });

  it("rejects a leading zero but accepts a bare zero for a number entry", () => {
    expect(validateEnvEntry("CLAUDE_CODE_MAX_RETRIES", "007").ok).toBe(false);
    expect(validateEnvEntry("CLAUDE_CODE_MAX_RETRIES", "0000").ok).toBe(false);
    expect(validateEnvEntry("CLAUDE_CODE_MAX_RETRIES", "0")).toEqual({ ok: true });
  });

  it("accepts a JSON object for a json entry", () => {
    expect(validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", '{"thinking":{"type":"enabled"}}')).toEqual({ ok: true });
    expect(validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", "{}")).toEqual({ ok: true });
  });

  it("rejects JSON that parses to something other than an object", () => {
    for (const value of ["[]", "123", "null", '"hello"', "true"]) {
      expect(validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", value).ok, value).toBe(false);
    }
  });

  it("rejects malformed JSON for a json entry", () => {
    expect(validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", "{nope").ok).toBe(false);
  });

  it("never echoes the value when rejecting a json entry", () => {
    const pasted = '{"metadata":{"api_key":"sk-not-a-real-key"';
    const result = validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", pasted);
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).not.toContain("sk-not-a-real-key");
    expect(error).not.toContain("api_key");
    expect(error).toBe("CLAUDE_CODE_EXTRA_BODY expects a JSON object");
  });

  it("names only the JSON type when the shape is wrong", () => {
    const result = validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", '["sk-not-a-real-key"]');
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).not.toContain("sk-not-a-real-key");
    expect(error).toBe("CLAUDE_CODE_EXTRA_BODY expects a JSON object, got array");
  });

  it("rejects a key that is not a POSIX environment variable name", () => {
    for (const key of ["A; touch /tmp/clausona-pwned; B", "A $(id)", "A B", "A=B", "9LEADING", "", "ANTHROPIC-MODEL"]) {
      const result = validateEnvEntry(key, "1");
      expect(result.ok, key).toBe(false);
      const error = result.ok ? "" : result.error;
      // The message has to describe the shape, since the catalog is not a whitelist and
      // "unknown key" would be the wrong thing to tell the user.
      expect(error, key).toMatch(/not a valid environment variable name/);
      expect(error, key).toMatch(/letters, digits and underscores/);
    }
  });

  it("rejects a malformed key before the reserved-key check", () => {
    const result = validateEnvEntry("CLAUDE_CONFIG_DIR; touch /tmp/clausona-pwned", "1");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/not a valid environment variable name/);
  });

  it("accepts 1 and 0 for a bool entry", () => {
    expect(validateEnvEntry("DISABLE_PROMPT_CACHING", "1")).toEqual({ ok: true });
    expect(validateEnvEntry("DISABLE_PROMPT_CACHING", "yes").ok).toBe(false);
  });
});
