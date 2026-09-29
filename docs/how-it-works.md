# How It Works

[← Back to the README](../README.md)

## Profile Switching

Shell wrappers for `claude` and `codex` are registered via `eval "$(clausona shell-init)"` on zsh/bash or
`Invoke-Expression (& clausona shell-init | Out-String)` on PowerShell:

1. **Before** each invocation — asks clausona for the active profile's environment: the config
   directory (`CLAUDE_CONFIG_DIR` for claude, `CODEX_HOME` for codex) and, for an API-backed
   profile, its endpoint and credential
2. **During** the invocation — those variables exist only for that one run. On zsh/bash the tool
   runs in a subshell, on PowerShell each variable is restored afterwards, so your interactive
   shell is left exactly as it was. On PowerShell the environment arrives as ASCII-only JSON,
   so a config directory under a non-ASCII user folder reaches the tool intact whatever the
   console's code page
3. **After** each `claude` invocation — detects usage changes via fingerprint comparison and
   records cost/token usage per profile

```
clausona use work
↓
claude             ← wrapper applies the work profile's env, then runs claude
↓
_track-usage       ← on exit, records any new cost/token usage

clausona use codex:personal
↓
codex              ← wrapper applies the personal profile's env, then runs codex
```

If you export `CLAUDE_CONFIG_DIR` (or `CODEX_HOME`) yourself, clausona steps aside for that
shell: it applies no profile environment, skips plugin sync and usage tracking, and leaves your
variable untouched — tracking that run would file its cost against a profile you are not using.
Unset it to hand control back to clausona.

If a profile cannot be applied in full — a credential command that fails, an environment
variable name a shell cannot export — the wrapper applies the rest of the profile, prints a
warning to stderr before every invocation, and still runs the tool. The warning repeats until the
profile is fixed; it is not a one-off notice. The one exception is Windows when PowerShell cannot
create a temp file to capture it: the warning is dropped, but the tool still launches with the
right account.

## Shared Environment

When you register a new profile, clausona symlinks shared resources from your primary config directory into the new profile's config directory.

**Claude profile** (`clausona add claude:work`):

```
~/.claude-work/            (new claude profile)
├── .claude.json           ← own account metadata (NOT shared)
├── .credentials.json      ← own OAuth tokens outside macOS, and on macOS when the
│                            Keychain refuses them (NOT shared)
├── .last-update-result.json, gh-pr-status-cache.json, .session-stats.json
│                          ← own per-dir state and caches (NOT shared)
├── projects/              ← own session history (NOT shared by default)
├── jobs/                  ← own background sessions (follows projects/)
├── teams/                 ← own team records (follows projects/)
├── mcp-servers/  →  ~/.claude/mcp-servers    (symlink to primary)
├── plugins/      →  ~/.claude/plugins        (symlink to primary)
├── settings.json →  ~/.claude/settings.json  (symlink to primary)
└── ...
```

**Codex profile** (`clausona add codex:work`):

```
~/.codex-work/             (new codex profile)
├── auth.json              ← own credentials (NOT shared)
├── sessions/              ← own conversation history (NOT shared)
├── history.jsonl          ← own input history (NOT shared)
├── state_*.sqlite         ← own state DB (NOT shared)
├── config.toml  →  ~/.codex/config.toml      (symlink to primary)
├── skills/      →  ~/.codex/skills           (symlink to primary)
├── plugins/cache/ → ~/.codex/plugins/cache   (symlink to primary)
└── ...
```

The private set is larger for codex (state DB, input history, logs) but the principle is the same: credentials and session data stay profile-specific; everything else is shared.

On Windows, shared directories use junctions. Shared files use symbolic links when Windows Developer Mode is enabled and
otherwise fall back to same-volume hard links. If a profile is imported from another drive, enable Developer Mode so
clausona can create file symbolic links across volumes.

**Session separation** is the default: each profile keeps its own session directory, so `/resume` (Claude) and `codex resume` (Codex) only show that profile's conversations. To share session history across claude profiles, pass `--merge-sessions` when adding or initializing.

For claude profiles this covers background sessions and team records too. A background
session is stored as a record in `jobs/` keyed by the same session id as its transcript
under `projects/`, so the two are shared or separated together — sharing one without the
other would leave a record whose transcript cannot be resumed. `clausona repair` folds a
profile's own records into the primary before re-linking, so nothing is lost when a
profile switches to shared sessions or has its links rebuilt.

