# Codex Multi-Profile Support — Design

Date: 2026-05-15
Target version: clausona 0.1.0 (BREAKING from 0.0.4-beta)

## Goal

Extend clausona so a single user can manage multiple OpenAI Codex CLI accounts on one machine via the same UX they already use for Claude Code. Both tools' profiles appear in one unified `clausona list`, and the same commands (`use`, `add`, `login`, `current`, `run`, ...) work for either tool.

## Non-Goals (v1)

- Codex usage tracking (cost/tokens). Skipped — codex internal sqlite/sessions schema is unstable and not exposed.
- Codex `cli_auth_credentials_store = "keyring"` backend. File backend (`auth.json`) only.
- Integration with codex's own `--profile` flag (model preset feature, distinct concept).
- Macros that switch claude + codex profiles in one command.
- Linux Secret Service / Windows Credential Manager integration (matches existing claude-side scope).

## Background

### Why this works mechanically

Codex CLI (verified against 0.130.0) honors a `CODEX_HOME` environment variable that relocates its entire state directory. Setting `CODEX_HOME=~/.codex-work` causes:
- Login writes credentials to `~/.codex-work/auth.json`
- Sessions write to `~/.codex-work/sessions/`
- `codex resume` only sees `~/.codex-work/sessions/`
- All other state (`history.jsonl`, `state_*.sqlite`, `logs/`) lives under that dir

This is the exact same pattern as Claude Code's `CLAUDE_CONFIG_DIR`, with two simplifications:

1. **No path-bound credentials.** Claude Code stores tokens in macOS Keychain under a per-config-dir hashed service name (`Claude Code-credentials-<sha256(configDir)>`). Codex stores them in a plain JSON file inside `$CODEX_HOME`. No keychain hash gymnastics, no platform branching.
2. **Cross-OS uniform.** Codex behaves the same on macOS / Linux / WSL.

### Verified locally

```
$ CODEX_HOME=/tmp/codex-test codex login status
Not logged in            ← isolated from main account
$ ls /tmp/codex-test
memories/  tmp/          ← codex auto-bootstraps the dir
```

## Architecture

### Tool adapter pattern

Today `src/lib/service.ts` (1500 lines) hardcodes Claude Code assumptions throughout (`.claude.json` parsing, `claude auth login`, `Claude Code-credentials` service name). Adding a second tool by branching inline would compound the existing weight.

Introduce `src/tools/` with a `ToolAdapter` interface; all tool-specific logic lives behind it.

```
src/
├── core/
│   ├── paths.ts           # tool-agnostic path utils
│   ├── registry.ts        # v2 schema read/write/migrate
│   ├── shell.ts           # emits BOTH claude() and codex() wrappers
│   ├── usage.ts           # claude only (unchanged)
│   ├── track-usage.ts     # claude only (unchanged)
│   └── doctor.ts          # tool-aware
│
├── tools/                 # NEW — tool adapters
│   ├── types.ts           # ToolAdapter interface
│   ├── claude.ts          # claude logic extracted from service.ts
│   ├── codex.ts           # codex implementation
│   └── registry.ts        # name -> adapter map
│
├── lib/
│   ├── service.ts         # delegates to adapter; no tool branching
│   ├── format.ts          # adds tool column to list rendering
│   └── cli-style.ts       # unchanged
│
├── tui/                   # tool column / sectioned use picker / init
└── commands.ts            # prefix parsing + ambiguity check
```

### `ToolAdapter` interface

```ts
type ToolName = "claude" | "codex";

type ToolAdapter = {
  name: ToolName;
  binary: string;                              // "claude" | "codex"
  configEnvVar: string;                        // "CLAUDE_CONFIG_DIR" | "CODEX_HOME"
  defaultConfigDir(homeDir: string): string;   // ~/.claude | ~/.codex
  configDirPattern: RegExp;                    // matches ~/.claude(-...)? or ~/.codex(-...)?

  // Read account metadata from a config dir (returns null if not authenticated)
  readAccountInfo(configDir: string): Promise<{ email: string; orgName?: string } | null>;

  // OS keychain probe (claude only; codex returns no-op)
  keychainServiceName?(configDir: string, homeDir: string): string;
  hasKeychainCredential?(service: string): Promise<boolean>;

  // Files/dirs under configDir to NOT symlink-share
  sharedSkipSet(mergeSessions: boolean): Set<string>;

  // Per-tool post-setup (e.g. claude's syncPluginsJson absolute-path rewrite)
  postSetup?(profileDir: string, primaryDir: string): Promise<void>;

  // Interactive login command for this tool
  runLogin(configDir: string): Promise<boolean>;
};
```

