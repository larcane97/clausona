import { describe, expect, it } from "vitest";
import type { ApiEndpoint, Profile } from "../types.js";
import { type ApiHealthInput, evaluateApiHealth, evaluateSymlinkHealth } from "./doctor.js";

describe("evaluateSymlinkHealth", () => {
  it("reports a local override where primary has the item", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      items: [{ name: "jobs", isSharedLink: false, pointsToPrimary: false, targetExists: true, existsInPrimary: true }],
    });
    expect(issues).toEqual([{ kind: "local_override", message: "jobs replaced an expected shared link" }]);
  });

  it("reports a directory the primary has but the profile is missing", () => {
    const issues = evaluateSymlinkHealth({
      isPrimary: false,
      items: [],
      missingSharedDirs: ["jobs", "teams"],
    });
    expect(issues.map((i) => i.kind)).toEqual(["missing_shared_link", "missing_shared_link"]);
    expect(issues[0].message).toContain("jobs/");
    expect(issues[0].message).toContain("clausona repair");
  });

  it("stays silent for the primary profile even when directories are reported missing", () => {
    expect(evaluateSymlinkHealth({ isPrimary: true, items: [], missingSharedDirs: ["jobs"] })).toEqual([]);
  });

  it("treats an absent missingSharedDirs as no missing directories", () => {
    expect(evaluateSymlinkHealth({ isPrimary: false, items: [] })).toEqual([]);
  });
});

const endpoint: ApiEndpoint = {
  baseUrl: "http://gpu-box:30000",
  authScheme: "bearer",
  secret: { source: "keychain" },
};

const apiProfile: Profile = {
  tool: "claude",
  kind: "api",
  configDir: "/home/u/.claude-glm",
  email: "",
  label: "gpu-box:30000",
  api: endpoint,
};

/** The healthy case, with one thing changed per test. */
function health(overrides: Partial<ApiHealthInput> = {}): ReturnType<typeof evaluateApiHealth> {
  return evaluateApiHealth({ id: "claude:glm", profile: apiProfile, secret: { ok: true }, ...overrides });
}

const withApi = (baseUrl: string): Profile => ({ ...apiProfile, api: { ...endpoint, baseUrl } });

