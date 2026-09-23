import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi } from "./lib/cli-style.js";
import type { DoctorProfileResult, Profile, SecretSource } from "./types.js";

/**
 * The CLI surface for API profiles: `add --api`, and `config` for a profile's advanced
 * settings and its credential. These are the commands a person - or an agent asked to
 * "set up clausona against endpoint X" - actually types, so they are driven end to end
 * through `runCommand` against a real filesystem.
 *
 * Four seams keep this off the machine running it:
 *
 * - HOME, stubbed and the module graph re-imported, as in src/commands.shell-env.test.ts.
 * - `./lib/secrets.js`, delegating to the real implementation with the "file" backend
 *   forced, so a stored key lands in the temp HOME and never in the login Keychain.
 * - `./core/process.js`, where every spawn throws and is recorded; `afterEach` fails the
 *   test if one happened. `security` is reached only through the spawn helpers, so the
 *   Keychain is unreachable from here even if the secrets mock were wrong. The one
 *   exception is `--edit`, which installs a stand-in editor for the length of one test.
 * - `./lib/prompt-secret.js`, which answers from a queue instead of reading a terminal.
 *   The prompt itself is tested in src/lib/prompt-secret.test.ts.
 */

const KEY = "sk-fake-9xQZ-0001";
/**
 * A key the endpoint rule recognises. KEY above is short enough to be deliberately below it -
 * most tests here are about where a key goes, not about spotting one.
 */
const KEY_SHAPED = "sk-ant-api03-QZXJ7wvKpLmN8rTyUbHc5dFgA2sE9oIuWq";

const temps: string[] = [];
let spawned: string[] = [];
let promptAnswers: string[] = [];
let promptCalls: string[] = [];
let editor: ((argv: string[]) => SpawnSyncReturns<string>) | null = null;
const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./core/process.js");
  vi.doUnmock("./lib/secrets.js");
  vi.doUnmock("./lib/prompt-secret.js");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  promptAnswers = [];
  promptCalls = [];
  editor = null;
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

const API_PROFILE = {
  tool: "claude",
  kind: "api",
  email: "",
  label: "openrouter.ai",
  mergeSessions: false,
  api: { baseUrl: "https://openrouter.ai/api", authScheme: "bearer", secret: { source: "keychain" } },
  env: { ANTHROPIC_MODEL: "z-ai/glm-5.3" },
};

async function harness(extraProfiles: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-cli-api-"));
  temps.push(home);

  const primary = path.join(home, ".claude");
  mkdirSync(path.join(primary, "commands"), { recursive: true });
  writeFileSync(path.join(primary, "settings.json"), '{"theme":"dark"}');
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.0",
      oauthAccount: { emailAddress: "primary@example.com" },
    }),
  );
  mkdirSync(path.join(home, ".clausona"), { recursive: true });

  // Any profile the caller asked for that names a config dir gets the directory too.
  const profiles: Record<string, unknown> = {
    "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
  };
  for (const [id, profile] of Object.entries(extraProfiles)) {
    const name = id.split(":").slice(1).join(":");
    const configDir = path.join(home, `.claude-${name}`);
    mkdirSync(configDir, { recursive: true });
    profiles[id] = { configDir, ...(profile as Record<string, unknown>) };
  }

  const registryPath = path.join(home, ".clausona", "profiles.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 2,
      primarySources: { claude: primary },
      activeProfiles: { claude: "claude:default" },
      profiles,
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // A real $EDITOR in the developer's environment must never be launched by these tests.
  vi.stubEnv("EDITOR", "");
  vi.stubEnv("VISUAL", "");
  vi.resetModules();

  vi.doMock("./core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/process.js")>();
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return {
      ...actual,
      spawnCommand: refuse,
      spawnCommandSync: (command: string, args: string[] = []) => {
        if (editor) return editor([command, ...args]);
        return refuse(command);
      },
    };
  });
  vi.doMock("./lib/secrets.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./lib/secrets.js")>();
    return {
      ...actual,
      storeSecret: (id: string, value: string) => actual.storeSecret(id, value, "file"),
      deleteSecret: (id: string) => actual.deleteSecret(id, "file"),
      resolveSecret: (id: string, source: SecretSource) => actual.resolveSecret(id, source, "file"),
    };
  });
  vi.doMock("./lib/prompt-secret.js", () => ({
    promptSecret: async (prompt: string) => {
      promptCalls.push(prompt);
      const next = promptAnswers.shift();
      if (next === undefined) throw new Error("test: the command asked for a key with no answer queued");
      return next;
    },
  }));

  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const { runCommand } = await import("./commands.js");
  const secretsPath = path.join(home, ".clausona", "secrets.json");

  return {
    home,
    run: (command: string, ...args: string[]) => runCommand(command, args),
    registryText: () => readFileSync(registryPath, "utf8"),
    registry: () => JSON.parse(readFileSync(registryPath, "utf8")) as { profiles: Record<string, Profile> },
    profile: (id: string) => JSON.parse(readFileSync(registryPath, "utf8")).profiles[id] as Profile,
    storedSecrets: (): Record<string, string> =>
      existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {},
    stderr: () => stderr.join(""),
  };
}

/** The message a rejected command produced. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the command to be rejected");
}

/**
 * Every `clausona …` command a piece of advice names, as argv for `runCommand`, in the
 * order it names them. Advice is tested by running what it says rather than by matching
 * its words: a warning that names a command which refuses the profile it is about reads
 * perfectly well.
 */
