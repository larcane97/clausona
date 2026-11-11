import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi } from "./lib/cli-style.js";

/**
 * Each account's plan in `list` and `current`, read from the files the tools keep with the
 * sign-in: Claude Code's `.claude.json` (the primary's at ~/.claude.json) and Codex's auth.json.
 * Driven through `runCommand` against a throwaway HOME, with every spawn refused, as in
 * src/commands.api.test.ts. `--no-quota` keeps `list` off the credential stores and the network:
 * the plan is read without either.
 */

const temps: string[] = [];
let spawned: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./core/process.js");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  const unexpected = spawned;
  spawned = [];
  expect(unexpected, "a test spawned a process").toEqual([]);
});

function jwt(payload: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [part({ alg: "none" }), part(payload), "sig"].join(".");
}

async function harness(active: { claude?: string; codex?: string } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-plan-"));
  temps.push(home);
  const dir = (name: string) => {
    const configDir = path.join(home, name);
    mkdirSync(configDir, { recursive: true });
    return configDir;
  };
  const primary = dir(".claude");
  const work = dir(".claude-work");
  const old = dir(".claude-old");
  const codexWork = dir(".codex-work");
  const glm = dir(".claude-glm");

  // The primary's account file is ~/.claude.json, not one inside ~/.claude.
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        emailAddress: "primary@example.com",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_5x",
      },
    }),
  );
  writeFileSync(
    path.join(work, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "work@example.com", planDisplayName: "Ultra" } }),
  );
  writeFileSync(path.join(old, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "old@example.com" } }));
  writeFileSync(
    path.join(codexWork, "auth.json"),
    JSON.stringify({
      tokens: {
        id_token: jwt({ email: "cx@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
      },
    }),
  );

  mkdirSync(path.join(home, ".clausona"));
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { claude: primary },
      activeProfiles: { claude: active.claude ?? "claude:default", codex: active.codex ?? "codex:work" },
      profiles: {
        "claude:default": { tool: "claude", configDir: primary, email: "primary@example.com", isPrimary: true },
        "claude:work": { tool: "claude", configDir: work, email: "work@example.com" },
        "claude:old": { tool: "claude", configDir: old, email: "old@example.com" },
        "codex:work": { tool: "codex", configDir: codexWork, email: "cx@example.com" },
        "claude:glm": {
          tool: "claude",
          kind: "api",
          email: "",
          label: "gpu-box",
          configDir: glm,
          api: { baseUrl: "https://gpu.example.com", authScheme: "bearer", secret: { source: "env", name: "GLM_KEY" } },
        },
      },
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("./core/process.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./core/process.js")>();
    const refuse = (command: string): never => {
      spawned.push(command);
      throw new Error(`test attempted to spawn '${command}'`);
    };
    return {
      ...actual,
      spawnCommand: (...args: Parameters<typeof actual.spawnCommand>) => refuse(args[0]),
      spawnCommandSync: (command: string) => refuse(command),
    };
  });
  const { runCommand } = await import("./commands.js");
  return { run: async (command: string, ...args: string[]) => String(await runCommand(command, args)) };
}

describe("plans in list", () => {
  it("names each account's plan in list --json, and none for an API profile or an account that records none", async () => {
    const h = await harness();
    const items = JSON.parse(await h.run("list", "--no-quota", "--json")) as Array<{ name: string; plan?: string }>;
    const plans = Object.fromEntries(items.map((item) => [item.name, item.plan]));

    expect(plans).toEqual({
      "claude:default": "Max",
      "claude:work": "Ultra",
      "claude:old": undefined,
      "codex:work": "Plus",
      "claude:glm": undefined,
    });
    expect(items.find((item) => item.name === "claude:old")).not.toHaveProperty("plan");
  });

  it("names them after the account without reading the quota", async () => {
    const h = await harness();
    const out = stripAnsi(await h.run("list", "--no-quota"));
    const row = (name: string) => out.split("\n").find((line) => line.includes(name)) ?? "";

    expect(out).not.toContain("PLAN");
    expect(row("claude:default")).toContain("primary@example.com (Max)");
    expect(row("claude:work")).toContain("work@example.com (Ultra)");
    expect(row("claude:old")).toMatch(/old@example\.com\s/);
    expect(row("claude:old")).not.toContain("(");
    expect(row("codex:work")).toContain("cx@example.com (Plus)");
    expect(row("claude:glm")).not.toContain("(");
  });
});

describe("plans in current", () => {
  it("names the plan after each active account that has one", async () => {
    const h = await harness({ claude: "claude:work" });
    const out = stripAnsi(await h.run("current"));

    expect(out).toMatch(/Account +work@example\.com \(Ultra\)/);
    expect(out).toMatch(/Account +cx@example\.com \(Plus\)/);
  });

  it("names the plan in current --json, and leaves it out where none is known", async () => {
    const withPlan = JSON.parse(await (await harness({ claude: "claude:work" })).run("current", "--json"));
    expect(withPlan.claude.plan).toBe("Ultra");
    expect(withPlan.codex.plan).toBe("Plus");

    vi.resetModules();
    const without = JSON.parse(await (await harness({ claude: "claude:old" })).run("current", "--json"));
    expect(without.claude).not.toHaveProperty("plan");
    // An API profile has none: the one plan named is the active Codex account's.
    const api = stripAnsi(await (await harness({ claude: "claude:glm" })).run("current"));
    expect(api).toMatch(/Account +gpu-box\s/);
    expect(api.match(/\((\w+)\)/g)).toEqual(["(Plus)"]);
  });
});
