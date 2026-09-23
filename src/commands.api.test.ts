import type { SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi } from "./lib/cli-style.js";
import { randomBody } from "./test-leaks.js";
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
/** Lets `/bin/sh` through, for a test where doctor runs a `command:` key source. */
let allowShell = false;
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
  allowShell = false;
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
      spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) =>
        allowShell && args[0] === "/bin/sh" ? actual.spawnCommand(...args) : refuse(args[0]),
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
 * The five-character slices of `secret` that `text` repeats, compared without case: a
 * refusal may not print what it refused, nor any piece of it long enough to recognise.
 */
function slicesIn(text: string, secret: string): string[] {
  const slices = Array.from({ length: secret.length - 4 }, (_, i) => secret.slice(i, i + 5));
  return slices.filter((slice) => text.toLowerCase().includes(slice.toLowerCase()));
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

  // config --key-from says so; add said nothing, and the first sign was a launch with no key.
  it("warns, and still adds, when the variable is not set here", async () => {
    const h = await harness();
    vi.stubEnv("MY_KEY", "");

    await h.run("add", "claude:gw", "--api", "--base-url", "https://openrouter.ai/api", "--key-from", "env:MY_KEY");

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "env", name: "MY_KEY" });
    expect(stripAnsi(h.stderr())).toContain("The key now comes from env:MY_KEY, which is not set in this shell.");
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

    it("refuses a Codex profile before asking for a key", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "codex:gw", "--api", "--base-url", "https://openrouter.ai/api"));

      expect(message).toBe("API profiles are Claude Code only in this version.");
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

    // A value option that ends the line was dropped without a word, and one followed by another
    // option took that option as its value: `--label --json` stored the label "--json".
    it.each([
      [
        "ends the line",
        ["add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--key-from", "env:X1", "--model"],
      ],
      ["is followed by another option", ["config", "claude:gw", "--label", "--json"]],
    ])("refuses a value option that %s, rather than dropping it or taking the option", async (_case, args) => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const flag = args.includes("--model") ? "--model" : "--label";

      const message = await failure(h.run(args[0], ...args.slice(1)));

      expect(message).toBe(`${flag} needs a value.`);
      expect(h.profile("claude:gw")).toMatchObject({
        label: "openrouter.ai",
        env: { ANTHROPIC_MODEL: "z-ai/glm-5.3" },
      });
      expect(promptCalls).toEqual([]);
    });

    it("still counts a value option with no value as one given without --api", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--model"));

      expect(message).toBe("--model only applies to an API profile. Add --api, or leave it out.");
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

      // The way out first - where the key goes - then what was wrong, and what to do when
      // the check is wrong: a URL with a random-looking segment in it has no other route.
      expect(message).toBe(
        "Invalid base URL: give the endpoint without the key, and the key through the key source - the prompt or --key, or --key-from env:NAME. Part of this URL looks like an API key, so it was not stored. If none of it is one, write the URL into api.baseUrl in ~/.clausona/profiles.json by hand (for a new profile, after adding it with any other URL).",
      );
      expect(slicesIn(message, KEY_SHAPED)).toEqual([]);
      expect(promptCalls).toEqual([]);
      expect(existsSync(path.join(h.home, ".claude-gw"))).toBe(false);
    });

    // With no `//`, what comes before the first colon is what the parser calls the scheme, and
    // quoting "the scheme" printed the key's beginning, lowercased. KEY is too short for the
    // shape check, so this is the rule that starts from `sk-`.
    it("refuses a key with a colon after it as a key, not by naming it as the scheme", async () => {
      const h = await harness();

      const message = await failure(h.run("add", "claude:gw", "--api", "--base-url", `${KEY}:xyz`));

      expect(message).toContain("looks like an API key");
      expect(message).not.toContain("scheme");
      expect(slicesIn(message, KEY)).toEqual([]);
      expect(promptCalls).toEqual([]);
    });

    // A gateway that takes its key in the URL takes it under a name like these, and a short or
    // hex key under one is no less a key for missing the shape check.
    it.each([
      "api_key",
      "API-Key",
      "apikey",
      "key",
      "token",
      "access_token",
      "secret",
      "password",
      "sig",
      "signature",
      // A credential word as one part of a longer name.
      "x-api-key",
      "client_secret",
      "auth_token",
      "api_token",
      "access_key",
    ])("refuses a base URL with a %s query parameter, whatever its value, without printing the value", async (name) => {
      const h = await harness();

      const message = await failure(
        h.run("add", "claude:gw", "--api", "--base-url", `https://gw.example.com/v1?${name}=f00d42`),
      );

      expect(message).toBe(
        `Invalid base URL: give the endpoint without its '${name}' parameter, and the key through the key source - the prompt or --key, or --key-from env:NAME. A query parameter by that name carries a credential, so the URL was not stored.`,
      );
      expect(message).not.toContain("f00d42");
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

    // The key prompt used to come first, so the refusal cost the user a typed key.
    it.each([
      ["a profile that already has the name", "Profile 'claude:gw' already exists."],
      [
        "a config directory already at its path",
        `${path.join("~", ".claude-other")} already exists. Choose another profile name.`,
      ],
    ])("refuses a name taken by %s before asking for a key", async (_case, expected) => {
      const h = await harness({ "claude:gw": API_PROFILE });
      mkdirSync(path.join(h.home, ".claude-other"));
      const name = expected.startsWith("Profile") ? "claude:gw" : "claude:other";

      const message = await failure(h.run("add", name, "--api", "--base-url", "http://localhost:8000"));

      expect(message).toBe(expected);
      expect(promptCalls).toEqual([]);
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

    // The tool is not part of the name: `claude:` took seven of the 64 characters.
    it("measures the name without its tool prefix", async () => {
      const h = await harness();
      promptAnswers.push(KEY);

      await h.run("add", `claude:${"a".repeat(60)}`, "--api", "--base-url", "http://localhost:8000");
      const message = await failure(
        h.run("add", `claude:${"b".repeat(65)}`, "--api", "--base-url", "http://localhost:8000"),
      );

      expect(Object.keys(h.registry().profiles)).toContain(`claude:${"a".repeat(60)}`);
      expect(message).toContain("at most 64 characters");
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

  // The rule `config --base-url` notes a move to plain http by, on the other route to an
  // endpoint: `add` said nothing.
  describe("pointed at plain http", () => {
    for (const [to, noted] of [
      ["http://gw.example.com/api", true],
      ["http://localhost:8000", false],
      ["https://gw.example.com/api", false],
    ] as const) {
      it(`${noted ? "notes" : "says nothing about"} ${to}`, async () => {
        const h = await harness();

        await h.run("add", "claude:gw", "--api", "--base-url", to, "--key-from", "env:GW_KEY");

        if (noted) expect(stripAnsi(h.stderr())).toContain("gw.example.com is plain http");
        else expect(h.stderr()).not.toContain("unencrypted");
      });
    }
  });
});

// A key can be a valid variable name - letters, digits and underscores - so `--key-from
// env:<the key>` passed the name rule, was stored, and was printed by every surface that names
// the variable, including the warning `_shell-env` repeats at every launch. Joined at run time
// so the file holds no string a secret scanner would take for a live key.
describe("--key-from env: given a key where the name belongs", () => {
  const nameShaped: [string, string][] = [
    ["a Hugging Face token", ["hf", "WPSXyPafNBzpChzNhlDfqrFDVOBzjXVAuM"].join("_")],
    ["a Groq key", ["gsk", "F1POSIXKEY0123456789abcdefXYZqRsTuVwXyZ0a1B2c3D4e5F6"].join("_")],
    ["a 46-character sk_ gateway key", ["sk", "u3HnwbgnFlWdggSOJ1WEy7kjPfP7KSbGvH3ZN0gE4O4"].join("_")],
  ];

  it.each(nameShaped)("refuses %s on add, printing none of it", async (_shape, key) => {
    const h = await harness();

    const message = await failure(
      h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--key-from", `env:${key}`),
    );

    expect(message).toBe(
      "Pass the name of the variable that holds the key - export GW_KEY=… in the shell that runs claude, then --key-from env:GW_KEY. What followed env: looks like an API key rather than a name, so it was not stored. If it is a variable's name, copy the variable to a plainer name the same way and pass that.",
    );
    expect(slicesIn(message, key)).toEqual([]);
    expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
    expect(promptCalls).toEqual([]);
  });

  it("refuses one on config --key-from and leaves the profile as it was", async () => {
    const [, key] = nameShaped[0];
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.registryText();

    const message = await failure(h.run("config", "claude:gw", "--key-from", `env:${key}`));

    expect(message).toContain("Pass the name of the variable that holds the key");
    expect(slicesIn(message, key)).toEqual([]);
    expect(h.registryText()).toBe(before);
  });

  it("still takes an ordinary variable name", async () => {
    const h = await harness();

    await h.run(
      "add",
      "claude:gw",
      "--api",
      "--base-url",
      "http://localhost:8000",
      "--key-from",
      "env:OPENROUTER_API_KEY",
    );

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "env", name: "OPENROUTER_API_KEY" });
  });

  // Stored before the rule, or by hand: every surface that names the variable, and the
  // launch warning, say where the key is read from without the name.
  it("hides one already stored on every surface that names the variable", async () => {
    const [, key] = nameShaped[0];
    // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({
      "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "env", name: key } } },
    });
    await h.run("use", "claude:gw");

    const outputs = [
      await h.run("config", "claude:gw", "--show"),
      await h.run("config", "claude:gw", "--show", "--json"),
      await h.run("current", "--json"),
      await h.run("list", "--json", "--no-quota"),
      await h.run("doctor"),
      await h.run("doctor", "--json"),
      await h.run("_shell-env", "claude"),
    ].map((output) => stripAnsi(String(output)));
    const printed = [...outputs, stripAnsi(h.stderr())].join("\n");

    expect(slicesIn(printed, key)).toEqual([]);
    expect(outputs[0]).toContain("env:<hidden>");
    // Launch and doctor still say what is wrong and what to run.
    expect(h.stderr()).toContain("its name looks like an API key");
    expect(h.stderr()).toContain("clausona config claude:gw --key-from env:<NAME>");
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

  // It used to print the profile and exit 0, and the change was dropped without a word.
  it("refuses a change passed next to it, and changes nothing", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--show", "--set", "API_TIMEOUT_MS=600000"));

    expect(message).toBe("--show only reads; run the change on its own.");
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

  // "✔ Updated" for a name the map never had read as if a setting had gone - a typo included.
  it("says a name --unset was given was not set, rather than that it was updated", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const nothing = stripAnsi(await h.run("config", "claude:gw", "--unset", "DISABLE_PROMPT_CACHING"));
    const some = stripAnsi(
      await h.run("config", "claude:gw", "--unset", "DISABLE_PROMPT_CACHING", "--unset", "ANTHROPIC_MODEL"),
    );

    expect(nothing).toBe("DISABLE_PROMPT_CACHING was not set; nothing changed");
    expect(some).toContain("Updated claude:gw (ANTHROPIC_MODEL)");
    expect(some).toContain("DISABLE_PROMPT_CACHING was not set");
    expect(h.profile("claude:gw").env).toEqual({});
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

  // The env map is applied after the endpoint, so the variable there would send the key to a
  // host that list, --show and doctor never name, past every note --base-url prints.
  it.each([
    ["config --set", ["config", "claude:gw", "--set", "ANTHROPIC_BASE_URL=http://gw.example.com"]],
    ["config --set, in another case", ["config", "claude:gw", "--set", "anthropic_base_url=http://gw.example.com"]],
    [
      "add --set",
      [
        "add",
        "claude:gw2",
        "--api",
        "--base-url",
        "https://openrouter.ai/api",
        "--set",
        "ANTHROPIC_BASE_URL=http://x.example.com",
      ],
    ],
  ])("refuses an API profile's endpoint as a setting through %s", async (_route, [command, ...args]) => {
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.registryText();

    const message = await failure(h.run(command as string, ...args));

    expect(message).toMatch(
      /^(ANTHROPIC_BASE_URL|anthropic_base_url) is this profile's endpoint - set the endpoint with --base-url$/,
    );
    expect(h.registryText()).toBe(before);
    expect(promptCalls).toEqual([]);
  });

  // validateEnvEntry quoted what it refused for a number or 0/1 setting, so a key given there
  // was printed back - the rule every other option already keeps.
  it.each([
    [
      "config --set on a number setting",
      ["config", "claude:gw", "--set", `CLAUDE_CODE_MAX_CONTEXT_TOKENS=${KEY_SHAPED}`],
    ],
    [
      "add --set on a 0/1 setting",
      [
        "add",
        "claude:gw2",
        "--api",
        "--base-url",
        "https://gw.example.com",
        "--set",
        `DISABLE_AUTO_COMPACT=${KEY_SHAPED}`,
      ],
    ],
    ["config --set on a setting of the user's own", ["config", "claude:gw", "--set", `MY_SETTING=${KEY_SHAPED}`]],
  ])("refuses a key given as a setting's value through %s, without printing it", async (_route, [command, ...args]) => {
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.registryText();

    const message = await failure(h.run(command as string, ...args));

    expect(message).toContain("That setting's value is shaped like an API key, so it was not stored.");
    expect(slicesIn(message, randomBody(KEY_SHAPED))).toEqual([]);
    expect(h.registryText()).toBe(before);
    expect(promptCalls).toEqual([]);
  });

  it("still lets a subscription profile set ANTHROPIC_BASE_URL", async () => {
    const h = await harness({ "claude:work": { tool: "claude", email: "work@example.com" } });

    await h.run("config", "claude:work", "--set", "ANTHROPIC_BASE_URL=http://proxy.example.com");

    expect(h.profile("claude:work").env).toEqual({ ANTHROPIC_BASE_URL: "http://proxy.example.com" });
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

  // Linux, so the store the line names is the file these tests' key lives in.
  it("says a stored key was deleted when the source moves off the credential store", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": API_PROFILE });
    promptAnswers.push(KEY);
    await h.run("config", "claude:gw", "--key");
    vi.stubEnv("MY_KEY", "set-in-the-shell");

    const output = stripAnsi(String(await h.run("config", "claude:gw", "--key-from", "env:MY_KEY")));

    expect(h.storedSecrets()).toEqual({});
    expect(output).toBe(
      "  \u2714 Updated the credential for claude:gw (deleted the key stored in ~/.clausona/secrets.json)",
    );
    expect(h.stderr()).toBe("");
  });

  // Not refused: the variable is read in the shell that runs claude, and the user may be
  // about to export it in their rc file. A typo, though, would otherwise go unnoticed until
  // the next launch has no key.
  it("warns, and still switches, when the variable is not set here", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("MY_KEY", "");

    await h.run("config", "claude:gw", "--key-from", "env:MY_KEY");

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "env", name: "MY_KEY" });
    expect(stripAnsi(h.stderr())).toContain("The key now comes from env:MY_KEY, which is not set in this shell.");
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

    // The half of the rule the case above cannot reach: with no label at all, "is it the old
    // host?" would be `undefined === undefined` without the check that there was a host.
    it("is not invented for a profile with no label and a broken old URL", async () => {
      const { label: _label, ...unlabelled } = API_PROFILE;
      const h = await harness({
        "claude:gw": { ...unlabelled, api: { ...API_PROFILE.api, baseUrl: "openrouter.ai" } },
      });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.profile("claude:gw").label).toBeUndefined();
    });
  });

  /**
   * `add` picks the scheme from the host: api-key for Anthropic's own API, bearer for anything
   * else. Moving the endpoint across that line with the old default left behind sends the key
   * in the header the new host does not read, and the first sign is a 401. So the scheme gets
   * the label's rule: while it is still the old host's default, it follows; one that was
   * chosen stays, with a note when the new host would default to the other one.
   */
  describe("the auth scheme add chose for it", () => {
    const ANTHROPIC = {
      ...API_PROFILE,
      label: "api.anthropic.com",
      api: { ...API_PROFILE.api, baseUrl: "https://api.anthropic.com", authScheme: "api-key" },
    };

    it("follows from Anthropic to a gateway, and says so", async () => {
      const h = await harness({ "claude:gw": ANTHROPIC });

      const output = stripAnsi(String(await h.run("config", "claude:gw", "--base-url", "https://openrouter.ai/api")));

      expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
      expect(output).toContain("(base URL; label and auth follow the new host)");
    });

    it("follows from a gateway to Anthropic", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "https://api.anthropic.com");

      expect(h.profile("claude:gw").api?.authScheme).toBe("api-key");
    });

    it("does not move within one side of the line, and does not mention it", async () => {
      const h = await harness({ "claude:gw": { ...API_PROFILE, label: "Gateway" } });

      const output = stripAnsi(String(await h.run("config", "claude:gw", "--base-url", "http://localhost:8000")));

      expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
      expect(output).toContain("(base URL)");
      expect(h.stderr()).not.toContain("--auth");
    });

    it("stays when it was chosen, and says the new host usually takes the other - the command it names runs", async () => {
      const chosen = { ...API_PROFILE, label: "Gateway", api: { ...API_PROFILE.api, authScheme: "api-key" } };
      const h = await harness({ "claude:gw": chosen });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000");

      expect(h.profile("claude:gw").api?.authScheme).toBe("api-key");
      const commands = advisedCommands(h.stderr()).filter((argv) => argv.includes("--auth"));
      expect(commands, h.stderr()).toEqual([["config", "claude:gw", "--auth", "bearer"]]);
      await h.run(commands[0][0], ...commands[0].slice(1));
      expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
    });

    // Said once, when the host changes; a new path on the same host is not news, and a note
    // repeated on every move of a scheme chosen on purpose reads as a problem it is not.
    it("says nothing about a chosen scheme when only the path changes", async () => {
      const chosen = {
        ...API_PROFILE,
        label: "Gateway",
        api: { ...API_PROFILE.api, baseUrl: "http://localhost:8000", authScheme: "api-key" },
      };
      const h = await harness({ "claude:gw": chosen });

      await h.run("config", "claude:gw", "--base-url", "http://localhost:8000/v1");

      expect(h.profile("claude:gw").api?.authScheme).toBe("api-key");
      expect(h.stderr()).not.toContain("--auth");
    });

    it("stays when it was chosen and already matches the new host, with no note", async () => {
      const chosen = { ...API_PROFILE, label: "Gateway", api: { ...API_PROFILE.api, authScheme: "api-key" } };
      const h = await harness({ "claude:gw": chosen });

      await h.run("config", "claude:gw", "--base-url", "https://api.anthropic.com");

      expect(h.profile("claude:gw").api?.authScheme).toBe("api-key");
      expect(h.stderr()).not.toContain("--auth");
    });

    it("gives way to --auth in the same call, with no note and no claim that it followed", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const output = stripAnsi(
        String(await h.run("config", "claude:gw", "--base-url", "https://api.anthropic.com", "--auth", "bearer")),
      );

      expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
      expect(h.stderr()).not.toContain("--auth");
      expect(output).toContain("(base URL, auth; label follows the new host)");
    });

    it("stays when the old URL is too broken to tell, with a note if the new host would differ", async () => {
      const broken = { ...API_PROFILE, api: { ...API_PROFILE.api, baseUrl: "openrouter.ai" } };
      const h = await harness({ "claude:gw": broken });

      await h.run("config", "claude:gw", "--base-url", "https://api.anthropic.com");

      expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
      expect(advisedCommands(h.stderr())).toContainEqual(["config", "claude:gw", "--auth", "api-key"]);
    });
  });

  describe("the success line", () => {
    it("says the label followed the host when it did", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const output = stripAnsi(String(await h.run("config", "claude:gw", "--base-url", "http://localhost:8000")));

      expect(output).toContain("(base URL; label follows the new host)");
    });

    it("names only what was asked for when nothing followed", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const output = stripAnsi(String(await h.run("config", "claude:gw", "--label", "Gateway")));

      expect(output).toContain("(label)");
      expect(output).not.toContain("base URL");
    });
  });

  // An http base URL sends the key in the clear. That is normal for a server on this
  // machine and nothing to remark on anywhere else it newly happens.
  describe("a move to plain http", () => {
    const cases: [string, string, string, boolean][] = [
      ["https to http on the same host", "https://openrouter.ai/api", "http://openrouter.ai/api", true],
      ["https to http on another host", "https://openrouter.ai/api", "http://gw.example.com/api", true],
      ["http staying http on the same host", "http://gw.example.com/api", "http://gw.example.com/v2", false],
      ["http to http on another host", "http://gw.example.com/api", "http://gw2.example.com/api", true],
      ["https to http on localhost", "https://openrouter.ai/api", "http://localhost:8000", false],
      ["https to http on 127.0.0.1", "https://openrouter.ai/api", "http://127.0.0.1:8000", false],
      ["https to http on ::1", "https://openrouter.ai/api", "http://[::1]:8000", false],
      ["https to http on 127.0.0.0/8, spelled short", "https://openrouter.ai/api", "http://127.1:8000", false],
      // A DNS name that starts like a loopback address is still a name, resolved wherever
      // its owner points it; the key would leave the machine.
      ["https to http on a name starting 127.", "https://openrouter.ai/api", "http://127.gw.example.com/api", true],
      ["https to http on a name under .localhost", "https://openrouter.ai/api", "http://gw.localhost:8000", true],
      ["https to https", "https://openrouter.ai/api", "https://gw.example.com/api", false],
    ];

    for (const [label, from, to, noted] of cases) {
      it(`${noted ? "notes" : "says nothing about"} ${label}`, async () => {
        const h = await harness({ "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, baseUrl: from } } });

        await h.run("config", "claude:gw", "--base-url", to);

        if (noted) expect(h.stderr()).toContain("unencrypted");
        else expect(h.stderr()).not.toContain("unencrypted");
      });
    }
  });

  // Marked `api` with no endpoint block - a hand edit - is still an API profile to doctor and
  // `list`. Calling it "not an API profile" sent the user nowhere; the doctor's own remedy runs.
  describe("an API profile with no endpoint block", () => {
    const NO_BLOCK = { tool: "claude", kind: "api", email: "", label: "gw" };

    for (const args of [["--base-url", "http://localhost:8000"], ["--key"]]) {
      it(`says why ${args[0]} cannot change it, and the commands it names run`, async () => {
        const h = await harness({ "claude:gw": NO_BLOCK });
        promptAnswers.push(KEY);

        const message = await failure(h.run("config", "claude:gw", ...args));

        expect(message).toContain("no endpoint");
        expect(promptCalls).toEqual([]);
        for (const argv of advisedCommands(message)) {
          const filled = argv.map(
            (arg) => ({ "<new-name>": "claude:gw2", "<url>": "http://localhost:8000" })[arg] ?? arg,
          );
          await h.run(filled[0], ...filled.slice(1));
        }
        expect(Object.keys(h.registry().profiles)).toEqual(["claude:default", "claude:gw2"]);
      });
    }
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

    // `--key` would replace a source the user chose, so for these the note says where the key
    // still comes from and advises nothing that moves it. A neighbour reading another variable
    // or command does not share the source, so the advice is to change it.
    for (const [label, secret, neighbour, said, advice] of [
      [
        "env:",
        { source: "env", name: "GW_KEY" },
        { source: "env", name: "GW_KEY2" },
        "env:GW_KEY",
        "set that variable",
      ],
      [
        "command:",
        { source: "command", run: "exit 7" },
        { source: "command", run: "exit 8" },
        "a command",
        "the command print",
      ],
    ] as const) {
      it(`says where a key from ${label} still comes from, and moves nothing`, async () => {
        const h = await harness({
          "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, secret } },
          "claude:other": { ...API_PROFILE, api: { ...API_PROFILE.api, secret: neighbour } },
        });

        await h.run("config", "claude:gw", "--base-url", "https://gw.example.com/api");

        const note = stripAnsi(h.stderr());
        expect(note).toContain("gw.example.com");
        expect(note).toContain(`still comes from ${said}`);
        expect(note).toContain(advice);
        expect(note).not.toContain("claude:other");
        expect(note).not.toContain("exit 7");
        for (const argv of advisedCommands(note)) {
          expect(argv, note).not.toContain("--key");
          await h.run(argv[0], ...argv.slice(1));
        }
        expect(h.profile("claude:gw").api?.secret).toEqual(secret);
        expect(h.storedSecrets()).toEqual({});
      });
    }

    // A source another profile reads too is not this profile's to change: the new endpoint's
    // key would reach the other profile's endpoint as well. So the note names the other
    // profile, and the command that gives this one a key of its own.
    for (const [label, secret] of [
      ["env:", { source: "env", name: "GW_KEY" }],
      ["command:", { source: "command", run: "exit 7" }],
    ] as const) {
      it(`gives a profile sharing a key from ${label} its own, and leaves the other's alone`, async () => {
        const shared = { ...API_PROFILE, api: { ...API_PROFILE.api, secret } };
        const h = await harness({ "claude:glm": shared, "claude:flash": shared });

        await h.run("config", "claude:flash", "--base-url", "http://localhost:8000");

        const note = stripAnsi(h.stderr());
        expect(note).toContain("claude:glm");
        expect(note).not.toContain("set that variable");
        expect(note).not.toContain("the command print");
        expect(note).toContain("--key-from env:");
        expect(note).toMatch(/--key\b(?!-)/);
        expect(note).not.toContain("exit 7");
        for (const argv of advisedCommands(note)) {
          const filled = argv.map((arg) => arg.replace(/<[A-Z_]+>/, "FLASH_KEY"));
          await h.run(filled[0], ...filled.slice(1));
        }
        expect(h.profile("claude:flash").api?.secret).toEqual({ source: "env", name: "FLASH_KEY" });
        expect(h.profile("claude:glm").api?.secret).toEqual(secret);
      });
    }

    // A profile already on the new endpoint wants that endpoint's key too, so changing the
    // shared variable is right for both, and naming it would send this one elsewhere.
    it("does not count a profile sharing the source that is already on the new endpoint", async () => {
      const shared = { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "env", name: "GW_KEY" } } };
      const h = await harness({
        "claude:local": { ...shared, api: { ...shared.api, baseUrl: "http://localhost:8000" } },
        "claude:flash": shared,
      });

      await h.run("config", "claude:flash", "--base-url", "http://localhost:8000/v1");

      const note = stripAnsi(h.stderr());
      expect(note).toContain("set that variable");
      expect(note).not.toContain("claude:local");
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
        "Invalid base URL: give the endpoint without the key",
      ],
      [
        "a base URL with a key glued to its host",
        ["--base-url", `https://gateway.example.com${KEY_SHAPED}`],
        "Invalid base URL: give the endpoint without the key",
      ],
      [
        "a base URL with a credential-named query parameter",
        ["--base-url", "https://gateway.example.com/v1?access_token=f00d42"],
        "Invalid base URL: give the endpoint without its 'access_token' parameter",
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

    // The rule is the parameter's name, not "any query": an Azure-style endpoint carries its
    // API version in one.
    it("accepts a query parameter that names no credential", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--base-url", "https://gw.example.com/v1?api-version=2024-10-21");

      expect(h.profile("claude:gw").api?.baseUrl).toBe("https://gw.example.com/v1?api-version=2024-10-21");
    });

    it("refuses the whole call when one of three values is bad", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const before = h.registryText();

      await failure(h.run("config", "claude:gw", "--base-url", "http://localhost:8000", "--label", " "));

      expect(h.registryText()).toBe(before);
    });

    // A token in the username slot: the parser calls it the scheme, and quoting "the scheme"
    // printed the token, lowercased. It is userinfo, and is refused as userinfo. The token is
    // not key-shaped: a key-shaped one is answered by the key check, which runs first.
    it("refuses a token given as scheme-less userinfo without printing it", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const message = await failure(h.run("config", "claude:gw", "--base-url", "TOKENabc123XYZ:@gw.example.com"));

      expect(message.toLowerCase()).not.toContain("tokenabc");
      expect(message).toContain("must not carry credentials");
    });

    // The same shape with a key-shaped token is the key check's to answer, and no part of the
    // key comes back - not even lowercased, which is how the scheme path would print it.
    it("refuses a key given as scheme-less userinfo with the key message, printing none of it", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      const message = await failure(h.run("config", "claude:gw", "--base-url", `${KEY_SHAPED}:@gw.example.com`));

      expect(message).toContain("looks like an API key");
      expect(slicesIn(message, KEY_SHAPED)).toEqual([]);
    });

    it("still names the scheme of a bare host:port, which carries nothing", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      expect(await failure(h.run("config", "claude:gw", "--base-url", "localhost:8000"))).toContain("not 'localhost'");
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
    // At add, leaving it out is the way to get the host; at config there is no such default.
    expect(message).toContain("Leave --label out to use the endpoint's host.");
    expect(promptCalls).toEqual([]);
  });

  it("config's blank-label refusal does not offer add's default", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--label", " "));

    expect(message).toContain("Label cannot be blank");
    expect(message).not.toContain("Leave --label out");
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
  // And by every route that writes the variable, not only --model: a blank one that got in
  // through --set is exported at launch while `list` and the preview call it "none".
  describe("an empty value", () => {
    const configRoutes: Record<string, (h: Awaited<ReturnType<typeof harness>>, value: string) => Promise<unknown>> = {
      "--model": (h, value) => h.run("config", "claude:gw", "--model", value),
      "--set": (h, value) => h.run("config", "claude:gw", "--set", `ANTHROPIC_MODEL=${value}`),
      "--edit": (h, value) => {
        vi.stubEnv("EDITOR", "fake-editor");
        editor = (argv) => {
          writeFileSync(argv[argv.length - 1], JSON.stringify({ ANTHROPIC_MODEL: value }));
          return { status: 0 } as SpawnSyncReturns<string>;
        };
        return h.run("config", "claude:gw", "--edit");
      },
    };
    const addRoutes: Record<string, string[]> = {
      "--model": ["--model"],
      "--set": ["--set"],
    };

    const configMessage = async (route: string, value: string) => {
      const h = await harness({ "claude:gw": API_PROFILE });
      const before = h.registryText();
      const message = await failure(configRoutes[route](h, value));
      expect(h.registryText(), route).toBe(before);
      return message;
    };
    const addMessage = async (route: string, value: string) => {
      const h = await harness();
      const arg = route === "--set" ? `ANTHROPIC_MODEL=${value}` : value;
      const message = await failure(
        h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", ...addRoutes[route], arg),
      );
      expect(promptCalls, route).toEqual([]);
      expect(Object.keys(h.registry().profiles), route).toEqual(["claude:default"]);
      return message;
    };

    for (const value of ["", "   "]) {
      for (const route of Object.keys(configRoutes)) {
        it(`is refused by config ${route} (${JSON.stringify(value)}), naming how to clear one`, async () => {
          const message = await configMessage(route, value);

          expect(message).toContain("A model id cannot be blank");
          expect(message).toContain("clausona config <profile> --unset ANTHROPIC_MODEL");
        });
      }

      for (const route of Object.keys(addRoutes)) {
        it(`is refused by add ${route} (${JSON.stringify(value)}) before the key prompt, with nothing to clear`, async () => {
          const message = await addMessage(route, value);

          expect(message).toContain("A model id cannot be blank");
          // At add time there is no model yet, so nothing to clear.
          expect(message).not.toContain("--unset");
        });
      }
    }

    it("says the same thing by every route within a command", async () => {
      const config = await Promise.all(Object.keys(configRoutes).map((route) => configMessage(route, " ")));
      const add = await Promise.all(Object.keys(addRoutes).map((route) => addMessage(route, " ")));

      expect(new Set(config).size).toBe(1);
      expect(new Set(add).size).toBe(1);
    });

    it("leaves --unset ANTHROPIC_MODEL as the way to clear it", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--unset", "ANTHROPIC_MODEL");

      expect(h.profile("claude:gw").env).toEqual({});
    });
  });

  describe("next to --set or --unset", () => {
    // Each half of the "one or the other" guard, on config and on add. The first is the
    // documented way to change a model without --model, and nothing pinned it.
    it("still takes --set ANTHROPIC_MODEL= on its own, on config", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--set", "ANTHROPIC_MODEL=z-ai/glm-5.3-flash");

      expect(h.profile("claude:gw").env?.ANTHROPIC_MODEL).toBe("z-ai/glm-5.3-flash");
    });

    it("still takes --set ANTHROPIC_MODEL= on its own, on add", async () => {
      const h = await harness();
      promptAnswers.push(KEY);

      await h.run("add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--set", "ANTHROPIC_MODEL=m1");

      expect(h.profile("claude:gw").env?.ANTHROPIC_MODEL).toBe("m1");
    });

    it("takes --model next to another --set on add", async () => {
      const h = await harness();
      promptAnswers.push(KEY);

      await h.run(
        "add",
        "claude:gw",
        "--api",
        "--base-url",
        "http://localhost:8000",
        "--model",
        "m1",
        "--set",
        "API_TIMEOUT_MS=600000",
      );

      expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "m1", API_TIMEOUT_MS: "600000" });
    });

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
// `--model "$KEY"` or `--label "$KEY"` with the wrong variable stored the key where every
// `list` prints it - and a model id is sent to the endpoint with every request.
describe("a key given as the model or the label", () => {
  it.each([
    ["add --model", ["add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--model", KEY_SHAPED]],
    ["add --label", ["add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--label", KEY_SHAPED]],
    [
      "add --set ANTHROPIC_MODEL=",
      ["add", "claude:gw", "--api", "--base-url", "http://localhost:8000", "--set", `ANTHROPIC_MODEL=${KEY_SHAPED}`],
    ],
  ])("is refused by %s before the prompt, printing none of it", async (_route, argv) => {
    const h = await harness();

    const message = await failure(h.run(argv[0], ...argv.slice(1)));

    expect(message).toContain("looks like an API key, so it was not stored");
    expect(slicesIn(message, KEY_SHAPED)).toEqual([]);
    expect(Object.keys(h.registry().profiles)).toEqual(["claude:default"]);
    expect(promptCalls).toEqual([]);
  });

  it.each([
    ["config --model", ["--model", KEY_SHAPED]],
    ["config --set ANTHROPIC_MODEL=", ["--set", `ANTHROPIC_MODEL=${KEY_SHAPED}`]],
    ["config --label", ["--label", KEY_SHAPED]],
  ])("is refused by %s, leaving the profile as it was", async (_route, args) => {
    const h = await harness({ "claude:gw": API_PROFILE });
    const before = h.registryText();

    const message = await failure(h.run("config", "claude:gw", ...args));

    expect(message).toContain("looks like an API key, so it was not stored");
    expect(slicesIn(message, KEY_SHAPED)).toEqual([]);
    expect(h.registryText()).toBe(before);
  });

  it("says where the model id and the key each go", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });

    const message = await failure(h.run("config", "claude:gw", "--model", KEY_SHAPED));

    expect(message).toBe(
      "Give the model's id as your endpoint names it, such as z-ai/glm-5.3, and the key through the key source - the prompt or --key, or --key-from env:NAME. This value for ANTHROPIC_MODEL looks like an API key, so it was not stored. If it is the model's id, pick it for one session with `claude --model` instead.",
    );
  });

  // Stored before the rule, or by hand: every surface that shows the model or the label.
  it("is hidden on every surface when one is already stored", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, label: KEY_SHAPED, env: { ANTHROPIC_MODEL: KEY_SHAPED } },
    });
    await h.run("use", "claude:gw");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
    const table = await h.run("list", "--no-quota").then(
      (out) => stripAnsi(String(out)),
      (error) => error,
    );
    if (columns) Object.defineProperty(process.stdout, "columns", columns);
    else delete (process.stdout as { columns?: number }).columns;
    if (table instanceof Error) throw table;

    const printed = [
      table,
      await h.run("list", "--json", "--no-quota"),
      await h.run("config", "claude:gw", "--show"),
      await h.run("config", "claude:gw", "--show", "--json"),
      await h.run("current"),
      await h.run("current", "--json"),
    ]
      .map((output) => stripAnsi(String(output)))
      .join("\n");

    expect(slicesIn(printed, KEY_SHAPED)).toEqual([]);
    expect(table).toContain("<hidden>");
    const listed = JSON.parse(String(await h.run("list", "--json", "--no-quota"))) as {
      name: string;
      model?: string;
      label?: string;
    }[];
    expect(listed.find((item) => item.name === "claude:gw")).toMatchObject({ model: "<hidden>", label: "<hidden>" });
  });
});

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

