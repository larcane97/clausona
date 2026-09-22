import { describe, expect, it } from "vitest";

import { CLAUDE_ENV_CATALOG, catalogEntry, validateEnvEntry } from "./claude-env-catalog.js";

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

  it("rejects malformed JSON for a json entry", () => {
    expect(validateEnvEntry("CLAUDE_CODE_EXTRA_BODY", "{nope").ok).toBe(false);
  });

  it("accepts 1 and 0 for a bool entry", () => {
    expect(validateEnvEntry("DISABLE_PROMPT_CACHING", "1")).toEqual({ ok: true });
    expect(validateEnvEntry("DISABLE_PROMPT_CACHING", "yes").ok).toBe(false);
  });
});
