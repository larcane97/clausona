import { describe, expect, it } from "vitest";

import { HIDDEN, redactBaseUrl, redactUrlsIn } from "../core/api-url.js";
import { CLAUDE_ENV_CATALOG } from "../tools/claude-env-catalog.js";
import type { Profile, SecretSource } from "../types.js";
import { CREDENTIAL_ENV_KEYS, isSecretEnvName } from "./profile-env.js";
import { describeSecretSource, hiddenEnvKeys, redactEnv, redactProfile, redactSecretSource } from "./redact.js";

/**
 * The rules, one case per branch. src/output-redaction.test.tsx runs every output path over
 * a registry holding all of these at once; this file is where each rule is pinned on its own,
 * so a failure there points at the branch that broke.
 */

describe("redactBaseUrl", () => {
  it.each([
    ["an ordinary URL", "https://openrouter.ai/api"],
    ["a URL with no path, which must not gain a trailing slash", "http://localhost:8000"],
    ["a URL with a port and a path", "http://127.0.0.1:8080/v1"],
  ])("leaves %s exactly as stored", (_label, url) => {
    expect(redactBaseUrl(url)).toBe(url);
  });

  it.each([
    ["a username and password", "https://user:pw-0001@gw.example.com/api", `https://${HIDDEN}@gw.example.com/api`],
    [
      "a username alone, a token's usual place",
      "https://tok-0002@gw.example.com/api",
      `https://${HIDDEN}@gw.example.com/api`,
    ],
    ["a query", "https://gw.example.com/api?key=q-0003", `https://gw.example.com/api?${HIDDEN}`],
    ["a fragment", "https://gw.example.com/api#f-0004", `https://gw.example.com/api#${HIDDEN}`],
    [
      "all three",
      "https://u:p-0005@gw.example.com/api?key=q-0006#f-0007",
      `https://${HIDDEN}@gw.example.com/api?${HIDDEN}#${HIDDEN}`,
    ],
    ["userinfo under a scheme add refuses", "ftp://u:p-0008@gw.example.com/x", `ftp://${HIDDEN}@gw.example.com/x`],
    ["a query on a URL with no host", "gpu-box:30000?k=q-0009", `gpu-box:30000?${HIDDEN}`],
  ])("hides %s", (_label, url, expected) => {
    expect(redactBaseUrl(url)).toBe(expected);
  });

  // `admin:pw@host` parses - as an opaque URL whose "scheme" is the username and whose host
  // is empty - so the parser reports no userinfo. The scheme-less rule has to apply here too.
  it.each([
    ["userinfo with no scheme", "admin:pw-0027@gw.example.com", `${HIDDEN}@gw.example.com`],
    [
      "the same with a path and a query",
      "admin:pw-0028@gw.example.com/api?k=q-0029",
      `${HIDDEN}@gw.example.com/api?${HIDDEN}`,
    ],
    ["a token with an empty password", "sk-ant-api03-t-0030:@gw.example.com", `${HIDDEN}@gw.example.com`],
  ])("hides %s in a base URL", (_label, url, expected) => {
    expect(redactBaseUrl(url)).toBe(expected);
  });

  // A URL that does not parse cannot be taken apart, and it can still hold a password:
  // `//admin:pw@host` is one. So none of it is printed.
  it("hides a URL that does not parse, whole", () => {
    expect(redactBaseUrl("//admin:pw-0010@gw.example.com/api")).toBe(HIDDEN);
  });

  it.each([
    ["in its path", "https://gw.example.com/v1/sk-ant-api03-QZXJ7wvKpLmN8rTyUbHc5dFgA2sE9oIuWq"],
    ["glued to its host", "https://gw.example.comsk-ant-api03-QZXJ7wvKpLmN8rTyUbHc5dFgA2sE9oIuWq"],
  ])("hides a URL carrying a key %s, whole", (_where, url) => {
    // Host and path are the parts printed as they are, so a key there has no part of its own
    // to be replaced in. add and config refuse such a URL now; this is for one stored before.
    expect(redactBaseUrl(url)).toBe(HIDDEN);
  });

  it("leaves an empty one empty, so a missing URL still reads as missing", () => {
    expect(redactBaseUrl("")).toBe("");
  });

  it("hides something that is not a string at all, which only a hand edit produces", () => {
    expect(redactBaseUrl(42 as unknown as string)).toBe(HIDDEN);
  });
});