describe("doctor's advice for a config directory that is gone", () => {
  async function goneConfigDir() {
    // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness();
    // Added, not written into the registry: add is what leaves a backup behind to restore.
    promptAnswers.push(KEY);
    await h.run("add", "claude:gw", "--api", "--base-url", "https://openrouter.ai/api");
    rmSync(path.join(h.home, ".claude-gw"), { recursive: true, force: true });
    const findings = async () =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
        .flatMap((result) => result.issues)
        .filter((issue) => issue.kind === "missing_config_dir");
    const [finding] = await findings();
    return { h, findings, advice: advisedCommands(finding?.message ?? "") };
  }

  it("is first to make the directory again and repair it, which clears the finding and keeps the key", async () => {
    const { h, findings, advice } = await goneConfigDir();
    const entry = h.profile("claude:gw");

    mkdirSync(path.join(h.home, ".claude-gw"));
    const [first] = advice;
    expect(first).toEqual(["repair", "claude:gw"]);
    await h.run(first[0], ...first.slice(1));

    expect(await findings()).toEqual([]);
    expect(h.profile("claude:gw")).toEqual(entry);
    expect(h.storedSecrets()).toEqual({ "claude:gw": KEY });
  });

  it("falls back to remove and re-add under its own name, which clears the finding too", async () => {
    const { h, findings, advice } = await goneConfigDir();
    promptAnswers.push(KEY);

    for (const argv of advice.filter(([command]) => command !== "repair")) {
      const args = argv.map((arg) => (arg === "<url>" ? "https://openrouter.ai/api" : arg));
      await h.run(args[0] as string, ...args.slice(1));
    }

    expect(await findings()).toEqual([]);
    expect(Object.keys(h.registry().profiles)).toEqual(["claude:default", "claude:gw"]);
  });
});

