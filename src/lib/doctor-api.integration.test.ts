import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, SecretSource } from "../types.js";

/**
 * `clausona doctor` over a registry that holds API profiles, driven through the real
 * service against a real filesystem.
 *
 * The same three seams as src/lib/api-profile.integration.test.ts keep this off the
 * machine running it:
 *
 * - HOME, stubbed with the module graph re-imported, so ~/.clausona is a temp directory.
 * - `./secrets.js`, delegating to the real implementation with the "file" backend forced,
 *   so a stored key lands in the temp HOME and never in the login Keychain.
 * - `../core/process.js`, where every spawn throws and is recorded. `security` and
 *   `secret-tool` are reached only through the spawn helpers, so no test here can touch a
 *   real credential store even if the secrets mock were wrong. One test deliberately
 *   provokes a spawn - resolving a `command:` key source is a spawn - and clears the
 *   record itself.
 *
 * process.platform is forced too. Left alone, the Keychain probe for the subscription
 * profiles would spawn `security` on the developer's own machine.
 */

const temps: string[] = [];
let spawned: string[] = [];
const realPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./secrets.js");
  vi.doUnmock("../core/process.js");
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

type HarnessOptions = {
  platform?: NodeJS.Platform;
  /** Extra profiles written straight into profiles.json, as a hand-edited one would be. */
  profiles?: Record<string, unknown>;
  /** Contents of the primary's settings.json, which every profile shares. */
  settings?: Record<string, unknown>;
  /** Leave the primary out of the registry entirely. */
  withoutPrimary?: boolean;
};

async function harness(options: HarnessOptions = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-doctor-api-"));
  temps.push(home);

  // What an initialised install has: a primary that has been through onboarding and holds
  // a login, plus one directory for profiles to share.
  const primary = path.join(home, ".claude");
  mkdirSync(path.join(primary, "commands"), { recursive: true });
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  writeFileSync(path.join(primary, "settings.json"), JSON.stringify(options.settings ?? { theme: "dark" }));
  writeFileSync(path.join(primary, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "P" } }));
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "primary@example.com" } }),
  );

  const registryPath = path.join(home, ".clausona", "profiles.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 2,
      primarySources: { claude: primary },
      activeProfiles: { claude: "claude:default" },
      profiles: {
        ...(options.withoutPrimary
          ? {}
          : {
              "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
            }),
        ...options.profiles,
      },
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  Object.defineProperty(process, "platform", { value: options.platform ?? "linux", configurable: true });
  vi.resetModules();
  vi.doMock("../core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../core/process.js")>();
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return { ...actual, spawnCommand: refuse, spawnCommandSync: refuse };
  });
  vi.doMock("./secrets.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./secrets.js")>();
    return {
      ...actual,
      storeSecret: (id: string, value: string) => actual.storeSecret(id, value, "file"),
      deleteSecret: (id: string) => actual.deleteSecret(id, "file"),
      resolveSecret: (id: string, source: SecretSource) => actual.resolveSecret(id, source, "file"),
    };
  });
  const service = await import("./service.js");
  const secrets = await import("./secrets.js");
  const { renderDoctor } = await import("./format.js");
  const { stripAnsi } = await import("./cli-style.js");

  return {
    home,
    primary,
    service,
    secrets,
    /** Paths under the temp HOME are replaced with `~`, so output can be compared literally. */
    normalize: (text: string) => text.split(home).join("~"),
    doctor: () => service.doctorProfiles(),
    render: (results: DoctorProfileResult[]) => stripAnsi(renderDoctor(results)),
    /** The API profile every test starts from: one endpoint, one stored key. */
    addApi: (extra: Parameters<typeof service.addApiProfile>[0] extends infer T ? Partial<T> : never = {}) =>
      service.addApiProfile({
        tool: "claude",
        name: "glm",
        baseUrl: "http://gpu-box:30000",
        authScheme: "bearer",
        secret: { source: "keychain" },
        secretValue: STORED_KEY,
        ...extra,
      }),
  };
}

/** A value that must never appear in doctor's output, in any form. */
const STORED_KEY = "sk-live-DO-NOT-PRINT-0001";

function issuesFor(results: DoctorProfileResult[], name: string) {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues;
}

const kinds = (results: DoctorProfileResult[], name: string) => issuesFor(results, name).map((issue) => issue.kind);

