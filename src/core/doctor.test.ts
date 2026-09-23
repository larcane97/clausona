import { describe, expect, it } from "vitest";
import { leakedWindows } from "../test-leaks.js";
import type { ApiEndpoint, Profile } from "../types.js";
import { type ApiHealthInput, countIssues, evaluateApiHealth, evaluateSymlinkHealth } from "./doctor.js";

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

      // A bare host:port parses as a URL whose scheme is the host, so this is the scheme
      // rule speaking. What it must not do is repeat the value back.
      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).not.toContain("gpu-box:30000");
    });

    // checkBaseUrl called `.trim()` on it, and the throw took every profile's report with it.
    it("reports a base URL a hand edit left as a number, rather than crashing", () => {
      const issues = health({ profile: withApi(8000 as unknown as string) });

      expect(issues.map((issue) => issue.kind)).toEqual(["invalid_api_config"]);
      expect(issues[0].message).toContain("not an absolute http:// or https:// URL");
      expect(issues[0].message).toContain("clausona config claude:glm --base-url <url>");
    });

    // `--set` refuses it now; one stored before, or by hand, still wins at launch.
    it("warns that an ANTHROPIC_BASE_URL in the env map overrides the endpoint shown", () => {
      const issues = health({
        profile: { ...apiProfile, env: { ANTHROPIC_BASE_URL: "http://elsewhere.example.com" } },
      });

      expect(issues.map((issue) => [issue.kind, issue.severity])).toEqual([["env_overrides_endpoint", "warning"]]);
      expect(issues[0].message).toContain("clausona config claude:glm --unset ANTHROPIC_BASE_URL");
      expect(issues[0].message).toContain("clausona config claude:glm --base-url <url>");
      expect(issues[0].message).not.toContain("elsewhere");
      // A miscased one is dropped at launch, with a warning of its own, so it overrides nothing.
      expect(
        health({ profile: { ...apiProfile, env: { anthropic_base_url: "http://elsewhere.example.com" } } }),
      ).toEqual([]);
    });

    // Parses with an empty host, and the "scheme" is the username: never quote any of it.
    it("reports scheme-less userinfo as credentials, quoting none of it", () => {
      const message = health({ profile: withApi("admin-name:pw-0040@gpu-box/api") })[0].message;

      expect(message).toContain("username or password");
      expect(message).not.toContain("admin-name");
      expect(message).not.toContain("pw-0040");
    });

    it("reports a scheme the tool cannot call", () => {
      const issues = health({ profile: withApi("ftp://gpu-box/api") });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("http");
    });

    it.each([
      ["a URL that is refused for its credentials", "https://admin-name:sk-in-the-url@gpu-box/api"],
      ["a URL refused for its scheme first", "ftp://admin-name:sk-in-the-url@gpu-box/api"],
      ["a URL that does not parse at all", "//admin-name:sk-in-the-url@gpu-box/api"],
      ["a URL refused for both", "gpu-box:30000?k=sk-in-the-url"],
    ])("reports %s without printing what it carries", (_label, baseUrl) => {
      const issues = health({ profile: withApi(baseUrl) });

      // A password in the URL is a credential like any other, and it is reported by
      // whichever branch rejects the URL first - so no branch may quote the URL back.
      // doctor --help promises the output is safe to paste into a bug report.
      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).not.toContain("sk-in-the-url");
      expect(issues[0].message).not.toContain("admin-name");
      expect(issues[0].message).not.toContain(baseUrl);
    });

    it("reports a base URL carrying a key as that, rather than as a username or password", () => {
      // Its own reason, so its own words: this used to fall through to the userinfo message,
      // which describes a URL with no user or password in it.
      const key = "sk-ant-api03-QZXJ7wvKpLmN8rTyUbHc5dFgA2sE9oIuWq";
      const issues = health({ profile: withApi(`https://gateway.example.com/v1?key=${key}`) });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("looks like an API key");
      expect(issues[0].message).not.toContain("username or password");
      expect(issues[0].message).not.toContain(key.slice(13, 25));
      // The way out comes first, and a check that is wrong about a URL is said to be survivable.
      expect(issues[0].message).toMatch(/^give the base URL without the key/);
      expect(issues[0].message).toContain("if none of it is one, the profile works as it is");
    });

    it("reports a query parameter named for a credential by its name, and never its value", () => {
      const issues = health({ profile: withApi("https://gateway.example.com/v1?token=f00d42") });

      expect(issues[0].kind).toBe("invalid_api_config");
      expect(issues[0].message).toContain("'token' parameter");
      expect(issues[0].message).not.toContain("f00d42");
    });

    it("points at the command that rewrites the endpoint, not at the file", () => {
      // A hand-edited profiles.json is how a base URL gets broken; `config --base-url`
      // rewrites it through the rule `add --api` applies.
      const message = health({ profile: withApi("") })[0].message;

      expect(message).toContain("clausona config claude:glm --base-url <url>");
      expect(message).not.toContain("profiles.json");
    });

    it("points at remove and add when there is no endpoint block for config to rewrite", () => {
      // `config --base-url` refuses a profile with no block: there is no key source to keep.
      const message = evaluateApiHealth({ id: "claude:glm", profile: { ...apiProfile, api: undefined } })[0].message;

      expect(message).toContain("clausona remove claude:glm");
      expect(message).toContain("clausona add <new-name> --api --base-url <url>");
      expect(message).not.toContain("clausona config claude:glm --base-url");
    });

    it("flags every base URL that add --api would have refused", async () => {
      // Both sides now read the same rule out of core/api-url.ts, so they cannot disagree
      // about what is valid - only about how to word it. This checks that end to end, and
      // would fail again the moment either side grew a private rule of its own.
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

    // With no `//`, whatever comes before the first colon parses as the scheme - and a gateway
    // token with no prefix, too short for the key-shape check, is exactly that. Every surface
    // that words the refusal says there is no http(s) scheme instead of quoting it.
    it("quotes no would-be scheme that could be a token, on any surface", async () => {
      const { parseBaseUrl } = await import("../lib/service.js");
      const { baseUrlError } = await import("../tui/api-form.js");
      const token = ["a3f9c2e1", "7b4d0e8f", "c61a5b2d", "9e0f4c7a"].join("");
      const baseUrl = `${token}:v1`;

      const messages = [
        (() => {
          try {
            parseBaseUrl(baseUrl);
            return "";
          } catch (error) {
            return (error as Error).message;
          }
        })(),
        baseUrlError(baseUrl) ?? "",
        ...health({ profile: withApi(baseUrl) }).map((issue) => issue.message),
      ];

      expect(
        messages.every((message) => /no http:\/\/ or https:\/\/ scheme/i.test(message)),
        messages.join("\n"),
      ).toBe(true);
      expect(leakedWindows(messages, token)).toEqual([]);
      // A real scheme is still named.
      expect(baseUrlError("ftp://gpu-box")).toContain("'ftp'");
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
        settingsShared: true,
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

    it("does not claim the settings are shared when they are the profile's own", () => {
      // The file may be a local override - which doctor reports separately - and saying it
      // is shared with the primary would be the one thing that is not true about it.
      const issues = health({ settings: { apiKeyHelper: "cat ~/key" }, settingsPath: "~/.claude-glm/settings.json" });

      expect(issues[0].kind).toBe("shared_api_key_helper");
      expect(issues[0].message).not.toContain("shared with the primary");
      expect(issues[0].message).toContain("runs for this profile");
    });

    it("reports settings it could not read instead of passing over them", () => {
      const issues = health({ settings: null, settingsPath: "~/.claude-glm/settings.json" });

      expect(issues.map((issue) => [issue.kind, issue.severity])).toEqual([["unreadable_settings", "warning"]]);
      expect(issues[0].message).toContain("apiKeyHelper");
      expect(issues[0].message).toContain("~/.claude-glm/settings.json");
    });

    it("warns about the helper whatever auth scheme the profile uses", () => {
      // The scheme decides which variable clausona sets, not whether the helper runs.
      const apiKey: Profile = { ...apiProfile, api: { ...endpoint, authScheme: "api-key" } };

      expect(health({ profile: apiKey, settings: { apiKeyHelper: "cat ~/key" } })[0].kind).toBe(
        "shared_api_key_helper",
      );
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

    // A key pasted where the name goes: `config --show` and launch already hide it, and
    // doctor's report is promised safe to paste.
    it("never prints a name shaped like an API key, and names --edit for it", () => {
      // Built from pieces, so no line of this file is a token a secret scanner would flag.
      const pat = [
        "github",
        "pat",
        "11ABCDEFG0Q8r3LmZ7pW2x",
        "Kd9fT4vYb6NcR1sHjU5wE8aG3mP0qLzXy7Bn2Vt4Rk9Fh6Ds1Wc3Ju",
      ].join("_");
      const dashed = ["sk", "ant", "api03", "F4NAMEq7Rw2Lp9XzT5vB8nC1"].join("-");
      const issues = health({
        profile: { ...apiProfile, env: { [pat]: "x", [dashed]: "y" } },
        secretEnvName: (key) => /(^|_)PAT(_|$)/i.test(key),
      });

      expect(issues.map((issue) => [issue.kind, issue.severity])).toEqual([
        ["plaintext_env_secret", "warning"],
        ["plaintext_env_secret", "warning"],
      ]);
      const report = JSON.stringify(issues);
      expect(leakedWindows([report], pat)).toEqual([]);
      expect(leakedWindows([report], dashed)).toEqual([]);
      for (const issue of issues) expect(issue.message).toContain("clausona config claude:glm --edit");
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
      configDirExists: false,
      secret: { ok: false, error: "no stored secret" },
      settings: { apiKeyHelper: "op read op://vault/key" },
      credentialEnvKeys: ["ANTHROPIC_API_KEY"],
    });

    expect(issues.map((issue) => issue.kind)).toEqual([
      "missing_config_dir",
      "invalid_api_config",
      "missing_api_secret",
      "shared_api_key_helper",
      "plaintext_env_secret",
    ]);
  });
});

describe("severity", () => {
  it("marks the two advisory findings as warnings", () => {
    const issues = health({
      profile: { ...apiProfile, env: { ANTHROPIC_API_KEY: "sk-plain" } },
      settings: { apiKeyHelper: "op read op://vault/key" },
      credentialEnvKeys: ["ANTHROPIC_API_KEY"],
    });

    // Both describe a profile that works. Reporting them as breakage would send a user to
    // repair or login for something neither command can change.
    expect(issues.map((issue) => [issue.kind, issue.severity])).toEqual([
      ["shared_api_key_helper", "warning"],
      ["plaintext_env_secret", "warning"],
    ]);
  });

  it("leaves the severity key off a finding that stops the profile working", () => {
    const issues = health({
      profile: withApi(""),
      configDirExists: false,
      secret: { ok: false, error: "no stored secret" },
    });

    // A missing config directory in particular: as a warning it would leave the profile
    // `healthy: true`, which is the bug the check was added to close.
    expect(issues.map((issue) => issue.kind)).toEqual([
      "missing_config_dir",
      "invalid_api_config",
      "missing_api_secret",
    ]);
    // Absent, not "error": a key that is never written cannot change the JSON a registry
    // without warnings produces.
    for (const issue of issues) expect(Object.hasOwn(issue, "severity"), issue.kind).toBe(false);
  });
});

describe("countIssues", () => {
  it("reads a missing severity as an error", () => {
    expect(countIssues([{ kind: "broken_symlink", message: "x" }])).toEqual({ errors: 1, warnings: 0 });
  });

  it("counts the two apart", () => {
    expect(
      countIssues([
        { kind: "broken_symlink", message: "x" },
        { kind: "plaintext_env_secret", message: "y", severity: "warning" },
        { kind: "shared_api_key_helper", message: "z", severity: "warning" },
      ]),
    ).toEqual({ errors: 1, warnings: 2 });
  });

  it("counts nothing as nothing", () => {
    expect(countIssues([])).toEqual({ errors: 0, warnings: 0 });
  });
});
