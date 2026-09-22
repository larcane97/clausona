import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPosixShellInit } from "./core/shell.js";

/**
 * `_shell-env` is the one command whose stdout the user's shell runs:
 * `eval "$(clausona _shell-env claude)"`. Everything here drives the command case end to
 * end rather than the renderer alone, because the interesting failures (a hostile key in
 * a hand-edited profiles.json, a secret that will not resolve, a registry that is not
 * there) live in the path between loading the registry and printing a line.
 *
 * The seam is HOME: service.ts derives its ~/.clausona path from homedir() at import
 * time, so stubbing HOME and re-importing the module graph points the whole command at a
 * temp directory. Same pattern as src/lib/secrets.test.ts.
 */

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Harness = {
  home: string;
  /** Directory the fixture profiles point at. */
  workDir: string;
  /** stderr chunks the command wrote, one per warning. */
  warnings: string[];
  run: (...args: string[]) => Promise<string>;
};

/**
 * `makeRegistry` returns the profiles.json contents; returning undefined writes no file
 * at all, which is the "clausona was never initialised" case.
 */
async function harness(makeRegistry: (home: string, workDir: string) => unknown): Promise<Harness> {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-shell-env-"));
  temps.push(home);
  const workDir = path.join(home, ".claude-work");
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const registry = makeRegistry(home, workDir);
  if (registry !== undefined) {
    writeFileSync(path.join(home, ".clausona", "profiles.json"), JSON.stringify(registry));
  }

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  const { runCommand } = await import("./commands.js");

  const warnings: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });

  return { home, workDir, warnings, run: (...args: string[]) => runCommand("_shell-env", args) };
}

function registryWith(profile: Record<string, unknown>, home: string, id = "claude:work") {
  return {
    version: 2,
    primarySources: { claude: path.join(home, ".claude") },
    activeProfiles: { claude: id },
    profiles: { [id]: profile },
  };
}

const NAMES = "[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*";

/**
 * Reverses renderPosixExports for values that carry no newline. An unset reads back as
 * null, which is how `--json` names the same variable. The guard line is checked for shape
 * and skipped: `guardedNames` reads the names out of it instead.
 */
function parseExports(out: string): Record<string, string | null> {
  const parsed: Record<string, string | null> = {};
  for (const line of out.split("\n")) {
    if (line === "") continue;
    if (guardedNames(line) !== undefined) continue;
    const unset = line.match(new RegExp(`^unset (${NAMES})$`));
    if (unset) {
      for (const name of (unset[1] as string).split(" ")) parsed[name] = null;
      continue;
    }
    const match = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)='([\s\S]*)'$/);
    expect(match, line).not.toBeNull();
    if (match) parsed[match[1] as string] = (match[2] as string).replaceAll("'\\''", "'");
  }
  return parsed;
}

/** The names one guard line probes, or undefined when the line is not a guard. */
function guardedNames(line: string): string[] | undefined {
  const match = line.match(
    new RegExp(
      `^if \\( unset (${NAMES}) \\) 2>/dev/null; then :; else for _clausona_name in \\1; do \\( unset \\$_clausona_name \\) 2>/dev/null \\|\\| printf '[^']*' \\$_clausona_name >&2; done; exit 1; fi$`,
    ),
  );
  return match ? (match[1] as string).split(" ") : undefined;
}

/**
 * Everything an API profile clears beyond the three auth variables and custom headers, as
 * `--json` names it: the other credential sources, then every routing variable.
 */
const CLEARED_REST = {
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: null,
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: null,
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: null,
  CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: null,
  CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: null,
  ANTHROPIC_IDENTITY_TOKEN: null,
  ANTHROPIC_IDENTITY_TOKEN_FILE: null,
  ANTHROPIC_FEDERATION_RULE_ID: null,
  ANTHROPIC_ORGANIZATION_ID: null,
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: null,
  CLAUDE_CODE_HOST_CREDS_FILE: null,
  CLAUDE_CODE_USE_BEDROCK: null,
  CLAUDE_CODE_USE_VERTEX: null,
  CLAUDE_CODE_USE_GATEWAY: null,
  CLAUDE_CODE_USE_MANTLE: null,
  CLAUDE_CODE_USE_FOUNDRY: null,
  CLAUDE_CODE_USE_ANTHROPIC_AWS: null,
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: null,
  ANTHROPIC_UNIX_SOCKET: null,
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: null,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: null,
};