**Credentials are never shared.** On macOS Claude Code keeps its OAuth tokens in the
Keychain under a service name derived from the config directory, so each profile is
isolated by the tool itself, and puts them in a plain `.credentials.json` next to the
config only when the Keychain refuses its write. Everywhere else that file is the only
store. clausona keeps the file profile-local on every platform.
Profiles created by clausona 0.2.2-beta or earlier on Linux and Windows may hold a link
to the primary's credential; `clausona doctor` reports it as `stale_symlink` and
`clausona repair <profile>` removes it, after which that profile signs in on its own.

`clausona doctor` checks whichever store the platform uses. On macOS that is the Keychain
item plus the `.credentials.json` Claude Code falls back to, and it reports
`missing_keychain` only when neither holds a credential; everywhere else it is the
credential file (`missing_oauth`). A profile that has just had a stale credential link
removed reports `missing_oauth` until it signs in, so doctor points those findings at
`clausona login <profile>` rather than at `clausona repair`, which rebuilds shared links
and cannot produce a credential.

`.last-update-result.json`, `gh-pr-status-cache.json` and `.session-stats.json` hold
state or a cache for one config dir, and whatever writes them replaces a shared link with
a regular file, so they stay profile-local. A profile that still links one of them to the
primary from clausona 0.2.5-beta or earlier is reported as `stale_symlink`; `clausona repair
<profile>` removes the link.

`settings.json` is shared, though, and an `apiKeyHelper` in it runs for every profile that
links to it — including API profiles, whose endpoint the key it prints would then reach. See
[What an API profile clears from your environment](api-profiles.md#what-an-api-profile-clears-from-your-environment).

A marketplace registered from a path of your own — rather than installed under
`plugins/marketplaces/` — is left alone. clausona neither reports it as drift nor
rewrites its location, so `clausona repair` keeps the registration intact.

Shared links are created from the primary's contents at the time a profile is set up, so
a directory the tool introduces in a later version does not reach profiles that already
exist — the tool creates it locally instead, and the accounts silently stop sharing that
state. `clausona doctor` reports these as `missing_shared_link`; `clausona repair
<profile>` links them.

A `~/.clausona/profiles.json` that is there but is not valid JSON, or not a JSON object, is
the first thing `clausona doctor` checks. It says so in one line on stderr, in either output
form, and exits 1 without checking anything else. The line names the file and what is wrong
with it, never its contents. Fix the file by hand, or move it aside and run `clausona init`
to set clausona up again. `~/.clausona/backups` holds no copy of it to restore. A command
that would otherwise stop with "clausona is not initialized" prints the same line instead,
`clausona init` refuses to replace the file while it is there, and the dashboard shows the
line instead of opening init.

## Data Storage

All data stays local on your machine. clausona has no telemetry and no server of its
own, and nothing is sent to a third party.

The one thing that leaves your machine is the plan-quota lookup: each profile's own
credential is sent to that profile's own provider endpoint (`api.anthropic.com` for
Claude, `chatgpt.com` for Codex) to read its limits, and to renew a lapsed token.
Nothing else is transmitted, and `clausona list --no-quota` skips it entirely. An API
profile is not part of this: clausona makes no request on its behalf, but it does hand
that profile's key to Claude Code, which then talks to the endpoint you configured.

```
~/.clausona/
├── profiles.json    # registered profiles and active selection (including each API
│                    #   profile's endpoint and key *source*, never the key)
├── secrets.json     # API profile keys on Linux and Windows (macOS keeps them in the
│                    #   Keychain)
├── usage.json       # per-profile usage history
├── quota.json       # cached plan-quota readings (5-minute freshness)
├── locks/           # short-lived per-profile credential renewal locks
└── backups/
    ├── claude/      # backups of imported claude profile directories
    └── codex/       # backups of imported codex profile directories

~/.claude-<name>/        # claude profile config directories (created by `clausona add`)
~/.codex-<name>/         # codex profile config directories (created by `clausona add codex:<name>`)
```

`profiles.json` and `secrets.json` are written owner-only (mode 0600) on macOS and Linux. On
Windows a file mode means nothing: they are private because they sit inside your user profile,
which Windows opens only to you, SYSTEM and administrators.

## Migration from 0.0.x

clausona 0.1.0-beta introduces multi-tool support. On first launch, the registry at `~/.clausona/profiles.json` is automatically migrated to v2 format:

- Profile names are prefixed with their tool: `work` → `claude:work`
- Per-tool active profiles, per-tool primary sources
- Backup files saved with `.v1.bak` suffix

To roll back: restore the `.v1.bak` files and install the previous clausona version.
