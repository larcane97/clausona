import { describe, expect, it } from "vitest";

import { isPosixEnvName } from "../core/shell.js";
import type { Profile } from "../types.js";
import {
  buildProfileEnv,
  CREDENTIAL_ENV_KEYS,
  controlledEnvKeys,
  displayName,
  RESERVED_ENV_KEYS,
  ROUTING_ENV_KEYS,
} from "./profile-env.js";

/** Written out rather than imported, so the constants are pinned rather than echoed. */
const CREDENTIALS = [
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
];
const ROUTING = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_CUSTOM_OAUTH_URL",
];
const except = (list: string[], ...keys: string[]) => list.filter((key) => !keys.includes(key));

const identityRealpath = async (p: string) => p;
const fakeSecret = async () => "sk-test";

function apiProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    tool: "claude",
    kind: "api",
    configDir: "/home/u/.claude-glm",
    email: "",
    label: "gpu-box",
    api: { baseUrl: "http://gpu-box:30000", authScheme: "bearer", secret: { source: "keychain" } },
    ...overrides,
  };
}

describe("displayName", () => {
  it("prefers the label when present", () => {
    expect(displayName({ email: "", label: "gpu-box" })).toBe("gpu-box");
  });

  it("falls back to the email", () => {
    expect(displayName({ email: "you@example.com" })).toBe("you@example.com");
  });
});