`service.ts` functions (`discoverAccounts`, `setupSharedLinks`, `addProfile`, `loginProfile`, `doctorProfiles`, ...) take an adapter parameter or look one up by tool name from the registry.

### Implementation notes (specific concrete fixups)

- `src/index.tsx` — the `parsed.kind === "exec"` branch currently calls `spawnSync("claude", parsed.args, ...)`. Change to look up the profile's adapter and use `adapter.binary` + `adapter.configEnvVar` to build the env. The `trackUsage(profile).catch(...)` call should be skipped for codex profiles in v1.
- `src/commands.ts` — add `parseProfileRef(input: string, registry: RegistryV2): { tool: ToolName; name: string }` helper, used by all reference-taking commands. Implements the inference rule (unique → use it, ambiguous → throw).
- `src/core/shell.ts` — emit two wrapper functions; share a `_clausona_resolve` helper that takes the tool name as `$1`.
- Backups path resolver: every site that today builds `path.join(CLAUSONA_DIR, "backups", profileName)` must build `path.join(CLAUSONA_DIR, "backups", tool, name)` instead. Affected sites: `initializeRegistry`, `addProfile`, `repairProfile`, `cleanupProfile`, `updateProfileConfig`. Centralize as `backupDirFor(tool, name)` to avoid drift.

### Codex adapter specifics

- `binary`: `codex`
- `configEnvVar`: `CODEX_HOME`
- `defaultConfigDir`: `~/.codex`
- `readAccountInfo(configDir)`: read `<configDir>/auth.json`, decode the `tokens.id_token` JWT payload (base64url decode the middle segment, parse JSON). **Verified locally** — payload contains: `email`, `email_verified`, `name` (display name, unicode-safe), `sub`, and `https://api.openai.com/auth.{chatgpt_account_id, chatgpt_plan_type, organizations}`. Use `email` as primary identifier; `name` for display; `https://api.openai.com/auth.organizations[0].title` (or similar) as `orgName` if present. No signature verification — display purposes only. If `auth.json` is missing or token unparseable, return null.
- `keychainServiceName` / `hasKeychainCredential`: not implemented (return undefined / true).
- `runLogin(configDir)`: spawn `codex login` with `env: { CODEX_HOME: configDir }`, stdio inherited.

## Data Model — Registry v2

`~/.clausona/profiles.json`:

```jsonc
{
  "version": 2,
  "primarySources": {
    "claude": "/Users/x/.claude",
    "codex":  "/Users/x/.codex"
  },
  "activeProfiles": {
    "claude": "claude:work",
    "codex":  "codex:personal"
  },
  "profiles": {
    "claude:default":  { "tool": "claude", "configDir": "...", "email": "...", "isPrimary": true },
    "claude:work":     { "tool": "claude", "configDir": "...", "email": "...", "mergeSessions": false },
    "codex:default":   { "tool": "codex",  "configDir": "...", "email": "...", "isPrimary": true },
    "codex:personal":  { "tool": "codex",  "configDir": "...", "email": "...", "mergeSessions": false }
  }
}
```

Key decisions:
- Profile ID is `<tool>:<name>`. Same form is used in registry keys, CLI args, and display output. Zero ambiguity in stored form.
- `activeProfile` (string) → `activeProfiles` (per-tool map). Each tool's shell wrapper uses its own active profile.
- `primarySource` (string) → `primarySources` (per-tool map). A tool key being absent means "tool not initialized in clausona".

## CLI UX

### Prefix inference rule (uniform across all reference commands)

Reference commands: `use`, `current`, `login`, `remove`, `repair`, `config`, `run`.

| User input | Behavior |
|---|---|
| `clausona use claude:work` | Explicit — switch claude active to work |
| `clausona use codex:personal` | Explicit — switch codex active to personal |
| `clausona use work` (only claude has it) | → `claude:work` |
| `clausona use work` (only codex has it) | → `codex:work` |
| `clausona use work` (both have it) | Error: `"work" exists in both claude and codex. Use 'claude:work' or 'codex:work'.` |
| `clausona use work` (neither has it) | Error: `Profile 'work' not found.` |

Rule: prefix-less name is accepted if and only if it is globally unique across all configured tools, regardless of tool.

### Add command

| Scenario | `clausona add work` |
|---|---|
| Only claude is configured (no `primarySources.codex`) | → creates `claude:work` |
| Only codex is configured | → creates `codex:work` |
| Both tools configured | Error: `Both tools are configured. Specify 'claude:work' or 'codex:work'.` |

