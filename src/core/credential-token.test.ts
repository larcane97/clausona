import { describe, expect, it } from "vitest";

import { carriesCredentialToken } from "./credential-token.js";

/**
 * The one check for "is there a key in this", shared by the endpoint rule and the form's
 * drawn fields. It is a shape check, so both what it catches and what it misses are pinned:
 * the misses are what the routing in the form exists for, and the ordinary values are what
 * keep it from refusing an endpoint someone actually uses.
 */

/** Realistic shapes - random bodies, not words - built here so no real key is in the repo. */
const ANTHROPIC = "sk-ant-api03-QZXJ7wvKpLmN8rTyUbHc5dFgA2sE9oIuWqXv3Bn6Mk1Lp8Rt";
const OPENROUTER = `sk-or-v1-${"3f9a0c7e1b5d2468".repeat(4)}`;
const DEEPSEEK = "sk-7c1e9a3f5b2d4086e1f3a5c7b9d0e2f4";
const OPENAI_PROJECT = "sk-proj-Xy7Qz2Lm9Np4Rs6Tu1Vw3Ab5Cd8Ef0Gh";
const BASE62 = "xai-Q7mZ2pL9rT4vX1bN6cK8dF3gH5jW0sYe4Ru7Ai2";

describe("carriesCredentialToken", () => {
  it.each([
    ["an Anthropic key", ANTHROPIC],
    ["an OpenRouter key", OPENROUTER],
    ["a DeepSeek-style sk- key over hex", DEEPSEEK],
    ["an OpenAI project key", OPENAI_PROJECT],
    ["a prefix-less base62 body", BASE62],
    ["an sk_ key, underscore form", "sk_live_9aB3cD7eF1gH5jK2mN8pQ4rS6tU0vW"],
  ])("catches %s on its own", (_shape, token) => {
    expect(carriesCredentialToken(token)).toBe(true);
  });

  it.each([
    ["glued to the end of an endpoint, as coalesced input left it", `https://gateway.example.com${ANTHROPIC}`],
    ["in a URL's path", `https://gateway.example.com/v1/${DEEPSEEK}/messages`],
    ["in a URL's query", `https://gateway.example.com/v1?key=${OPENROUTER}`],
    ["in a URL's fragment", `https://gateway.example.com/v1#${OPENAI_PROJECT}`],
    ["after a model id", `glm-5${ANTHROPIC}`],
    ["inside a header line", `Authorization: Bearer ${BASE62}`],
    ["as the tail of a paste the key field lost its head to", ANTHROPIC.slice(13)],
  ])("catches one %s", (_where, value) => {
    expect(carriesCredentialToken(value)).toBe(true);
  });

  /**
   * What a real endpoint, model id or setting looks like. A false positive here is worse than
   * a miss: `config --base-url` would refuse an endpoint in use, with no way to override it.
   */
  it.each([
    ["an ordinary endpoint", "https://openrouter.ai/api/v1"],
    ["a hostname with sk- inside a word", "https://api.risk-management-service-v2.example.com"],
    ["a hostname beginning sk-", "https://sk-proxy-2024-production-cluster.example.com"],
    ["a path with sk- inside a word", "http://localhost:8000/flask-app/v1/messages"],
    [
      "a Cloudflare AI Gateway URL, whose ids are lowercase hex",
      `https://gateway.ai.cloudflare.com/v1/${"0a1b2c3d".repeat(4)}/my-gw/anthropic`,
    ],
    ["a UUID in a path", "https://example.com/deployments/123e4567-e89b-12d3-a456-426614174000"],
    ["a dated model id", "claude-sonnet-4-5-20250929"],
    ["a long model id", "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8"],
    ["a model id with a provider prefix", "openrouter/z-ai/glm-5.3"],
    ["a camel-case name with a digit", "MyFineTunedModelVersion2"],
    ["a beta-header list", "context-1m-2025-08-07,interleaved-thinking-2025-05-14"],
    ["a number", "262144"],
    ["a short sk- name", "sk-test"],
    ["the empty string", ""],
  ])("leaves %s alone", (_shape, value) => {
    expect(carriesCredentialToken(value)).toBe(false);
  });

  /**
   * The misses, stated so nobody mistakes this for a guarantee. Each is a token that nothing
   * about its shape separates from an id: this is why the form also routes input by where the
   * cursor is, rather than relying on spotting a key after it has landed somewhere.
   */
  it.each([
    ["a self-hosted token of lowercase hex with no prefix", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
    ["a token in one case only", "QZXJWVKPLMNRTYUBHCDFGASEOIUWQZXJWVKP"],
    ["a key shorter than any run the check looks for", "sk-a1b2c3d4"],
    ["a key cut into pieces shorter than a run by its own separators", "sk-a1b2-c3d4-e5f6-g7h8-i9j0-k1l2"],
    ["a short prefix-less base62 key", "Q7mZ2pL9rT4vX1bN6cK8dF3gH5jW"],
    ["a short key whose prefix is percent-encoded", "%73%6b-ant-api03-QZXJ7wvKpLmN8rTy"],
  ])("misses %s", (_shape, value) => {
    expect(carriesCredentialToken(value)).toBe(false);
  });
});