describe("evaluateApiHealth", () => {
  it("is silent for a healthy API profile", () => {
    expect(health()).toEqual([]);
  });

  it("says nothing at all about a subscription profile", () => {
    // Every input here is broken. A profile with no `kind` is a subscription, and the
    // whole point of this function is that such a profile's report is what it always was.
    const subscription: Profile = { tool: "claude", configDir: "/home/u/.claude-work", email: "a@b.c" };
    expect(
      evaluateApiHealth({
        id: "claude:work",
        profile: { ...subscription, env: { ANTHROPIC_API_KEY: "sk-x" } },
        secret: { ok: false, error: "no stored secret" },
        settings: { apiKeyHelper: "op read op://vault/key" },
        credentialEnvKeys: ["ANTHROPIC_API_KEY"],
      }),
    ).toEqual([]);
  });

  describe("the key source", () => {
    it("reports a credential that does not resolve", () => {
      const issues = health({ secret: { ok: false, error: "no stored secret for 'claude:glm'" } });

      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe("missing_api_secret");
      expect(issues[0].message).toMatch(/no stored secret for 'claude:glm'/);
    });

    it("keeps the store's own remedy rather than adding a second one", () => {
      // resolveSecret already ends "no stored secret" with the command that fixes it.
      // Appending another copy produced `... --key' - run 'clausona config <profile> --key'`.
      const error = "no stored secret for 'claude:glm' - run 'clausona config claude:glm --key'";
      const message = health({ secret: { ok: false, error } })[0].message;

      expect(message.match(/--key/g)).toHaveLength(1);
      expect(message).toContain("clausona config claude:glm --key");
    });

    it("does not tell a user with a corrupt store to store another key", () => {
      // A secrets.json that cannot be parsed is not "no secret stored": `config --key`
      // reads the same file before writing it, so it would fail the same way.
      const error = "~/.clausona/secrets.json is not valid JSON - fix or remove it";
      const message = health({ secret: { ok: false, error } })[0].message;

      expect(message).toContain("not valid JSON");
      expect(message).not.toContain("--key");
    });

    it("names the variable, not a value, when an env source is unset", () => {
      const message = health({ secret: { ok: false, error: "environment variable GLM_KEY is unset or empty" } })[0]
        .message;

      expect(message).toContain("GLM_KEY");
    });

    it("stays silent about the key when there is no endpoint to resolve one for", () => {
      const issues = evaluateApiHealth({ id: "claude:glm", profile: { ...apiProfile, api: undefined } });

      expect(issues.map((issue) => issue.kind)).toEqual(["invalid_api_config"]);
    });
  });

  describe("the endpoint", () => {
    it("reports a missing base URL", () => {
      const issues = health({ profile: withApi("") });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("no base URL");
    });

    it("reports a malformed base URL", () => {
      const issues = health({ profile: withApi("gpu-box:30000") });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("gpu-box:30000");
    });

    it("reports a scheme the tool cannot call", () => {
      const issues = health({ profile: withApi("ftp://gpu-box/api") });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("http");
    });

    it("reports credentials in the base URL without printing them", () => {
      const issues = health({ profile: withApi("https://admin-name:sk-in-the-url@gpu-box/api") });

      expect(issues[0].kind).toBe("invalid_api_config");
      // The password is a credential like any other: naming the problem must not repeat it.
      expect(issues[0].message).not.toContain("sk-in-the-url");
      expect(issues[0].message).not.toContain("admin-name");
    });

    it("points at the file that holds the endpoint, since no command edits it", () => {
      // `config --edit` edits the env map; nothing in the CLI rewrites api.baseUrl.
      expect(health({ profile: withApi("") })[0].message).toContain("profiles.json");
    });

    it("flags every base URL that add --api would have refused", async () => {
      // doctor cannot import parseBaseUrl (core must not reach into lib), so the two
      // rule sets are checked against each other instead of drifting apart silently.
      const { parseBaseUrl } = await import("../lib/service.js");
      const refused = ["", "gpu-box:30000", "ftp://gpu-box/api", "https://u:p@gpu-box/api", "/api/v1"];

      for (const baseUrl of refused) {
        expect(() => parseBaseUrl(baseUrl), baseUrl).toThrow();
        expect(
          health({ profile: withApi(baseUrl) }).map((issue) => issue.kind),
          baseUrl,
        ).toContain("invalid_api_config");
      }
    });

    it("accepts the base URLs add --api accepts", async () => {
      const { parseBaseUrl } = await import("../lib/service.js");
      const accepted = ["http://gpu-box:30000", "https://openrouter.ai/api", "http://127.0.0.1:8080/v1"];

      for (const baseUrl of accepted) {
        expect(() => parseBaseUrl(baseUrl), baseUrl).not.toThrow();
        expect(health({ profile: withApi(baseUrl) }), baseUrl).toEqual([]);
      }
    });
  });

  describe("a key that reaches the endpoint by another route", () => {
    it("reports apiKeyHelper in the settings this profile reads", () => {
      const issues = health({
        settings: { apiKeyHelper: "op read op://vault/key" },
        settingsPath: "~/.claude-glm/settings.json",
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe("shared_api_key_helper");
      expect(issues[0].message).toContain("apiKeyHelper");
      expect(issues[0].message).toContain("~/.claude-glm/settings.json");
      // What it costs the user, not just that the key exists: the helper runs for this
      // profile too, and its key goes to this profile's endpoint.
      expect(issues[0].message).toContain("http://gpu-box:30000");
      expect(issues[0].message).toContain("shared with the primary");
    });

    it("does not repeat the helper command itself", () => {
      // A helper is `op read op://vault/item` or `cat ~/key`; the command line can name
      // the secret, and doctor has no reason to copy it into its own output.
      const issues = health({ settings: { apiKeyHelper: "cat ~/.secrets/anthropic-key" } });

      expect(issues[0].message).not.toContain("~/.secrets/anthropic-key");
    });

    it("ignores an absent, blank or non-string apiKeyHelper", () => {
      expect(health({ settings: {} })).toEqual([]);
      expect(health({ settings: { apiKeyHelper: "   " } })).toEqual([]);
      expect(health({ settings: { apiKeyHelper: false } })).toEqual([]);
    });

    it("reports a credential kept in the profile's plain-text env map", () => {
      const issues = health({
        profile: { ...apiProfile, env: { ANTHROPIC_MODEL: "glm-5", ANTHROPIC_API_KEY: "sk-plain" } },
        credentialEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      });

      expect(issues).toHaveLength(1);
      expect(issues[0].kind).toBe("plaintext_env_secret");
      expect(issues[0].message).toContain("ANTHROPIC_API_KEY");
      expect(issues[0].message).toContain("plain text");
      expect(issues[0].message).toContain("clausona config claude:glm --key");
      // The name is the finding; the value is the thing being warned about.
      expect(issues[0].message).not.toContain("sk-plain");
    });

    it("reports each credential name once, in a stable order", () => {
      const issues = health({
        profile: { ...apiProfile, env: { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" } },
        credentialEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      });

      expect(issues.map((issue) => issue.message.split(" ")[0])).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    });

    it("says nothing about an env map that holds no credential", () => {
      expect(
        health({
          profile: { ...apiProfile, env: { ANTHROPIC_MODEL: "glm-5" } },
          credentialEnvKeys: ["ANTHROPIC_API_KEY"],
        }),
      ).toEqual([]);
    });
  });

  it("reports every problem a profile has, worst configuration first", () => {
    const issues = health({
      profile: { ...withApi(""), env: { ANTHROPIC_API_KEY: "sk-plain" } },
      secret: { ok: false, error: "no stored secret" },
      settings: { apiKeyHelper: "op read op://vault/key" },
      credentialEnvKeys: ["ANTHROPIC_API_KEY"],
    });

    expect(issues.map((issue) => issue.kind)).toEqual([
      "invalid_api_config",
      "missing_api_secret",
      "shared_api_key_helper",
      "plaintext_env_secret",
    ]);
  });
});