describe("buildProfileEnv", () => {
  // homedir is pinned so the tool's default config dir - and therefore the branch that
  // suppresses the config variable - is the same on every machine.
  const deps = { resolveSecret: fakeSecret, realpath: identityRealpath, homedir: () => "/home/u" };

  it("emits only CLAUDE_CONFIG_DIR for a subscription profile", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude-work", email: "you@example.com" };
    const { env, unset } = await buildProfileEnv("claude:work", profile, deps);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-work" });
    expect(unset).toEqual([]);
  });

  it("emits nothing for a primary profile", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude-main", email: "a@b.c", isPrimary: true };
    const { env } = await buildProfileEnv("claude:main", profile, deps);
    expect(env).toEqual({});
  });

  it("uses ANTHROPIC_AUTH_TOKEN for the bearer scheme", async () => {
    const { env } = await buildProfileEnv("claude:glm", apiProfile(), deps);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gpu-box:30000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("uses ANTHROPIC_API_KEY for the api-key scheme", async () => {
    const profile = apiProfile({
      api: { baseUrl: "https://api.anthropic.com", authScheme: "api-key", secret: { source: "keychain" } },
    });
    const { env } = await buildProfileEnv("claude:api", profile, deps);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("lets the env map override the API block but never CLAUDE_CONFIG_DIR", async () => {
    const profile = apiProfile({
      env: { ANTHROPIC_BASE_URL: "http://override:8080", ANTHROPIC_MODEL: "glm-5.3", CLAUDE_CONFIG_DIR: "/evil" },
    });
    const { env, warnings } = await buildProfileEnv("claude:glm", profile, deps);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://override:8080");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-glm");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("claude:glm");
    expect(warnings[0]).toContain("CLAUDE_CONFIG_DIR");
  });

  it("omits the config variable when a non-primary profile points at the tool default", async () => {
    const profile: Profile = { tool: "claude", configDir: "/home/u/.claude", email: "you@example.com" };
    const { env, warnings } = await buildProfileEnv("claude:default", profile, deps);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("warns and omits the credential when the secret cannot be resolved", async () => {
    const failing = async () => {
      throw new Error("no stored secret");
    };
    const { env, warnings } = await buildProfileEnv("claude:glm", apiProfile(), {
      resolveSecret: failing,
      realpath: identityRealpath,
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gpu-box:30000");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no stored secret/);
  });

  it("drops an env-map key that no shell could export, and says which", async () => {
    // A hand-edited profiles.json is the way this lands, and the POSIX renderer
    // interpolates keys bare - so the key has to die here rather than downstream.
    const hostile = "A; touch /tmp/clausona-pwned; B";
    const profile = apiProfile({
      env: { [hostile]: "x", "A $(id)": "x", "A B": "x", "A=B": "x", "9LEADING": "x", ANTHROPIC_MODEL: "glm-5.3" },
    });
    const { env, warnings } = await buildProfileEnv("claude:glm", profile, deps);

    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    for (const key of Object.keys(env)) expect(isPosixEnvName(key), key).toBe(true);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain("claude:glm");
    expect(warnings[0]).toContain(hostile);
    expect(warnings[0]).toMatch(/not a valid environment variable name/);
  });

  /**
   * Claude Code reads ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN independently and sends
   * X-Api-Key and Authorization together when both are set. Applying a profile on top of
   * the caller's environment is therefore not enough: a key the user exported for some
   * other purpose would travel to this profile's endpoint next to the profile's own. An
   * inherited provider switch would send the tool somewhere else entirely.
   */
  describe("unset", () => {
    it("clears every credential but the profile's own, and every routing variable, for bearer", async () => {
      const { env, unset } = await buildProfileEnv("claude:glm", apiProfile(), deps);
      expect(unset).toEqual([...except(CREDENTIALS, "ANTHROPIC_AUTH_TOKEN"), ...ROUTING]);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    });

    it("clears every credential but the profile's own, and every routing variable, for api-key", async () => {
      const profile = apiProfile({
        api: { baseUrl: "https://openrouter.ai/api", authScheme: "api-key", secret: { source: "keychain" } },
      });
      const { env, unset } = await buildProfileEnv("claude:or", profile, deps);
      expect(unset).toEqual([...except(CREDENTIALS, "ANTHROPIC_API_KEY"), ...ROUTING]);
      expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    });

    it("leaves alone anything the env map sets explicitly", async () => {
      const explicit = {
        ANTHROPIC_API_KEY: "sk-explicit",
        CLAUDE_CODE_OAUTH_TOKEN: "oat-explicit",
        ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/secrets/oidc",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_UNIX_SOCKET: "/run/proxy.sock",
      };
      const { env, unset } = await buildProfileEnv("claude:glm", apiProfile({ env: explicit }), deps);
      expect(env).toMatchObject(explicit);
      expect(unset).toEqual([
        ...except(CREDENTIALS, "ANTHROPIC_AUTH_TOKEN", ...Object.keys(explicit)),
        ...except(ROUTING, ...Object.keys(explicit)),
      ]);
    });

    // The profile's own variable is cleared too: an inherited one of the same name would
    // otherwise authenticate the tool against this endpoint with somebody else's key.
    for (const authScheme of ["bearer", "api-key"] as const) {
      it(`clears every credential variable when a ${authScheme} profile's key will not resolve`, async () => {
        const profile = apiProfile({
          api: { baseUrl: "https://openrouter.ai/api", authScheme, secret: { source: "keychain" } },
        });
        const { env, unset } = await buildProfileEnv("claude:glm", profile, {
          ...deps,
          resolveSecret: async () => {
            throw new Error("no stored secret");
          },
        });
        expect(unset).toEqual([...CREDENTIALS, ...ROUTING]);
        expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      });
    }

    it("clears nothing for any profile that is not an API profile", async () => {
      const profiles: Profile[] = [
        { tool: "claude", configDir: "/home/u/.claude-work", email: "you@example.com" },
        { tool: "claude", kind: "subscription", configDir: "/home/u/.claude-work", email: "you@example.com" },
        { tool: "claude", configDir: "/home/u/.claude", email: "a@b.c", isPrimary: true },
        { tool: "codex", configDir: "/home/u/.codex-work", email: "you@example.com" },
        // No endpoint to protect, so nothing to clear for it.
        { tool: "claude", kind: "api", configDir: "/home/u/.claude-glm", email: "", label: "half-written" },
      ];
      for (const profile of profiles) {
        const { unset } = await buildProfileEnv("claude:x", profile, deps);
        expect(unset, JSON.stringify(profile)).toEqual([]);
      }
    });

    it("never lists a variable it also sets", async () => {
      const profiles = [
        apiProfile(),
        apiProfile({ env: { ANTHROPIC_API_KEY: "sk-explicit", CLAUDE_CODE_USE_VERTEX: "1" } }),
        apiProfile({
          api: { baseUrl: "https://openrouter.ai/api", authScheme: "api-key", secret: { source: "keychain" } },
          env: { ANTHROPIC_AUTH_TOKEN: "explicit", ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform" },
        }),
      ];
      for (const profile of profiles) {
        const { env, unset } = await buildProfileEnv("claude:glm", profile, deps);
        for (const key of unset) expect(env, key).not.toHaveProperty(key);
      }
    });
  });

  // Narrowing either list reopens, for whatever is dropped, what it exists to prevent.
  it("treats every variable Claude Code 2.1.278 takes a credential from as a credential", () => {
    expect([...CREDENTIAL_ENV_KEYS]).toEqual(CREDENTIALS);
    // OAuth client configuration carries no secret, and clearing it would only break login.
    for (const key of [
      "CLAUDE_CODE_OAUTH_SCOPES",
      "CLAUDE_CODE_OAUTH_CLIENT_ID",
      "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
    ]) {
      expect(CREDENTIAL_ENV_KEYS, key).not.toContain(key);
    }
  });

  it("treats every variable that routes Claude Code 2.1.278 away from the base URL as routing", () => {
    expect([...ROUTING_ENV_KEYS]).toEqual(ROUTING);
    // A USE_ flag that routes nothing is not one of them.
    expect(ROUTING_ENV_KEYS).not.toContain("CLAUDE_CODE_USE_POWERSHELL_TOOL");
  });

  /**
   * Windows treats environment names case-insensitively, so two names that differ only in
   * case are one variable there. PowerShell's ConvertFrom-Json refuses a JSON object holding
   * both, and the hook's catch then applies no profile at all - the tool runs on the default
   * account. So an env-map key that differs only in case from a name already in the output,
   * or from a name clausona sets or clears for an API profile, is dropped with a warning.
   */
  describe("case collisions in the env map", () => {
    const folded = (keys: string[]) => keys.map((key) => key.toUpperCase());

    it("drops a key that differs from an earlier one only in case", async () => {
      const profile: Profile = {
        tool: "claude",
        configDir: "/home/u/.claude-work",
        email: "you@example.com",
        env: { ANTHROPIC_MODEL: "first", anthropic_model: "second-secret-looking-value" },
      };
      const { env, warnings } = await buildProfileEnv("claude:work", profile, deps);
      expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-work", ANTHROPIC_MODEL: "first" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("anthropic_model");
      expect(warnings[0]).toContain("ANTHROPIC_MODEL");
      expect(warnings[0]).not.toContain("second-secret-looking-value");
    });

    it("drops any spelling of a variable clausona owns", async () => {
      for (const profile of [
        { tool: "claude", configDir: "/home/u/.claude-work", email: "a@b.c", env: { claude_config_dir: "/evil" } },
        { ...apiProfile(), env: { Claude_Config_Dir: "/evil" } },
      ] as Profile[]) {
        const { env, warnings } = await buildProfileEnv("claude:x", profile, deps);
        expect(Object.values(env)).not.toContain("/evil");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/clausona sets it per profile/);
      }
    });

    it("drops a miscased name an API profile sets or clears, so the real one is still cleared", async () => {
      const profile = apiProfile({
        env: {
          anthropic_custom_headers: "X-Team: platform",
          anthropic_auth_token: "sk-lowercase",
          Anthropic_Base_Url: "http://elsewhere:1",
          claude_code_use_bedrock: "1",
          ANTHROPIC_MODEL: "glm-5.3",
        },
      });
      const { env, unset, warnings } = await buildProfileEnv("claude:glm", profile, deps);
      expect(env).toEqual({
        CLAUDE_CONFIG_DIR: "/home/u/.claude-glm",
        ANTHROPIC_BASE_URL: "http://gpu-box:30000",
        ANTHROPIC_AUTH_TOKEN: "sk-test",
        ANTHROPIC_MODEL: "glm-5.3",
      });
      expect(unset).toContain("ANTHROPIC_CUSTOM_HEADERS");
      expect(unset).toContain("CLAUDE_CODE_USE_BEDROCK");
      expect(warnings).toHaveLength(4);
      for (const warning of warnings) expect(warning).toMatch(/differs from [A-Z_]+ only in case/);
      expect(warnings.join("\n")).not.toContain("sk-lowercase");
    });

    // On POSIX those are distinct variables Claude Code never reads, and a subscription
    // profile clears nothing - so its output stays exactly what it was.
    it("keeps a subscription profile's miscased credential-like key", async () => {
      const profile: Profile = {
        tool: "claude",
        configDir: "/home/u/.claude-work",
        email: "you@example.com",
        env: { anthropic_api_key: "mine" },
      };
      const { env, unset, warnings } = await buildProfileEnv("claude:work", profile, deps);
      expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-work", anthropic_api_key: "mine" });
      expect(unset).toEqual([]);
      expect(warnings).toEqual([]);
    });

    /**
     * The invariant the whole scheme rests on, over every shape that could break it: each
     * case variant of each name an API profile sets or clears, put in through the env map,
     * on both schemes, with the key resolving and failing. The variant is dropped before
     * `unset` is computed, so nothing cleared is another spelling of something set - and
     * the real name is still cleared, so dropping the variant never reopens the leak.
     */
    it("never clears a name that is another spelling of one it sets, and still clears the real one", async () => {
      const variants = (name: string) => [
        name.toLowerCase(),
        name
          .toLowerCase()
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("_"),
      ];
      const failing = async () => {
        throw new Error("no stored secret");
      };
      let checked = 0;
      for (const authScheme of ["bearer", "api-key"] as const) {
        const ownVar = authScheme === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
        for (const resolves of [true, false]) {
          for (const managed of ["ANTHROPIC_BASE_URL", ...CREDENTIALS, ...ROUTING]) {
            for (const variant of variants(managed)) {
              const profile = apiProfile({
                api: { baseUrl: "https://openrouter.ai/api", authScheme, secret: { source: "keychain" } },
                env: { [variant]: "value-that-must-not-leak" },
              });
              const { env, unset, warnings } = await buildProfileEnv("claude:glm", profile, {
                ...deps,
                ...(resolves ? {} : { resolveSecret: failing }),
              });
              const label = `${authScheme} ${resolves ? "resolved" : "failing"} ${variant}`;

              const setNames = new Set(Object.keys(env).map((key) => key.toUpperCase()));
              expect(
                unset.filter((key) => setNames.has(key.toUpperCase())),
                label,
              ).toEqual([]);
              expect(env, label).not.toHaveProperty(variant);
              expect(
                warnings.filter((w) => w.includes(`'${variant}'`)),
                label,
              ).toHaveLength(1);
              expect(warnings.join("\n"), label).not.toContain("value-that-must-not-leak");
              // The real name is where it belongs: set by the profile, or cleared.
              if (managed === "ANTHROPIC_BASE_URL" || (managed === ownVar && resolves)) {
                expect(env, label).toHaveProperty(managed);
              } else {
                expect(unset, label).toContain(managed);
              }
              checked++;
            }
          }
        }
      }
      expect(checked).toBe(2 * 2 * (1 + CREDENTIALS.length + ROUTING.length) * 2);
    });

    it("never produces two names, set or cleared, that are one variable on Windows", async () => {
      const profiles: Profile[] = [
        apiProfile({ env: { anthropic_custom_headers: "x", ANTHROPIC_MODEL: "a", anthropic_model: "b" } }),
        apiProfile({
          api: { baseUrl: "https://openrouter.ai/api", authScheme: "api-key", secret: { source: "keychain" } },
          env: { anthropic_api_key: "x", Claude_Code_Oauth_Token: "y", anthropic_unix_socket: "/s" },
        }),
        { tool: "claude", configDir: "/home/u/.claude-work", email: "a@b.c", env: { FOO: "1", foo: "2", Foo: "3" } },
      ];
      for (const profile of profiles) {
        const { env, unset } = await buildProfileEnv("claude:glm", profile, deps);
        const names = folded([...Object.keys(env), ...unset]);
        expect(new Set(names).size, JSON.stringify(profile.env)).toBe(names.length);
      }
    });
  });

  /**
   * On POSIX a name the profile cannot export is as bad as one it cannot unset: the run
   * would half apply. So the renderer is given the names it sets as well as the ones it
   * clears, and refuses to launch when any of them is stuck.
   */
  describe("controlledEnvKeys", () => {
    it("covers what an API profile clears and everything it sets", async () => {
      const profile = apiProfile({ env: { ANTHROPIC_MODEL: "glm-5.3", ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform" } });
      const built = await buildProfileEnv("claude:glm", profile, deps);

      const controlled = controlledEnvKeys(profile, built);

      expect(controlled).toEqual([...built.unset, ...Object.keys(built.env)]);
      // An entry of the user's own is in there too: a stuck one drops every later export.
      expect(controlled).toContain("ANTHROPIC_MODEL");
      expect(new Set(controlled).size).toBe(controlled.length);
    });

    it("still covers the profile's own credential name when the key will not resolve", async () => {
      const profile = apiProfile();
      const built = await buildProfileEnv("claude:glm", profile, {
        ...deps,
        resolveSecret: async () => {
          throw new Error("no stored secret");
        },
      });

      // Cleared rather than set, but controlled either way.
      expect(controlledEnvKeys(profile, built)).toContain("ANTHROPIC_AUTH_TOKEN");
    });

    it("is empty for every profile that is not an API profile", async () => {
      for (const profile of [
        { tool: "claude", configDir: "/home/u/.claude-work", email: "a@b.c" },
        { tool: "claude", kind: "subscription", configDir: "/home/u/.claude-work", email: "a@b.c" },
        { tool: "claude", configDir: "/home/u/.claude", email: "a@b.c", isPrimary: true },
        { tool: "claude", kind: "api", configDir: "/home/u/.claude-glm", email: "", label: "half-written" },
      ] as Profile[]) {
        const built = await buildProfileEnv("claude:x", profile, deps);
        expect(controlledEnvKeys(profile, built), JSON.stringify(profile)).toEqual([]);
      }
    });
  });

  it("reserves the tool config variables", () => {
    expect(RESERVED_ENV_KEYS.has("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(RESERVED_ENV_KEYS.has("CODEX_HOME")).toBe(true);
  });
});
