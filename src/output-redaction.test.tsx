import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi } from "./lib/cli-style.js";
import type { DoctorProfileResult, SecretSource } from "./types.js";

/**
 * Every way a profile leaves the process, against every shape a secret takes in one.
 *
 * Output paths were guarded one at a time on this branch - `list --json` in Task 8, the
 * doctor's URLs in Task 9, `config --show`'s env map by a filter of its own - and the path
 * nobody looked at, `current --json`, printed an Authorization header verbatim. So this file
 * does not test a path. It plants one secret of every shape in a registry, as a hand-edited
 * profiles.json could hold them, runs every path over it, and searches what each one printed
 * for a slice of every secret: a secret cut short is still a leak.
 *
 * The one path allowed to carry them is `_shell-env`'s stdout, whose job is to hand them to
 * the tool. It is pinned byte for byte at the end instead.
 *
 * The harness is the one the other integration files use: HOME stubbed, secrets forced to the
 * file backend, and every spawn refused except the shell a `command:` key source runs in -
 * the planted commands are `exit` and `echo`. The platform is forced to linux, so no path
 * reaches for the Keychain.
 */

const temps: string[] = [];
let spawned: string[] = [];
const realPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./core/process.js");
  vi.doUnmock("./lib/secrets.js");
  vi.doUnmock("./core/quota-store.js");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

/** One secret per shape. Each is searched for by every 5-character window of it - see `leaks`. */
const PLANTED = {
  "a credential env value": "S1HDR-1d5e",
  "a second credential env value": "S1TOK-2e6f",
  "a credential env value on a subscription profile": "S1SUB-3a7b",
  "a json env value (a gateway's auth field)": "S1BODY-4b8c",
  "a base URL's username": "S2USER-5c9d",
  "a base URL's password": "S2PASS-6d0e",
  "a base URL's query": "S2QUERY-7e1f",
  "a base URL's fragment": "S2FRAG-8f2a",
  "the query of a base URL that is otherwise valid": "S2VQ-9a3b",
  "URL userinfo inside an env value": "S2PRX-0b4c",
  "URL userinfo without a scheme, inside an env value": "S2BARE-1c5d",
  "a command key source's command line": "S3CMD-2d6e",
  "an env key source whose name is a key": "S3ENV-3e7f",
  "a stored key": "S4STORED-4f8a",
  "the key a command prints": "S4CMDKEY-5a9b",
  "a field added to profiles.json by hand": "S5STRAY-6b0c",
  "the userinfo of a base URL that does not parse": "S2UNP-7c8d",
  "a secret under a name that is on no clear list (OTEL)": "S6OTL-8d9e",
  "a secret under a name that is on no clear list (Bedrock)": "S6BDK-9e0f",
  "scheme-less userinfo in a base URL": "S2BUR-1a2b",
  "a / in a scheme-less password in an env value": "S7SLA-3f4a",
  "userinfo in a URL after other words in an env value": "S7EMB-4a5b",
  "an env map that is a list": "S8ARR-5b6c",
  "an env map that is a string": "S8STR-6c7d",
} as const;

/**
 * Whether any part of `secret` is in `printed`. Not a prefix: a display that shows the last
 * few characters of a hidden value - "ends in …2e6f" - leaks as surely as one that shows the
 * first few, so every 5-character window is searched. Five, because that is the usual length
 * of such a hint, and every planted secret is at least twice it.
 *
 * And a second time with JSON punctuation, whitespace and numeric keys taken out, because a
 * string walked as if it were an object prints one character per key - `{"0":"S","1":"2"…}` -
 * which no substring search of the raw text finds.
 */
