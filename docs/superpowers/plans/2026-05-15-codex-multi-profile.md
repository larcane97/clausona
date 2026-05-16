# Codex Multi-Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex CLI multi-account support to clausona (currently Claude-only) using a tool-adapter abstraction; both tools' profiles are managed from a single unified CLI.

**Architecture:** Introduce `src/tools/{claude,codex}.ts` implementing a `ToolAdapter` interface. Refactor `src/lib/service.ts` to dispatch to the active adapter per profile rather than hardcoding Claude. Registry schema bumps to v2 (per-tool active/primary maps, `tool` field on every profile, `<tool>:<name>` keys). Shell hook emits both `claude()` and `codex()` wrappers using `CLAUDE_CONFIG_DIR` and `CODEX_HOME` env vars respectively. Profile references in CLI use `<tool>:<name>` form, with auto-inference when the bare name is globally unique.

**Tech Stack:** TypeScript 5.9, Node ≥20, vitest 4, Ink 6 (React 19) for TUI, Biome 2 for lint, esbuild for bundling. Tests use vitest. Package manager: pnpm.

**Spec:** `docs/superpowers/specs/2026-05-15-codex-multi-profile-design.md`

---

## File Structure

**New files**:
- `src/tools/types.ts` — `ToolAdapter` interface, `ToolName` type
- `src/tools/claude.ts` — Claude adapter (logic extracted from service.ts)
- `src/tools/codex.ts` — Codex adapter
- `src/tools/codex-jwt.ts` — Standalone JWT payload decoder (no signature verification)
- `src/tools/codex-jwt.test.ts` — Decoder tests
- `src/tools/codex.test.ts` — Codex adapter tests (account info + skip set)
- `src/tools/registry.ts` — Adapter lookup map
- `src/lib/profile-ref.ts` — `parseProfileRef` helper
- `src/lib/profile-ref.test.ts` — Reference parser tests

**Modified files**:
- `src/types.ts` — Registry v2 + Profile.tool + per-tool maps
- `src/core/registry.ts` — Migration from v1 to v2
- `src/core/registry.test.ts` — Add migration tests
- `src/core/paths.ts` — Add `backupDirFor(tool, name)` helper, move `keychainServiceForConfigDir` into Claude adapter
- `src/core/paths.test.ts` — Tests for new helpers
- `src/core/shell.ts` — Emit two wrappers via `_clausona_resolve` helper
- `src/core/shell.test.ts` — Snapshot two-wrapper output
- `src/core/doctor.ts` — Tool-aware health checks (no functional change for Claude)
- `src/lib/service.ts` — Refactored to dispatch via adapters
- `src/lib/format.ts` — Render tool column in list
- `src/commands.ts` — Use `parseProfileRef` + adjusted help/usage text
- `src/index.tsx` — `exec` branch uses adapter binary + env var
- `src/tui/App.tsx` — Unified list, sectioned use picker, sectioned init
- `package.json` — version bump 0.0.4-beta → 0.1.0
- `README.md` — Document codex support, prefix UX, migration

---

## Conventions

- Run a single test file: `pnpm vitest run path/to/file.test.ts`
- Run all tests: `pnpm test`
- Type-check: `pnpm typecheck`
- Lint: `pnpm lint` (or `pnpm lint:fix`)
- Build: `pnpm build`
- Commit format: follow existing repo style — short prefix (`feat:`, `refactor:`, `fix:`, `chore:`), imperative mood, no body unless needed.
- After a refactor task, run `pnpm typecheck && pnpm test` before committing — they're cheap and catch most regressions.

---

## Task 1: Registry v2 types + migration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/registry.ts`
- Modify: `src/core/registry.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add to `src/core/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { migrateRegistryV1toV2, setActiveProfile } from "./registry.js";
import type { Registry, RegistryV1 } from "../types.js";

describe("migrateRegistryV1toV2", () => {
  it("rewrites a v1 registry into v2 form with prefixed keys", () => {
    const v1: RegistryV1 = {
      primarySource: "/home/x/.claude",
      activeProfile: "work",
      profiles: {
        default: { configDir: "/home/x/.claude", email: "a@x", isPrimary: true },
        work:    { configDir: "/home/x/.claude-work", email: "b@x", mergeSessions: false },
      },
    };

    const v2 = migrateRegistryV1toV2(v1);

    expect(v2).toEqual({
      version: 2,
      primarySources: { claude: "/home/x/.claude" },
      activeProfiles: { claude: "claude:work" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/home/x/.claude", email: "a@x", isPrimary: true },
        "claude:work":    { tool: "claude", configDir: "/home/x/.claude-work", email: "b@x", mergeSessions: false },
      },
    } satisfies Registry);
  });

  it("is a no-op for an already-v2 registry", () => {
    const v2: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude" },
      activeProfiles: { claude: "claude:default" },
      profiles: { "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true } },
    };
    expect(migrateRegistryV1toV2(v2)).toEqual(v2);
  });
});