function advisedCommands(text: string): string[][] {
  const commands: string[][] = [];
  for (const match of stripAnsi(text).matchAll(/clausona ([^`'()\n]+)/g)) {
    commands.push(match[1].trim().split(/\s+/));
  }
  return commands;
}

describe("add --api", () => {
  it("creates an API profile and keeps the key out of profiles.json", async () => {
    const h = await harness();
    promptAnswers.push(KEY);

    const output = await h.run(
      "add",
      "claude:gw",
      "--api",
      "--base-url",
      "https://openrouter.ai/api",
      "--model",
      "z-ai/glm-5.3",
    );

    expect(h.profile("claude:gw")).toMatchObject({
      tool: "claude",
      kind: "api",
      label: "openrouter.ai",
      api: { baseUrl: "https://openrouter.ai/api", authScheme: "bearer", secret: { source: "keychain" } },
      env: { ANTHROPIC_MODEL: "z-ai/glm-5.3" },
    });
    expect(h.registryText()).not.toContain(KEY);
    expect(h.storedSecrets()).toEqual({ "claude:gw": KEY });
    expect(promptCalls).toEqual(["API key: "]);
    expect(output).toContain("openrouter.ai");
    expect(output).not.toContain(KEY);
  });

  it("takes --key-from env:NAME without asking for a key", async () => {
    const h = await harness();

    await h.run("add", "claude:gw", "--api", "--base-url", "https://openrouter.ai/api", "--key-from", "env:MY_KEY");

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "env", name: "MY_KEY" });
    expect(promptCalls).toEqual([]);
    expect(h.storedSecrets()).toEqual({});
  });

  it('takes --key-from command:"..." without asking for a key', async () => {
    const h = await harness();

    await h.run(
      "add",
      "claude:gw",
      "--api",
      "--base-url",
      "https://openrouter.ai/api",
      "--key-from",
      "command:pass show gw",
    );

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "command", run: "pass show gw" });
    expect(promptCalls).toEqual([]);
  });

  it("accepts the --flag=value spelling as well", async () => {
    const h = await harness();
    promptAnswers.push(KEY);

    await h.run("add", "claude:gw", "--api", "--base-url=https://openrouter.ai/api", "--label=Gateway");

    expect(h.profile("claude:gw").label).toBe("Gateway");
  });

  it("reads the profile name past an option's value", async () => {
    const h = await harness();
    promptAnswers.push(KEY);

    await h.run("add", "--base-url", "https://openrouter.ai/api", "claude:gw", "--api");

    expect(Object.keys(h.registry().profiles)).toContain("claude:gw");
  });

  describe("the default auth scheme", () => {
    const cases: [string, string, "bearer" | "api-key"][] = [
      ["Anthropic itself", "https://api.anthropic.com", "api-key"],
      ["the apex domain", "https://anthropic.com", "api-key"],
      ["a port on Anthropic's own host", "https://api.anthropic.com:8443", "api-key"],
      // The reason the match is exact rather than a suffix: this host is not Anthropic's.
      ["a look-alike domain", "https://evilanthropic.com", "bearer"],
      ["a subdomain of a look-alike", "https://api.evilanthropic.com", "bearer"],
      ["a gateway", "https://openrouter.ai/api", "bearer"],
      ["a local server", "http://localhost:8000", "bearer"],
    ];

    for (const [label, baseUrl, expected] of cases) {
      it(`is ${expected} for ${label}`, async () => {
        const h = await harness();
        promptAnswers.push(KEY);

        await h.run("add", "claude:gw", "--api", "--base-url", baseUrl);

        expect(h.profile("claude:gw").api?.authScheme).toBe(expected);
      });
    }

    it("gives way to an explicit --auth", async () => {
      const h = await harness();
      promptAnswers.push(KEY);

      await h.run("add", "claude:gw", "--api", "--base-url", "https://openrouter.ai/api", "--auth", "api-key");

      expect(h.profile("claude:gw").api?.authScheme).toBe("api-key");
    });
  });

  describe("rejections", () => {
    it("refuses --api together with --from", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--from", "/tmp/somewhere"));

      expect(message).toContain("--api and --from cannot be combined");
      expect(promptCalls).toEqual([]);
    });

    it("says what is missing when --base-url is left out", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api"));

      expect(message).toContain("--base-url <url>");
      expect(promptCalls).toEqual([]);
    });

    it("refuses an API option without --api rather than ignoring it", async () => {
      const h = await harness();

      for (const args of [
        ["--base-url", "https://openrouter.ai/api"],
        ["--model", "z-ai/glm-5.3"],
        ["--auth", "bearer"],
        ["--key-from", "env:MY_KEY"],
        ["--label", "Gateway"],
        ["--set", "API_TIMEOUT_MS=600000"],
      ]) {
        const message = await failure(h.run("add", "claude:gw", ...args));
        expect(message).toBe(`${args[0]} only applies to an API profile. Add --api, or leave it out.`);
      }
      expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
    });

    it("refuses an option given twice instead of quietly taking the first", async () => {
      const h = await harness();

      const message = await failure(
        h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--base-url", "http://localhost:9"),
      );

      expect(message).toBe("--base-url was given more than once. Pass it at most once.");
    });

    it("refuses --model and --set ANTHROPIC_MODEL in one call", async () => {
      const h = await harness();

      const message = await failure(
        h.run(
          "add",
          "claude:gw",
          "--api",
          "--base-url",
          "http://localhost:8000",
          "--model",
          "a",
          "--set",
          "ANTHROPIC_MODEL=b",
        ),
      );

      expect(message).toContain("--model sets");
    });

    it("checks an advanced setting before it asks for a key", async () => {
      const h = await harness();

      const message = await failure(
        h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--set", "API_TIMEOUT_MS=soon"),
      );

      expect(message).toBe("API_TIMEOUT_MS expects a whole number, got 'soon'");
      // A typed key would have been thrown away along with the command.
      expect(promptCalls).toEqual([]);
      expect(existsSync(path.join(h.home, ".claude-gw"))).toBe(false);
    });

    it("leaves the base-URL rule to the service, and applies it before the prompt", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", "localhost:8000"));

      // addApiProfile's own message, from its own exported function - not a second rule.
      expect(message).toBe("Invalid base URL: the scheme must be http or https, not 'localhost'.");
      // And it runs first, so a URL that was going to be refused costs no typed key.
      expect(promptCalls).toEqual([]);
    });

    it("refuses a base URL carrying credentials before the prompt too", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", "https://u:p@example.com"));

      expect(message).toContain("must not carry credentials");
      expect(message).not.toContain("u:p");
      expect(promptCalls).toEqual([]);
    });

    it.each([
      ["in the query", `https://gateway.example.com/v1?key=${KEY_SHAPED}`],
      ["glued to the host", `https://gateway.example.com${KEY_SHAPED}`],
    ])("refuses a base URL carrying a key %s, before the prompt, without printing it", async (_where, url) => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", url));

      expect(message).toBe(
        "Invalid base URL: it carries something shaped like an API key. Supply the key through the key source instead.",
      );
      expect(message).not.toContain(KEY_SHAPED.slice(13, 25));
      expect(promptCalls).toEqual([]);
      expect(existsSync(path.join(h.home, ".claude-gw"))).toBe(false);
    });

    it("refuses a bad profile name with the service's rule, before asking for a key", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:.hidden", "--api", "--base-url", "http://localhost:8000"));

      expect(message).toContain("Invalid profile name");
      expect(promptCalls).toEqual([]);
      expect(existsSync(path.join(h.home, ".claude-.hidden"))).toBe(false);
    });

    it("says nothing about the key when there is none", async () => {
      const h = await harness();
      promptAnswers.push("");

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000"));

      expect(message).toContain("No API key supplied");
      expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
    });
  });

  // A key pasted one option to the left of where it belongs is a plausible slip, and the
  // terminal - and its scrollback - is exactly where it must not end up.
  describe("a key passed where an option's value belongs", () => {
    const misplaced: [string, string[]][] = [
      ["--key-from", ["--key-from", KEY]],
      ["--auth", ["--auth", KEY]],
      ["--set", ["--set", KEY]],
    ];

    for (const [flag, args] of misplaced) {
      it(`never prints it back from ${flag}`, async () => {
        const h = await harness();

        const message = await failure(
          h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", ...args),
        );

        expect(message).not.toContain(KEY);
        expect(message.length).toBeGreaterThan(0);
        expect(promptCalls).toEqual([]);
      });
    }

    // `--key` and `--api` are boolean flags, so `--key=<key>` is not an option at all and
    // falls through to the unknown-option message, which used to quote the whole token.
    // The fix is in validateFlags, so it covers every flag there will ever be.
    const attached: [string, string[]][] = [
      ["config --key=", ["config", "claude:gw", `--key=${KEY}`]],
      ["add --key=", ["add", "claude:gw", "--api", "--base-url", "http://localhost:8000", `--key=${KEY}`]],
      ["a misspelled option", ["add", "claude:gw", "--api", `--base-urll=${KEY}`]],
    ];

    for (const [label, args] of attached) {
      it(`never prints it back from ${label}`, async () => {
        const h = await harness({ "claude:gw": API_PROFILE });

        const message = await failure(h.run(args[0], ...args.slice(1)));

        expect(message).not.toContain(KEY);
        expect(message).toContain("Unknown option: --");
        expect(message).not.toContain("=");
      });
    }

    it("never prints it back from config --unset", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const message = await failure(h.run("config", "claude:gw", "--unset", KEY));

      expect(message).not.toContain(KEY);
      expect(message).toContain("--unset");
    });
  });

  // A key in the positional slot would otherwise become a profile id in profiles.json, a
  // directory name under HOME, and a line of stdout - the one slip that puts a credential
  // in the file this feature promises never holds one.
  describe("a key passed where the profile name belongs", () => {
    it("refuses it on add, without creating anything or echoing it", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "--api", "--base-url", "http://localhost:8000", KEY));

      expect(message).not.toContain(KEY);
      expect(message).toContain("looks like an API key");
      expect(message).toContain("--key-from env:NAME");
      expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
      expect(existsSync(path.join(h.home, `.claude-${KEY}`))).toBe(false);
      expect(promptCalls).toEqual([]);
    });

    it("refuses it wherever a profile is named", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      for (const args of [
        ["config", KEY, "--key"],
        ["remove", KEY],
        ["use", KEY],
        ["repair", KEY],
      ]) {
        const message = await failure(h.run(args[0], ...args.slice(1)));
        expect(message, args.join(" ")).not.toContain(KEY);
        expect(message, args.join(" ")).toContain("looks like an API key");
      }
      expect(promptCalls).toEqual([]);
    });

    it("refuses a name too long to be one, whatever it starts with", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "a".repeat(65), "--api", "--base-url", "http://localhost:8000"));

      expect(message).toContain("at most 64 characters");
      expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
    });

    it("still accepts an ordinary name of that shape's length", async () => {
      const h = await harness();
      promptAnswers.push(KEY);

      await h.run("add", "a".repeat(64), "--api", "--base-url", "http://localhost:8000");

      expect(Object.keys(h.registry().profiles)).toContain(`claude:${"a".repeat(64)}`);
    });
  });

  // The other shape of the same slip: the key is passed as if an option took it, and the
  // command used to ignore it and prompt anyway, leaving the user sure they had supplied one.
  describe("a key passed as an extra argument", () => {
    it("refuses it on config --key rather than prompting anyway", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const message = await failure(h.run("config", "claude:gw", "--key", KEY));

      expect(message).not.toContain(KEY);
      expect(message).toContain("--key takes no value");
      expect(promptCalls).toEqual([]);
    });

    it("refuses it on add", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", KEY));

      expect(message).not.toContain(KEY);
      expect(message).toContain("one profile name and nothing else");
      expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
      expect(promptCalls).toEqual([]);
    });
  });

  it("warns on stderr when a setting that can hold a credential is written", async () => {
    const h = await harness();
    promptAnswers.push(KEY);

    await h.run(
      "add",
      "claude:gw",
      "--api",
      "--base-url",
      "http://localhost:8000",
      "--set",
      "ANTHROPIC_CUSTOM_HEADERS=Authorization: Bearer sk-fake-header-0002",
    );

    expect(h.stderr()).toContain("ANTHROPIC_CUSTOM_HEADERS is stored in plain text");
    expect(h.stderr()).toContain("--key");
    // The warning names the variable, never its value.
    expect(h.stderr()).not.toContain("sk-fake-header-0002");
    // A warning, not a refusal: the setting is there.
    expect(h.profile("claude:gw").env?.ANTHROPIC_CUSTOM_HEADERS).toContain("Authorization");
  });
});