`add` ambiguity is based on which tools are configured (not which profile names exist), because `add` creates new state.

### Per-command behavior

| Command | New behavior |
|---|---|
| `clausona list [--tool=claude\|codex] [--json]` | Unified table with tool column; filter optional |
| `clausona current [--tool=...] [--json]` | Both tools' active by default; `--tool` for one |
| `clausona use [profile]` | Per inference rule; opens TUI picker if no arg |
| `clausona add <profile> [--from <path>] [--merge-sessions]` | Per inference rule; tool determined by configured set |
| `clausona login <profile>` | Per inference rule; spawns the right tool's login |
| `clausona remove <profile>` | Per inference rule |
| `clausona run <profile> [-- args...]` | Spawns the profile's tool binary with the right env var |
| `clausona init` | Discovers `~/.claude*` AND `~/.codex*`; TUI shows two sections; `--tool=...` to scope |
| `clausona doctor [--tool=...] [--json]` | Both tools combined; tool-specific health rules |
| `clausona repair <profile>` | Per inference rule |
| `clausona config <profile> --merge-sessions \| --separate-sessions` | Per inference rule; same semantics for both tools |
| `clausona usage [profile] [--period=...] [--json]` | claude profiles only; codex profile arg → polite error: `usage tracking not supported for codex (yet)` |
| `clausona shell-init` | Emits both `claude()` and `codex()` wrappers + `csn` alias |
| `clausona uninstall` | Cleans up both tools' non-primary profiles |

### Shell hook

```bash
# clausona shell integration
_clausona_resolve() {
  local tool=$1
  local pfile="$HOME/.clausona/profiles.json"
  [[ -f "$pfile" ]] || return
  # node one-liner: read activeProfiles[tool] → resolve configDir →
  # echo "PRIMARY" or the configDir path
  ...
}

unalias claude 2>/dev/null
claude() {
  if [[ -z "${CLAUDE_CONFIG_DIR:-}" ]]; then
    local r=$(_clausona_resolve claude)
    if [[ "$r" != "PRIMARY" && -n "$r" ]]; then
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
  if [[ -z "${CODEX_HOME:-}" ]]; then
    local r=$(_clausona_resolve codex)
    if [[ "$r" != "PRIMARY" && -n "$r" ]]; then
      export CODEX_HOME="$r"
    fi
  fi
  command codex "$@"
  local rc=$?
  unset CODEX_HOME
  return $rc
}

alias csn=clausona
```

The `codex()` wrapper has no equivalent of `_sync-plugins` / `_track-usage` in v1.

## Codex SHARED vs SKIP File Matrix

Default (`mergeSessions = false`):

**SKIP (per-profile, never symlink-shared)**:
- `auth.json` — credentials
- `sessions/` — conversation transcripts (the `codex resume` source)
- `session_index.jsonl` — sessions index
- `history.jsonl` — input history (Ctrl-R)
- `state_*.sqlite[-shm/-wal]` — session state DB
- `logs_*.sqlite[-shm/-wal]` — log DB
- `log/`, `logs/` — log files
- `shell_snapshots/` — per-session shell snapshots
- `installation_id` — install marker
- `.codex-global-state.json[.bak]` — runtime global state
- `cloud-requirements-cache.json` — cache
- `external_agent_session_imports.json` — session imports
- `models_cache.json` — per-account model availability cache
- `cache/`, `tmp/`, `.tmp/` — caches & temp
- `computer-use/`, `sqlite/` — runtime
- `version.json` — codex version marker
- `plugins/.marketplace-plugin-source-staging/` — ephemeral marketplace staging (regenerated on demand)

**SHARED (symlinked to primary `~/.codex`)**:
- `config.toml` — model / personality / features / marketplaces (see Special-case)
- `plugins/cache/` — plugin cache (inner-symlink only; not the whole `plugins/` dir)
- `skills/` — agent skills definitions
- `superpowers/` — superpowers definitions
- `rules/` — user rules
- `memories/` — agent memory (assumes same human user across accounts)
- `hooks.json` — hooks
- `vendor_imports/` — vendor imports
- `.personality_migration` — migration marker

**Per-profile real dir with selective inner symlinks**:
- `plugins/` — real directory containing inner symlinks to primary (`cache/`) and per-profile dirs (`.marketplace-plugin-source-staging/`, regenerated by codex)

`mergeSessions = true` removes `sessions/`, `session_index.jsonl`, `history.jsonl` from SKIP (they become shared with primary).

### Special-case files