describe("redactUrlsIn (a value in the env map)", () => {
  it.each([
    ["a number", "262144"],
    ["a model id", "z-ai/glm-5.3"],
    ["an ARN, which parses as a URL but has nothing to hide", "arn:aws:bedrock:us-east-1:123456789012:x"],
    ["a proxy URL with no userinfo", "http://proxy.example.com:8080"],
    ["an email address, which is not userinfo", "me@example.com"],
    ["a query on something that is not a URL with a host", "foo:bar?x=1"],
  ])("leaves %s alone", (_label, value) => {
    expect(redactUrlsIn(value)).toBe(value);
  });

  it.each([
    [
      "a proxy URL's userinfo",
      "http://user:pw-0011@proxy.example.com:8080",
      `http://${HIDDEN}@proxy.example.com:8080/`,
    ],
    [
      "userinfo with no scheme, as proxies accept it",
      "user:pw-0012@proxy.example.com:1080",
      `${HIDDEN}@proxy.example.com:1080`,
    ],
    ["the same after a bare //", "//user:pw-0013@proxy.example.com", `${HIDDEN}@proxy.example.com`],
    ["a base URL's query", "https://gw.example.com/api?key=q-0014", `https://gw.example.com/api?${HIDDEN}`],
    // The forms a password takes that a narrower pattern stopped short of.
    ["a / in a scheme-less password", "u:pw/0031@proxy.example.com:1080", `${HIDDEN}@proxy.example.com:1080`],
    ["a ? in a scheme-less password", "u:pw?0032@proxy.example.com", `${HIDDEN}@proxy.example.com`],
    ["a # in a scheme-less password", "u:pw#0033@proxy.example.com", `${HIDDEN}@proxy.example.com`],
    ["an @ in a scheme-less password", "u:pw@0034@proxy.example.com", `${HIDDEN}@proxy.example.com`],
    ["an empty username", ":pw-0035@proxy.example.com:6379", `${HIDDEN}@proxy.example.com:6379`],
    ["a leading space", " u:pw-0036@proxy.example.com", ` ${HIDDEN}@proxy.example.com`],
    [
      "a URL after other words",
      "--proxy http://u:pw-0037@proxy.example.com",
      `--proxy http://${HIDDEN}@proxy.example.com`,
    ],
    [
      "an @ in the password of a URL after other words",
      "x http://u:pw@0038@proxy.example.com",
      `x http://${HIDDEN}@proxy.example.com`,
    ],
    ["userinfo on a second line", "first\nu:pw-0039@proxy.example.com", `first\n${HIDDEN}@proxy.example.com`],
  ])("hides %s", (_label, value, expected) => {
    expect(redactUrlsIn(value)).toBe(expected);
  });
});