describe("config --show", () => {
  it("prints an API profile's endpoint, auth and key source", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = await h.run("config", "claude:gw", "--show");

    expect(output).toContain("https://openrouter.ai/api");
    expect(output).toContain("bearer");
    expect(output).toContain("keychain");
    expect(output).toContain("ANTHROPIC_MODEL=z-ai/glm-5.3");
  });

  it("reports a credential-bearing setting as present without printing it", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-fake-hdr-0003" } },
    });

    const output = await h.run("config", "claude:gw", "--show");

    expect(output).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(output).not.toContain("sk-fake-hdr-0003");
  });

  it("hides the same value in --json, and says which names it hid", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-fake-hdr-0003" } },
    });

    const raw = await h.run("config", "claude:gw", "--show", "--json");
    const shown = JSON.parse(raw);

    expect(raw).not.toContain("sk-fake-hdr-0003");
    expect(shown.profile.env.ANTHROPIC_CUSTOM_HEADERS).toBe("<hidden>");
    expect(shown.profile.hiddenEnvKeys).toEqual(["ANTHROPIC_CUSTOM_HEADERS"]);
  });

  it("carries the advanced-settings catalog in --json, so a caller can discover the keys", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const shown = JSON.parse(await h.run("config", "claude:gw", "--show", "--json"));

    expect(shown.profile.api).toEqual(API_PROFILE.api);
    const keys = shown.catalog.map((entry: { key: string }) => entry.key);
    expect(keys).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(shown.catalog[0]).toMatchObject({ key: expect.any(String), kind: expect.any(String) });
  });

  it("works on a subscription profile, which has no endpoint", async () => {
    const h = await harness();

    const shown = JSON.parse(await h.run("config", "claude:default", "--show", "--json"));

    expect(shown.profile.kind).toBe("subscription");
    expect(shown.profile.api).toBeUndefined();
  });

  it("reads rather than writes when it is passed next to a change", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--show", "--set", "API_TIMEOUT_MS=600000");

    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
  });
});