/**
 * The spec's "doctor reports which backend is in use": the one place a user learns whether a
 * stored key is in the Keychain or in a file in their home directory.
 */
describe("doctor's line on where stored keys are kept", () => {
  // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
  it("closes the report when an API profile has its key stored", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": API_PROFILE });

    const output = stripAnsi(String(await h.run("doctor")));

    expect(output.trimEnd().split("\n").at(-1)).toBe("  Stored API keys are kept in ~/.clausona/secrets.json.");
  });

  it("is not there when no profile has one", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({
      "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "env", name: "GW_KEY" } } },
    });

    expect(stripAnsi(String(await h.run("doctor")))).not.toContain("Stored API keys");
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

  /**
   * The three places an API profile's key can come from, and how `add` is told each. The
   * advice differs between them: `--key` moves a key into the store for a keychain profile,
   * and for the other two it would quietly replace the source the user chose.
   */
  const SOURCES: Record<string, { secret: SecretSource; addArgs: string[]; said?: string }> = {
    keychain: { secret: { source: "keychain" }, addArgs: [] },
    "env:": { secret: { source: "env", name: "GW_KEY" }, addArgs: ["--key-from", "env:GW_KEY"], said: "env:GW_KEY" },
    "command:": {
      secret: { source: "command", run: "exit 7" },
      addArgs: ["--key-from", "command:exit 7"],
      said: "a command",
    },
  };

  /** Writes `{ [key]: PLAINTEXT }` into the map through one of the three routes that warn. */
  const routes: Record<
    string,
    (h: Awaited<ReturnType<typeof harness>>, id: string, key: string, addArgs?: string[]) => Promise<unknown>
  > = {
    "config --set": (h, id, key) => h.run("config", id, "--set", `${key}=${PLAINTEXT}`),
    "config --edit": (h, id, key) => {
      vi.stubEnv("EDITOR", "fake-editor");
      editor = (argv) => {
        writeFileSync(argv[argv.length - 1], JSON.stringify({ [key]: PLAINTEXT }));
        return { status: 0 } as SpawnSyncReturns<string>;
      };
      return h.run("config", id, "--edit");
    },
    "add --api --set": (h, id, key, addArgs = []) => {
      if (addArgs.length === 0) promptAnswers.push(KEY);
      return h.run(
        "add",
        id,
        "--api",
        "--base-url",
        "http://localhost:8000",
        ...addArgs,
        "--set",
        `${key}=${PLAINTEXT}`,
      );
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

  // One case per (source, route). Each runs what the warning says, then checks the two things
  // that make it right: the plain-text copy is gone, and the source is the one the user chose.
  for (const [source, { secret, addArgs, said }] of Object.entries(SOURCES)) {
    for (const route of ["config --set", "config --edit", "add --api --set"]) {
      it(`gives an API profile whose key comes from ${source} advice that works, via ${route}`, async () => {
        const seeded = { ...API_PROFILE, api: { ...API_PROFILE.api, secret } };
        const h = await harness(route.startsWith("add") ? {} : { "claude:gw": seeded });
        await routes[route](h, "claude:gw", "ANTHROPIC_AUTH_TOKEN", addArgs);
        expect(h.registryText()).toContain(PLAINTEXT);
        const warning = stripAnsi(h.stderr());
        const promptsBefore = promptCalls.length;

        promptAnswers.push(PLAINTEXT);
        await followAdvice(h);

        expect(h.registryText()).not.toContain(PLAINTEXT);
        expect(h.profile("claude:gw").api?.secret).toEqual(secret);
        // An API profile's advice, not a subscription profile's.
        expect(warning).not.toContain("subscription");
        expect(warning).not.toContain("add --help");
        if (secret.source === "keychain") {
          // Moved, not copied: the env map is applied after the stored key, so a copy left
          // there would still be what Claude Code is handed - and still in plain text.
          expect(h.storedSecrets()["claude:gw"]).toBe(PLAINTEXT);
        } else {
          // Nothing asked for a key, and nothing stored one: the key already lives outside
          // profiles.json, and the warning says where - by kind, never the command line.
          expect(promptCalls.length).toBe(promptsBefore);
          expect(h.storedSecrets()).toEqual({});
          expect(warning).toContain(`already comes from ${said}`);
          expect(warning).not.toContain("exit 7");
        }
      });
    }
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

  // API profiles are Claude-only, so pointing a Codex profile at one is advice it cannot take.
  it("gives a Codex profile advice without an API profile it cannot have", async () => {
    const h = await harness({ "codex:personal": { tool: "codex", email: "me@example.com" } });
    await routes["config --set"](h, "codex:personal", "ANTHROPIC_API_KEY");
    const warning = stripAnsi(h.stderr());

    await followAdvice(h);

    expect(h.registryText()).not.toContain(PLAINTEXT);
    expect(warning).not.toContain("add --help");
    expect(warning).toContain("Codex");
  });

  // doctor keeps reporting the same condition after the fact, so its advice has to clear
  // it too - and doctor looks again, so here "it worked" is doctor saying so.
  for (const [source, { secret, said }] of Object.entries(SOURCES)) {
    it.skipIf(process.platform === "win32" && source === "command:")(
      `gives doctor's finding advice that clears it, for a key from ${source}`,
      async () => {
        // Linux, so doctor reads the primary's login from a file rather than spawning `security`.
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        allowShell = true;
        vi.stubEnv("GW_KEY", "sk-fake-env-0005");
        const seeded = {
          ...API_PROFILE,
          api: { ...API_PROFILE.api, secret },
          env: { ANTHROPIC_AUTH_TOKEN: PLAINTEXT },
        };
        const h = await harness({ "claude:gw": seeded });
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
        expect(h.profile("claude:gw").api?.secret).toEqual(secret);
        if (said) {
          expect(finding.message).toContain(`already comes from ${said}`);
          expect(finding.message).not.toContain("--key'");
          expect(finding.message).not.toContain("exit 7");
        }
      },
    );
  }

  // Marked `api` with no endpoint block - a hand edit. `--key` refuses that profile, so the
  // advice is what doctor gives for the missing block: add it again, which takes the copy
  // in plain text away with the old profile.
  it("gives an API profile with no endpoint block advice that runs, from --set and from doctor", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": { tool: "claude", kind: "api", email: "", label: "gw" } });
    await routes["config --set"](h, "claude:gw", "ANTHROPIC_AUTH_TOKEN");
    const warning = stripAnsi(h.stderr());
    const [finding] = (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
      .flatMap((result) => result.issues)
      .filter((issue) => issue.kind === "plaintext_env_secret");

    for (const advice of [warning, finding.message]) {
      expect(
        advisedCommands(advice).map((argv) => argv[0]),
        advice,
      ).toEqual(["remove", "add"]);
    }
    promptAnswers.push(KEY);
    for (const argv of advisedCommands(finding.message)) {
      const filled = argv.map((arg) => ({ "<new-name>": "claude:gw2", "<url>": "http://localhost:8000" })[arg] ?? arg);
      await h.run(filled[0], ...filled.slice(1));
    }
    expect(h.registryText()).not.toContain(PLAINTEXT);
    expect(Object.keys(h.registry().profiles)).toEqual(["claude:default", "claude:gw2"]);
  });

  // A name that says it holds a secret but is not one Claude Code takes an Anthropic key
  // from - OTEL's headers, a Bedrock token. It is not the profile's key, so `--key` is not
  // where it goes: it belongs in the shell's environment, which the hook passes through.
  describe("for a secret that is not the profile's key", () => {
    const OTEL = "OTEL_EXPORTER_OTLP_HEADERS";

    for (const [label, id, profile] of [
      ["an API profile", "claude:gw", API_PROFILE],
      ["a subscription profile", "claude:work", SUBSCRIPTION],
    ] as const) {
      it(`warns on ${label}, says to keep it in the shell, and names only --unset`, async () => {
        const h = await harness({ [id]: profile });
        await routes["config --set"](h, id, OTEL);
        const warning = stripAnsi(h.stderr());

        await followAdvice(h);

        expect(warning).toContain(`${OTEL} is stored in plain text`);
        expect(warning).toContain("shell's environment");
        // Not per profile: the shell hands it to every claude profile it launches.
        expect(warning).toContain("every claude profile launched from that shell");
        expect(advisedCommands(warning)).toEqual([["config", id, "--unset", OTEL]]);
        expect(h.registryText()).not.toContain(PLAINTEXT);
        expect(promptCalls).toEqual([]);
        expect(h.profile(id).api?.secret).toEqual((profile as { api?: { secret: unknown } }).api?.secret);
      });
    }

    it("gives doctor's finding the same advice, and it clears it", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const h = await harness({
        "claude:gw": { ...API_PROFILE, env: { [OTEL]: `Authorization=Bearer ${PLAINTEXT}` } },
      });
      const findings = async () =>
        (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
          .flatMap((result) => result.issues)
          .filter((issue) => issue.kind === "plaintext_env_secret");

      const [finding] = await findings();
      // The whole sentence, since the parts were right and the joint between them was not.
      expect(finding?.message).toBe(
        `${OTEL} is stored in plain text in ~/.clausona/profiles.json - if it holds a secret, your shell's environment can hold it instead, but the hook then passes it to every claude profile launched from that shell, not just this one; if that is fine, run 'clausona config claude:gw --unset ${OTEL}', and if not, leave it here, where output hides it`,
      );
      const commands = advisedCommands(finding.message);
      expect(commands).toEqual([["config", "claude:gw", "--unset", OTEL]]);
      for (const argv of commands) await h.run(argv[0], ...argv.slice(1));

      expect(await findings()).toEqual([]);
      expect(h.profile("claude:gw").api?.secret).toEqual(API_PROFILE.api.secret);
    });

    it("does not warn about a count of tokens", async () => {
      const h = await harness({ "claude:gw": API_PROFILE });

      await h.run("config", "claude:gw", "--set", "CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144");

      expect(h.stderr()).toBe("");
    });
  });

  it("never prints the value it warns about, for either kind", async () => {
    const h = await harness({ "claude:gw": API_PROFILE, "claude:work": SUBSCRIPTION });

    await h.run("config", "claude:gw", "--set", `ANTHROPIC_AUTH_TOKEN=${PLAINTEXT}`);
    await h.run("config", "claude:work", "--set", `ANTHROPIC_API_KEY=${PLAINTEXT}`);

    expect(h.stderr()).not.toContain(PLAINTEXT);
    expect(h.stderr()).not.toContain(PLAINTEXT.slice(0, 10));
  });
});

/**
 * A `command:` key source that fails. Its command line is hidden on every path, so the
 * message cannot quote it - and must still say where it is and what replaces it. Not
 * `config --edit`: that opens the env map, and the command lives in the endpoint block.
 */
describe.skipIf(process.platform === "win32")("a key command that fails", () => {
  for (const [label, run, said] of [
    ["exits non-zero", "exit 3", "exited with 3"],
    ["prints nothing", "true", "produced no output"],
  ] as const) {
    it(`says where the command is when it ${label}, and the command it names fixes it`, async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      allowShell = true;
      const h = await harness({
        "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "command", run } } },
      });
      const findings = async () =>
        (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
          .flatMap((result) => result.issues)
          .filter((issue) => issue.kind === "missing_api_secret");

      const [finding] = await findings();
      expect(finding?.message).toContain(said);
      expect(finding.message).toContain("~/.clausona/profiles.json");
      expect(finding.message).not.toContain(run);
      const commands = advisedCommands(finding.message);
      expect(commands.length, finding.message).toBe(1);
      const argv = commands[0].map((arg) => (arg === 'command:"<command>"' ? "command:echo sk-fake-cmd-0008" : arg));
      await h.run(argv[0], ...argv.slice(1));

      expect(await findings()).toEqual([]);
    });
  }
});

/**
 * One variable or command feeding API profiles on different endpoints: each endpoint receives
 * whichever key it holds. doctor reports that state, and `add` says so when it creates it.
 */
describe("one key source read for two endpoints", () => {
  const ON_OPENROUTER = { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "env", name: "OR_KEY" } } };

  it("is noted by add --api --key-from, and the command it names gives the new profile its own", async () => {
    const h = await harness({ "claude:glm": ON_OPENROUTER });

    await h.run("add", "claude:flash", "--api", "--base-url", "http://localhost:8000", "--key-from", "env:OR_KEY");

    const note = stripAnsi(h.stderr());
    expect(note).toContain("claude:glm");
    expect(note).toContain("env:OR_KEY");
    for (const argv of advisedCommands(note)) {
      const filled = argv.map((arg) => arg.replace(/<[A-Z_]+>/, "FLASH_KEY"));
      await h.run(filled[0], ...filled.slice(1));
    }
    expect(h.profile("claude:flash").api?.secret).toEqual({ source: "env", name: "FLASH_KEY" });
    expect(h.profile("claude:glm").api?.secret).toEqual(ON_OPENROUTER.api.secret);
  });

  it("is not noted for two profiles on one endpoint", async () => {
    const h = await harness({ "claude:glm": ON_OPENROUTER });
    // Set, so that the one note an unset variable gets is not what this reads.
    vi.stubEnv("OR_KEY", "or-key-value");

    await h.run(
      "add",
      "claude:flash",
      "--api",
      "--base-url",
      "https://openrouter.ai/api/v1",
      "--key-from",
      "env:OR_KEY",
    );

    expect(h.stderr()).toBe("");
  });

  it("is a doctor warning on both profiles, which the command it names clears", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("OR_KEY", "sk-fake-env-0045");
    vi.stubEnv("FLASH_KEY", "sk-fake-env-0046");
    const h = await harness({
      "claude:glm": ON_OPENROUTER,
      "claude:flash": { ...ON_OPENROUTER, api: { ...ON_OPENROUTER.api, baseUrl: "http://localhost:8000" } },
    });
    const findings = async () =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[]).flatMap((result) =>
        result.issues
          .filter((issue) => issue.kind === "shared_key_source")
          .map((issue) => ({ ...issue, of: result.name })),
      );

    const before = await findings();
    expect(before.map((finding) => finding.of)).toEqual(["claude:glm", "claude:flash"]);
    expect(before.every((finding) => finding.severity === "warning")).toBe(true);
    const flash = before.find((finding) => finding.of === "claude:flash");
    expect(flash?.message).toContain("claude:glm");
    for (const argv of advisedCommands(flash?.message ?? "")) {
      const filled = argv.map((arg) => arg.replace(/<[A-Z_]+>/, "FLASH_KEY"));
      await h.run(filled[0], ...filled.slice(1));
    }

    expect(await findings()).toEqual([]);
  });
});