describe("redactEnv", () => {
  it("hides a credential name's value whole", () => {
    expect(redactEnv({ ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer h-0015" })).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: HIDDEN,
    });
  });

  // validateEnvEntry never echoes a json entry for the same reason: it is where a gateway's
  // auth field goes.
  it("hides a json setting's value whole", () => {
    expect(redactEnv({ CLAUDE_CODE_EXTRA_BODY: '{"api_key":"b-0016"}' })).toEqual({ CLAUDE_CODE_EXTRA_BODY: HIDDEN });
  });

  it("hides only the userinfo in any other value", () => {
    expect(redactEnv({ HTTPS_PROXY: "http://u:p-0017@proxy.example.com:8080" })).toEqual({
      HTTPS_PROXY: `http://${HIDDEN}@proxy.example.com:8080/`,
    });
  });

  it("leaves an ordinary setting as it is", () => {
    expect(redactEnv({ ANTHROPIC_MODEL: "z-ai/glm-5.3", API_TIMEOUT_MS: "600000" })).toEqual({
      ANTHROPIC_MODEL: "z-ai/glm-5.3",
      API_TIMEOUT_MS: "600000",
    });
  });

  it("hides a value that is not a string, which only a hand edit produces", () => {
    expect(redactEnv({ API_TIMEOUT_MS: { nested: "n-0018" } as unknown as string })).toEqual({
      API_TIMEOUT_MS: HIDDEN,
    });
  });

  // A hand edit can leave a key where a name belongs; printed as a name, it is the key.
  it("hides a name shaped like an API key, and its value, wherever it names one", () => {
    // Built from pieces, so no line of this file is a token a secret scanner would flag.
    const name = ["sk", "ant", "api03", "F4NAMEq7Rw2Lp9Xz"].join("-");

    expect(redactEnv({ [name]: "1", ANTHROPIC_MODEL: "m" })).toEqual({ [HIDDEN]: HIDDEN, ANTHROPIC_MODEL: "m" });
    expect(hiddenEnvKeys({ [name]: "1", ANTHROPIC_MODEL: "m" })).toEqual([HIDDEN]);
  });

  it("names the keys it hid whole, and only those", () => {
    expect(
      hiddenEnvKeys({
        ANTHROPIC_MODEL: "m",
        CLAUDE_CODE_EXTRA_BODY: "{}",
        HTTPS_PROXY: "http://u:p@proxy",
        ANTHROPIC_AUTH_TOKEN: "t",
      }),
    ).toEqual(["CLAUDE_CODE_EXTRA_BODY", "ANTHROPIC_AUTH_TOKEN"]);
  });
});

/**
 * The redact list is not the clear list. CREDENTIAL_ENV_KEYS is what an API profile's launch
 * CLEARS - the variables Claude Code takes an Anthropic credential from - and it has to stay
 * exactly that, or launch changes. What is HIDDEN on the way out is wider: any name that
 * says its value is a secret, so another service's token set through `config --set` does not
 * print on every path.
 */
describe("which names are hidden", () => {
  it.each([
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ])("hides %s, which is on no clear list", (key) => {
    expect(isSecretEnvName(key)).toBe(true);
    expect(redactEnv({ [key]: "v-0026" })).toEqual({ [key]: HIDDEN });
  });

  // One name per word, and each name carries no other word, so every word is pinned on its
  // own: AWS_SECRET_ACCESS_KEY alone would let either SECRET or ACCESS_KEY go unnoticed.
  it.each([
    ["TOKEN", "GITHUB_TOKEN"],
    ["SECRET", "JWT_SECRET"],
    ["PASSPHRASE", "GPG_PASSPHRASE"],
    ["API_KEY", "DD_API_KEY"],
    ["ACCESS_KEY", "MINIO_ACCESS_KEY"],
    ["HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"],
    ["CREDENTIAL", "GIT_CREDENTIAL"],
    ["PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY"],
    ["MASTER_KEY", "LITELLM_MASTER_KEY"],
    ["SIGNING_KEY", "WEBHOOK_SIGNING_KEY"],
    ["ENCRYPTION_KEY", "DB_ENCRYPTION_KEY"],
    ["SESSION_KEY", "SESSION_KEY"],
    ["LICENSE_KEY", "NEW_RELIC_LICENSE_KEY"],
    ["STORAGE_KEY", "AZURE_STORAGE_KEY"],
    ["APP_KEY", "DD_APP_KEY"],
    ["CONNECTION_STRING", "AZURE_STORAGE_CONNECTION_STRING"],
    ["PAT", "AZURE_DEVOPS_EXT_PAT"],
    ["PWD", "MYSQL_PWD"],
    ["COOKIE", "SESSION_COOKIE"],
    ["PASSWORD, with no underscore before it", "PGPASSWORD"],
    ["a word in lowercase", "github_token"],
  ])("hides a name for %s: %s", (_word, key) => {
    expect(isSecretEnvName(key)).toBe(true);
  });

  // A count of tokens is not a token, a path is not a PAT, and a bare KEY is a key file's
  // path as often as a key.
  it.each([
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "MAX_THINKING_TOKENS",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "NO_PROXY",
    "CLAUDE_CODE_GIT_BASH_PATH",
    "CLAUDE_CODE_CLIENT_KEY",
  ])("leaves %s visible", (key) => {
    expect(isSecretEnvName(key)).toBe(false);
  });

  it("hides no catalog setting except the one that is a credential", () => {
    const hidden = CLAUDE_ENV_CATALOG.map((entry) => entry.key).filter((key) => isSecretEnvName(key));

    expect(hidden).toEqual(["ANTHROPIC_CUSTOM_HEADERS"]);
  });

  it("still hides every name on the clear list", () => {
    for (const key of CREDENTIAL_ENV_KEYS) expect(isSecretEnvName(key), key).toBe(true);
  });

  // Pinned because launch reads it: a name added here would be unset for every API profile.
  it("leaves the clear list exactly as it was", () => {
    expect([...CREDENTIAL_ENV_KEYS]).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
      "ANTHROPIC_IDENTITY_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      "CLAUDE_CODE_HOST_CREDS_FILE",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
      "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
    ]);
  });
});