describe("doctor on an API profile", () => {
  it("reports a healthy one as healthy", async () => {
    const h = await harness();
    await h.addApi();

    const results = await h.doctor();

    // Before this, every API profile was reported broken: it has no account JSON and no
    // Claude Code Keychain item, and it never will have either.
    expect(issuesFor(results, "claude:glm")).toEqual([]);
    expect(results.find((r) => r.name === "claude:glm")?.healthy).toBe(true);
  });

  it("titles the profile with its label, since it has no account email", async () => {
    const h = await harness();
    await h.addApi({ label: "gpu-box" });

    const results = await h.doctor();

    expect(results.find((r) => r.name === "claude:glm")?.email).toBe("gpu-box");
  });

  it("does not probe the Keychain for it on macOS", async () => {
    // Only the API profile is registered: any spawn at all here came from this profile,
    // and `security` is reached only through the mocked spawn helpers.
    const h = await harness({ platform: "darwin", withoutPrimary: true });
    await h.addApi();

    const results = await h.doctor();

    expect(spawned).toEqual([]);
    expect(kinds(results, "claude:glm")).toEqual([]);
  });

  it("reports a key that is no longer in the store", async () => {
    const h = await harness();
    await h.addApi();
    await h.secrets.deleteSecret("claude:glm");

    const issues = issuesFor(await h.doctor(), "claude:glm");

    expect(issues.map((i) => i.kind)).toEqual(["missing_api_secret"]);
    expect(issues[0].message).toContain("clausona config claude:glm --key");
  });

  it("reports a key source whose environment variable is unset", async () => {
    const h = await harness();
    await h.addApi({ secret: { source: "env", name: "GLM_KEY_UNSET" }, secretValue: undefined });

    const issues = issuesFor(await h.doctor(), "claude:glm");

    expect(issues.map((i) => i.kind)).toEqual(["missing_api_secret"]);
    expect(issues[0].message).toContain("GLM_KEY_UNSET");
  });

  it("is quiet when the environment variable is set", async () => {
    const h = await harness();
    await h.addApi({ secret: { source: "env", name: "GLM_KEY_SET" }, secretValue: undefined });
    vi.stubEnv("GLM_KEY_SET", STORED_KEY);

    expect(issuesFor(await h.doctor(), "claude:glm")).toEqual([]);
  });

  it("runs a command key source, because running it is the check", async () => {
    const h = await harness();
    await h.addApi({ secret: { source: "command", run: "op read op://vault/glm" }, secretValue: undefined });

    const issues = issuesFor(await h.doctor(), "claude:glm");

    // The spawn is the point: a command source is only healthy if the command works, and
    // there is no way to learn that without running it. Here the harness refuses it.
    expect(spawned).toEqual(["/bin/sh"]);
    spawned = [];
    expect(issues.map((i) => i.kind)).toEqual(["missing_api_secret"]);
  });

  it("reports an endpoint that was edited into profiles.json by hand", async () => {
    const h = await harness({
      profiles: {
        "claude:bad": {
          tool: "claude",
          kind: "api",
          configDir: path.join("/does-not-matter"),
          email: "",
          label: "bad",
          api: { baseUrl: "gpu-box:30000", authScheme: "bearer", secret: { source: "env", name: "SET_BELOW" } },
        },
      },
    });
    vi.stubEnv("SET_BELOW", STORED_KEY);

    const issues = issuesFor(await h.doctor(), "claude:bad");

    expect(issues.map((i) => i.kind)).toContain("invalid_api_config");
    expect(issues[0].message).toContain("profiles.json");
  });

  it("reports apiKeyHelper in the settings the profile shares with the primary", async () => {
    const h = await harness({ settings: { theme: "dark", apiKeyHelper: "op read op://vault/anthropic" } });
    await h.addApi();

    const results = await h.doctor();

    // settings.json is a shared link into the primary, so the helper Claude Code runs for
    // the primary runs for this profile too - and hands its key to a third-party endpoint.
    expect(kinds(results, "claude:glm")).toEqual(["shared_api_key_helper"]);
    expect(issuesFor(results, "claude:glm")[0].message).toContain("http://gpu-box:30000");
    // The primary is the profile the helper was written for. Nothing is wrong there.
    expect(kinds(results, "claude:default")).toEqual([]);
  });

  it("reports a credential parked in the profile's plain-text env map", async () => {
    const h = await harness();
    await h.addApi({ env: { ANTHROPIC_AUTH_TOKEN: "sk-in-the-registry-0002" } });

    const results = await h.doctor();

    expect(kinds(results, "claude:glm")).toEqual(["plaintext_env_secret"]);
    expect(issuesFor(results, "claude:glm")[0].message).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(JSON.stringify(results)).not.toContain("sk-in-the-registry-0002");
  });
});