describe("config --set / --unset", () => {
  it("sets an advanced setting", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = await h.run("config", "claude:gw", "--set", "CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144");

    expect(h.profile("claude:gw").env).toEqual({
      ANTHROPIC_MODEL: "z-ai/glm-5.3",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
    });
    expect(output).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
  });

  it("sets several at once and removes one in the same call", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run(
      "config",
      "claude:gw",
      "--set",
      "API_TIMEOUT_MS=600000",
      "--set",
      "DISABLE_PROMPT_CACHING=1",
      "--unset",
      "ANTHROPIC_MODEL",
    );

    expect(h.profile("claude:gw").env).toEqual({ API_TIMEOUT_MS: "600000", DISABLE_PROMPT_CACHING: "1" });
  });

  it("passes a bad value to the service's own check", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--set", "API_TIMEOUT_MS=soon"));

    expect(message).toBe("API_TIMEOUT_MS expects a whole number, got 'soon'");
    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
  });

  it("refuses a bare key, so a typo cannot quietly clear a setting", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--set", "ANTHROPIC_MODEL"));

    expect(message).toContain("Expected --set KEY=VALUE");
  });

  it("warns when a setting that can hold a credential is written", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--set", "ANTHROPIC_CUSTOM_HEADERS=X-Trace: 1");

    expect(h.stderr()).toContain("ANTHROPIC_CUSTOM_HEADERS is stored in plain text");
  });

  it("says nothing extra for an ordinary setting", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--set", "API_TIMEOUT_MS=600000");

    expect(h.stderr()).toBe("");
  });
});

describe("config --key", () => {
  it("re-reads the key and stores it outside profiles.json", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    promptAnswers.push(KEY);

    await h.run("config", "claude:gw", "--key");

    expect(promptCalls).toEqual(["API key: "]);
    expect(h.storedSecrets()).toEqual({ "claude:gw": KEY });
    expect(h.registryText()).not.toContain(KEY);
  });

  it("switches the source without asking for a key", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--key-from", "env:MY_KEY");

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "env", name: "MY_KEY" });
    expect(promptCalls).toEqual([]);
  });

  it("refuses a subscription profile before asking for a key", async () => {
    const h = await harness();

    const message = await failure(h.run("config", "claude:default", "--key"));

    expect(message).toBe("Profile 'claude:default' is not an API profile.");
    expect(promptCalls).toEqual([]);
  });
});

/**
 * What `add --api` set, changed later without re-entering the key. Each value goes through
 * the rule `add` applies, so `config` cannot store what `add` would refuse.
 */
describe("config --base-url / --auth / --label", () => {
  const SUBSCRIPTION = { tool: "claude", email: "work@example.com" };

  it("points an API profile at another endpoint and keeps everything else", async () => {
    const h = await harness({ "claude:gw": { ...API_PROFILE, label: "Gateway" } });
    const before = h.profile("claude:gw");

    const output = await h.run("config", "claude:gw", "--base-url", " http://localhost:8000 ");

    // Trimmed, as add trims it.
    expect(h.profile("claude:gw")).toEqual({
      ...before,
      api: { ...before.api, baseUrl: "http://localhost:8000" },
    });
    expect(output).toContain("claude:gw");
  });

  it("switches how the key is presented", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--auth", "api-key");

    expect(h.profile("claude:gw").api).toEqual({ ...API_PROFILE.api, authScheme: "api-key" });
  });

  it("renames it, trimmed as add trims a label", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--label", "  Gateway  ");

    expect(h.profile("claude:gw").label).toBe("Gateway");
    expect(h.profile("claude:gw").api).toEqual(API_PROFILE.api);
  });

  it("changes all three in one call, since together they are one endpoint", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    await h.run("config", "claude:gw", "--base-url=https://api.anthropic.com", "--auth=api-key", "--label=Anthropic");

    expect(h.profile("claude:gw")).toMatchObject({
      label: "Anthropic",
      api: { baseUrl: "https://api.anthropic.com", authScheme: "api-key", secret: { source: "keychain" } },
    });
  });

  describe("the label add chose for it", () => {
    // `add` labels a profile with its endpoint's host unless told otherwise. Left alone
    // after the endpoint moves, `list` would go on naming the old one.
    it("follows the endpoint when it was still the old host", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.profile("claude:gw").label).toBe("localhost:8000");
    });

    it("stays when it was chosen", async () => {
      const h = await harness({ "claude:gw": { ...API_PROFILE, label: "Gateway" } });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.profile("claude:gw").label).toBe("Gateway");
    });

    it("stays when it is given in the same call", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000", "--label", "Local");

      expect(h.profile("claude:gw").label).toBe("Local");
    });

    it("stays when the old URL is too broken to have a host", async () => {
      // Nothing to compare against, so nothing to say it was the default.
      const h = await harness({
        "claude:gw": { ...API_PROFILE, label: "openrouter.ai", api: { ...API_PROFILE.api, baseUrl: "openrouter.ai" } },
      });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.profile("claude:gw")).toMatchObject({
        label: "openrouter.ai",
        api: { baseUrl: "http://localhost:8000" },
      });
    });
  });

  describe("the key, which stays where it was", () => {
    // Moving the endpoint does not move the key: the next launch hands the same key to the
    // new host. Worth a line, since it can be a third party's.
    it("says when it will now go to another host, and the command it names runs", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.stderr()).toContain("localhost:8000");
      const commands = advisedCommands(h.stderr());
      expect(commands.length, h.stderr()).toBeGreaterThan(0);
      promptAnswers.push(KEY);
      for (const argv of commands) await h.run(argv[0], ...argv.slice(1));
      expect(h.storedSecrets()).toEqual({ "claude:gw": KEY });
    });

    it("says nothing when the host is the same", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "https://openrouter.ai/api/v2");

      expect(h.stderr()).toBe("");
    });

    it("says nothing for a label or a scheme", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--label", "Gateway");
      await h.run("config", "claude:gw", "--auth", "api-key");

      expect(h.stderr()).toBe("");
    });
  });

  describe("an empty or invalid value", () => {
    // Each is refused with the message add gives, and leaves the profile as it was.
    const cases: [string, string[], string][] = [
      ["an empty base URL", ["--base-url", ""], "Invalid base URL: must be an absolute http:// or https:// URL."],
      [
        "a base URL without a scheme",
        ["--base-url", "localhost:8000"],
        "Invalid base URL: the scheme must be http or https, not 'localhost'.",
      ],
      [
        "a base URL carrying credentials",
        ["--base-url", "https://u:p@example.com"],
        "Invalid base URL: it must not carry credentials. Supply the key through the key source instead.",
      ],
      [
        "a base URL carrying a key in its query",
        ["--base-url", `https://gateway.example.com/v1?key=${KEY_SHAPED}`],
        "Invalid base URL: it carries something shaped like an API key. Supply the key through the key source instead.",
      ],
      [
        "a base URL with a key glued to its host",
        ["--base-url", `https://gateway.example.com${KEY_SHAPED}`],
        "Invalid base URL: it carries something shaped like an API key. Supply the key through the key source instead.",
      ],
      ["an empty auth scheme", ["--auth", ""], "Invalid --auth: use bearer or api-key."],
      ["an unknown auth scheme", ["--auth", "basic"], "Invalid --auth: use bearer or api-key."],
      // Ruling 7: a blank label would render the profile as an empty row in `list`.
      ["an empty label", ["--label", ""], "Label cannot be blank"],
      ["a label of spaces", ["--label", "   "], "Label cannot be blank"],
    ];

    for (const [label, args, expected] of cases) {
      it(`refuses ${label}`, async () => {
        const h = await harness({ "claude:gw": API_PROFILE });
        const before = h.registryText();

        const message = await failure(h.run("config", "claude:gw", ...args));

        expect(message).toContain(expected);
        expect(h.registryText()).toBe(before);
      });
    }

    it("refuses the whole call when one of three values is bad", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const before = h.registryText();

      await failure(h.run("config", "claude:gw", "--base-url", "http://localhost:8000", "--label", " "));

      expect(h.registryText()).toBe(before);
    });

    it("never prints a key given where a value belongs", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      for (const flag of ["--base-url", "--auth"]) {
        const message = await failure(h.run("config", "claude:gw", flag, KEY));
        expect(message, flag).not.toContain(KEY);
      }
    });
  });

  // A subscription profile has no endpoint, and `list` names it by its account email - the
  // label is by definition the name of a profile that has none. So each of the three is
  // refused, one case per flag, and nothing is written.
  describe("on a subscription profile", () => {
    for (const args of [
      ["--base-url", "http://localhost:8000"],
      ["--auth", "bearer"],
      ["--label", "Work"],
    ]) {
      it(`refuses ${args[0]}`, async () => {
        const h = await harness({ "claude:work": SUBSCRIPTION });
        const before = h.registryText();

        const message = await failure(h.run("config", "claude:work", ...args));

        expect(message).toBe("Profile 'claude:work' is not an API profile.");
        expect(h.registryText()).toBe(before);
      });
    }
  });

  it("is one change, refused next to a change of another kind", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.registryText();

    const message = await failure(
      h.run("config", "claude:gw", "--base-url", "http://localhost:8000", "--set", "API_TIMEOUT_MS=600000"),
    );

    expect(message).toContain("Change one thing at a time");
    expect(message).toContain("--base-url");
    expect(h.registryText()).toBe(before);
  });

  it("add refuses a blank label with the same rule, before it asks for a key", async () => {
    const h = await harness();

    const message = await failure(
      h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--label", " "),
    );

    expect(message).toContain("Label cannot be blank");
    expect(promptCalls).toEqual([]);
  });
});