function leaks(printed: string, secret: string): boolean {
  const compact = printed.replace(/"\d+":/g, "").replace(/[\s"{}[\],:]/g, "");
  for (let start = 0; start + 5 <= secret.length; start++) {
    const window = secret.slice(start, start + 5);
    if (printed.includes(window) || compact.includes(window.replace(/[\s"{}[\],:]/g, ""))) return true;
  }
  return false;
}

const API_IDS = [
  "claude:leaky",
  "claude:valid",
  "claude:cmdok",
  "claude:envsrc",
  "claude:unparse",
  "claude:bare",
  "claude:envlist",
];
const ALL_IDS = ["claude:default", "claude:envstring", ...API_IDS];

async function harness() {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const home = mkdtempSync(path.join(tmpdir(), "clausona-redaction-"));
  temps.push(home);
  const primary = path.join(home, ".claude");
  mkdirSync(path.join(primary, "commands"), { recursive: true });
  writeFileSync(path.join(primary, "settings.json"), '{"theme":"dark"}');
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "primary@example.com" } }),
  );
  mkdirSync(path.join(home, ".clausona"), { recursive: true });

  const dir = (name: string) => {
    const configDir = path.join(home, `.claude-${name}`);
    mkdirSync(configDir, { recursive: true });
    return configDir;
  };
  const api = (baseUrl: string, secret: SecretSource) => ({ baseUrl, authScheme: "bearer", secret });

  const profiles = {
    "claude:default": {
      tool: "claude",
      configDir: primary,
      email: "primary@example.com",
      isPrimary: true,
      env: { ANTHROPIC_AUTH_TOKEN: PLANTED["a credential env value on a subscription profile"] },
    },
    // Everything at once, as only a hand-edited profiles.json could hold it: add and config
    // refuse a URL with userinfo, and nothing writes a field the registry has no name for.
    "claude:leaky": {
      tool: "claude",
      kind: "api",
      configDir: dir("leaky"),
      email: "",
      label: "leaky",
      api: api(
        `https://${PLANTED["a base URL's username"]}:${PLANTED["a base URL's password"]}@gw.example.com/api?key=${PLANTED["a base URL's query"]}#${PLANTED["a base URL's fragment"]}`,
        { source: "command", run: `exit 3 # ${PLANTED["a command key source's command line"]}` },
      ),
      env: {
        ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${PLANTED["a credential env value"]}`,
        ANTHROPIC_AUTH_TOKEN: PLANTED["a second credential env value"],
        CLAUDE_CODE_EXTRA_BODY: `{"api_key":"${PLANTED["a json env value (a gateway's auth field)"]}"}`,
        HTTPS_PROXY: `http://proxyuser:${PLANTED["URL userinfo inside an env value"]}@proxy.example.com:8080`,
        ALL_PROXY: `proxyuser:${PLANTED["URL userinfo without a scheme, inside an env value"]}@proxy.example.com:1080`,
        ANTHROPIC_MODEL: "z-ai/glm-5.3",
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${PLANTED["a secret under a name that is on no clear list (OTEL)"]}`,
        AWS_BEARER_TOKEN_BEDROCK: PLANTED["a secret under a name that is on no clear list (Bedrock)"],
        SOCKS_PROXY: `u:${PLANTED["a / in a scheme-less password in an env value"]}/x@proxy.example.com:1080`,
        CURL_ARGS: `--proxy http://u:${PLANTED["userinfo in a URL after other words in an env value"]}@proxy.example.com`,
      },
      apiKey: PLANTED["a field added to profiles.json by hand"],
    },
    // A URL add would accept - its query is where a gateway that takes the key as a
    // parameter would have it - and an apiKeyHelper, so doctor has a reason to name it.
    "claude:valid": {
      tool: "claude",
      kind: "api",
      configDir: dir("valid"),
      email: "",
      label: "gw.example.com",
      api: api(`https://gw.example.com/api?key=${PLANTED["the query of a base URL that is otherwise valid"]}`, {
        source: "keychain",
      }),
    },
    "claude:cmdok": {
      tool: "claude",
      kind: "api",
      configDir: dir("cmdok"),
      email: "",
      label: "localhost:8000",
      api: api("http://localhost:8000", { source: "command", run: `echo ${PLANTED["the key a command prints"]}` }),
    },
    // Env maps a hand edit left as a list and as a string, walked as objects before.
    "claude:envlist": {
      tool: "claude",
      kind: "api",
      configDir: dir("envlist"),
      email: "",
      label: "envlist",
      api: api("http://localhost:8002", { source: "env", name: "GW_KEY" }),
      env: [`ANTHROPIC_AUTH_TOKEN=${PLANTED["an env map that is a list"]}`],
    },
    "claude:envstring": {
      tool: "claude",
      configDir: dir("envstring"),
      email: "envstring@example.com",
      env: `ANTHROPIC_AUTH_TOKEN=${PLANTED["an env map that is a string"]}`,
    },
    // Parses, as an opaque URL whose "scheme" is the username and whose host is empty.
    "claude:bare": {
      tool: "claude",
      kind: "api",
      configDir: dir("bare"),
      email: "",
      label: "bare",
      api: api(`admin:${PLANTED["scheme-less userinfo in a base URL"]}@gw.example.com/api`, {
        source: "env",
        name: "GW_KEY",
      }),
    },
    // Task 9's canonical shape: a URL that does not parse, so nothing can take it apart.
    "claude:unparse": {
      tool: "claude",
      kind: "api",
      configDir: dir("unparse"),
      email: "",
      label: "unparse",
      api: api(`//admin:${PLANTED["the userinfo of a base URL that does not parse"]}@gw.example.com/api`, {
        source: "env",
        name: "GW_KEY",
      }),
    },
    "claude:envsrc": {
      tool: "claude",
      kind: "api",
      configDir: dir("envsrc"),
      email: "",
      label: "localhost:8001",
      api: api("http://localhost:8001", {
        source: "env",
        name: `sk-${PLANTED["an env key source whose name is a key"]}`,
      }),
    },
  };
  writeFileSync(path.join(home, ".claude-valid", "settings.json"), '{"apiKeyHelper":"op read op://vault/key"}');
  writeFileSync(
    path.join(home, ".clausona", "secrets.json"),
    JSON.stringify({ "claude:valid": PLANTED["a stored key"] }),
  );
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { claude: primary },
      activeProfiles: { claude: "claude:leaky" },
      profiles,
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("./core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/process.js")>();
    return {
      ...actual,
      // The shell a `command:` source runs in, and nothing else.
      spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) => {
        if (args[0] === "/bin/sh") return actual.spawnCommand(...args);
        spawned.push(args[0]);
        throw new Error(`test attempted to spawn '${args[0]}'`);
      },
      spawnCommandSync: (command: string) => {
        spawned.push(command);
        throw new Error(`test attempted to spawn '${command}'`);
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
  // No plan quota: the subscription primary would otherwise be looked up over the network.
  vi.doMock("./core/quota-store.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/quota-store.js")>();
    return { ...actual, collectQuotas: async () => ({}) };
  });

  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const { runCommand } = await import("./commands.js");
  const service = await import("./lib/service.js");
  const { ProfilePreview } = await import("./tui/components/ProfilePreview.js");

  return {
    home,
    service,
    ProfilePreview,
    run: async (command: string, ...args: string[]) => String(await runCommand(command, args)),
    /** What went to stderr since the last call, and forget it. */
    takeStderr: () => stderr.splice(0).join(""),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Runs `step` for every id in turn, joining what each printed. */
async function each(ids: string[], step: (id: string) => Promise<string>): Promise<string> {
  const out: string[] = [];
  for (const id of ids) out.push(await step(id));
  return out.join("\n");
}

/**
 * Every output path, as a function returning what it printed - stdout and stderr both.
 * Enumerated from the code, not from a list: a path that prints a profile field and is not
 * here is a path nobody is checking.
 */
const PATHS: Record<string, (h: Harness) => Promise<string>> = {
  // `current` shows the active profile, so each is made active in turn.
  current: (h) => each(ALL_IDS, async (id) => [await h.run("use", id), await h.run("current")].join("\n")),
  "current --json": (h) =>
    each(ALL_IDS, async (id) => [await h.run("use", id), await h.run("current", "--json")].join("\n")),
  list: (h) => h.run("list", "--no-quota"),
  "list --json": (h) => h.run("list", "--json", "--no-quota"),
  "config --show": (h) => each(ALL_IDS, (id) => h.run("config", id, "--show")),
  "config --show --json": (h) => each(ALL_IDS, (id) => h.run("config", id, "--show", "--json")),
  doctor: (h) => h.run("doctor"),
  "doctor --json": (h) => h.run("doctor", "--json"),
  "use (its confirmation line)": (h) => each(ALL_IDS, (id) => h.run("use", id)),
  // Launch-time diagnostics. The stdout of `_shell-env` is the key's way to the tool and is
  // pinned separately; what it writes to stderr is a message like any other.
  "_shell-env's warnings": (h) =>
    each(API_IDS, async (id) => {
      await h.run("use", id);
      h.takeStderr();
      await h.run("_shell-env", "claude");
      return h.takeStderr();
    }),
  // `clausona run <profile>` builds its environment through resolveProfileEnv, which writes
  // the same warnings; the tool itself is not started.
  "clausona run's warnings": (h) =>
    each(API_IDS, async (id) => {
      h.takeStderr();
      await h.service.resolveProfileEnv(id);
      return h.takeStderr();
    }),
  // The dashboard draws from these two calls and nothing else that carries a profile field.
  "the TUI's profile data (listProfiles detail)": async (h) =>
    JSON.stringify(await h.service.listProfiles({ detail: true })),
  "the TUI's doctor data": async (h) => JSON.stringify(await h.service.doctorProfiles()),
  "the TUI's preview panel": async (h) => {
    const [items, results] = await Promise.all([h.service.listProfiles({ detail: true }), h.service.doctorProfiles()]);
    return items
      .map((item) => {
        const doctor = results.find((result: DoctorProfileResult) => result.name === item.name);
        return render(<h.ProfilePreview profile={item} doctor={doctor} />).lastFrame() ?? "";
      })
      .join("\n");
  },
  "config's own messages": (h) =>
    each(API_IDS, async (id) => [await h.run("config", id, "--label", "Renamed"), h.takeStderr()].join("\n")),
};

describe.skipIf(process.platform === "win32")("every output path, every secret shape", () => {
  for (const [name, produce] of Object.entries(PATHS)) {
    it(`${name} prints none of them`, async () => {
      const h = await harness();

      // The temp HOME's random suffix is the one thing in the output that could match a
      // window by chance, so it is taken out first.
      const printed = stripAnsi(`${await produce(h)}\n${h.takeStderr()}`)
        .split(h.home)
        .join("~");

      expect(printed.length, name).toBeGreaterThan(0);
      // Every cell of the row at once, so a failure names all the shapes that got out.
      const leaked = Object.entries(PLANTED)
        .filter(([, secret]) => leaks(printed, secret))
        .map(([shape]) => shape);
      expect(leaked, name).toEqual([]);
    });
  }
});

/**
 * What redaction must not take away: where a profile points, how it authenticates, which
 * settings it has, and what went wrong. A path that printed nothing would pass the matrix.
 */
describe.skipIf(process.platform === "win32")("what every path still says", () => {
  it("config --show names the endpoint, the source and every setting, with the secrets cut out", async () => {
    const h = await harness();

    const shown = stripAnsi(await h.run("config", "claude:leaky", "--show"));

    expect(shown).toContain("https://<hidden>@gw.example.com/api?<hidden>#<hidden>");
    expect(shown).toMatch(/Key +command +│/);
    expect(shown).toContain("ANTHROPIC_CUSTOM_HEADERS (set; not shown");
    expect(shown).toContain("CLAUDE_CODE_EXTRA_BODY (set; not shown");
    expect(shown).toContain("HTTPS_PROXY=http://<hidden>@proxy.example.com:8080/");
    expect(shown).toContain("ALL_PROXY=<hidden>@proxy.example.com:1080");
    expect(shown).toContain("SOCKS_PROXY=<hidden>@proxy.example.com:1080");
    expect(shown).toContain("CURL_ARGS=--proxy http://<hidden>@proxy.example.com");
    expect(shown).toContain("ANTHROPIC_MODEL=z-ai/glm-5.3");
  });

  it("config --show --json keeps every key, and says which values it hid whole", async () => {
    const h = await harness();

    const { profile } = JSON.parse(await h.run("config", "claude:leaky", "--show", "--json"));

    expect(profile.api).toEqual({
      baseUrl: "https://<hidden>@gw.example.com/api?<hidden>#<hidden>",
      authScheme: "bearer",
      secret: { source: "command", run: "<hidden>" },
    });
    expect(Object.keys(profile.env)).toEqual([
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_EXTRA_BODY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "ANTHROPIC_MODEL",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "AWS_BEARER_TOKEN_BEDROCK",
      "SOCKS_PROXY",
      "CURL_ARGS",
    ]);
    expect(profile.hiddenEnvKeys).toEqual([
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_EXTRA_BODY",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "AWS_BEARER_TOKEN_BEDROCK",
    ]);
  });

  it("prints a URL with nothing to hide exactly as it is stored", async () => {
    const h = await harness();

    expect(stripAnsi(await h.run("config", "claude:cmdok", "--show"))).toMatch(/Endpoint +http:\/\/localhost:8000 +│/);
    expect(JSON.parse(await h.run("config", "claude:cmdok", "--show", "--json")).profile.api.baseUrl).toBe(
      "http://localhost:8000",
    );
  });

  it("current --json says what the active profile is, and nothing it cannot vouch for", async () => {
    const h = await harness();

    const { claude } = JSON.parse(await h.run("current", "--json"));

    expect(claude).toMatchObject({ id: "claude:leaky", kind: "api", label: "leaky" });
    expect(claude).not.toHaveProperty("apiKey");
    expect(claude.env.ANTHROPIC_AUTH_TOKEN).toBe("<hidden>");
  });

  it("doctor still names the endpoint a helper's key can reach, and says what failed", async () => {
    const h = await harness();

    const report = stripAnsi(await h.run("doctor"));

    expect(report).toContain("can reach https://gw.example.com/api?<hidden>");
    expect(report).toContain("secret command exited with 3");
  });

  it("doctor tells a profile whose key variable is not a name how to fix it, and the command runs", async () => {
    const h = await harness();
    const results = JSON.parse(await h.run("doctor", "--json")) as DoctorProfileResult[];
    const message = results.find((result) => result.name === "claude:envsrc")?.issues[0]?.message ?? "";

    const command = message.match(/clausona (config \S+ --key-from env:[^\s']+)/)?.[1];
    expect(command, message).toBeDefined();
    const [verb, id, flag, source] = (command as string).replace("<NAME>", "GW_KEY").split(" ");
    await h.run(verb, id, flag, source);

    expect(JSON.parse(await h.run("config", "claude:envsrc", "--show", "--json")).profile.api.secret).toEqual({
      source: "env",
      name: "GW_KEY",
    });
  });

  it("the preview panel shows the endpoint with the secrets cut out, and the source by kind", async () => {
    const h = await harness();
    const items = await h.service.listProfiles({ detail: true });

    const frame = render(<h.ProfilePreview profile={items.find((item) => item.name === "claude:leaky")} />).lastFrame();

    expect(frame).toContain("https://<hidden>@gw.example.com");
    expect(frame).toMatch(/Key +command/);
  });
});

/**
 * The exception. `_shell-env` is how the key reaches the tool, so its stdout carries every
 * value as stored - redacting it would hand Claude Code `<hidden>` as a credential. Pinned
 * byte for byte, as it was before any redaction existed, so no change to what the rest of
 * clausona prints can reach it.
 */
describe.skipIf(process.platform === "win32")("_shell-env's stdout, the one path that carries them", () => {
  const exportsFor = async (id: string) => {
    const h = await harness();
    await h.run("use", id);
    return (await h.run("_shell-env", "claude")).split(h.home).join("~");
  };

  it("exports the leaky profile's values exactly as stored", async () => {
    const out = await exportsFor("claude:leaky");

    // The values themselves, which every other path hides.
    expect(out).toContain(PLANTED["a credential env value"]);
    expect(out).toContain(PLANTED["URL userinfo inside an env value"]);
    expect(out).not.toContain("<hidden>");
    expect(out).toMatchInlineSnapshot(`
      "if ( unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_EXTRA_BODY HTTPS_PROXY ALL_PROXY ANTHROPIC_MODEL OTEL_EXPORTER_OTLP_HEADERS AWS_BEARER_TOKEN_BEDROCK SOCKS_PROXY CURL_ARGS ) 2>/dev/null; then :; else for _clausona_name in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_EXTRA_BODY HTTPS_PROXY ALL_PROXY ANTHROPIC_MODEL OTEL_EXPORTER_OTLP_HEADERS AWS_BEARER_TOKEN_BEDROCK SOCKS_PROXY CURL_ARGS; do ( unset $_clausona_name ) 2>/dev/null || printf 'clausona: %s is read-only in this shell, so clausona cannot set or clear it for this profile. Not starting the tool.\\n' $_clausona_name >&2; done; exit 1; fi
      unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL
      export CLAUDE_CONFIG_DIR='~/.claude-leaky'
      export ANTHROPIC_BASE_URL='https://S2USER-5c9d:S2PASS-6d0e@gw.example.com/api?key=S2QUERY-7e1f#S2FRAG-8f2a'
      export ANTHROPIC_CUSTOM_HEADERS='Authorization: Bearer S1HDR-1d5e'
      export ANTHROPIC_AUTH_TOKEN='S1TOK-2e6f'
      export CLAUDE_CODE_EXTRA_BODY='{"api_key":"S1BODY-4b8c"}'
      export HTTPS_PROXY='http://proxyuser:S2PRX-0b4c@proxy.example.com:8080'
      export ALL_PROXY='proxyuser:S2BARE-1c5d@proxy.example.com:1080'
      export ANTHROPIC_MODEL='z-ai/glm-5.3'
      export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer S6OTL-8d9e'
      export AWS_BEARER_TOKEN_BEDROCK='S6BDK-9e0f'
      export SOCKS_PROXY='u:S7SLA-3f4a/x@proxy.example.com:1080'
      export CURL_ARGS='--proxy http://u:S7EMB-4a5b@proxy.example.com'"
    `);
  });

  it("exports the key a command prints", async () => {
    const out = await exportsFor("claude:cmdok");

    expect(out).toContain(PLANTED["the key a command prints"]);
    expect(out).toMatchInlineSnapshot(`
      "if ( unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ) 2>/dev/null; then :; else for _clausona_name in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL CLAUDE_CONFIG_DIR ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; do ( unset $_clausona_name ) 2>/dev/null || printf 'clausona: %s is read-only in this shell, so clausona cannot set or clear it for this profile. Not starting the tool.\\n' $_clausona_name >&2; done; exit 1; fi
      unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR ANTHROPIC_IDENTITY_TOKEN ANTHROPIC_IDENTITY_TOKEN_FILE ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID CLAUDE_CODE_HOST_AUTH_ENV_VAR CLAUDE_CODE_HOST_CREDS_FILE CLAUDE_CODE_SESSION_ACCESS_TOKEN CLAUDE_SESSION_INGRESS_TOKEN_FILE CLAUDE_BG_AUTH_SNAPSHOT_PATH CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ANTHROPIC_UNIX_SOCKET CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CLAUDE_CODE_CUSTOM_OAUTH_URL
      export CLAUDE_CONFIG_DIR='~/.claude-cmdok'
      export ANTHROPIC_BASE_URL='http://localhost:8000'
      export ANTHROPIC_AUTH_TOKEN='S4CMDKEY-5a9b'"
    `);
  });
});
