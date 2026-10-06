# How It Works

[← Back to the README](../README.md)

## Profile Switching

Shell wrappers for `claude` and `codex` are registered via `eval "$(clausona shell-init)"` on zsh/bash or
`Invoke-Expression (& clausona shell-init | Out-String)` on PowerShell:

1. **Before** each invocation — applies the active profile's launch script: the config directory
   (`CLAUDE_CONFIG_DIR` for claude, `CODEX_HOME` for codex) and, for an API-backed profile, its
   endpoint and credential, plus a check on the plugin files for claude. The script comes from
   clausona's launch cache when it can, so no clausona process runs before the tool (see
   [The launch cache](#the-launch-cache) below), and from `clausona _launch` otherwise
2. **During** the invocation — those variables exist only for that one run. On zsh/bash the tool
   runs in a subshell, on PowerShell each variable is restored afterwards, so your interactive
   shell is left exactly as it was. On PowerShell the environment arrives as ASCII-only JSON,
   so a config directory under a non-ASCII user folder reaches the tool intact whatever the
   console's code page
3. **After** each `claude` invocation — detects usage changes via fingerprint comparison and
   records cost/token usage per profile. This runs in the background, so your prompt comes back
   as soon as the tool exits: zsh and bash print no job notices for it, and PowerShell starts it
   in a hidden window. Two sessions that end at the same moment are both recorded, because each
   takes a lock on `usage.json` before writing to it

```
clausona use work
↓
claude             ← wrapper applies the work profile's env, then runs claude
↓
_track-usage       ← on exit, records any new cost/token usage in the background

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
profile is fixed; it is not a one-off notice.

### The launch cache

Starting clausona costs a Node process, a tenth of a second or more, before the tool even
starts. So when `clausona _launch` works out a profile's launch script, it also saves a copy
in `~/.clausona/cache/`, and the next launch reads that file in the shell itself.

- **What is cached** — only a script that holds nothing to be worked out afresh at each launch.
  An API profile is never cached, because its key is read from the Keychain, `secrets.json`, an
  environment variable or a command each time, and must not be copied anywhere else. Neither is
  a profile whose environment produced a warning, which has to print on every launch, one whose
  env map holds something that looks like a secret, nor one whose config directory - or
  `~/.claude` or `~/.codex` - is missing or reached through a symlink, which can be created or
  repointed without `profiles.json` changing. Those profiles launch through `clausona _launch`
  every time, as they always did. So does a run under another `HOME` than the shell hook was
  set up with.
- **When it is used** — only while `profiles.json` is still the very file the script was
  rendered from and has not changed since: on zsh/bash the script keeps a hard link to that
  file and must be newer than it, on PowerShell it records the file's exact write time and
  size. Every change clausona makes to `profiles.json` (`clausona use`, `config`, `add`,
  `remove`) deletes the cache as it saves, so the very next launch after `clausona use work`
  starts as `work`. An editor saving the file, or a backup moved back over it, also sends the
  next launch to clausona. On zsh/bash, copying another file over it in place with its old time
  kept (`cp -p`) does not, until the next change clausona makes; PowerShell's exact time check
  catches that too. A cache written while another command was changing `profiles.json` is not
  saved at all.
- **Per version** — the file name carries clausona's version, and a shell hook only reads the
  cache of the version that rendered it, so a shell opened before `clausona update` never reads
  a script the new version wrote, or the reverse.

For claude, the launch script also decides whether the plugin files need syncing, without
starting clausona. Each sync that works leaves a stamp, `plugins/.clausona-synced`, in the
profile's config directory, and the script runs `clausona _sync-plugins` only when that stamp is
missing or something the sync reads is at least as new as it: the profile's
`known_marketplaces.json` or `installed_plugins.json`, or the primary's marketplaces,
`installed_plugins.json`, plugin cache, or the cache's marketplace and plugin directories. When
any of those changes, the sync runs on the next launch.

## Shared Environment

When you register a new profile, clausona symlinks shared resources from your primary config directory into the new profile's config directory.

**Claude profile** (`clausona add claude:work`):

```
~/.claude-work/            (new claude profile)
├── .claude.json           ← own account metadata and `claude mcp add` servers (NOT shared)
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
├── app-server-control/, app-server-daemon/
│                          ← own app-server daemon (NOT shared)
├── memories/, memories_1.sqlite
│                          ← own memories (NOT shared)
├── *.sqlite               ← own databases: state, threads, goals, queues, logs (NOT shared)
├── sessions/, history.jsonl, ...
│                          ← own conversation history (NOT shared by default)
├── packages/              ← own app-server daemon install (NOT shared)
├── config.toml  →  ~/.codex/config.toml      (symlink to primary)
├── hooks.json   →  ~/.codex/hooks.json       (symlink to primary)
├── skills/      →  ~/.codex/skills           (symlink to primary)
├── plugins/     →  ~/.codex/plugins          (symlink to primary)
└── ...                    ← anything else Codex keeps here (NOT shared)
```

For claude the principle is that credentials and session data stay profile-specific and
everything else is shared. Codex is the other way round, because each Codex release adds state
that belongs to one account to its home. See [What a Codex profile shares](#what-a-codex-profile-shares) below.

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
<profile>` links them. For codex that is only ever a directory on the list below.

`clausona doctor` only reads. A shared link whose target is gone is reported as
`broken_symlink` and left where it is. `clausona repair` never deletes what it replaces: each
file, directory or stray link that stands where a shared link goes is moved into
`~/.clausona/backups/<tool>/<profile>/<name>.<timestamp>`, a new backup every time, so a
second repair keeps what the first one set aside. Removing the profile puts the newest backup
of each entry back where the profile has none of that entry; an entry it has again is newer
than any backup, so it stays as it is, and its backups stay too. A SQLite database's `-wal`,
`-shm` or `-journal` comes back only with the copy of the database it was set aside with.
`clausona uninstall` keeps `~/.clausona/backups` whenever something is left in it, and says so.

A shared link to a primary entry that is itself a broken link is reported as
`primary_broken_link`, with the primary's path. That break is the primary's to fix:
`clausona repair` changes nothing in the primary, and leaves the profile's link as it is.

A profile registered on its tool's primary directory itself (a non-primary entry whose
config directory is `~/.claude` or `~/.codex`) has nothing to share, so clausona never links
or repairs it. `clausona doctor` reports it as `primary_config_dir`, with the registry change
that settles it: mark the entry `"isPrimary": true`, or remove it when another entry is
already the primary. `clausona remove` of such an entry drops only the entry.