/**
 * `--model` is sugar over the env map's ANTHROPIC_MODEL, which is what Claude Code reads and
 * the one place the model is stored - `add --model` writes the same key. So the questions
 * are the ones `add` already answers: which kinds it applies to, what an empty value means,
 * and what happens next to a --set or --unset of the same variable.
 */
describe("config --model", () => {
  const SUBSCRIPTION = { tool: "claude", email: "work@example.com" };

  it("changes an API profile's model, and nothing else", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.profile("claude:gw");

    await h.run("config", "claude:gw", "--model", "z-ai/glm-5.3-flash");

    expect(h.profile("claude:gw")).toEqual({ ...before, env: { ANTHROPIC_MODEL: "z-ai/glm-5.3-flash" } });
  });

  // A subscription profile can pin a model too, and Claude Code honours it there. Refusing
  // one kind only would be an accident of where the flag is parsed, not a decision.
  it("pins a subscription profile's model", async () => {
    const h = await harness({ "claude:work": SUBSCRIPTION });

    await h.run("config", "claude:work", "--model", "claude-opus-5-5");

    expect(h.profile("claude:work").env).toEqual({ ANTHROPIC_MODEL: "claude-opus-5-5" });
  });

  // Codex reads its model from its own configuration, never from ANTHROPIC_MODEL: a --model
  // that stored it anyway would report success and change nothing Codex does.
  it("refuses a Codex profile rather than storing a variable Codex never reads", async () => {
    const h = await harness({ "codex:personal": { tool: "codex", email: "me@example.com" } });
    const before = h.registryText();

    const message = await failure(h.run("config", "codex:personal", "--model", "gpt-5"));

    expect(message).toContain("only Claude Code reads");
    expect(h.registryText()).toBe(before);
  });

  it("trims the id, on config and on add alike", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    promptAnswers.push(KEY);

    await h.run("config", "claude:gw", "--model=  z-ai/glm-5.3-flash  ");
    await h.run("add", "claude:local", "--api", "--base-url", "http://localhost:8000", "--model", " glm-5.3 ");

    expect(h.profile("claude:gw").env?.ANTHROPIC_MODEL).toBe("z-ai/glm-5.3-flash");
    expect(h.profile("claude:local").env?.ANTHROPIC_MODEL).toBe("glm-5.3");
  });

  // Empty is refused rather than read as "clear it": `--model "$MODEL"` with MODEL unset
  // would otherwise drop the profile's model without a word. Clearing has its own spelling.
  describe("an empty value", () => {
    for (const value of ["", "   "]) {
      it(`is refused on config (${JSON.stringify(value)}), and names how to clear it`, async () => {
        const h = await harness({ "claude:gw": API_PROFILE });
        const before = h.registryText();

        const message = await failure(h.run("config", "claude:gw", "--model", value));

        expect(message).toContain("--model needs a model id");
        expect(message).toContain("--unset ANTHROPIC_MODEL");
        expect(h.registryText()).toBe(before);
      });

      it(`is refused on add (${JSON.stringify(value)}), before it asks for a key`, async () => {
        const h = await harness();

        const message = await failure(
          h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--model", value),
        );

        expect(message).toContain("--model needs a model id");
        expect(promptCalls).toEqual([]);
        expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
      });
    }

    it("leaves --unset ANTHROPIC_MODEL as the way to clear it", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--unset", "ANTHROPIC_MODEL");

      expect(h.profile("claude:gw").env).toEqual({});
    });
  });

  describe("next to --set or --unset", () => {
    it("refuses --set ANTHROPIC_MODEL=, as add does", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const before = h.registryText();

      const message = await failure(h.run("config", "claude:gw", "--model", "a", "--set", "ANTHROPIC_MODEL=b"));

      expect(message).toBe("ANTHROPIC_MODEL is what --model sets. Pass one or the other.");
      expect(h.registryText()).toBe(before);
    });

    it("refuses --unset ANTHROPIC_MODEL, which asks for the opposite", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const before = h.registryText();

      const message = await failure(h.run("config", "claude:gw", "--model", "a", "--unset", "ANTHROPIC_MODEL"));

      expect(message).toBe("ANTHROPIC_MODEL is what --model sets. Pass one or the other.");
      expect(h.registryText()).toBe(before);
    });

    it("applies with other settings in one change, as add allows", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--model", "b", "--set", "API_TIMEOUT_MS=600000");

      expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "b", API_TIMEOUT_MS: "600000" });
    });

    it("is refused next to a change of another kind", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const message = await failure(h.run("config", "claude:gw", "--model", "b", "--label", "Gateway"));

      expect(message).toContain("Change one thing at a time");
      expect(message).toContain("--model");
    });
  });

  it("is what list shows afterwards, in the table and in --json", async () => {
    const h = await harness({ "claude:gw": API_PROFILE, "claude:work": SUBSCRIPTION });

    await h.run("config", "claude:gw", "--model", "z-ai/glm-5.3-flash");
    await h.run("config", "claude:work", "--model", "claude-opus-5-5");
    // Wide enough for the column whatever terminal the suite runs in.
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
    const table = await h.run("list", "--no-quota").then(
      (out) => stripAnsi(String(out)),
      (error) => error,
    );
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (table instanceof Error) throw table;
    const json = JSON.parse(String(await h.run("list", "--json", "--no-quota"))) as { name: string; model?: string }[];

    expect(table).toContain("MODEL");
    expect(table).toContain("z-ai/glm-5.3-flash");
    expect(table).toContain("claude-opus-5-5");
    expect(Object.fromEntries(json.map((item) => [item.name, item.model]))).toEqual({
      "claude:default": undefined,
      "claude:gw": "z-ai/glm-5.3-flash",
      "claude:work": "claude-opus-5-5",
    });
  });
});