describe("setActiveProfile (v2)", () => {
  it("sets the per-tool active by tool field", () => {
    const reg: Registry = {
      version: 2,
      primarySources: { claude: "/x/.claude", codex: "/x/.codex" },
      activeProfiles: { claude: "claude:default", codex: "codex:default" },
      profiles: {
        "claude:default": { tool: "claude", configDir: "/x/.claude", email: "a@x", isPrimary: true },
        "claude:work":    { tool: "claude", configDir: "/x/.claude-work", email: "b@x" },
        "codex:default":  { tool: "codex",  configDir: "/x/.codex", email: "c@x", isPrimary: true },
      },
    };
    const next = setActiveProfile(reg, "claude:work");
    expect(next.activeProfiles).toEqual({ claude: "claude:work", codex: "codex:default" });
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm vitest run src/core/registry.test.ts`
Expected: FAIL — `migrateRegistryV1toV2` does not exist; `setActiveProfile` signature mismatch.

- [ ] **Step 3: Update `src/types.ts` with v2 schema**

Replace existing `Profile` and `Registry` types and add v1 alias:

```ts
export type ToolName = "claude" | "codex";

export type Profile = {
  tool: ToolName;
  configDir: string;
  email: string;
  orgName?: string;
  isPrimary?: boolean;
  mergeSessions?: boolean;
};

export type Registry = {
  version: 2;
  primarySources: Partial<Record<ToolName, string>>;
  activeProfiles: Partial<Record<ToolName, string>>;   // value is profile id "tool:name"
  profiles: Record<string, Profile>;                    // key is "tool:name"
};

// v1 schema retained only for migration input
export type RegistryV1 = {
  primarySource: string;
  activeProfile: string;
  profiles: Record<string, {
    configDir: string;
    email: string;
    orgName?: string;
    isPrimary?: boolean;
    mergeSessions?: boolean;
  }>;
};
```

- [ ] **Step 4: Implement migration in `src/core/registry.ts`**

Replace the file content:

```ts
import type { Registry, RegistryV1, ToolName } from "../types.js";

export function migrateRegistryV1toV2(input: Registry | RegistryV1): Registry {
  if ("version" in input && input.version === 2) {
    return input;
  }
  const v1 = input as RegistryV1;
  const profiles: Registry["profiles"] = {};
  let activeKey = "";
  for (const [oldName, profile] of Object.entries(v1.profiles)) {
    const newKey = `claude:${oldName}`;
    profiles[newKey] = { tool: "claude", ...profile };
    if (oldName === v1.activeProfile) activeKey = newKey;
  }
  return {
    version: 2,
    primarySources: { claude: v1.primarySource },
    activeProfiles: { claude: activeKey || `claude:${v1.activeProfile}` },
    profiles,
  };
}

export function setActiveProfile(registry: Registry, profileId: string): Registry {
  const profile = registry.profiles[profileId];
  if (!profile) throw new Error(`Profile '${profileId}' not found.`);
  return {
    ...registry,
    activeProfiles: { ...registry.activeProfiles, [profile.tool]: profileId },
    profiles: { ...registry.profiles },
  };
}

export function isV1Registry(input: unknown): input is RegistryV1 {
  return Boolean(input && typeof input === "object" && "primarySource" in input && !("version" in input));
}
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm vitest run src/core/registry.test.ts`
Expected: PASS for both new tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/core/registry.ts src/core/registry.test.ts
git commit -m "feat: add registry v2 schema and v1→v2 migration"
```

---

## Task 2: Backup directory helper + path utilities

**Files:**
- Modify: `src/core/paths.ts`
- Modify: `src/core/paths.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/core/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backupDirFor, isClaudeKeychainSupported, claudeJsonPathForConfigDir } from "./paths.js";

describe("backupDirFor", () => {
  it("nests by tool then name", () => {
    expect(backupDirFor("/h/.clausona", "claude", "work")).toBe("/h/.clausona/backups/claude/work");
    expect(backupDirFor("/h/.clausona", "codex", "personal")).toBe("/h/.clausona/backups/codex/personal");
  });
});

describe("claudeJsonPathForConfigDir (unchanged)", () => {
  it("returns ~/.claude.json for primary", () => {
    expect(claudeJsonPathForConfigDir({ homeDir: "/h", configDir: "/h/.claude" })).toBe("/h/.claude.json");
  });
  it("returns <dir>/.claude.json for non-primary", () => {
    expect(claudeJsonPathForConfigDir({ homeDir: "/h", configDir: "/h/.claude-work" })).toBe("/h/.claude-work/.claude.json");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm vitest run src/core/paths.test.ts`
Expected: FAIL — `backupDirFor` not exported.

- [ ] **Step 3: Add helper to `src/core/paths.ts`**

Append to `src/core/paths.ts`:

```ts
import type { ToolName } from "../types.js";

export function backupDirFor(clausonaDir: string, tool: ToolName, name: string): string {
  return path.join(clausonaDir, "backups", tool, name);
}
```

(`path` is already imported in the file.)

- [ ] **Step 4: Run test to confirm pass**

Run: `pnpm vitest run src/core/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/paths.ts src/core/paths.test.ts
git commit -m "feat: add backupDirFor helper for per-tool backup layout"
```

---

## Task 3: ToolAdapter interface

**Files:**
- Create: `src/tools/types.ts`

- [ ] **Step 1: Write the interface (no test — used by adapters tested in Tasks 4 & 6)**

Create `src/tools/types.ts`:

```ts
import type { ToolName } from "../types.js";

export type AccountInfo = {
  email: string;
  orgName?: string;
};

export type ToolAdapter = {
  name: ToolName;
  binary: string;
  configEnvVar: string;

  defaultConfigDir(homeDir: string): string;
  configDirPattern: RegExp;        // e.g. /^\.claude(-.+)?$/

  readAccountInfo(configDir: string): Promise<AccountInfo | null>;

  // Optional Keychain probe (Claude only on macOS).
  keychainServiceName?(args: { homeDir: string; configDir: string }): string;
  hasKeychainCredential?(service: string): Promise<boolean>;

  // Files/dirs under the profile's config dir that must NOT be symlinked to primary.
  sharedSkipSet(mergeSessions: boolean): Set<string>;

  // Per-tool post-link setup (e.g. Claude's plugins JSON path-rewrite).
  postSetup?(profileDir: string, primaryDir: string): Promise<void>;

  // Spawns the tool's interactive login with the given config dir as its env-var target.
  runLogin(configDir: string): Promise<boolean>;
};
```

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/types.ts
git commit -m "feat: add ToolAdapter interface"
```

---

## Task 4: Extract ClaudeAdapter from existing service.ts logic

**Files:**
- Create: `src/tools/claude.ts`

- [ ] **Step 1: Implement the adapter, copying logic from `src/lib/service.ts` and `src/core/paths.ts`**

Create `src/tools/claude.ts`:

```ts
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { claudeJsonPathForConfigDir } from "../core/paths.js";
import type { ToolAdapter } from "./types.js";

const BASE_SHARED_LINK_SKIP = new Set([".claude.json", "image-cache", "statsig", "plugins"]);

function keychainService(args: { homeDir: string; configDir: string }): string {
  const primary = path.join(args.homeDir, ".claude");
  if (args.configDir === primary) return "Claude Code-credentials";
  const hash = crypto.createHash("sha256").update(args.configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

async function hasKeychain(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise<boolean>((resolve) => {
    const child = spawn("security", ["find-generic-password", "-s", service], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function readAccount(configDir: string): Promise<{ email: string; orgName?: string } | null> {
  const jsonPath = claudeJsonPathForConfigDir({ homeDir: process.env.HOME ?? "", configDir });
  try {
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string; organizationName?: string } };
    const email = parsed.oauthAccount?.emailAddress;
    if (!email) return null;
    return { email, orgName: parsed.oauthAccount?.organizationName };
  } catch {
    return null;
  }
}

async function runLoginInteractive(configDir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("claude", ["auth", "login"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export const claudeAdapter: ToolAdapter = {
  name: "claude",
  binary: "claude",
  configEnvVar: "CLAUDE_CONFIG_DIR",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".claude"),
  configDirPattern: /^\.claude(-.+)?$/,
  readAccountInfo: readAccount,
  keychainServiceName: keychainService,
  hasKeychainCredential: hasKeychain,
  sharedSkipSet: (mergeSessions) =>
    mergeSessions ? new Set(BASE_SHARED_LINK_SKIP) : new Set([...BASE_SHARED_LINK_SKIP, "projects"]),
  // postSetup is left undefined here — service.ts's syncPluginsJson is wired into the
  // Claude code path explicitly because it has cross-cutting plugin marketplace state.
  // We will keep that wiring during Task 11 refactor; the adapter is not the place for it.
  runLogin: runLoginInteractive,
};
```

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/claude.ts
git commit -m "feat: extract Claude logic into ClaudeAdapter"
```

---

## Task 5: JWT payload decoder utility

**Files:**
- Create: `src/tools/codex-jwt.ts`
- Create: `src/tools/codex-jwt.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tools/codex-jwt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeJwtPayload } from "./codex-jwt.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a normal payload", () => {
    const tok = makeJwt({ email: "x@y.com", name: "X" });
    expect(decodeJwtPayload(tok)).toEqual({ email: "x@y.com", name: "X" });
  });

  it("handles non-ASCII display names (Korean)", () => {
    const tok = makeJwt({ email: "u@v.co", name: "임문경" });
    expect(decodeJwtPayload(tok)).toMatchObject({ name: "임문경" });
  });

  it("returns null on malformed input", () => {
    expect(decodeJwtPayload("not.a.jwt.too.many.segments")).toBeNull();
    expect(decodeJwtPayload("only-one-segment")).toBeNull();
    expect(decodeJwtPayload("a.@@@.c")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/tools/codex-jwt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement decoder**

Create `src/tools/codex-jwt.ts`:

```ts
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const buf = Buffer.from(parts[1], "base64url");
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm vitest run src/tools/codex-jwt.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/codex-jwt.ts src/tools/codex-jwt.test.ts
git commit -m "feat: add JWT payload decoder for codex auth.json"
```

---

## Task 6: CodexAdapter

**Files:**
- Create: `src/tools/codex.ts`
- Create: `src/tools/codex.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tools/codex.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./codex.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function withTmpAuth(payload: Record<string, unknown> | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-test-"));
  if (payload) {
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ tokens: { id_token: makeJwt(payload), account_id: "uuid-123" } }),
    );
  }
  return dir;
}

describe("codexAdapter.readAccountInfo", () => {
  it("returns email + orgName from JWT id_token", async () => {
    const dir = withTmpAuth({
      email: "u@example.com",
      name: "Example User",
      "https://api.openai.com/auth": { organizations: [{ title: "Example Org" }] },
    });
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toEqual({ email: "u@example.com", orgName: "Example Org" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to account_id when email claim is absent", async () => {
    const dir = withTmpAuth({ name: "anon" });
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toEqual({ email: "uuid-123", orgName: undefined });
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when auth.json is missing", async () => {
    const dir = withTmpAuth(null);
    const info = await codexAdapter.readAccountInfo(dir);
    expect(info).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("codexAdapter.sharedSkipSet", () => {
  it("isolates auth + sessions + state DB by default", () => {
    const skip = codexAdapter.sharedSkipSet(false);
    for (const item of [
      "auth.json",
      "sessions",
      "session_index.jsonl",
      "history.jsonl",
      "state_5.sqlite",
      "logs_2.sqlite",
      "log",
      "logs",
      "shell_snapshots",
      "installation_id",
      ".codex-global-state.json",
      "models_cache.json",
      "cache",
      "tmp",
      ".tmp",
      "version.json",
    ]) {
      expect(skip.has(item)).toBe(true);
    }
  });

  it("with mergeSessions=true, removes sessions/history from skip", () => {
    const skip = codexAdapter.sharedSkipSet(true);
    expect(skip.has("sessions")).toBe(false);
    expect(skip.has("history.jsonl")).toBe(false);
    expect(skip.has("session_index.jsonl")).toBe(false);
    // auth.json is still always isolated
    expect(skip.has("auth.json")).toBe(true);
  });
});

describe("codexAdapter wiring", () => {
  it("uses CODEX_HOME env var", () => {
    expect(codexAdapter.configEnvVar).toBe("CODEX_HOME");
  });
  it("default dir is ~/.codex", () => {
    expect(codexAdapter.defaultConfigDir("/h")).toBe("/h/.codex");
  });
  it("matches ~/.codex and ~/.codex-foo via configDirPattern", () => {
    expect(codexAdapter.configDirPattern.test(".codex")).toBe(true);
    expect(codexAdapter.configDirPattern.test(".codex-work")).toBe(true);
    expect(codexAdapter.configDirPattern.test(".claude")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/tools/codex.test.ts`
Expected: FAIL — `codexAdapter` not found.

- [ ] **Step 3: Implement codex adapter**

Create `src/tools/codex.ts`:

```ts
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { decodeJwtPayload } from "./codex-jwt.js";
import type { AccountInfo, ToolAdapter } from "./types.js";

// Files/dirs under $CODEX_HOME that are credential or per-account state and must not be shared.
const BASE_SKIP = new Set([
  "auth.json",
  "sessions",
  "session_index.jsonl",
  "history.jsonl",
  "log",
  "logs",
  "shell_snapshots",
  "installation_id",
  ".codex-global-state.json",
  ".codex-global-state.json.bak",
  "cloud-requirements-cache.json",
  "external_agent_session_imports.json",
  "models_cache.json",
  "cache",
  "tmp",
  ".tmp",
  "computer-use",
  "sqlite",
  "version.json",
]);

// Patterns that should also be skipped (sqlite WAL/SHM siblings, log/state DBs).
const SKIP_PREFIXES = ["state_", "logs_", "sessions_"];

function expandSkipSet(items: Iterable<string>): Set<string> {
  const set = new Set(items);
  // sqlite wal/shm siblings of state_*.sqlite / logs_*.sqlite are filtered at link time
  // by checking name prefix; we represent that using a sentinel suffix entry list.
  for (const prefix of SKIP_PREFIXES) set.add(`__prefix__:${prefix}`);
  return set;
}

export function shouldSkipForCodex(name: string, mergeSessions: boolean): boolean {
  const skip = codexAdapter.sharedSkipSet(mergeSessions);
  if (skip.has(name)) return true;
  for (const entry of skip) {
    if (entry.startsWith("__prefix__:")) {
      const p = entry.slice("__prefix__:".length);
      if (name.startsWith(p)) return true;
    }
  }
  return false;
}

async function readCodexAccount(configDir: string): Promise<AccountInfo | null> {
  const authPath = path.join(configDir, "auth.json");
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: { tokens?: { id_token?: string; account_id?: string } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  const idToken = parsed.tokens?.id_token;
  if (!idToken) return null;

  const payload = decodeJwtPayload(idToken);
  if (!payload) return null;

  const email = typeof payload.email === "string" ? payload.email : null;
  const oai = (payload["https://api.openai.com/auth"] ?? null) as
    | { organizations?: Array<{ title?: string }> }
    | null;
  const orgName = oai?.organizations?.[0]?.title;

  if (email) return { email, orgName };
  // Fallback so list output is not blank.
  if (parsed.tokens?.account_id) return { email: parsed.tokens.account_id, orgName: undefined };
  return null;
}

async function runCodexLogin(configDir: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("codex", ["login"], {
      env: { ...process.env, CODEX_HOME: configDir },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

const SESSION_SKIP = new Set(["sessions", "session_index.jsonl", "history.jsonl"]);

export const codexAdapter: ToolAdapter = {
  name: "codex",
  binary: "codex",
  configEnvVar: "CODEX_HOME",
  defaultConfigDir: (homeDir) => path.join(homeDir, ".codex"),
  configDirPattern: /^\.codex(-.+)?$/,
  readAccountInfo: readCodexAccount,
  // No keychain integration in v1; codex uses file-backend (auth.json) by default.
  sharedSkipSet: (mergeSessions) => {
    const base = expandSkipSet(BASE_SKIP);
    if (mergeSessions) {
      for (const item of SESSION_SKIP) base.delete(item);
    }
    return base;
  },
  // No path-rewrite postSetup needed — codex registers marketplaces in config.toml directly,
  // not in per-profile JSON files like claude does.
  runLogin: runCodexLogin,
};
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm vitest run src/tools/codex.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/codex.ts src/tools/codex.test.ts
git commit -m "feat: add CodexAdapter (auth.json + JWT email + skip set)"
```

---

## Task 7: Adapter registry

**Files:**
- Create: `src/tools/registry.ts`

- [ ] **Step 1: Implement registry (no test — single line lookup)**

Create `src/tools/registry.ts`:

```ts
import type { ToolName } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { ToolAdapter } from "./types.js";

const ADAPTERS: Record<ToolName, ToolAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getAdapter(tool: ToolName): ToolAdapter {
  return ADAPTERS[tool];
}

export function allAdapters(): ToolAdapter[] {
  return Object.values(ADAPTERS);
}

export const ALL_TOOLS: ToolName[] = ["claude", "codex"];
```

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat: add adapter registry"
```

---

## Task 8: parseProfileRef helper

**Files:**
- Create: `src/lib/profile-ref.ts`
- Create: `src/lib/profile-ref.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/profile-ref.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseProfileRef, profileId } from "./profile-ref.js";
import type { Registry } from "../types.js";

const REG: Registry = {
  version: 2,
  primarySources: { claude: "/h/.claude", codex: "/h/.codex" },
  activeProfiles: { claude: "claude:default", codex: "codex:default" },
  profiles: {
    "claude:default": { tool: "claude", configDir: "/h/.claude", email: "a", isPrimary: true },
    "claude:work":    { tool: "claude", configDir: "/h/.claude-work", email: "b" },
    "codex:default":  { tool: "codex",  configDir: "/h/.codex", email: "c", isPrimary: true },
    "codex:personal": { tool: "codex",  configDir: "/h/.codex-personal", email: "d" },
  },
};

describe("parseProfileRef", () => {
  it("accepts explicit prefix", () => {
    expect(parseProfileRef("claude:work", REG)).toEqual({ tool: "claude", name: "work", id: "claude:work" });
    expect(parseProfileRef("codex:personal", REG)).toEqual({ tool: "codex", name: "personal", id: "codex:personal" });
  });

  it("infers tool when bare name is unique", () => {
    expect(parseProfileRef("work", REG)).toEqual({ tool: "claude", name: "work", id: "claude:work" });
    expect(parseProfileRef("personal", REG)).toEqual({ tool: "codex", name: "personal", id: "codex:personal" });
  });

  it("errors on ambiguous bare name", () => {
    const reg2: Registry = {
      ...REG,
      profiles: { ...REG.profiles, "codex:work": { tool: "codex", configDir: "/h/.codex-work", email: "e" } },
    };
    expect(() => parseProfileRef("work", reg2)).toThrow(/exists in both claude and codex/i);
  });

  it("errors when profile is not registered", () => {
    expect(() => parseProfileRef("missing", REG)).toThrow(/not found/i);
    expect(() => parseProfileRef("claude:missing", REG)).toThrow(/not found/i);
  });

  it("rejects malformed prefix forms", () => {
    expect(() => parseProfileRef("foo:bar", REG)).toThrow(/unknown tool/i);
  });
});

describe("profileId", () => {
  it("composes tool:name", () => {
    expect(profileId("codex", "work")).toBe("codex:work");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/lib/profile-ref.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helper**

Create `src/lib/profile-ref.ts`:

```ts
import { ALL_TOOLS } from "../tools/registry.js";
import type { Registry, ToolName } from "../types.js";

export type ParsedProfileRef = { tool: ToolName; name: string; id: string };

export function profileId(tool: ToolName, name: string): string {
  return `${tool}:${name}`;
}

function isToolName(value: string): value is ToolName {
  return (ALL_TOOLS as string[]).includes(value);
}

export function parseProfileRef(input: string, registry: Registry): ParsedProfileRef {
  if (input.includes(":")) {
    const [maybeTool, ...rest] = input.split(":");
    const name = rest.join(":");
    if (!isToolName(maybeTool)) {
      throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
    }
    const id = profileId(maybeTool, name);
    if (!registry.profiles[id]) {
      throw new Error(`Profile '${id}' not found.`);
    }
    return { tool: maybeTool, name, id };
  }

  const candidates: ParsedProfileRef[] = [];
  for (const tool of ALL_TOOLS) {
    const id = profileId(tool, input);
    if (registry.profiles[id]) candidates.push({ tool, name: input, id });
  }
  if (candidates.length === 0) throw new Error(`Profile '${input}' not found.`);
  if (candidates.length > 1) {
    const list = candidates.map((c) => `'${c.id}'`).join(" or ");
    throw new Error(`'${input}' exists in both claude and codex. Use ${list}.`);
  }
  return candidates[0];
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm vitest run src/lib/profile-ref.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/profile-ref.ts src/lib/profile-ref.test.ts
git commit -m "feat: add parseProfileRef with tool inference"
```

---

## Task 9: Refactor service.ts — discoverAccounts via adapters

**Files:**
- Modify: `src/lib/service.ts`

This is the first of several service.ts refactors; do them in sequence and run `pnpm typecheck && pnpm test` between each to catch regressions early.

- [ ] **Step 1: Replace `discoverAccounts` to iterate over all adapters**

In `src/lib/service.ts`, replace the existing `discoverAccounts` function:

```ts
import { allAdapters, getAdapter } from "../tools/registry.js";
import type { ToolAdapter } from "../tools/types.js";

export async function discoverAccounts(): Promise<DiscoveredAccount[]> {
  const home = homedir();
  const out: DiscoveredAccount[] = [];

  const entries = await readdir(home, { withFileTypes: true });
  for (const adapter of allAdapters()) {
    const matchingDirs = entries
      .filter((e) => e.isDirectory() && adapter.configDirPattern.test(e.name))
      .map((e) => path.join(home, e.name))
      .sort();

    for (const configDir of matchingDirs) {
      const account = await adapter.readAccountInfo(configDir);
      if (!account) continue;

      const resolvedConfig = await realpath(configDir).catch(() => configDir);
      const resolvedPrimary = await realpath(adapter.defaultConfigDir(home)).catch(() => adapter.defaultConfigDir(home));
      const isPrimary = resolvedConfig === resolvedPrimary;

      // Per-tool credential gate (Claude requires Keychain on macOS)
      if (adapter.keychainServiceName && adapter.hasKeychainCredential) {
        const service = adapter.keychainServiceName({ homeDir: home, configDir: resolvedConfig });
        if (process.platform === "darwin" && !(await adapter.hasKeychainCredential(service))) {
          continue;
        }
      }

      const jsonPath =
        adapter.name === "claude"
          ? claudeJsonPathForConfigDir({ homeDir: home, configDir })
          : path.join(configDir, "auth.json");

      out.push({
        tool: adapter.name,
        configDir,
        jsonPath,
        email: account.email,
        orgName: account.orgName,
        keychainService: adapter.keychainServiceName?.({ homeDir: home, configDir: resolvedConfig }) ?? "",
        isPrimary,
      });
    }
  }

  return out;
}
```

- [ ] **Step 2: Add `tool` field to `DiscoveredAccount`**

In `src/types.ts`:

```ts
export type DiscoveredAccount = {
  tool: ToolName;
  configDir: string;
  jsonPath: string;
  email: string;
  orgName?: string;
  keychainService: string;
  isPrimary: boolean;
};
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: errors at usages of `DiscoveredAccount` that don't yet pass `tool`. Fix call sites in `discoverAccounts` (already done) and `initializeRegistry` (Task 11).

If errors only point to `initializeRegistry` and `bootstrapInitFromCurrentState` in `commands.ts` accessing `account.configDir` etc., that's expected — they will be fixed in Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/lib/service.ts
git commit -m "refactor: dispatch discoverAccounts via tool adapters"
```

---

## Task 10: Refactor service.ts — setupSharedLinks via adapter skip set

**Files:**
- Modify: `src/lib/service.ts`

- [ ] **Step 1: Replace `sharedLinkSkipSet` and add per-name predicate**

Find and remove these top-level constants in `src/lib/service.ts`:

```ts
const BASE_SHARED_LINK_SKIP = new Set([".claude.json", "image-cache", "statsig", "plugins"]);
function sharedLinkSkipSet(mergeSessions: boolean): Set<string> { ... }
```

Replace with:

```ts
function shouldSkipShare(adapter: ToolAdapter, name: string, mergeSessions: boolean): boolean {
  const skip = adapter.sharedSkipSet(mergeSessions);
  if (skip.has(name)) return true;
  for (const entry of skip) {
    if (entry.startsWith("__prefix__:")) {
      const prefix = entry.slice("__prefix__:".length);
      if (name.startsWith(prefix)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 2: Update `setupSharedLinks` signature to accept adapter**

Find:

```ts
async function setupSharedLinks(profileDir: string, primarySource: string, mergeSessions = false, backupDir?: string)
```

Replace with:

```ts
async function setupSharedLinks(adapter: ToolAdapter, profileDir: string, primarySource: string, mergeSessions = false, backupDir?: string)
```

Inside, replace `const skipSet = sharedLinkSkipSet(mergeSessions);` and the `if (skipSet.has(item.name))` check with a call to `shouldSkipShare(adapter, item.name, mergeSessions)`.

Likewise update the corresponding check inside `doctorProfiles` (which currently calls `sharedLinkSkipSet(profile.mergeSessions ?? false)`):

```ts
const isSkipped = (n: string) => shouldSkipShare(getAdapter(profile.tool), n, profile.mergeSessions ?? false);
// ... use isSkipped(entry.name) wherever skipSet.has(entry.name) was used
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: errors at all call sites of `setupSharedLinks` (initializeRegistry, addProfile, repairProfile, updateProfileConfig). Fix them by passing `getAdapter(profile.tool)` (or `getAdapter(account.tool)` in the init path).

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: pre-existing tests pass. There may be some skipped/uncovered claude-only invariants — confirm none of them break.

- [ ] **Step 5: Commit**

```bash
git add src/lib/service.ts
git commit -m "refactor: route setupSharedLinks through tool adapter skip sets"
```

---

## Task 11: Refactor service.ts — addProfile / loginProfile / removeProfile

**Files:**
- Modify: `src/lib/service.ts`

- [ ] **Step 1: Update helpers and add tool-aware backup paths**

Add near the top of `src/lib/service.ts`:

```ts
import { backupDirFor } from "../core/paths.js";
import { profileId } from "./profile-ref.js";
```

Replace internal usages of `path.join(CLAUSONA_DIR, "backups", name)` (where `name` was the bare profile name) with `backupDirFor(CLAUSONA_DIR, profile.tool, name)`. Sites: `initializeRegistry`, `addProfile`, `repairProfile`, `cleanupProfile`, `updateProfileConfig`, `uninstallClausona`. Use the `tool` field from the profile or account being processed.

- [ ] **Step 2: Rewrite `addProfile` signature to accept tool**

Find:

```ts
export async function addProfile(options: { name: string; fromPath?: string; mergeSessions?: boolean })
```

Replace with:

```ts
export async function addProfile(options: { tool: ToolName; name: string; fromPath?: string; mergeSessions?: boolean })
```

Throughout the function body:
- Build the registry key as `const id = profileId(options.tool, options.name);` and use it where `options.name` was used as a registry key.
- Replace `runLoginFlow(configDir)` with `getAdapter(options.tool).runLogin(configDir)`.
- Replace any direct `.claude.json`/`oauthAccount` parsing with `getAdapter(options.tool).readAccountInfo(configDir)`.
- The default config dir for newly-created (non-`--from`) profiles is now `path.join(homedir(), \`.${options.tool === "claude" ? "claude" : "codex"}-${options.name}\`)`.
- Onboarding-state merge (`hasCompletedOnboarding`, `lastOnboardingVersion`) — keep ONLY for `tool === "claude"`. Skip for codex (codex has no equivalent).
- Backup path: `const backupDir = backupDirFor(CLAUSONA_DIR, options.tool, options.name);`
- Set `tool: options.tool` on the new `Profile` record.

- [ ] **Step 3: Rewrite `loginProfile` signature**

Replace:

```ts
export async function loginProfile(name: string)
```

with:

```ts
export async function loginProfile(id: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const ok = await getAdapter(profile.tool).runLogin(profile.configDir);
  if (!ok) throw new Error(`${profile.tool} login failed.`);
  return profile;
}
```

- [ ] **Step 4: Rewrite `removeProfile` and `setActiveProfileByName` signatures**

Both take `id: string` (a `tool:name` profile id) instead of bare `name: string`. Internally call `parseProfileRef` is NOT needed here — assume the caller (commands.ts) passes the parsed id. Update body to use the id directly as the registry key and look up `profile.tool` for backup paths and adapter dispatch.

- [ ] **Step 5: Rewrite `resolveProfileEnv` to set the right env var**

Replace:

```ts
export async function resolveProfileEnv(name: string): Promise<{ configDir: string; env: NodeJS.ProcessEnv }> {
  // ...
  if (profile.isPrimary) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = profile.configDir;
  }
```

with:

```ts
export async function resolveProfileEnv(id: string): Promise<{ tool: ToolName; binary: string; configDir: string; env: NodeJS.ProcessEnv }> {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  const profile = registry.profiles[id];
  const adapter = getAdapter(profile.tool);
  const env = { ...process.env };
  if (profile.isPrimary) {
    delete env[adapter.configEnvVar];
  } else {
    env[adapter.configEnvVar] = profile.configDir;
  }
  if (profile.tool === "claude") {
    await syncPluginsJson(profile.configDir, registry.primarySources.claude ?? "").catch(() => {});
  }
  return { tool: profile.tool, binary: adapter.binary, configDir: profile.configDir, env };
}
```

- [ ] **Step 6: Type-check + tests**

Run: `pnpm typecheck && pnpm test`
Expected: all green. If existing tests reference removed signatures, update them. Specifically, `App.test.tsx` and any service.ts integration tests may need parameter updates.

- [ ] **Step 7: Commit**

```bash
git add src/lib/service.ts src/types.ts
git commit -m "refactor: route addProfile/loginProfile/removeProfile through tool adapters"
```

---

## Task 12: Refactor service.ts — doctorProfiles & repairProfile

**Files:**
- Modify: `src/lib/service.ts`

- [ ] **Step 1: Update `doctorProfiles` to call adapter for keychain check + skip set**

In `doctorProfiles`, the existing block:

```ts
const keychainService = keychainServiceForConfigDir({ homeDir: homedir(), configDir: resolvedDir });
if (process.platform === "darwin" && !(await checkKeychain(keychainService))) {
  issues.push({ kind: "missing_keychain", message: ... });
}
```

Replace with:

```ts
const adapter = getAdapter(profile.tool);
if (adapter.keychainServiceName && adapter.hasKeychainCredential) {
  const service = adapter.keychainServiceName({ homeDir: homedir(), configDir: resolvedDir });
  if (process.platform === "darwin" && !(await adapter.hasKeychainCredential(service))) {
    issues.push({ kind: "missing_keychain", message: `${service} not found in Keychain` });
  }
}
```

- [ ] **Step 2: Update json-parse path to be tool-aware**

The existing block:

```ts
const jsonPath = claudeJsonPathForConfigDir({ homeDir: homedir(), configDir: profile.configDir });
const claudeJson = await parseClaudeJson(jsonPath);

if (!claudeJson) {
  issues.push({ kind: "missing_json", message: ".claude.json is missing" });
} else if (!claudeJson.oauthAccount?.emailAddress) {
  issues.push({ kind: "missing_oauth", message: ".claude.json is missing oauthAccount.emailAddress" });
}
```

Replace with adapter-driven check:

```ts
const accountInfo = await adapter.readAccountInfo(profile.configDir);
if (!accountInfo) {
  issues.push({
    kind: "missing_json",
    message: profile.tool === "claude"
      ? ".claude.json is missing or missing oauthAccount.emailAddress"
      : "auth.json is missing or id_token unparseable",
  });
}
```

(Remove the now-unused `parseClaudeJson` only if no other site uses it; otherwise keep it.)

- [ ] **Step 3: Update plugins consistency check to apply only when tool is claude**

Wrap the existing `if (!profile.isPrimary) { const profilePlugins = ... pluginsOutOfSync logic }` block in `if (profile.tool === "claude")`. Codex has no equivalent JSON to drift in v1.

- [ ] **Step 4: Update `repairProfile` to use adapter**

In `repairProfile`, replace `setupSharedLinks(profile.configDir, registry.primarySource, ...)` with:

```ts
const adapter = getAdapter(profile.tool);
const primary = registry.primarySources[profile.tool];
if (!primary) throw new Error(`Tool '${profile.tool}' is not initialized in clausona.`);
const repaired = await setupSharedLinks(adapter, profile.configDir, primary, profile.mergeSessions ?? false, backupDir);
if (profile.tool === "claude") await setupPluginsDir(profile.configDir, primary);
```

(`setupPluginsDir` stays Claude-only — codex's plugins handling will be added in Task 18 if needed; for v1 the wholesale-symlink-default works.)

- [ ] **Step 5: Type-check + tests**

Run: `pnpm typecheck && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/service.ts
git commit -m "refactor: tool-aware doctor and repair paths"
```

---

## Task 13: Update commands.ts — prefix parsing + new help text

**Files:**
- Modify: `src/commands.ts`

- [ ] **Step 1: Add tool-aware command resolution**

At the top of `src/commands.ts`, add:

```ts
import { parseProfileRef, profileId } from "./lib/profile-ref.js";
import { ALL_TOOLS } from "./tools/registry.js";
```

- [ ] **Step 2: Update `use` command**

Replace:

```ts
case "use": {
  const [name] = args;
  if (!name) return "__OPEN_TUI__:use";
  const profile = await setActiveProfileByName(name);
  return success(`Switched to ${bold(name)} ${dim(`(${profile.email})`)}`);
}
```

with:

```ts
case "use": {
  const [input] = args;
  if (!input) return "__OPEN_TUI__:use";
  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");
  const ref = parseProfileRef(input, registry);
  const profile = await setActiveProfileByName(ref.id);
  return success(`Switched to ${bold(ref.id)} ${dim(`(${profile.email})`)}`);
}
```

- [ ] **Step 3: Update remove / login / repair / config**

For each of these, replace lookup-by-bare-name with `parseProfileRef(input, registry).id` then pass that id to the service function. Example (for `remove`):

```ts
case "remove": {
  const [input] = args.filter((arg) => !arg.startsWith("--"));
  if (!input) throw new Error("Usage: clausona remove <profile>");
  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");
  const ref = parseProfileRef(input, registry);
  await removeProfile(ref.id);
  return success(`Removed ${bold(ref.id)}`);
}
```

Apply the same pattern to `login`, `repair`, and `config`. For `config`, also update the success message to use `ref.id`.

- [ ] **Step 4: Update `add` command (different ambiguity rule)**

Replace the existing `add` case body:

```ts
case "add": {
  const fromIndex = args.indexOf("--from");
  const fromPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
  const fromValueIndex = fromIndex >= 0 ? fromIndex + 1 : -1;
  const mergeSessions = args.includes("--merge-sessions");
  const [input] = args.filter((arg, i) => !arg.startsWith("--") && i !== fromValueIndex);
  if (!input) throw new Error("Usage: clausona add <profile> [--from <path>] [--merge-sessions]");

  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");

  let tool: ToolName;
  let name: string;
  if (input.includes(":")) {
    const [maybeTool, ...rest] = input.split(":");
    if (!(ALL_TOOLS as string[]).includes(maybeTool)) {
      throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
    }
    tool = maybeTool as ToolName;
    name = rest.join(":");
  } else {
    const configured = ALL_TOOLS.filter((t) => registry.primarySources[t]);
    if (configured.length !== 1) {
      throw new Error(
        configured.length === 0
          ? "No tools configured. Run `clausona init` first."
          : `Both tools are configured. Specify '${configured.map((t) => `${t}:${input}`).join("' or '")}'.`,
      );
    }
    tool = configured[0];
    name = input;
  }

  const added = await addProfile({ tool, name, fromPath, mergeSessions: mergeSessions || undefined });
  return success(`Added ${bold(profileId(tool, added.name))} ${dim(`(${added.email})`)}`);
}
```

(Add `import type { ToolName } from "./types.js";` at the top if not present.)

- [ ] **Step 5: Update `list`/`current`/`usage` commands and help text**

For `list` and `current`, the changes are in formatting (Task 16). Just confirm the underlying service functions return per-tool data; they should already.

For `usage`, gate codex-tool profile lookups:

```ts
case "usage": {
  const [input] = args.filter((arg) => !arg.startsWith("--"));
  const periodArg = args.find((arg) => arg.startsWith("--period="));
  const period = (periodArg?.split("=")[1] as "today" | "week" | "month" | "all" | undefined) ?? "today";

  let id: string | null = null;
  if (input) {
    const registry = await loadRegistry();
    if (!registry) throw new Error("clausona is not initialized.");
    const ref = parseProfileRef(input, registry);
    if (ref.tool === "codex") {
      throw new Error("Usage tracking not supported for codex (yet).");
    }
    id = ref.id;
  }

  const summary = await getUsageSummary(id, period);
  if (!summary) return success(dim("No usage data found."));
  if (jsonFlag(args)) return JSON.stringify(summary, null, 2);
  return renderUsageSummary(summary, id ?? undefined, period);
}
```

Update help text in `subcommandHelpText` to use `<profile>` (instead of `<name>`) and add note: `<profile>` accepts either bare name (when unique) or `tool:name`.

- [ ] **Step 6: Type-check + tests**

Run: `pnpm typecheck && pnpm test`
Expected: green. Update the existing `index.test.ts` if it referenced removed signatures.

- [ ] **Step 7: Commit**

```bash
git add src/commands.ts src/index.test.ts
git commit -m "feat: prefix-aware CLI parsing for use/add/login/remove/repair/config/usage"
```

---

## Task 14: Update src/index.tsx exec branch

**Files:**
- Modify: `src/index.tsx`

- [ ] **Step 1: Replace hardcoded `claude` spawn with adapter binary**

Replace the `parsed.kind === "exec"` branch:

```ts
if (parsed.kind === "exec") {
  try {
    const registry = await loadRegistry();
    if (!registry) throw new Error("clausona is not initialized.");
    const ref = parseProfileRef(parsed.profile, registry);
    const { binary, env } = await resolveProfileEnv(ref.id);
    const result = spawnSync(binary, parsed.args, { stdio: "inherit", env });
    process.exitCode = result.status ?? 1;
    if (ref.tool === "claude") {
      await trackUsage(ref.id).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  ${xMark} ${message}\n`);
    process.exitCode = 1;
  }
  return;
}
```

Add the imports:

```ts
import { loadRegistry } from "./lib/service.js";
import { parseProfileRef } from "./lib/profile-ref.js";
```

- [ ] **Step 2: Type-check + smoke**

Run: `pnpm typecheck && pnpm build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/index.tsx
git commit -m "feat: clausona run dispatches via adapter binary (claude or codex)"
```

---

## Task 15: Update shell.ts — emit two wrappers

**Files:**
- Modify: `src/core/shell.ts`
- Modify: `src/core/shell.test.ts`

- [ ] **Step 1: Update existing test + add codex-wrapper assertions**

Replace contents of `src/core/shell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderShellInit } from "./shell.js";

describe("renderShellInit", () => {
  const out = renderShellInit();

  it("defines _clausona_resolve helper that takes a tool argument", () => {
    expect(out).toMatch(/_clausona_resolve\(\)\s*\{/);
    expect(out).toMatch(/local tool=\$1/);
  });

  it("defines a claude() wrapper that sets CLAUDE_CONFIG_DIR", () => {
    expect(out).toMatch(/^claude\(\)\s*\{/m);
    expect(out).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/_clausona_resolve claude/);
    expect(out).toMatch(/clausona _track-usage/);
  });

  it("defines a codex() wrapper that sets CODEX_HOME", () => {
    expect(out).toMatch(/^codex\(\)\s*\{/m);
    expect(out).toMatch(/CODEX_HOME/);
    expect(out).toMatch(/_clausona_resolve codex/);
  });

  it("does NOT include _track-usage in codex wrapper (claude only in v1)", () => {
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    expect(codexBlock).not.toMatch(/_track-usage/);
  });

  it("retains csn alias", () => {
    expect(out).toMatch(/alias csn=clausona/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/core/shell.test.ts`
Expected: FAIL — codex() wrapper, _clausona_resolve helper not present.

- [ ] **Step 3: Replace `src/core/shell.ts`**

Replace file contents:

```ts
export function renderShellInit() {
  return `# clausona shell integration
_clausona_resolve() {
  local tool=$1
  local pfile="$HOME/.clausona/profiles.json"
  [[ -f "$pfile" ]] || return

  local result
  result=$(node -e "
const fs = require('fs');
const os = require('os');
const path = require('path');
try {
  const d = JSON.parse(fs.readFileSync('$pfile', 'utf8'));
  const tool = '$tool';
  const id = (d.activeProfiles || {})[tool] || '';
  if (!id) { return; }
  const profile = (d.profiles || {})[id];
  if (!profile) { return; }
  const configDir = profile.configDir || '';
  const isPrimary = profile.isPrimary || false;
  const defaultDir = tool === 'claude'
    ? path.join(os.homedir(), '.claude')
    : path.join(os.homedir(), '.codex');
  const resolved = fs.realpathSync(configDir);
  const defaultResolved = fs.realpathSync(defaultDir);
  if (isPrimary || resolved === defaultResolved) {
    console.log('__PRIMARY__');
  } else {
    console.log(configDir);
  }
} catch {}
" 2>/dev/null)
  echo "$result"
}

unalias claude 2>/dev/null
claude() {
  if [[ -z "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    local r
    r=$(_clausona_resolve claude)
    if [[ "$r" == "__PRIMARY__" ]]; then
      :
    elif [[ -n "$r" ]]; then
      export CLAUDE_CONFIG_DIR="$r"
    fi
  fi
  clausona _sync-plugins 2>/dev/null
  command claude "$@"
  local rc=$?
  unset CLAUDE_CONFIG_DIR
  clausona _track-usage 2>/dev/null
  return $rc
}

unalias codex 2>/dev/null
codex() {
  if [[ -z "\${CODEX_HOME:-}" ]]; then
    local r
    r=$(_clausona_resolve codex)
    if [[ "$r" == "__PRIMARY__" ]]; then
      :
    elif [[ -n "$r" ]]; then
      export CODEX_HOME="$r"
    fi
  fi
  command codex "$@"
  local rc=$?
  unset CODEX_HOME
  return $rc
}

alias csn=clausona
`;
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm vitest run src/core/shell.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/shell.ts src/core/shell.test.ts
git commit -m "feat: emit claude() and codex() wrappers in shell-init"
```

---

## Task 16: format.ts — render tool column in list

**Files:**
- Modify: `src/lib/format.ts`

- [ ] **Step 1: Update `renderList` to include a tool column**

Locate `renderList` in `src/lib/format.ts`. Adjust the column layout so each row begins with the tool name (e.g., `claude` or `codex`) before the profile name. The exact rendering style should match the existing aesthetic — keep the active marker, padding, and color treatment consistent.

Concrete requirements:
- Sort items: tool ascending (claude before codex), then name ascending (primary first within each tool).
- For codex rows, render the usage cost columns as `—` (em-dash) in dim color, with a one-line footnote at table bottom: `* usage tracking not supported for codex`.
- Use existing `accent`/`dim`/`secondary` style helpers; do not introduce a new color.

Add a small change in `renderUsageSummary` to display the profile id (`claude:work`) in headers instead of bare name.

- [ ] **Step 2: Type-check + smoke**

Run: `pnpm typecheck`
Expected: clean.

If `format.ts` has its own tests, update them. (Currently it does not.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/format.ts
git commit -m "feat: render tool column in clausona list"
```

---

## Task 17: TUI — unified list + sectioned use picker + sectioned init

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/App.test.tsx` (if affected)

- [ ] **Step 1: Update Dashboard list view**

In `App.tsx`, locate the list rendering (Dashboard view). Render a unified table grouped/ordered by tool. Each row shows: active marker | `<tool>:<name>` | email | today's cost (or `—` for codex) | `active` badge if it's that tool's active.

- [ ] **Step 2: Update use picker view**

When the user invokes `clausona use` without an argument, the picker now shows two sections:
```
── claude ──
  claude:default
  claude:work
── codex ──
  codex:default
  codex:personal
```
Arrow keys traverse across both sections. Pressing Enter on a row switches THAT tool's active to THAT row's profile (does not change the other tool's active).

- [ ] **Step 3: Update init view**

In the init flow, discover via `discoverAccounts()` (which now returns per-tool entries). Render two sections (`── claude ──`, `── codex ──`). Within each, allow renaming + merge-sessions toggle as today. If a tool has no discovered accounts, omit its section entirely.

- [ ] **Step 4: Run tests + manual smoke**

Run: `pnpm test`. Update `App.test.tsx` snapshots/assertions for new layout.

Manual smoke (after `pnpm build`): `node dist/index.js list`, `node dist/index.js current`, `node dist/index.js` (TUI). Verify both tools' profiles appear if both are configured locally; verify nothing breaks for claude-only users (toggle by temporarily deleting `primarySources.codex` from `~/.clausona/profiles.json`).

- [ ] **Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/App.test.tsx
git commit -m "feat: unified TUI list and sectioned use/init pickers"
```

---

## Task 18: Codex config.toml symlink probe (manual integration)

This task is gated on real-world behavior. It is NOT a code task by default — it's a verification step that may produce code changes.

- [ ] **Step 1: Set up a test profile manually**

```bash
# Save current state
cp -a ~/.codex /tmp/codex-backup-$(date +%s)

# Create a fresh test profile dir
mkdir -p ~/.codex-clausona-probe
ln -s ~/.codex/config.toml ~/.codex-clausona-probe/config.toml

# Try launching codex with that as CODEX_HOME
CODEX_HOME=~/.codex-clausona-probe codex login status
CODEX_HOME=~/.codex-clausona-probe codex --help
```

Expected: codex launches and reads model/personality from the symlinked `config.toml` without crashing on the inside-`$CODEX_HOME` `[marketplaces.openai-bundled].source` paths. Login status will say "Not logged in" because no auth.json was placed.

- [ ] **Step 2: If codex launches cleanly → no code change needed**

Document the verification in a commit-message-only change or a small note in `README.md`. Proceed to Task 19.

- [ ] **Step 3: If codex errors on missing marketplace source paths**

Implement a `postSetup` for codex in `src/tools/codex.ts`:

```ts
async function codexPostSetup(profileDir: string, primaryDir: string): Promise<void> {
  const configPath = path.join(profileDir, "config.toml");
  // If config.toml is a symlink to primary, replace with a copy.
  const stat = await lstat(configPath).catch(() => null);
  if (!stat?.isSymbolicLink()) return;
  const linkTarget = await readlink(configPath);
  if (linkTarget !== path.join(primaryDir, "config.toml")) return;
  const content = await readFile(configPath, "utf8");
  await rm(configPath);
  await writeFile(configPath, content, "utf8");
}
```

Wire it into `codexAdapter.postSetup` and call it from `setupSharedLinks`'s caller (already a hook in the adapter contract). Add a unit test that confirms the symlink is replaced with a real file containing the same content. Update `Risks` section of the spec to note the fall-back was activated.

- [ ] **Step 4: Cleanup probe artifacts**

```bash
rm -rf ~/.codex-clausona-probe
```

- [ ] **Step 5: Commit (only if code changed)**

```bash
git add src/tools/codex.ts src/tools/codex.test.ts
git commit -m "fix: copy config.toml per-profile to avoid primary .tmp/ leak"
```

---

## Task 19: Auto-migrate registry on boot + version bump + README

**Files:**
- Modify: `src/lib/service.ts` (loadRegistry hook)
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Implement migration-on-load**

In `src/lib/service.ts`, modify `loadRegistry` to detect and migrate v1 in-place on first read:

```ts
import { migrateRegistryV1toV2, isV1Registry } from "../core/registry.js";

export async function loadRegistry(): Promise<Registry | null> {
  const raw = await readJson<unknown>(REGISTRY_PATH, null);
  if (raw === null) return null;
  if (isV1Registry(raw)) {
    // Backup before rewriting
    await cp(REGISTRY_PATH, `${REGISTRY_PATH}.v1.bak`).catch(() => {});
    const migrated = migrateRegistryV1toV2(raw as RegistryV1);
    await writeJson(REGISTRY_PATH, migrated);

    // Backup directory layout migration: claude/ subdir
    const backupsDir = path.join(CLAUSONA_DIR, "backups");
    const backupEntries = await readdir(backupsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of backupEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "claude" || entry.name === "codex") continue; // already-new layout
      const src = path.join(backupsDir, entry.name);
      const dst = path.join(backupsDir, "claude", entry.name);
      await mkdir(path.dirname(dst), { recursive: true });
      await rename(src, dst).catch(() => {});
    }

    // Usage store key rename
    const usageRaw = await readJson<Record<string, unknown> | null>(USAGE_PATH, null);
    if (usageRaw && Object.keys(usageRaw).some((k) => !k.includes(":"))) {
      await cp(USAGE_PATH, `${USAGE_PATH}.v1.bak`).catch(() => {});
      const renamed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(usageRaw)) {
        renamed[k.includes(":") ? k : `claude:${k}`] = v;
      }
      await writeJson(USAGE_PATH, renamed);
    }

    process.stderr.write(
      "  clausona migrated registry to v2 (codex support enabled). Open a new terminal to activate the codex() wrapper.\n",
    );
    return migrated;
  }
  return raw as Registry;
}
```

(Add `import { rename } from "node:fs/promises";` if not present.)

- [ ] **Step 2: Bump version**

In `package.json`:

```json
"version": "0.1.0"
```

In `src/commands.ts`, the version literal:

```ts
return `  ${accent("clausona")} ${dim("v0.1.0")}`;
```

- [ ] **Step 3: Update README**

In `README.md`:
- Update tagline: `Switch between multiple Claude Code and OpenAI Codex CLI accounts on one machine — plugins, MCP servers, and settings stay shared.`
- Add a "Codex support" subsection under "How It Works" describing CODEX_HOME swap and the SHARED/SKIP file matrix briefly.
- Update Quick Start to show codex examples: `clausona add codex:work`, `clausona use codex:personal`.
- Add a Migration note: "Upgrading from 0.0.x: registry is auto-migrated on first launch; backups are saved with `.v1.bak` suffix."

- [ ] **Step 4: Lint + typecheck + full test pass**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all clean.

- [ ] **Step 5: Manual end-to-end verification**

```bash
# Backup current state for safety
cp ~/.clausona/profiles.json ~/.clausona/profiles.json.preupgrade.bak

# Build and run
pnpm build
node dist/index.js list                        # both tools listed if both configured
node dist/index.js current                     # both tools' active shown
node dist/index.js add codex:probe             # interactive: should run `codex login`
node dist/index.js use codex:probe             # switch
echo $CLAUDE_CONFIG_DIR                        # unchanged (only codex switched)
node dist/index.js use claude:default          # switch claude
node dist/index.js list                        # see updated active markers
node dist/index.js remove codex:probe          # cleanup
```

- [ ] **Step 6: Commit**

```bash
git add package.json src/commands.ts src/lib/service.ts README.md
git commit -m "feat: auto-migrate registry to v2 on boot; bump 0.1.0 with codex support"
```

---

## Self-Review Checklist (run before handoff)

- [ ] Spec coverage: every section in `docs/superpowers/specs/2026-05-15-codex-multi-profile-design.md` maps to at least one task above (registry v2 → Task 1; backups → Tasks 2 & 19; ToolAdapter → Task 3; ClaudeAdapter → Task 4; JWT decoder → Task 5; CodexAdapter → Task 6; adapter registry → Task 7; parseProfileRef → Task 8; service.ts refactors → Tasks 9–12; commands.ts → Task 13; index.tsx exec → Task 14; shell hook → Task 15; format → Task 16; TUI → Task 17; config.toml probe → Task 18; auto-migrate + version + README → Task 19).
- [ ] No `TODO`, `TBD`, or "implement later" markers in any task body.
- [ ] All function/type names referenced in later tasks (e.g., `getAdapter`, `parseProfileRef`, `backupDirFor`, `migrateRegistryV1toV2`, `profileId`) are defined in earlier tasks.
- [ ] Acceptance criteria from spec are exercised by tasks: prefix inference (Task 8), JWT display (Tasks 5–6), unified list (Tasks 16, 17), codex resume preservation (Task 6's skip set + manual smoke in Task 19), v1 migration (Task 19).