describe("_shell-env", () => {
  // Regression test for a shell-injection hole: keys used to be interpolated bare, so
  // `export A; touch /tmp/clausona-pwned; B='x'` came out of a hand-edited profiles.json
  // and the shell's eval ran it as three commands.
  it("never emits a key carrying shell metacharacters, and names each one on stderr", async () => {
    const hostile = {
      "A; touch /tmp/clausona-pwned; B": "x",
      "A $(id)": "x",
      "A `id`": "x",
      "A B": "x",
      "A=B": "x",
      "9LEADING": "x",
    };
    const h = await harness((home, workDir) =>
      registryWith(
        { tool: "claude", configDir: workDir, email: "you@example.com", env: { ...hostile, ANTHROPIC_MODEL: "m" } },
        home,
      ),
    );

    const out = await h.run("claude");

    for (const line of out.split("\n")) expect(line).toMatch(/^export [A-Za-z_][A-Za-z0-9_]*='/);
    expect(out).not.toContain("touch");
    expect(out).not.toContain("$(id)");
    expect(out).not.toContain("`id`");
    expect(parseExports(out)).toEqual({ CLAUDE_CONFIG_DIR: h.workDir, ANTHROPIC_MODEL: "m" });

    expect(h.warnings).toHaveLength(Object.keys(hostile).length);
    for (const key of Object.keys(hostile)) {
      expect(
        h.warnings.some((w) => w.includes(key)),
        key,
      ).toBe(true);
    }
    expect(h.warnings.every((w) => w.includes("not a valid environment variable name"))).toBe(true);
  });

  // kind: undefined means subscription, and those profiles must keep behaving exactly as
  // they did before API profiles existed - one export, or none at all.
  it("emits only the config-dir export for a subscription profile", async () => {
    const h = await harness((home, workDir) =>
      registryWith({ tool: "claude", configDir: workDir, email: "you@example.com" }, home),
    );
    expect(await h.run("claude")).toBe(`export CLAUDE_CONFIG_DIR='${h.workDir}'`);
    expect(h.warnings).toEqual([]);
  });

  it("emits nothing for a primary subscription profile", async () => {
    const h = await harness((home) =>
      registryWith({ tool: "claude", configDir: path.join(home, ".claude"), email: "a@b.c", isPrimary: true }, home),
    );
    expect(await h.run("claude")).toBe("");
    expect(h.warnings).toEqual([]);
  });

  it("keeps the other variables and warns once when the secret will not resolve", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "local",
          api: {
            baseUrl: "http://localhost:8000",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_ABSENT_SECRET" },
          },
          env: { ANTHROPIC_MODEL: "m" },
        },
        home,
      ),
    );

    const out = await h.run("claude");

    expect(parseExports(out)).toEqual({
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_CUSTOM_HEADERS: null,
      ...CLEARED_REST,
      CLAUDE_CONFIG_DIR: h.workDir,
      ANTHROPIC_BASE_URL: "http://localhost:8000",
      ANTHROPIC_MODEL: "m",
    });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("CLAUSONA_TEST_ABSENT_SECRET");
  });

  it("drops a reserved key from the env map without duplicating the export", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          configDir: workDir,
          email: "you@example.com",
          env: { CLAUDE_CONFIG_DIR: "/evil", ANTHROPIC_MODEL: "m" },
        },
        home,
      ),
    );

    const out = await h.run("claude");

    expect(out.match(/^export CLAUDE_CONFIG_DIR=/gm)).toHaveLength(1);
    expect(out).not.toContain("/evil");
    expect(parseExports(out)).toEqual({ CLAUDE_CONFIG_DIR: h.workDir, ANTHROPIC_MODEL: "m" });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("CLAUDE_CONFIG_DIR");
  });

  // The PowerShell hook reads --json, so the two paths must describe the same environment.
  it("describes the same environment through --json as through the export lines", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "local",
          api: {
            baseUrl: "http://localhost:8000",
            authScheme: "api-key",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
          env: { ANTHROPIC_MODEL: "m", "A B": "dropped", API_TIMEOUT_MS: "600000" },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-not-a-real-key");

    const posix = parseExports(await h.run("claude"));
    const json = JSON.parse(await h.run("claude", "--json")) as Record<string, string | null>;

    expect(json).toEqual(posix);
    expect(json).toEqual({
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_CUSTOM_HEADERS: null,
      ...CLEARED_REST,
      CLAUDE_CONFIG_DIR: h.workDir,
      ANTHROPIC_BASE_URL: "http://localhost:8000",
      ANTHROPIC_API_KEY: "sk-not-a-real-key",
      ANTHROPIC_MODEL: "m",
      API_TIMEOUT_MS: "600000",
    });
  });

  // The PowerShell hook hands each value to SetEnvironmentVariable, which removes a
  // variable it is given $null for - so null is how --json says "must not be inherited".
  it("names each variable an API profile clears with a JSON null", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "router",
          api: {
            baseUrl: "https://openrouter.ai/api",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-or-not-a-real-key");

    const raw = await h.run("claude", "--json");

    expect(raw).toContain('"ANTHROPIC_API_KEY":null');
    expect(raw).toContain('"CLAUDE_CODE_OAUTH_TOKEN":null');
    expect(JSON.parse(raw)).toEqual({
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_CUSTOM_HEADERS: null,
      ...CLEARED_REST,
      CLAUDE_CONFIG_DIR: h.workDir,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-not-a-real-key",
    });
  });

  // PowerShell's ConvertFrom-Json refuses an object with two keys that differ only in case,
  // and the hook's catch would then apply no profile at all - default account, no warning.
  it("never emits two JSON keys that are one variable on Windows", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "router",
          api: {
            baseUrl: "https://openrouter.ai/api",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
          env: { anthropic_custom_headers: "X-Team: platform", claude_config_dir: "/evil", MY_FLAG: "1", my_flag: "2" },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-or-not-a-real-key");

    const keys = Object.keys(JSON.parse(await h.run("claude", "--json")) as Record<string, unknown>);

    const folded = keys.map((key) => key.toUpperCase());
    expect(new Set(folded).size).toBe(keys.length);
    expect(keys).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(keys).toContain("MY_FLAG");
    expect(h.warnings).toHaveLength(3);
  });

  // On POSIX the profile must be able to set its own names as well as clear the others, so
  // the guard covers both. Windows has no readonly variables, so --json is unaffected.
  it("guards every name it clears and every managed name it sets, in one probe", async () => {
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "router",
          api: {
            baseUrl: "https://openrouter.ai/api",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
          env: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform", ANTHROPIC_MODEL: "glm-5.3" },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-or-not-a-real-key");

    const lines = (await h.run("claude")).split("\n");
    const guarded = guardedNames(lines[0] as string);

    const cleared = Object.entries(parseExports(await h.run("claude")))
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    expect(guarded).toEqual([
      ...cleared,
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]);
    // The user's own name is theirs to break; clausona does not refuse to launch over it.
    expect(guarded).not.toContain("ANTHROPIC_MODEL");
    // One probe for all of them, before anything is unset or exported.
    expect(lines.filter((line) => guardedNames(line) !== undefined)).toHaveLength(1);
    expect(lines[1]).toMatch(/^unset /);
  });

  /**
   * kind: undefined means subscription, and a subscription profile clears nothing: its
   * output, in both forms, is pinned byte for byte as it was before API profiles could
   * clear a variable. JSON.stringify on the path keeps the expectation right on Windows,
   * where the separators are backslashes JSON has to escape.
   */
  describe("subscription output, byte for byte", () => {
    const cases: [string, (home: string, workDir: string) => Record<string, unknown>][] = [
      ["no kind", (_home, workDir) => ({ tool: "claude", configDir: workDir, email: "you@example.com" })],
      [
        "an explicit subscription kind",
        (_home, workDir) => ({ tool: "claude", kind: "subscription", configDir: workDir, email: "you@example.com" }),
      ],
    ];
    for (const [name, make] of cases) {
      it(`emits one export and one JSON key for ${name}`, async () => {
        const h = await harness((home, workDir) => registryWith(make(home, workDir), home));
        expect(await h.run("claude")).toBe(`export CLAUDE_CONFIG_DIR='${h.workDir}'`);
        expect(await h.run("claude", "--json")).toBe(`{"CLAUDE_CONFIG_DIR":${JSON.stringify(h.workDir)}}`);
      });
    }

    it("emits an env map in order, with nothing cleared ahead of it", async () => {
      const h = await harness((home, workDir) =>
        registryWith(
          {
            tool: "claude",
            configDir: workDir,
            email: "you@example.com",
            // Credential names on purpose: on a subscription profile they are the user's
            // own choice and are exported like any other entry.
            env: { ANTHROPIC_MODEL: "m", ANTHROPIC_API_KEY: "sk-mine" },
          },
          home,
        ),
      );
      expect(await h.run("claude")).toBe(
        `export CLAUDE_CONFIG_DIR='${h.workDir}'\nexport ANTHROPIC_MODEL='m'\nexport ANTHROPIC_API_KEY='sk-mine'`,
      );
      expect(await h.run("claude", "--json")).toBe(
        `{"CLAUDE_CONFIG_DIR":${JSON.stringify(h.workDir)},"ANTHROPIC_MODEL":"m","ANTHROPIC_API_KEY":"sk-mine"}`,
      );
    });

    it("emits nothing at all for a primary profile", async () => {
      const h = await harness((home) =>
        registryWith({ tool: "claude", configDir: path.join(home, ".claude"), email: "a@b.c", isPrimary: true }, home),
      );
      expect(await h.run("claude")).toBe("");
      expect(await h.run("claude", "--json")).toBe("{}");
    });
  });

  describe("degenerate input", () => {
    it("returns nothing when no tool is named", async () => {
      const h = await harness((home, workDir) =>
        registryWith({ tool: "claude", configDir: workDir, email: "a@b.c" }, home),
      );
      await expect(h.run()).resolves.toBe("");
      await expect(h.run("--json")).resolves.toBe("");
    });

    it("returns nothing for a tool clausona does not manage", async () => {
      const h = await harness((home, workDir) =>
        registryWith({ tool: "claude", configDir: workDir, email: "a@b.c" }, home),
      );
      await expect(h.run("gemini")).resolves.toBe("");
    });

    it("returns nothing when there is no registry at all", async () => {
      const h = await harness(() => undefined);
      await expect(h.run("claude")).resolves.toBe("");
    });

    it("returns nothing when the tool has no active profile", async () => {
      const h = await harness(() => ({
        version: 2,
        primarySources: {},
        activeProfiles: {},
        profiles: {},
      }));
      await expect(h.run("claude")).resolves.toBe("");
    });

    it("returns nothing when the active id is not in the registry", async () => {
      const h = await harness((home) => ({
        version: 2,
        primarySources: { claude: path.join(home, ".claude") },
        activeProfiles: { claude: "claude:ghost" },
        profiles: {},
      }));
      await expect(h.run("claude")).resolves.toBe("");
    });
  });

  // The end of the real path: what the shell function actually does with this stdout.
  it.skipIf(process.platform === "win32")("survives eval in a real shell with a hostile secret", async () => {
    const secret = "a'b$c`d\ne;f\\g";
    const h = await harness((home, workDir) =>
      registryWith(
        {
          tool: "claude",
          kind: "api",
          configDir: workDir,
          email: "",
          label: "local",
          api: {
            baseUrl: "http://localhost:8000",
            authScheme: "bearer",
            secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
          },
        },
        home,
      ),
    );
    vi.stubEnv("CLAUSONA_TEST_SECRET", secret);

    const out = await h.run("claude");
    const outPath = path.join(h.home, "shell-env.sh");
    writeFileSync(outPath, out);

    const result = spawnSync("/bin/sh", ["-c", `eval "$(cat '${outPath}')"\nprintf %s "$ANTHROPIC_AUTH_TOKEN"`], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(secret);
  });

  /**
   * The leak this guards against, end to end: Claude Code sends X-Api-Key and
   * Authorization together when both variables are set, so an ANTHROPIC_API_KEY the user
   * exported in their rc file would go to a bearer profile's third-party endpoint on every
   * request. The script has the hook's own shape - eval inside a subshell, launch a
   * process there, return - and `env` stands in for the tool, reporting exactly the
   * environment a process launched in that subshell inherits.
   */
  it.skipIf(process.platform === "win32")(
    "keeps a credential the parent shell exported away from a bearer profile's tool",
    async () => {
      const parentKey = "sk-ant-parent-sentinel";
      const parentOauth = "sk-ant-oat-parent-sentinel";
      const profileToken = "sk-or-profile-token";
      const h = await harness((home, workDir) =>
        registryWith(
          {
            tool: "claude",
            kind: "api",
            configDir: workDir,
            email: "",
            label: "router",
            api: {
              baseUrl: "https://openrouter.ai/api",
              authScheme: "bearer",
              secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
            },
          },
          home,
        ),
      );
      // clausona itself runs in the same shell, so it sees the parent's variables too.
      vi.stubEnv("ANTHROPIC_API_KEY", parentKey);
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", parentOauth);
      vi.stubEnv("CLAUSONA_TEST_SECRET", profileToken);

      const out = await h.run("claude");
      const outPath = path.join(h.home, "shell-env.sh");
      const childEnvPath = path.join(h.home, "child.env");
      writeFileSync(outPath, out);

      const script = [
        "(",
        `  eval "$(cat '${outPath}')"`,
        `  env > '${childEnvPath}'`,
        ")",
        `printf 'parent ANTHROPIC_API_KEY=%s\\n' "$ANTHROPIC_API_KEY"`,
        `printf 'parent CLAUDE_CODE_OAUTH_TOKEN=%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN"`,
      ].join("\n");
      const result = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: parentKey, CLAUDE_CODE_OAUTH_TOKEN: parentOauth },
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const childText = readFileSync(childEnvPath, "utf8");
      const child = Object.fromEntries(
        childText
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      // The tool sees the profile's own credential and nothing that competes with it...
      expect(child.ANTHROPIC_AUTH_TOKEN).toBe(profileToken);
      expect(child.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
      expect(child).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(child).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(childText).not.toContain(parentKey);
      expect(childText).not.toContain(parentOauth);
      // ...and the parent shell, which the subshell cannot touch, still has both of its own.
      expect(result.stdout).toBe(
        `parent ANTHROPIC_API_KEY=${parentKey}\nparent CLAUDE_CODE_OAUTH_TOKEN=${parentOauth}\n`,
      );
    },
  );

  /**
   * The same leak through the warning path: when the profile's key will not resolve, its
   * own variable is missing from the output - and an inherited one of the same name would
   * authenticate the tool against the third-party endpoint in its place. Every credential
   * variable comes from the profile or not at all, so the tool reports its own auth error.
   */
  for (const [authScheme, ownVar] of [
    ["bearer", "ANTHROPIC_AUTH_TOKEN"],
    ["api-key", "ANTHROPIC_API_KEY"],
  ] as const) {
    it.skipIf(process.platform === "win32")(
      `keeps an inherited ${ownVar} from a ${authScheme} profile whose key will not resolve`,
      async () => {
        const parentValue = "sk-ant-parent-sentinel";
        const h = await harness((home, workDir) =>
          registryWith(
            {
              tool: "claude",
              kind: "api",
              configDir: workDir,
              email: "",
              label: "router",
              api: {
                baseUrl: "https://openrouter.ai/api",
                authScheme,
                secret: { source: "env", name: "CLAUSONA_TEST_ABSENT_SECRET" },
              },
            },
            home,
          ),
        );
        vi.stubEnv(ownVar, parentValue);

        const out = await h.run("claude");
        const outPath = path.join(h.home, "shell-env.sh");
        const childEnvPath = path.join(h.home, "child.env");
        writeFileSync(outPath, out);

        const script = [
          "(",
          `  eval "$(cat '${outPath}')"`,
          `  env > '${childEnvPath}'`,
          ")",
          `printf 'parent ${ownVar}=%s\\n' "$${ownVar}"`,
        ].join("\n");
        // With every key cleared, workload identity federation is next in line in Claude
        // Code, and it would exchange the parent's identity token at this profile's URL.
        const federation = {
          ANTHROPIC_FEDERATION_RULE_ID: "fdrl_parent_sentinel",
          ANTHROPIC_ORGANIZATION_ID: "org-parent-sentinel",
          ANTHROPIC_IDENTITY_TOKEN: "parent-sentinel-identity-token",
        };
        const result = spawnSync("/bin/sh", ["-c", script], {
          encoding: "utf8",
          timeout: 5000,
          env: { PATH: process.env.PATH ?? "", [ownVar]: parentValue, ...federation },
        });

        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        // The key did not resolve, and said so...
        expect(h.warnings).toHaveLength(1);
        expect(h.warnings[0]).toContain("CLAUSONA_TEST_ABSENT_SECRET");
        // ...so the tool gets the endpoint and no credential at all, not the parent's...
        const childText = readFileSync(childEnvPath, "utf8");
        expect(childText).toContain("ANTHROPIC_BASE_URL=https://openrouter.ai/api");
        expect(childText).not.toMatch(new RegExp(`^${ownVar}=`, "m"));
        expect(childText).not.toContain(parentValue);
        for (const [key, value] of Object.entries(federation)) {
          expect(childText, key).not.toContain(value);
        }
        // ...while the parent shell keeps its own.
        expect(result.stdout).toBe(`parent ${ownVar}=${parentValue}\n`);
      },
    );
  }

  // A readonly credential cannot be unset, so the eval stops the run rather than leak it.
  it.skipIf(process.platform === "win32")(
    "stops the run in a real shell when a credential it must clear is read-only",
    async () => {
      const parentKey = "sk-ant-parent-sentinel";
      const h = await harness((home, workDir) =>
        registryWith(
          {
            tool: "claude",
            kind: "api",
            configDir: workDir,
            email: "",
            label: "router",
            api: {
              baseUrl: "https://openrouter.ai/api",
              authScheme: "bearer",
              secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
            },
          },
          home,
        ),
      );
      vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-or-profile-token");
      const out = await h.run("claude");
      const outPath = path.join(h.home, "shell-env.sh");
      const childEnvPath = path.join(h.home, "child.env");
      writeFileSync(outPath, out);

      const script = [
        "readonly ANTHROPIC_API_KEY",
        "(",
        `  eval "$(cat '${outPath}')"`,
        `  env > '${childEnvPath}'`,
        ")",
        `printf 'rc=%s parent=%s\\n' "$?" "$ANTHROPIC_API_KEY"`,
      ].join("\n");
      const result = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH ?? "", ANTHROPIC_API_KEY: parentKey },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`rc=1 parent=${parentKey}\n`);
      expect(result.stderr).toContain("clausona: ANTHROPIC_API_KEY is read-only in this shell");
      expect(result.stderr).not.toContain(parentKey);
      // Nothing was launched in the subshell at all.
      expect(existsSync(childEnvPath)).toBe(false);
    },
  );

  /**
   * An inherited ANTHROPIC_CUSTOM_HEADERS can carry an Authorization header to the profile's
   * endpoint, and an inherited provider switch sends the tool to Bedrock or Vertex with the
   * profile's base URL ignored. Both are cleared unless the profile sets them itself.
   */
  for (const c of [
    { name: "clears an inherited provider switch and custom headers", env: undefined, expected: {} },
    {
      name: "keeps a provider switch and custom headers the env map sets",
      env: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform", CLAUDE_CODE_USE_BEDROCK: "1" },
      expected: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: platform", CLAUDE_CODE_USE_BEDROCK: "1" },
    },
  ]) {
    it.skipIf(process.platform === "win32")(c.name, async () => {
      const inheritedHeaders = "Authorization: Bearer sk-ant-parent-sentinel";
      const h = await harness((home, workDir) =>
        registryWith(
          {
            tool: "claude",
            kind: "api",
            configDir: workDir,
            email: "",
            label: "router",
            api: {
              baseUrl: "https://openrouter.ai/api",
              authScheme: "bearer",
              secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
            },
            env: c.env,
          },
          home,
        ),
      );
      vi.stubEnv("CLAUSONA_TEST_SECRET", "sk-or-profile-token");
      const out = await h.run("claude");
      const outPath = path.join(h.home, "shell-env.sh");
      const childEnvPath = path.join(h.home, "child.env");
      writeFileSync(outPath, out);

      const script = [
        "(",
        `  eval "$(cat '${outPath}')"`,
        `  env > '${childEnvPath}'`,
        ")",
        `printf 'parent %s|%s\\n' "$CLAUDE_CODE_USE_BEDROCK" "$ANTHROPIC_CUSTOM_HEADERS"`,
      ].join("\n");
      const result = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_CUSTOM_HEADERS: inheritedHeaders },
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const child = Object.fromEntries(
        readFileSync(childEnvPath, "utf8")
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      expect({
        ANTHROPIC_CUSTOM_HEADERS: child.ANTHROPIC_CUSTOM_HEADERS,
        CLAUDE_CODE_USE_BEDROCK: child.CLAUDE_CODE_USE_BEDROCK,
      }).toEqual({ ANTHROPIC_CUSTOM_HEADERS: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, ...c.expected });
      expect(child.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-profile-token");
      // The parent shell keeps both of its own either way.
      expect(result.stdout).toBe(`parent 1|${inheritedHeaders}\n`);
    });
  }
});