/**
 * A key source a hand edit left as something other than keychain, env or command. clausona
 * cannot say where that key comes from, so it says exactly that - not `<hidden>`, and not the
 * advice for a command - and doctor reports it with the command that gives it a real one.
 */
describe("a key source clausona does not know", () => {
  const UNKNOWN = { ...API_PROFILE, api: { ...API_PROFILE.api, secret: { source: "vault", path: "v-secret-0043" } } };

  it("is a doctor finding whose command fixes it, and is never resolved", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": UNKNOWN });
    const issues = async () =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[]).flatMap((result) => result.issues);

    const before = await issues();
    const [finding] = before.filter((issue) => issue.kind === "invalid_api_config");
    expect(finding?.message).toContain("not keychain, env or command");
    // Resolving it would read the store and advise --key for the wrong reason.
    expect(before.map((issue) => issue.kind)).not.toContain("missing_api_secret");
    expect(JSON.stringify(before)).not.toContain("v-secret");

    const [first] = advisedCommands(finding.message);
    promptAnswers.push(KEY);
    await h.run(first[0], ...first.slice(1));

    expect(h.profile("claude:gw").api?.secret).toEqual({ source: "keychain" });
    expect((await issues()).filter((issue) => issue.kind === "invalid_api_config")).toEqual([]);
  });

  it("is described as unknown by --show and by the notes, and advised on as unknown", async () => {
    const h = await harness({ "claude:gw": UNKNOWN });

    expect(stripAnsi(String(await h.run("config", "claude:gw", "--show")))).toMatch(/Key +unknown/);
    await h.run("config", "claude:gw", "--base-url", "https://gw.example.com/api");
    await h.run("config", "claude:gw", "--set", "ANTHROPIC_AUTH_TOKEN=sk-fake-plain-0044");

    const notes = stripAnsi(h.stderr());
    expect(notes).toContain("an unknown key source");
    expect(notes).not.toContain("<hidden>");
    expect(notes).not.toContain("the command print");
    expect(notes).not.toContain("already comes from");
    expect(advisedCommands(notes).map((argv) => argv.slice(2).join(" "))).toContain("--key");
  });
});