/**
 * doctor names a command for a base URL it cannot use. With `config --base-url` there is
 * one, where the endpoint block exists to be changed; where it does not, there is no key
 * source for `config` to keep, and `--base-url` would refuse the profile.
 */
describe("doctor's advice for a broken base URL", () => {
  async function brokenEndpoint(api: unknown) {
    // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": { ...API_PROFILE, api } });
    const findings = async () =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
        .flatMap((result) => result.issues)
        .filter((issue) => issue.kind === "invalid_api_config");
    return { h, findings };
  }

  /** Runs what the finding says, with its placeholders filled in. */
  async function follow(h: Awaited<ReturnType<typeof harness>>, findings: () => Promise<unknown[]>) {
    const [finding] = (await findings()) as { message: string }[];
    const commands = advisedCommands(finding.message);
    expect(commands.length, finding.message).toBeGreaterThan(0);
    const placeholders: Record<string, string> = { "<url>": "https://openrouter.ai/api", "<new-name>": "claude:gw2" };
    for (const argv of commands) {
      const args = argv.map((arg) => placeholders[arg] ?? arg);
      await h.run(args[0], ...args.slice(1));
    }
    return commands;
  }

  it("names config --base-url where there is an endpoint block, and it clears the finding", async () => {
    const { h, findings } = await brokenEndpoint({ ...API_PROFILE.api, baseUrl: "openrouter.ai/api" });

    const commands = await follow(h, findings);

    expect(commands.flat()).toContain("--base-url");
    expect(await findings()).toEqual([]);
    // Nothing had to be typed again: the key source was kept.
    expect(promptCalls).toEqual([]);
  });

  it("names remove and add where there is none, and they clear the finding", async () => {
    const { h, findings } = await brokenEndpoint(undefined);
    promptAnswers.push(KEY);

    const commands = await follow(h, findings);

    expect(commands.map((argv) => argv[0])).toEqual(["remove", "add"]);
    expect(await findings()).toEqual([]);
    expect(Object.keys(h.registry().profiles)).toEqual(["claude:default", "claude:gw2"]);
  });
});

/**
 * The warning written when a credential name lands in a profile's env map. It is advice,
 * so it is only right if following it works - and what works depends on the profile's
 * kind: `--key` stores a key for an API profile and refuses a subscription one. One case
 * per kind and per command that writes the map, each running every command the warning
 * names and then checking the credential is no longer in plain text.
 */
describe("the plain-text credential warning", () => {
  const SUBSCRIPTION = { tool: "claude", email: "work@example.com" };
  const PLAINTEXT = "sk-fake-plain-0004";

  /** Writes `{ [key]: PLAINTEXT }` into the map through one of the three routes that warn. */
  const routes: Record<string, (h: Awaited<ReturnType<typeof harness>>, id: string, key: string) => Promise<unknown>> =
    {
      "config --set": (h, id, key) => h.run("config", id, "--set", `${key}=${PLAINTEXT}`),
      "config --edit": (h, id, key) => {
        vi.stubEnv("EDITOR", "fake-editor");
        editor = (argv) => {
          writeFileSync(argv[argv.length - 1], JSON.stringify({ [key]: PLAINTEXT }));
          return { status: 0 } as SpawnSyncReturns<string>;
        };
        return h.run("config", id, "--edit");
      },
      "add --api --set": (h, id, key) => {
        promptAnswers.push(KEY);
        return h.run("add", id, "--api", "--base-url", "http://localhost:8000", "--set", `${key}=${PLAINTEXT}`);
      },
    };

  async function followAdvice(h: Awaited<ReturnType<typeof harness>>) {
    const commands = advisedCommands(h.stderr());
    expect(commands.length, h.stderr()).toBeGreaterThan(0);
    const outputs: string[] = [];
    for (const argv of commands) {
      editor = null;
      outputs.push(String(await h.run(argv[0], ...argv.slice(1))));
    }
    return outputs;
  }

  for (const route of ["config --set", "config --edit", "add --api --set"]) {
    it(`gives an API profile advice that moves the key, via ${route}`, async () => {
      const h = await harness(route.startsWith("add") ? {} : { "claude:gw": API_PROFILE });
      await routes[route](h, "claude:gw", "ANTHROPIC_AUTH_TOKEN");
      expect(h.registryText()).toContain(PLAINTEXT);

      promptAnswers.push(PLAINTEXT);
      await followAdvice(h);

      // Moved, not copied: the env map is applied after the stored key, so a copy left
      // there would still be what Claude Code is handed - and still in plain text.
      expect(h.registryText()).not.toContain(PLAINTEXT);
      expect(h.storedSecrets()["claude:gw"]).toBe(PLAINTEXT);
    });
  }

  for (const route of ["config --set", "config --edit"]) {
    it(`gives a subscription profile advice it can follow, via ${route}`, async () => {
      const h = await harness({ "claude:work": SUBSCRIPTION });
      await routes[route](h, "claude:work", "ANTHROPIC_API_KEY");
      expect(h.registryText()).toContain(PLAINTEXT);

      const outputs = await followAdvice(h);

      expect(h.registryText()).not.toContain(PLAINTEXT);
      // Nothing asked for a key: a subscription profile has nowhere to store one.
      expect(promptCalls).toEqual([]);
      // The way to what they may have meant, an API profile, is a command that runs too.
      expect(outputs.some((output) => output.includes("--api --base-url"))).toBe(true);
    });
  }

  // doctor keeps reporting the same condition after the fact, so its advice has to clear
  // it too - and doctor looks again, so here "it worked" is doctor saying so.
  it("gives doctor's finding advice that clears it", async () => {
    // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_AUTH_TOKEN: PLAINTEXT } } });
    const findings = async () =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
        .flatMap((result) => result.issues)
        .filter((issue) => issue.kind === "plaintext_env_secret");

    const [finding] = await findings();
    const commands = advisedCommands(finding.message);
    expect(commands.length, finding.message).toBeGreaterThan(0);
    promptAnswers.push(PLAINTEXT);
    for (const argv of commands) await h.run(argv[0], ...argv.slice(1));

    expect(await findings()).toEqual([]);
    expect(h.registryText()).not.toContain(PLAINTEXT);
  });

  it("never prints the value it warns about, for either kind", async () => {
    const h = await harness({ "claude:gw": API_PROFILE, "claude:work": SUBSCRIPTION });

    await h.run("config", "claude:gw", "--set", `ANTHROPIC_AUTH_TOKEN=${PLAINTEXT}`);
    await h.run("config", "claude:work", "--set", `ANTHROPIC_API_KEY=${PLAINTEXT}`);

    expect(h.stderr()).not.toContain(PLAINTEXT);
    expect(h.stderr()).not.toContain(PLAINTEXT.slice(0, 10));
  });
});