/**
 * The three cases the review found, driven through the real hook in real shells: a variable
 * the output has to set - the profile's own credential, or its base URL - that the caller
 * made `readonly`. The export then fails, and without a guard bash runs the tool with the
 * caller's credential and the profile's endpoint, while zsh runs it on the default account.
 *
 * Everything here is the real path: the real `_shell-env` output, the real emitted hook, a
 * `clausona` that replays that output, and a stand-in tool that says what it was launched
 * with.
 */
const HOOK_SHELLS = (["zsh", "bash"] as const).filter((shell) => spawnSync("which", [shell]).status === 0);

function hookRunner(h: Harness, out: string) {
  const bin = path.join(h.home, "bin");
  mkdirSync(bin, { recursive: true });
  const outPath = path.join(h.home, "shell-env.sh");
  writeFileSync(outPath, out);
  writeFileSync(
    path.join(bin, "clausona"),
    ["#!/bin/sh", 'case "$1" in', "  _shell-env)", `    cat '${outPath}'`, "    ;;", "esac", "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "claude"),
    [
      "#!/bin/sh",
      'printf "TOOL STARTED\\n"',
      ...["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].map(
        (name) => `printf "tool ${name}=[%s]\\n" "\${${name}:-<unset>}"`,
      ),
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return (shell: "zsh" | "bash", body: string, env: Record<string, string>) => {
    const args = shell === "zsh" ? ["-f"] : ["--noprofile", "--norc"];
    return spawnSync(shell, [...args, "-c", `${renderPosixShellInit()}\n${body}\n`], {
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: h.home, ...env },
    });
  };
}

function apiRegistry(authScheme: "bearer" | "api-key") {
  return (home: string, workDir: string) =>
    registryWith(
      {
        tool: "claude",
        kind: "api",
        configDir: workDir,
        email: "",
        label: "router",
        api: {
          baseUrl: "https://openrouter.ai/api",
          authScheme,
          secret: { source: "env", name: "CLAUSONA_TEST_SECRET" },
        },
      },
      home,
    );
}

const PARENT = "sk-ant-parent-sentinel";
const PROFILE_TOKEN = "sk-or-profile-token";

describe.skipIf(HOOK_SHELLS.length === 0)(
  "the real hook, with a variable the profile must control made readonly",
  () => {
    const cases = [
      // The name the profile exports as its own credential, under each scheme.
      { label: "the api-key profile's own ANTHROPIC_API_KEY", scheme: "api-key", readonly: ["ANTHROPIC_API_KEY"] },
      { label: "the bearer profile's own ANTHROPIC_AUTH_TOKEN", scheme: "bearer", readonly: ["ANTHROPIC_AUTH_TOKEN"] },
      // The endpoint: with it stuck, bash sent the profile's key to the caller's URL.
      { label: "the endpoint the profile sets", scheme: "bearer", readonly: ["ANTHROPIC_BASE_URL"] },
      // The name the profile clears, which the earlier round already guarded.
      { label: "a credential the profile clears", scheme: "bearer", readonly: ["ANTHROPIC_API_KEY"] },
      { label: "two of them at once", scheme: "bearer", readonly: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
    ] as const;

    for (const shell of HOOK_SHELLS) {
      for (const { label, scheme, readonly } of cases) {
        it(`refuses to launch in ${shell} when ${label} is readonly`, async () => {
          const h = await harness(apiRegistry(scheme));
          vi.stubEnv("CLAUSONA_TEST_SECRET", PROFILE_TOKEN);
          const run = hookRunner(h, await h.run("claude"));
          const parentEnv = Object.fromEntries(readonly.map((name) => [name, PARENT]));

          const result = run(
            shell,
            [
              ...readonly.map((name) => `readonly ${name}`),
              "claude",
              'printf "rc=%s\\n" "$?"',
              ...readonly.map((name) => `printf "parent ${name}=[%s]\\n" "\${${name}:-<unset>}"`),
            ].join("\n"),
            parentEnv,
          );

          // The tool never started...
          expect(result.stdout).not.toContain("TOOL STARTED");
          expect(result.stdout).toContain("rc=1");
          // ...every stuck variable was named, with no value...
          for (const name of readonly) {
            expect(result.stderr).toContain(`clausona: ${name} is read-only in this shell`);
            expect(result.stdout).toContain(`parent ${name}=[${PARENT}]`);
          }
          expect(result.stderr).not.toContain(PARENT);
          expect(result.stderr).not.toContain(PROFILE_TOKEN);
        });
      }

      it(`launches as usual in ${shell} when nothing is readonly`, async () => {
        const h = await harness(apiRegistry("bearer"));
        vi.stubEnv("CLAUSONA_TEST_SECRET", PROFILE_TOKEN);
        const run = hookRunner(h, await h.run("claude"));

        const result = run(
          shell,
          ["claude", 'printf "rc=%s\\n" "$?"', `printf "parent ANTHROPIC_API_KEY=[%s]\\n" "$ANTHROPIC_API_KEY"`].join(
            "\n",
          ),
          { ANTHROPIC_API_KEY: PARENT },
        );

        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("TOOL STARTED");
        expect(result.stdout).toContain("rc=0");
        expect(result.stdout).toContain(`tool ANTHROPIC_AUTH_TOKEN=[${PROFILE_TOKEN}]`);
        expect(result.stdout).toContain("tool ANTHROPIC_BASE_URL=[https://openrouter.ai/api]");
        expect(result.stdout).toContain("tool ANTHROPIC_API_KEY=[<unset>]");
        expect(result.stdout).toContain(`parent ANTHROPIC_API_KEY=[${PARENT}]`);
      });
    }
  },
);