/**
 * The kind, the label and the auth scheme are printed as stored, and a hand edit can put a
 * terminal escape in any of them. Output drops their control characters, and doctor reports a
 * kind or a scheme clausona does not know. Nothing refuses to load.
 */
describe("a hand-edited kind, label or auth scheme", () => {
  const ESCAPES = "\u001b]0;owned\u0007\u001b[2J\u009b31m";
  /** A control character other than a line break or a tab, raw or escaped the way JSON writes one. */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\\u00[0-9a-f]{2}/i;

  it("prints none of their control characters, in text or in --json", async () => {
    const h = await harness({
      "claude:gw": {
        ...API_PROFILE,
        label: `gw${ESCAPES}`,
        api: { ...API_PROFILE.api, authScheme: `bearer${ESCAPES}` },
      },
      "claude:odd": { tool: "claude", email: "odd@example.com", kind: `subscription${ESCAPES}` },
    });

    const outputs = [
      await h.run("list", "--no-quota"),
      await h.run("list", "--json", "--no-quota"),
      await h.run("config", "claude:gw", "--show"),
      await h.run("config", "claude:gw", "--show", "--json"),
      await h.run("config", "claude:odd", "--show", "--json"),
    ].map((output) => stripAnsi(String(output)));

    for (const output of outputs) expect(output).not.toMatch(CONTROL);
    expect(outputs[2]).toContain("gw]0;owned");
  });

  // Stripped of its control character, `api\u0007` would print as a valid `api` while launch
  // treats it as a subscription. It is neither, so it is shown as neither.
  it("shows a kind that is neither as unknown, not as the kind it resembles", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:odd": { ...API_PROFILE, kind: "api\u0007" } });
    await h.run("use", "claude:odd");

    const listed = JSON.parse(String(await h.run("list", "--json", "--no-quota"))) as { name: string; kind?: string }[];
    const shown = JSON.parse(String(await h.run("config", "claude:odd", "--show", "--json"))) as {
      profile: { kind: string };
    };
    const current = JSON.parse(String(await h.run("current", "--json"))) as Record<string, { kind?: string }>;
    const text = stripAnsi(String(await h.run("config", "claude:odd", "--show")));

    expect(listed.find((item) => item.name === "claude:odd")?.kind).toBe("unknown");
    expect(shown.profile.kind).toBe("unknown");
    expect(current.claude?.kind).toBe("unknown");
    expect(text).toMatch(/Kind\s+unknown/);
    const doctor = JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[];
    expect(doctor.find((result) => result.name === "claude:odd")?.issues.map((issue) => issue.kind)).toContain(
      "invalid_profile_kind",
    );
  });

  it("is reported by doctor when the kind or the scheme is not one there is, and --auth fixes the scheme", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({
      "claude:gw": { ...API_PROFILE, api: { ...API_PROFILE.api, authScheme: "Bearer" } },
      "claude:odd": { tool: "claude", email: "odd@example.com", kind: "API" },
    });
    const findings = async (kind: string) =>
      (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[]).flatMap((result) =>
        result.issues.filter((issue) => issue.kind === kind).map((issue) => ({ ...issue, of: result.name })),
      );

    const [scheme] = await findings("invalid_api_config");
    const [kind] = await findings("invalid_profile_kind");
    expect(scheme?.of).toBe("claude:gw");
    expect(scheme.message).not.toContain("Bearer");
    expect(kind?.of).toBe("claude:odd");

    const [first] = advisedCommands(scheme.message);
    await h.run(first[0], ...first.slice(1));

    expect(h.profile("claude:gw").api?.authScheme).toBe("bearer");
    expect(await findings("invalid_api_config")).toEqual([]);
  });

  it("gets a remedy that works for a kind that is not one there is, and remove deletes its stored key", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness();
    promptAnswers.push(KEY);
    await h.run("add", "claude:kc", "--api", "--base-url", "https://openrouter.ai/api");
    const registry = h.registry();
    registry.profiles["claude:kc"] = { ...registry.profiles["claude:kc"], kind: "API" as Profile["kind"] };
    writeFileSync(path.join(h.home, ".clausona", "profiles.json"), JSON.stringify(registry));

    const report = stripAnsi(String(await h.run("doctor")));
    await h.run("remove", "claude:kc");

    // remove keeps the config directory, so adding it again under its own name is refused.
    expect(report).toContain("add it again under a new name");
    // Read as a subscription, it lacks a login - but signing one in would make what was
    // meant as an API profile's directory a subscription's.
    expect(report).not.toContain("clausona login claude:kc");
    expect(h.storedSecrets()).toEqual({});
  });
});