describe("config --edit", () => {
  /** Stands in for $EDITOR: rewrites the scratch file and reports how it exited. */
  function fakeEditor(write: (file: string) => void, status = 0) {
    const seen: { argv: string[]; mode: number; dirMode: number; dir: string }[] = [];
    editor = (argv: string[]) => {
      const file = argv[argv.length - 1];
      const dir = path.dirname(file);
      // Read while the editor is "open": the directory is gone by the time the command returns.
      seen.push({ argv, mode: statSync(file).mode & 0o777, dirMode: statSync(dir).mode & 0o777, dir });
      if (status === 0) write(file);
      return { status } as SpawnSyncReturns<string>;
    };
    return seen;
  }

  it("applies what the editor saved, and takes the scratch file away with it", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor((file) => writeFileSync(file, JSON.stringify({ API_TIMEOUT_MS: "600000" })));

    const output = await h.run("config", "claude:gw", "--edit");

    // The model key was not in the saved file, so it is gone.
    expect(h.profile("claude:gw").env).toEqual({ API_TIMEOUT_MS: "600000" });
    expect(output).toContain("1 setting(s)");
    expect(existsSync(seen[0].dir)).toBe(false);
  });

  it("opens the map the profile already has", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    let opened = "";
    fakeEditor((file) => {
      opened = readFileSync(file, "utf8");
    });

    await h.run("config", "claude:gw", "--edit");

    expect(JSON.parse(opened)).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
  });

  it("writes the scratch file only for its owner, in a directory of its own", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-fake-hdr-0003" } },
    });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor(() => {});

    await h.run("config", "claude:gw", "--edit");

    expect(seen[0].mode).toBe(0o600);
    expect(seen[0].dirMode).toBe(0o700);
    // Not the shared temp directory itself, where the name would be guessable and the
    // path a symlink anyone on the machine could plant first.
    expect(seen[0].dir).not.toBe(tmpdir());
    expect(path.dirname(seen[0].dir)).toBe(tmpdir());
    expect(existsSync(seen[0].dir)).toBe(false);
  });

  it("passes the arguments $EDITOR carries", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "my editor -w");
    const seen = fakeEditor(() => {});

    await h.run("config", "claude:gw", "--edit");

    expect(seen[0].argv.slice(0, 3)).toEqual(["my", "editor", "-w"]);
  });

  it("prefers $VISUAL and ignores a blank one", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("VISUAL", "  ");
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor(() => {});

    await h.run("config", "claude:gw", "--edit");

    expect(seen[0].argv[0]).toBe("fake-editor");
  });

  it("changes nothing when the editor exits non-zero, and still clears up", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor(() => {}, 1);

    const message = await failure(h.run("config", "claude:gw", "--edit"));

    expect(message).toContain("exited with 1");
    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
    expect(existsSync(seen[0].dir)).toBe(false);
  });

  it("changes nothing when the edit is not valid JSON, and still clears up", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor((file) => writeFileSync(file, "{ oops"));

    const message = await failure(h.run("config", "claude:gw", "--edit"));

    expect(message).toContain("not valid JSON");
    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
    expect(existsSync(seen[0].dir)).toBe(false);
  });

  it("refuses a JSON shape that is not a flat map of strings", async () => {
    for (const [body, expected] of [
      ["[1, 2]", "JSON object"],
      ['{"API_TIMEOUT_MS": 600000}', "must be a string"],
      ['{"API_TIMEOUT_MS": {"a": 1}}', "must be a string"],
    ] as const) {
      const h = await harness({ "claude:gw": API_PROFILE });
      vi.stubEnv("EDITOR", "fake-editor");
      const seen = fakeEditor((file) => writeFileSync(file, body));

      const message = await failure(h.run("config", "claude:gw", "--edit"));

      expect(message).toContain(expected);
      expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
      expect(existsSync(seen[0].dir)).toBe(false);
      editor = null;
    }
  });

  it("says what to set when there is no editor", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--edit"));

    expect(message).toContain("Set $EDITOR");
  });

  // Ctrl-C while the editor is open reaches clausona too - the editor runs in the same
  // process group - so the `finally` never gets to run. A signal handler is what takes the
  // scratch file with it.
  it("takes the scratch file away on a signal, and stops listening afterwards", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-fake-hdr-0003" } },
    });
    vi.stubEnv("EDITOR", "fake-editor");
    const before = process.listeners("SIGINT");
    let duringEditor: { installed: NodeJS.SignalsListener[]; fileExisted: boolean } | undefined;

    // process.kill would take the test runner with it, so the handler's re-raise is stubbed.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const seen = fakeEditor((file) => {
      const installed = process.listeners("SIGINT").filter((listener) => !before.includes(listener));
      duringEditor = { installed, fileExisted: existsSync(file) };
      // What SIGINT would do, run directly: this is the handler's real body.
      for (const listener of installed) listener("SIGINT");
    });

    await failure(h.run("config", "claude:gw", "--edit"));

    expect(duringEditor?.fileExisted).toBe(true);
    expect(duringEditor?.installed).toHaveLength(1);
    expect(existsSync(seen[0].dir)).toBe(false);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    // Nothing is left listening once the command is done.
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("stops listening for a signal after an ordinary edit too", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    const before = process.listeners("SIGINT").length;
    let during = 0;
    fakeEditor(() => {
      during = process.listeners("SIGINT").length;
    });

    await h.run("config", "claude:gw", "--edit");

    expect(during).toBe(before + 1);
    expect(process.listeners("SIGINT").length).toBe(before);
  });
});

describe("config, the parts that were already there", () => {
  it("still switches session mode", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = await h.run("config", "claude:gw", "--merge-sessions");

    expect(h.profile("claude:gw").mergeSessions).toBe(true);
    expect(output).toContain("merged");
  });

  it("still reports a session mode that is already set", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = await h.run("config", "claude:gw", "--separate-sessions");

    expect(output).toContain("already separated");
  });

  it("still asks for a profile", async () => {
    const h = await harness();

    const message = await failure(h.run("config", "--merge-sessions"));

    expect(message).toContain("Usage: clausona config <profile>");
  });

  it("still asks for something to do", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw"));

    expect(message).toContain("Usage: clausona config <profile>");
  });

  it("refuses two changes in one call rather than dropping one", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--set", "API_TIMEOUT_MS=600000", "--merge-sessions"));

    expect(message).toContain("Change one thing at a time");
    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
    expect(h.profile("claude:gw").mergeSessions).toBe(false);
  });

  it("refuses both session flags at once", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--merge-sessions", "--separate-sessions"));

    expect(message).toContain("not both");
  });
});