describe("doctor and the key itself", () => {
  it("never puts the key in its output, however many other things are wrong", async () => {
    const h = await harness({ settings: { apiKeyHelper: "op read op://vault/anthropic" } });
    await h.addApi({ env: { ANTHROPIC_API_KEY: STORED_KEY } });

    const results = await h.doctor();
    const everything = `${JSON.stringify(results)}\n${h.render(results)}`;

    // doctor resolves the key only to learn whether it resolves. The value is read from
    // the store on every run and must not reach a message, a log, or --json.
    expect(everything).not.toContain(STORED_KEY);
    expect(everything).not.toContain(STORED_KEY.slice(0, 10));
    expect(kinds(results, "claude:glm")).toEqual(["shared_api_key_helper", "plaintext_env_secret"]);
  });
});

describe("doctor on a subscription-only registry", () => {
  /**
   * A registry with no API profile anywhere must produce exactly the report it produced
   * before API profiles existed - the same issues, in the same order, with the same words,
   * in both output forms. Both expectations below are literal for that reason.
   */
  async function subscriptionOnly() {
    const h = await harness({
      profiles: { "claude:work": { tool: "claude", configDir: "WORK_DIR", email: "work@example.com" } },
    });
    // The registry is rewritten with a real path now that the temp home is known.
    const registryPath = path.join(h.home, ".clausona", "profiles.json");
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const raw = readFileSync(registryPath, "utf8").replace("WORK_DIR", path.join(h.home, ".claude-work"));
    write(registryPath, raw);
    mkdirSync(path.join(h.home, ".claude-work"), { recursive: true });
    return h;
  }

  it("renders exactly what it always rendered", async () => {
    const h = await subscriptionOnly();

    const output = h.normalize(h.render(await h.doctor()));

    expect(output).toBe(
      [
        "",
        "",
        "  claude:default (primary@example.com)",
        "    ✔ healthy",
        "",
        "  claude:work (work@example.com)",
        "    ✘ 3 issues",
        "    ├─ .claude.json is missing or missing oauthAccount.emailAddress",
        "    ├─ .credentials.json is missing or has no access token - sign in from this profile",
        "    ╰─ commands/ is shared in primary but missing here — run 'clausona repair'",
        "       Run clausona repair claude:work to fix",
        "       Run clausona login claude:work to sign in",
        "",
        "",
      ].join("\n"),
    );
  });

  it("serialises exactly what it always serialised", async () => {
    const h = await subscriptionOnly();

    const json = h.normalize(JSON.stringify(await h.doctor(), null, 2));

    expect(JSON.parse(json)).toEqual([
      {
        name: "claude:default",
        email: "primary@example.com",
        configDir: "~/.claude",
        isPrimary: true,
        healthy: true,
        issues: [],
      },
      {
        name: "claude:work",
        email: "work@example.com",
        configDir: "~/.claude-work",
        isPrimary: false,
        healthy: false,
        issues: [
          { kind: "missing_json", message: ".claude.json is missing or missing oauthAccount.emailAddress" },
          {
            kind: "missing_oauth",
            message: ".credentials.json is missing or has no access token - sign in from this profile",
          },
          {
            kind: "missing_shared_link",
            message: "commands/ is shared in primary but missing here — run 'clausona repair'",
          },
        ],
      },
    ]);
    // No key the JSON does not already carry: the shape is pinned as well as the values.
    expect(json).not.toContain('kind": "api');
  });
});

describe("the report a mixed registry produces", () => {
  it("reads as one healthy account and one endpoint that needs attention", async () => {
    const h = await harness();
    await h.addApi({ label: "gpu-box" });
    await h.secrets.deleteSecret("claude:glm");

    const output = h.normalize(h.render(await h.doctor()));

    expect(output).toBe(
      [
        "",
        "",
        "  claude:default (primary@example.com)",
        "    ✔ healthy",
        "",
        "  claude:glm (gpu-box)",
        "    ✘ 1 issue",
        "    ╰─ API key unavailable: no stored secret for 'claude:glm' - run 'clausona config claude:glm --key'",
        "",
        "",
      ].join("\n"),
    );
    // Neither repair nor login can produce an API key, so neither is offered.
    expect(output).not.toContain("clausona repair");
    expect(output).not.toContain("clausona login");
  });
});