describe("a key source", () => {
  const cases: [string, SecretSource, SecretSource, string][] = [
    ["keychain", { source: "keychain" }, { source: "keychain" }, "keychain"],
    ["an env variable, by name", { source: "env", name: "GW_KEY" }, { source: "env", name: "GW_KEY" }, "env:GW_KEY"],
    // checkSecretSource refuses anything but a name on the way in; a hand edit is how a
    // key gets into this slot, and the name is the one thing that would print it.
    [
      "an env variable whose name is not a name",
      { source: "env", name: "sk-e-0019" },
      { source: "env", name: HIDDEN },
      `env:${HIDDEN}`,
    ],
    // The command line is hidden on every path, not only on screens: it can carry a vault
    // path, a token argument, or the key itself, and --json output goes into pipes and logs.
    ["a command", { source: "command", run: "echo c-0020" }, { source: "command", run: HIDDEN }, "command"],
  ];

  it.each(cases)("%s is reported without what it could carry", (_label, source, redacted, described) => {
    expect(redactSecretSource(source)).toEqual(redacted);
    expect(describeSecretSource(source)).toBe(described);
  });

  // Unknown rather than `<hidden>`: nothing is being withheld, clausona just cannot use it.
  it.each([
    ["a source clausona does not know", { source: "vault", path: "v-0021" }],
    ["no source at all", undefined],
  ])("reports %s as unknown, and nothing it carries", (_label, source) => {
    const unknown = source as unknown as SecretSource;

    expect(redactSecretSource(unknown)).toEqual({ source: "unknown" });
    expect(describeSecretSource(unknown)).toBe("unknown");
  });
});

describe("redactProfile", () => {
  const api: Profile = {
    tool: "claude",
    kind: "api",
    configDir: "/h/.claude-gw",
    email: "",
    label: "gw",
    mergeSessions: false,
    api: {
      baseUrl: "https://u:p-0022@gw.example.com/api",
      authScheme: "bearer",
      secret: { source: "command", run: "echo c-0023" },
    },
    env: { ANTHROPIC_AUTH_TOKEN: "t-0024", ANTHROPIC_MODEL: "m" },
  };

  it("keeps what a profile is, and hides what it could carry", () => {
    expect(redactProfile(api)).toEqual({
      tool: "claude",
      kind: "api",
      configDir: "/h/.claude-gw",
      email: "",
      label: "gw",
      mergeSessions: false,
      api: {
        baseUrl: `https://${HIDDEN}@gw.example.com/api`,
        authScheme: "bearer",
        secret: { source: "command", run: HIDDEN },
      },
      env: { ANTHROPIC_AUTH_TOKEN: HIDDEN, ANTHROPIC_MODEL: "m" },
    });
  });

  // Built from the fields it knows, not spread: a field someone added to profiles.json by
  // hand is not one clausona can vouch for.
  it("drops a field it has no name for", () => {
    const stray = { ...api, apiKey: "s-0025" } as Profile;

    expect(JSON.stringify(redactProfile(stray))).not.toContain("s-0025");
  });

  // A hand edit can leave the env map a list - the docker-compose habit - or a string.
  // Walked as an object, the first prints in full under key "0", the second one character
  // per key. It is not a map of settings, so none of it is printed.
  it.each([
    ["a list", ["ANTHROPIC_AUTH_TOKEN=l-0041"]],
    ["a string", "ANTHROPIC_AUTH_TOKEN=s-0042"],
    ["a number", 42],
  ])("hides an env map that is %s, whole", (_label, env) => {
    const shown = redactProfile({ ...api, env: env as unknown as Record<string, string> });

    expect(shown.env).toBe(HIDDEN);
  });

  it("leaves the profile it was given untouched", () => {
    const before = JSON.stringify(api);

    redactProfile(api);

    expect(JSON.stringify(api)).toBe(before);
  });

  it("gives a subscription profile no endpoint and no env map where it has none", () => {
    const subscription: Profile = { tool: "claude", configDir: "/h/.claude", email: "a@b.c", isPrimary: true };

    expect(redactProfile(subscription)).toEqual(subscription);
    expect(Object.keys(JSON.parse(JSON.stringify(redactProfile(subscription))))).not.toContain("api");
  });
});