/**
 * An env map a hand edit left as a list or a string. It is applied as nothing - no key of
 * it is a variable name - and printed as `<hidden>`, so doctor is where it is found. The
 * remedy is --edit, which opens what is there and saves the object it is given.
 */
describe("an env map that is not a map", () => {
  for (const [label, env, profile] of [
    ["a list, on an API profile", ["ANTHROPIC_AUTH_TOKEN=sk-fake-list-0006"], API_PROFILE],
    [
      "a string, on a subscription profile",
      "ANTHROPIC_AUTH_TOKEN=sk-fake-string-0007",
      { tool: "claude", email: "w@x" },
    ],
  ] as const) {
    it(`is reported by doctor for ${label}, and the --edit it names fixes it`, async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const h = await harness({ "claude:gw": { ...profile, env } });
      const findings = async () =>
        (JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[])
          .flatMap((result) => result.issues)
          .filter((issue) => issue.kind === "invalid_env_map");

      const [finding] = await findings();
      expect(finding?.message).toBeDefined();
      expect(finding.message).not.toContain("sk-fake");
      const commands = advisedCommands(finding.message);
      expect(commands).toEqual([["config", "claude:gw", "--edit"]]);
      vi.stubEnv("EDITOR", "fake-editor");
      editor = (argv) => {
        writeFileSync(argv[argv.length - 1], JSON.stringify({ API_TIMEOUT_MS: "600000" }));
        return { status: 0 } as SpawnSyncReturns<string>;
      };
      await h.run(commands[0][0], ...commands[0].slice(1));

      expect(await findings()).toEqual([]);
      expect(h.profile("claude:gw").env).toEqual({ API_TIMEOUT_MS: "600000" });
    });
  }

  // Spread into an object, the content became index keys: `0=ANTHROPIC_AUTH_TOKEN=...` on
  // every path, and doctor went quiet. Every change that starts from the map refuses it with
  // doctor's sentence instead, and leaves the file as it was.
  for (const [label, env] of [
    ["a list", ["ANTHROPIC_AUTH_TOKEN=sk-fake-list-0006"]],
    ["a string", "ANTHROPIC_AUTH_TOKEN=sk-fake-string-0007"],
    ["a number", 42],
  ] as const) {
    it(`refuses --set, --model and --unset on ${label}, with the --edit that fixes it`, async () => {
      const h = await harness({ "claude:gw": { ...API_PROFILE, env } });
      const before = h.registryText();

      for (const args of [
        ["--set", "API_TIMEOUT_MS=1000"],
        ["--model", "z-ai/glm-5.3"],
        ["--unset", "ANTHROPIC_MODEL"],
      ]) {
        const message = await failure(h.run("config", "claude:gw", ...args));
        expect(message).toContain("not a map of NAME: value");
        expect(advisedCommands(message)).toEqual([["config", "claude:gw", "--edit"]]);
        expect(message).not.toContain("sk-fake");
      }
      expect(h.registryText()).toBe(before);
    });
  }

  // They apply exactly what `{}` does, so they are that everywhere: nothing to report, and
  // nothing to refuse.
  for (const [label, env] of [
    ["null", null],
    ["[]", []],
  ] as const) {
    it(`takes ${label} as the empty map it applies as`, async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const h = await harness({ "claude:gw": { ...API_PROFILE, env } });

      const report = JSON.parse(String(await h.run("doctor", "--json"))) as DoctorProfileResult[];
      expect(report.flatMap((result) => result.issues).map((issue) => issue.kind)).not.toContain("invalid_env_map");
      expect(stripAnsi(String(await h.run("config", "claude:gw", "--show")))).toMatch(/Settings +none/);

      await h.run("config", "claude:gw", "--set", "API_TIMEOUT_MS=1000");
      expect(h.profile("claude:gw").env).toEqual({ API_TIMEOUT_MS: "1000" });
    });
  }

  // Its own message names the fix; `repair` rebuilds shared links and cannot touch it.
  it("is not sent to repair by the doctor report", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const h = await harness({ "claude:gw": { ...API_PROFILE, env: ["ANTHROPIC_AUTH_TOKEN=sk-fake-list-0006"] } });
    // The primary's shared directory, linked as `add` would have: a missing link is a real
    // reason to run repair, and would put the suggestion there for a reason of its own.
    symlinkSync(path.join(h.home, ".claude", "commands"), path.join(h.home, ".claude-gw", "commands"));

    const report = stripAnsi(String(await h.run("doctor")));

    expect(report).toContain("clausona config claude:gw --edit");
    expect(report).not.toContain("clausona repair claude:gw");
  });

  it("shows as <hidden> in config --show, not as its characters", async () => {
    const h = await harness({ "claude:gw": { ...API_PROFILE, env: "ANTHROPIC_AUTH_TOKEN=sk-fake-string-0007" } });

    const shown = stripAnsi(String(await h.run("config", "claude:gw", "--show")));

    expect(shown).toMatch(/Settings +<hidden>/);
    expect(shown).not.toContain("0=A");
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

  // The value was never on a command line here, so an error quoting it would be the only
  // place the key ever showed.
  it("refuses a key saved as a setting's value, without printing it", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    fakeEditor((file) => writeFileSync(file, JSON.stringify({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: KEY_SHAPED })));

    const message = await failure(h.run("config", "claude:gw", "--edit"));

    expect(message).toContain("shaped like an API key");
    expect(slicesIn(message, randomBody(KEY_SHAPED))).toEqual([]);
    expect(h.profile("claude:gw").env).toEqual({ ANTHROPIC_MODEL: "z-ai/glm-5.3" });
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

  // Windows has no POSIX modes - stat reports 0o666 for any writable file - so there the file
  // is kept private by the temp directory's place in the user's own profile, not by a mode.
  it.skipIf(process.platform === "win32")("writes the scratch file only for its owner", async () => {
    const h = await harness({
      "claude:gw": { ...API_PROFILE, env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-fake-hdr-0003" } },
    });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor(() => {});

    await h.run("config", "claude:gw", "--edit");

    expect(seen[0].mode).toBe(0o600);
    expect(seen[0].dirMode).toBe(0o700);
  });

  it("writes the scratch file in a directory of its own", async () => {
    const h = await harness({ "claude:gw": API_PROFILE });
    vi.stubEnv("EDITOR", "fake-editor");
    const seen = fakeEditor(() => {});

    await h.run("config", "claude:gw", "--edit");

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
    // The scheme moves with the host the way the label does, and plain http is remarked on.
    expect(help).toContain("auth scheme");
    expect(help).toContain("plain http");
    // --key would replace an env: or command: source, so the help says what to do instead -
    // and, for a source another profile reads too, gives this one its own, as the note does.
    expect(help).toContain("env: or command:");
    expect(help).toContain("another profile");
    expect(help).toContain("--key-from env:<ANOTHER_NAME>");
    expect(help).toContain("clausona config claude:gw --base-url http://localhost:8000");
  });

  it("tells `config` readers how to change the model, and where it is kept", async () => {
    const h = await harness();

    const help = await h.run("config", "--help");

    expect(help).toContain("--model");
    expect(help).toContain("stored as ANTHROPIC_MODEL");
    expect(help).toContain("--unset ANTHROPIC_MODEL");
    expect(help).toContain("clausona config claude:gw --model z-ai/glm-5.3-flash");
    expect(help).toContain("--model, --set and --edit alike");
  });

  it("tells `list` readers what the MODEL column is, and what its dash means", async () => {
    const h = await harness();

    const help = await h.run("list", "--help");

    expect(help).toContain("MODEL");
    expect(help).toContain("ANTHROPIC_MODEL");
    expect(help).toContain("pins none");
    // A Codex row shows the same dash for another reason, and a long id loses its middle.
    expect(help).toContain("Codex");
    expect(help).toContain("middle");
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
    expect(help).toContain("the --unset alone");
    expect(help).toContain("a hand edit can leave it a list or a string");
    // Two promises worth making explicit: the key is never printed, and a command key
    // source is executed - doctor is not a read-only inspection of the registry.
    expect(help).toContain("never prints the key");
    expect(help).toContain("is run");
    // Which three leave the profile healthy, so a warning is not read as breakage.
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