A `~/.clausona/profiles.json` that is there but is not valid JSON, or not a JSON object, is
the first thing `clausona doctor` checks. It says so in one line on stderr, in either output
form, and exits 1 without checking anything else. The line names the file and what is wrong
with it, never its contents. Fix the file by hand, or move it aside and run `clausona init`
to set clausona up again. `~/.clausona/backups` holds no copy of it to restore. A command
that would otherwise stop with "clausona is not initialized" prints the same line instead,
`clausona init` refuses to replace the file while it is there, and the dashboard shows the
line instead of opening init.

### What a Codex profile shares

A codex profile links only these entries of the primary's `~/.codex`:

- `config.toml` and every `*.config.toml`, `hooks.json`, `AGENTS.md` and every `AGENTS*.md`,
  `rules/`, `.sandbox_migration`, `skills/`, `plugins/`, `agents/`, `prompts/`,
  `vendor_imports/`, `pets/` and `.personality_migration`.
- With merged sessions, its conversation history as well: `sessions/`, `archived_sessions/`,
  `session_index.jsonl`, `history.jsonl`, `attachments/`, `visualizations/` and
  `thread-writer-locks/`.

Everything else stays in the profile. That includes every SQLite database and its `-wal`, `-shm`
and `-journal` files, whatever the database is called. Codex 0.148 to 0.159 added about ten new
entries of one account's to its home, and with a list of what not to share, each of them was
linked into every profile until someone noticed. With a list of what to share, a new Codex config
file is not shared until clausona adds it, and nothing of one account's is shared by mistake. Two
of those entries show what goes wrong:

- **The app-server daemon.** Codex starts a background daemon by default (`daemon_auto_start`)
  and finds its control socket through `$CODEX_HOME/app-server-control/`. The socket's path is a
  hash of that directory's real path. So a profile that linked the primary's
  `app-server-control/` talked to the primary's daemon, which serves the primary's `auth.json`
  and quota, and its Codex ran on the wrong account. `app-server-daemon/` holds the daemon's pid
  files and lock. While it was shared, `codex app-server daemon stop` in one profile stopped the
  other's daemon.
- **Memories.** `memories_1.sqlite` and the `memories` directories hold summaries of past
  conversations that Codex adds to future prompts. While they were shared, one account's
  conversations reached the other account's prompts.

`packages/` is not shared either. It holds the app-server daemon's install, about 317 MB in each
Codex home. Sharing it would save that space, but the profiles would then share one updater,
which replaces the daemon every one of them runs.

Profiles set up by clausona 0.5.0-beta or earlier link some entries that are not on the list to
the primary's. `clausona doctor` reports each such link: `wrong_account_link` for the daemon's directories and
the credential stores, `shared_account_state` for the rest. `clausona repair <profile>` and the
session-mode toggle unlink it. If clausona set aside the profile's own copy when it made the
link, repair moves the newest one back from `~/.clausona/backups/codex/<profile>/`. A database
comes back with the `-wal`, `-shm` and `-journal` files set aside with it, never with ones written
beside another copy of it. If there is no backup, the entry stays absent and Codex starts a fresh
one. The primary is never changed. SQLite through a link was never a corruption risk, because the
write-ahead log goes next to the file the link leads to. The problem was isolation only.

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
├── cache/           # launch scripts the shell hook reads (owner-only; never an API
│                    #   profile's, so never a key)
├── locks/           # short-lived locks: registry and usage.json writes, per-profile
│                    #   credential renewal
└── backups/
    ├── claude/      # what clausona set aside from claude profile directories,
    │                #   <profile>/<name>.<timestamp>
    └── codex/       # the same for codex profile directories

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