- **`config.toml`**: start with whole-file symlink to primary. **Verified risk** (in test machine's config.toml): `[marketplaces.openai-bundled].source = "/Users/x/.codex/.tmp/bundled-marketplaces/openai-bundled"` — the source path points inside `$CODEX_HOME`. With a symlinked config.toml, non-primary profiles will reference primary's `.tmp/`. Implementation must verify two things during implementation:
  1. Whether codex actually requires that staged `bundled-marketplaces` content to be present at the recorded source path (it may be regenerated at startup, in which case primary's path is fine).
  2. Whether non-primary profiles can read it (it lives outside their `$CODEX_HOME`).
  Fallback if symlink causes issues: copy config.toml on profile creation (per-profile, not synced) and document this trade-off in README.

- **`plugins/`** (corrected from earlier draft — codex's `plugins/` is **simpler than claude's**):
  - **Verified locally**: `~/.codex/plugins/` contains only `cache/` and `.marketplace-plugin-source-staging/`. There is **no** `installed_plugins.json` or `known_marketplaces.json` inside `plugins/` — codex registers marketplaces in `config.toml` instead.
  - Treat `plugins/cache/` as SHARED (symlink to primary; cache benefits all profiles).
  - Treat `plugins/.marketplace-plugin-source-staging/` as SKIP (per-profile, ephemeral staging directory; codex regenerates on demand).
  - Wholesale `plugins/` symlink would also work but inner-symlink with `.marketplace-plugin-source-staging` excluded is safer.
  - No path-rewrite logic needed (no per-profile JSON to edit).

## Migration & Compatibility

### Auto-migrate registry on boot (v1 → v2)

Triggered once at first boot of v0.1.0. Detected by absence of `version` key.

Steps:
1. Backup: `cp ~/.clausona/profiles.json ~/.clausona/profiles.json.v1.bak`
2. Rewrite:
   - Add `tool: "claude"` to every profile
   - Rename keys: `<name>` → `claude:<name>`
   - `primarySource` (string) → `primarySources: { claude: <string> }`
   - `activeProfile` (string) → `activeProfiles: { claude: "claude:<old_name>" }`
   - Add `version: 2`

Same one-shot migration for `~/.clausona/usage.json`: rename keys `<name>` → `claude:<name>`, backup as `usage.json.v1.bak`.

### Backup directory layout migration

Old: `~/.clausona/backups/<profileName>/` (flat).
New: `~/.clausona/backups/<tool>/<name>/` (nested by tool).

Migration: at first v0.1.0 boot, move `~/.clausona/backups/<oldName>/` → `~/.clausona/backups/claude/<oldName>/` for every entry that doesn't already match the new layout. Idempotent — safe to re-run.

Reason: profile names like `claude:work` would create directory names containing `:`, which is fine on macOS/Linux but historically bad on Windows. Subdir layout sidesteps the issue and is cleaner.

### Shell hook auto-refresh

Existing users have `eval "$(clausona shell-init)"` in their rc files — no action needed. Re-running shell-init (next terminal start, or `source ~/.zshrc`) installs both wrappers.

Migration message printed on first v0.1.0 invocation: `"Codex support is now available. Open a new terminal to activate the codex() wrapper."`

### CLI compatibility

- `clausona use work` (no prefix): keeps working unchanged when codex is not configured. Becomes ambiguous-error only if user later registers a `codex:work`.
- `--json` output for `current` is BREAKING (`{ name, ... }` → `{ claude: { ... }, codex: { ... } }`). Acceptable at 0.0.4-beta → 0.1.0 jump.

### Codex absent / not configured

- Codex binary missing: `clausona init` skips codex section. The `codex()` wrapper still emits but defers to `command codex` which yields the OS's "command not found".
- `~/.codex` missing: `discoverAccounts("codex")` returns empty. List/current omit codex section.
- Claude-only users: zero behavior change.

### Codex-only user (claude not installed)

- `discoverAccounts("claude")` graceful-fail.
- Both wrappers still emit (cost: 2 shell function definitions).

### Rollback

`cp ~/.clausona/profiles.json.v1.bak ~/.clausona/profiles.json` then install previous clausona version.

## TUI Changes

`src/tui/App.tsx`:

- **Dashboard list**: unified table, sorted by tool then name. Active marker `●` per tool.
  ```
  ●  claude:work       hui_eun@yanolja.com    $0.42 today    active
     claude:personal   hui_eun@gmail.com      $0.00 today
  ●  codex:work        hui_eun@yanolja.com       —    *      active
     codex:personal    hui_eun@gmail.com         —    *
                                                * usage tracking not supported for codex
  ```
- **Use picker**: two sections grouped by tool (`── claude ──` / `── codex ──`). Arrow keys traverse both. Enter switches that tool's active only.
- **Init screen**: tool sections; auto-skip codex section if `~/.codex` is absent.
- **Doctor view**: tool column added.
- Theme & components: unchanged.

## Codex Account Metadata Extraction

`auth.json` shape (verified):
```json
{
  "auth_mode": "...",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<JWT>",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "<UUID>"
  },
  "last_refresh": "..."
}
```

`tokens.id_token` is a 3-segment JWT. Decode the middle segment (base64url → JSON). Verified claims (live decode against test machine): `email`, `email_verified`, `name`, `sub`, `exp`, `iat`, `https://api.openai.com/auth.{chatgpt_account_id, chatgpt_plan_type, chatgpt_user_id, organizations}`. No signature verification needed — purely for display.

Contract for `readAccountInfo(configDir)`:
- `auth.json` missing or unparseable → `null`
- JWT decode succeeds with `email` claim → `{ email, orgName? }` (orgName from `organizations[0].title` if present)
- JWT decode succeeds without `email` claim (edge case for some auth modes) → `{ email: tokens.account_id, orgName: undefined }` (UUID fallback so list output isn't blank)

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `config.toml` `[marketplaces.*].source` paths point inside `$CODEX_HOME` (e.g. `.codex/.tmp/bundled-marketplaces/...`); symlinked config.toml makes non-primary profiles point to primary's `.tmp/` | Implementation step: probe whether non-primary profiles can launch successfully with config.toml symlink. If broken, fall back to "copy on profile creation, not symlink" for config.toml; document trade-off (model/personality settings would need per-profile setup). |
| `.codex-global-state.json` semantic uncertain (filename says "global" but lives inside `$CODEX_HOME`) — per-profile isolation might either be correct or break a daily-limit-style invariant | Default isolate (SKIP). Watch for issues during testing; if a real problem emerges, switch to symlink-shared with a release note. |
| Global `forced_login_method` / `forced_chatgpt_workspace_id` in config.toml blocks switching ChatGPT account ↔ API key | Document in README; no code-level block — user opts in by removing the setting |
| codex 0.x CLI shape changes (young tool, fast iteration) | Pin verified behavior to 0.130.0+; doctor flags incompatible versions; spec deliberately limits assumed surface to `codex login`, `codex logout`, `CODEX_HOME`, `auth.json` shape, `sessions/` location |
| Existing v1 registry data corrupted during migration | Pre-migration backup file (`profiles.json.v1.bak`, `usage.json.v1.bak`) + clear error message + manual restore documented in README |
| Profile name `claude:work` contains `:` — historically problematic on Windows filesystems for backup directory names | Use subdir layout `~/.clausona/backups/<tool>/<name>/` instead of flat `<profileName>/` (avoids `:` in filenames; also cleaner organization). clausona doesn't claim Windows support but this is essentially free safety. |
| Pre-existing `CODEX_HOME` env var in user's shell (set manually) is overwritten by `unset CODEX_HOME` at end of `codex()` wrapper | Inherited behavior from existing `claude()` wrapper (same `unset CLAUDE_CONFIG_DIR` at exit). Intentional: clausona enforces "active profile is the source of truth." Document in README. |

## Open Questions

None — all design decisions have been made and confirmed. Two items deferred to implementation-time empirical verification (see Risks): config.toml symlink-vs-copy decision; `.codex-global-state.json` per-profile vs shared.

## Acceptance Criteria

- [ ] `clausona init` discovers existing `~/.codex*` directories alongside `~/.claude*`
- [ ] `clausona add codex:work` creates `~/.codex-work`, runs `codex login`, registers profile
- [ ] `clausona list` shows both tools' profiles in one table
- [ ] `clausona use codex:work` followed by `codex` enters work account; `codex resume` sees only work's history
- [ ] Switching back via `clausona use codex:personal` does not lose work's sessions/history; switching forward again restores resume access to work's prior conversations
- [ ] Existing v1 users on first launch: registry auto-migrated to v2 with backup, no profile loss, claude-only commands behave identically
- [ ] codex absent → no codex commands surface in help/list/current
- [ ] `clausona doctor` reports both tools' health
- [ ] Prefix inference: `clausona use <unique-name>` resolves to its tool; `clausona use <ambiguous-name>` errors with both candidates listed; `clausona add <name>` errors only when both tools are configured
- [ ] codex profile listing shows email + display name from JWT decode (verified to handle non-ASCII display names)
- [ ] All existing claude-side tests still pass