// An API profile has no account email. `displayName` is the one rule for what names a
// profile - its label, else its email - and every line that names one goes through it.
describe("naming an API profile", () => {
  it("use says which endpoint it switched to, not an empty ()", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = stripAnsi(String(await h.run("use", "claude:gw")));

    expect(output).toContain("Switched to claude:gw (openrouter.ai)");
    expect(output).not.toContain("()");
  });

  it("use still names a subscription profile by its email", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    expect(stripAnsi(String(await h.run("use", "claude:default")))).toContain("(primary@example.com)");
  });

  it("current's Account row names an API profile by its label", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    await h.run("use", "claude:gw");

    const output = stripAnsi(String(await h.run("current")));

    expect(output).toMatch(/Account +openrouter\.ai/);
  });
});

describe("help", () => {
  it("tells `add` readers how to set up an endpoint without reading the source", async () => {
    const h = await harness();

    const help = await h.run("add", "--help");

    expect(help).toContain("--api");
    expect(help).toContain("--base-url");
    // The non-interactive form, which is how an agent supplies a key.
    expect(help).toContain('printf %s "$MY_API_KEY" | clausona add');
    expect(help).toContain("--key-from env:MY_API_KEY");
    expect(help).toContain('command:"pass show gw"');
    // The name rule, and that names collide without case.
    expect(help).toContain("/^[A-Za-z0-9][A-Za-z0-9._-]*$/");
    expect(help).toContain("compared without case");
    expect(help).toContain("api-key for anthropic.com");
    // --set has to be usable from this page alone: a real key, and where the rest live.
    expect(help).toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144");
    expect(help).toContain("--show --json");
    // When a referenced key is read, which is the difference between a profile that works
    // now and one that works in the shell someone runs claude in tomorrow.
    expect(help).toContain("every time the profile is used");
    expect(help).toContain("the shell that runs claude");
    expect(help).toContain("[--merge-sessions]");
  });

  it("tells `config` readers where the env map and the key each live", async () => {
    const h = await harness();

    const help = await h.run("config", "--help");

    expect(help).toContain("plain text");
    expect(help).toContain("--key");
    expect(help).toContain("--show --json");
    expect(help).toContain("--edit");
    expect(help).toContain("every time the profile is used");
    expect(help).toContain("the shell that runs claude");
  });

  it("says what --show, current and doctor never print, and where the command line is", async () => {
    const h = await harness();

    const config = stripAnsi(String(await h.run("config", "--help")));
    const current = stripAnsi(String(await h.run("current", "--help")));
    const doctor = stripAnsi(String(await h.run("doctor", "--help")));

    expect(config).toContain("<hidden>");
    expect(config).toContain("command line");
    expect(config).toContain("profiles.json");
    expect(current).toContain("<hidden>");
    expect(doctor).toContain("command line");
  });

  it("names the editor variables --edit reads, in the order it reads them", async () => {
    const h = await harness();

    const line = stripAnsi(String(await h.run("config", "--help")))
      .split("\n")
      .find((text) => text.trim().startsWith("--edit"));

    // editProfileEnv takes $VISUAL first and falls back to $EDITOR; the help said $EDITOR only.
    expect(line).toContain("$VISUAL or $EDITOR");
  });

  it("tells `config` readers how to change what add set, without re-adding", async () => {
    const h = await harness();

    const help = await h.run("config", "--help");

    for (const flag of ["--base-url", "--auth", "--label"]) expect(help, flag).toContain(flag);
    expect(help).toContain("bearer | api-key");
    // The two things a reader cannot guess: what happens to the key, and to a default label.
    expect(help).toContain("The key is kept");
    expect(help).toContain("follows");
    expect(help).toContain("clausona config claude:gw --base-url http://localhost:8000");
  });

  it("tells `config` readers how to change the model, and where it is kept", async () => {
    const h = await harness();

    const help = await h.run("config", "--help");

    expect(help).toContain("--model");
    expect(help).toContain("stored as ANTHROPIC_MODEL");
    expect(help).toContain("--unset ANTHROPIC_MODEL");
    expect(help).toContain("clausona config claude:gw --model z-ai/glm-5.3-flash");
  });

  it("tells `list` readers what the MODEL column is, and what its dash means", async () => {
    const h = await harness();

    const help = await h.run("list", "--help");

    expect(help).toContain("MODEL");
    expect(help).toContain("ANTHROPIC_MODEL");
    expect(help).toContain("pins none");
  });

  it("tells `add` readers the model can be changed later", async () => {
    const h = await harness();

    expect(await h.run("add", "--help")).toContain("config <profile> --model");
  });

  it("tells `doctor` readers which command fixes a base URL", async () => {
    const h = await harness();

    expect(await h.run("doctor", "--help")).toContain("config <profile> --base-url");
  });

  it("tells `list` readers why an API profile's quota columns are a dash", async () => {
    const h = await harness();

    const help = await h.run("list", "--help");

    // Without this the dash is indistinguishable from a quota lookup that failed.
    expect(help).toContain("API PROFILES");
    expect(help).toContain("show a dash");
    expect(help).toContain("subscription window to report");
    expect(help).toContain("It is not queried");
    expect(help).toContain("label rather than an account email");
  });

  it("tells `doctor` readers what it checks on an API profile, and what it does not", async () => {
    const h = await harness();

    const help = await h.run("doctor", "--help");

    // Every finding a user can hit has to be readable from this page alone.
    expect(help).toContain("API PROFILES");
    expect(help).toContain("base URL");
    expect(help).toContain("apiKeyHelper");
    expect(help).toContain("plain text");
    // Two promises worth making explicit: the key is never printed, and a command key
    // source is executed - doctor is not a read-only inspection of the registry.
    expect(help).toContain("never prints the key");
    expect(help).toContain("is run");
    // Which of the four leave the profile healthy, so a warning is not read as breakage.
    expect(help).toContain("are warnings");
    expect(help).toContain("stays healthy");
    // And what it does not do, so a healthy report is not read as "the endpoint answered".
    expect(help).toContain("No request is made");
  });

  it("points at add --api from the top-level usage", async () => {
    const h = await harness();

    expect(await h.run("help")).toContain("--api");
  });

  it("names the option it did not recognise", async () => {
    const h = await harness();

    const message = await failure(h.run("add", "claude:gw", "--base-urls", "http://localhost:8000"));

    expect(message).toContain("Unknown option: --base-urls");
  });
});
