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
`known_marketplaces.json` or `installed_plugins.json`, the primary's marketplaces,
`installed_plugins.json`, plugin cache, or the cache's marketplace and plugin directories, or
any other Claude profile's `installed_plugins.json`. When any of those changes, the sync runs on
the next launch, so a plugin installed under one profile reaches another the next time that one
starts ([Plugin installs](#plugin-installs)).

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
├── policy-limits.json, remote-settings.json, state/, daemon/, ...
│                          ← own account and org state (NOT shared, see the list below)
├── projects/              ← own session history (NOT shared by default)
├── jobs/                  ← own background sessions (follows projects/)
├── teams/                 ← own team records (follows projects/)
├── mcp-servers/  →  ~/.claude/mcp-servers    (symlink to primary)
├── plugins/               ← own directory: each entry links to ~/.claude/plugins/, except
│                            known_marketplaces.json and installed_plugins.json, kept as
│                            per-profile copies with their paths rewritten; a plugin
│                            installed or updated in one profile reaches the others' copies
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
├── *.sqlite               ← own databases: queues, logs and the rest (NOT shared); the thread
│                            store - state, goals, history - follows merged sessions
├── sessions/, history.jsonl, ...
│                          ← own conversation history (NOT shared by default)
├── packages/              ← own app-server daemon install (NOT shared)
├── .env                   ← own (NOT shared)
├── config.toml  →  ~/.codex/config.toml      (symlink to primary)
├── hooks.json   →  ~/.codex/hooks.json       (symlink to primary)
├── skills/      →  ~/.codex/skills           (symlink to primary)
├── plugins/     →  ~/.codex/plugins          (symlink to primary)
└── ...                    ← anything else Codex keeps here (NOT shared)
```

For claude the principle is that credentials, session data and what Claude Code keeps for one
account stay profile-specific and everything else is shared. See [What a Claude profile
shares](#what-a-claude-profile-shares) below. Codex is the other way round, because each Codex
release adds state that belongs to one account to its home. See [What a Codex profile
shares](#what-a-codex-profile-shares) below.

On Windows, shared directories use junctions. Shared files use symbolic links when Windows Developer Mode is enabled.
Without it, a file the tool saves whole - Claude Code's `settings.json`, `CLAUDE.md` and `keybindings.json`, Codex's
`config.toml`, `*.config.toml` and `hooks.json` - stays a copy in each profile, because a save would break a hard link,
and `clausona doctor` reports it. Other files fall back to same-volume hard links. If a profile is imported from another
drive, enable Developer Mode so clausona can create file symbolic links across volumes.

**Session separation** is the default: each profile keeps its own session directory, so `/resume` (Claude) and `codex resume` (Codex) only show that profile's conversations. To share session history, pass `--merge-sessions` when adding or initializing, or turn it on later with `clausona config <profile> --merge-sessions`.

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

### Plugin installs

Claude Code lists the plugins it has installed in `plugins/installed_plugins.json`, with the
absolute path of each one's cached version, so every Claude profile keeps a copy of its own with
the paths under its own config directory. The cache itself is shared. `claude plugin install`,
`update` and `uninstall`, and `/plugin` inside a session, rewrite only the copy of the profile
they run in. The plugin sync that runs before each launch carries the change to the others, and
the primary's copy is the one every other is kept in step with.

Each sync reads every profile's copy and compares it with what clausona last wrote there or read
from it, which it keeps beside the copy in `plugins/.clausona-installed-plugins.json`. A plugin a
copy has gained or changed since was installed or updated in that profile, and one it has lost
was uninstalled there. Those changes go into the shared list, which the primary's record keeps,
and the shared list is then written to the primary's copy and to the profile that is starting.
Every other profile gets it when it starts next. A copy that still lists a plugin because its
profile has not started since the plugin was uninstalled elsewhere is not an install, and does
not bring the plugin back. An install for one project, at project or local scope, is carried
with that project's path and apart from an install for the user.

When two profiles changed the same plugin, the later change wins, as near as clausona can tell.
An install or update is timed by the `lastUpdated` Claude Code gives it, but an uninstall only by
when that profile's copy was last written. A profile that uninstalled one plugin and then
installed another before its changes were synced has its uninstall timed by the install, and
that uninstall can lose to an update made earlier in another profile.

A plugin whose cached version is not on disk, because that folder was removed, is left out of
every copy, since Claude Code cannot load it. It stays in the shared list, though, and is back in
every copy once its folder is.

The first sync after upgrading from a version that kept the copies apart has nothing to compare
with yet. It takes every plugin any profile lists, and of a plugin listed with different versions
the record updated most recently, by its `lastUpdated`, which is not always the highest version.
A plugin you had uninstalled in one profile but not the others comes back that once; uninstall it
again and it stays uninstalled. A profile that joins later with no record of its own, one just
added or one whose cache has just been linked, counts only what it changed after the last sync
as its own; the rest of its copy is taken to be an old copy of the shared list, so it brings back
nothing uninstalled meanwhile.

A profile whose `plugins/cache` is a directory of its own rather than a link to the primary's,
which happens when the primary had no plugin cache yet when the profile was set up, caches
versions the others cannot reach. Its copy is left to itself, as all copies were before.
`clausona repair <profile>` links its cache to the primary's and sets its own aside in the
profile's backup; a plugin only that cache held has to be installed again.

The sync takes a lock in `~/.clausona/locks` for the few milliseconds it reads and writes, so two
profiles started at once do not each fold in half of what changed. A launch waits for it a second
and a half at most. A sync that cannot finish, because of the lock, a copy or record it cannot
read, or a copy in a form this version does not read, writes nothing and leaves no stamp, so the
next launch tries again. Claude Code can still read a copy just before clausona writes it and
write its own after. clausona reads each copy again right before it writes, and gives up if it
changed, which narrows that window to the moment between the two but cannot close it.

`clausona doctor` says nothing about a copy that is only behind, which the profile's next launch
brings in step: after every `claude plugin update` that is every profile but one. It warns only
about what a launch will not put right. `plugins_cache_not_shared` is a profile whose cache is
not linked to the primary's; `clausona repair <profile>` links it. `plugin_sync_blocked` names a
copy or record the sync cannot read, which only fixing that file settles. `installed_plugins_differ`
is a copy that still differs from the primary's after the profile's sync has run since either
changed. It names each plugin with its version or state on each side, such as `p@m 1.1.0 here,
1.0.0 in the primary` or `p@m only here`, and `clausona repair <profile>` runs the sync again.

### What a Claude profile shares

A claude profile links every entry of the primary's `~/.claude` except the ones below. Claude
Code 2.1.299 keeps its own list of the entries in its config directory that are state rather
than configuration, and clausona went through it one entry at a time.

| Entry | In a profile | Why |
|---|---|---|
| `.claude.json`, `.claude-*-oauth.json`, `.config.json`, their backups, and `backups/` | own | The signed-in account and its MCP servers. `.config.json` is the legacy name, which Claude Code reads in place of `.claude.json` when it is there. `backups/` holds copies of `.claude.json`, and Claude Code offers the newest one to restore a lost file. |
| `.credentials.json` | own | OAuth tokens outside macOS, and on macOS when the Keychain refuses them. |
| `policy-limits.json`, `remote-settings.json`, their `.signature.json`, `.signature-iat.json`, `.stamp.json` and `.synced-at`, `remote-settings-consent.json`, `remote-settings-helper-consent` | own | The org's policy limits and remote managed settings, stamped with the identity they were fetched for, and what this account agreed to apply. |
| `mcp-needs-auth-cache.json` | own | The MCP servers and claude.ai connectors that need this account's sign-in. |
| `state/` | own | Per-account records, such as MCP discovery verdicts. It also holds the one-time consents Claude Code asks for on this device (device hooks, device MCP servers, cloud plugins), so each profile asks for those once more. |
| `chrome/` | own | The Claude in Chrome host that Claude Code writes for its config directory. |
| `daemon/` and every other name starting with `daemon`: `daemon.json`, `daemon.lock`, `daemon.status.json`, `daemon.scheduled.status.json`, `daemon.log`, `daemon-auth-status.json`, `daemon-auth-cooldown` | own | The background daemon: its control key, the roster of the sessions it runs, its lock and status, the workers it runs, its log and its sign-in state. `daemon.json` holds the scheduled tasks and the Remote Control folders, which the daemon runs on its own account: shared, every account's daemon would run them again. On Windows a profile linking the primary's `daemon/` reaches the primary's daemon, which runs on the primary's account. |
| `telemetry/` | own | Events that failed to send, stamped with the account and org. A later run of the same session sends them again, on whichever account resumed it. |
| `.session_ingress_token`, `hfi-auth.json` | own | Tokens of hosted sessions. |
| `cache/`, `mcp-discovery-cache/`, `stats-cache.json`, `feedback/`, `active-time.json` | own | Caches and ledgers of the account Claude Code runs as: the models it was refused or served, MCP discovery, the `/stats` numbers, feedback drafts waiting to be sent, active time. Shared, two profiles overwrite each other's numbers, and a draft could go out on another account. |
| `statsig/`, `image-cache/`, `.last-update-result.json`, `gh-pr-status-cache.json`, `.session-stats.json` | own | State and caches for one config directory. |
| `plugins/` | own directory | Each entry links to the primary's, except the two JSON files that hold paths. The list of installed plugins is kept in step across profiles ([Plugin installs](#plugin-installs)). |
| `projects/`, `jobs/`, `teams/` | shared with merged sessions | One session's transcript and records, kept together. |
| `sessions/`, `todos/`, `shell-snapshots/`, `file-history/`, `history.jsonl`, `tasks/`, `session-env/`, `plans/`, `paste-cache/`, `uploads/` | shared | So a session carries across accounts. |
| A temp file a save left behind, `<file>.tmp.<suffix>` | never linked | It holds nothing a profile reads, and a link to one would stay for good. |
| Everything else: `settings.json`, `CLAUDE.md`, `skills/`, `agents/`, `commands/`, ... | shared | Your configuration. |

Some entries on Claude Code's list stay shared, because you write them or sessions refer to them,
or because nothing showed that sharing them does harm: `usage-data/`, `debug/`, `loop.md` and the
like. `ide/` is shared too: Claude Code finds a running IDE through it, and reads `~/.claude/ide`
from every profile in any case.

Scheduled tasks and Remote Control set up on the primary stay with the primary, in its
`daemon.json`. A profile sets its own, with `claude daemon scheduled add` or `claude daemon
remote-control add` run in that profile.

A scheduled task or Remote Control folder that a profile added while clausona 0.8.0-beta or earlier
linked its `daemon.json` was saved in the primary's, and stays there. After repair it runs only on
the primary's account, and the profile runs nothing of it, with nothing said. To move one:

1. On the primary, list them with `claude daemon scheduled list` and `claude daemon remote-control
   list`.
2. In the profile, add the profile's own again with `claude daemon scheduled add` or `claude daemon
   remote-control add`.
3. On the primary, remove them with `claude daemon scheduled remove <task-id>` or `claude daemon
   remote-control remove <name-or-dir>`.

Profiles set up by clausona 0.8.0-beta or earlier link the account entries above to the primary's.
`clausona doctor` reports each such link with what the profile reads of the primary account's
through it: `wrong_account_link` for the account files, the daemon's directory and lock, and the
session tokens, and `shared_account_state` for the rest. `clausona repair <profile>` takes it out.
A copy that Claude Code has already saved in the profile is the profile's own: doctor no longer
reports it, and repair keeps it. If an earlier repair set the profile's own copy aside to put the
link back, repair and the session-mode toggle, either way, bring the newest one back from
`~/.clausona/backups/claude/<profile>/`.

Repair, the session-mode toggle and `clausona init` refuse to take out a profile's `daemon/` link
while the profile's background daemon runs. The daemon keeps its control key and roster in the
directory the link leads to, and its clients could not reach it without them. clausona finds it by
its control socket, `/tmp/cc-daemon-<uid>/<hash>/control.sock`, where the hash is of the profile's
config directory, as Claude Code derives it. Stop the daemon with
`CLAUDE_CONFIG_DIR=~/.claude-<profile> claude daemon stop` and run the command again, or pass
`--force`. The next daemon starts with the profile's own `daemon/`.

clausona never looks through the link itself: what it reaches is the primary's daemon, which keeps
its own `~/.claude/daemon/` and goes on running whatever happens to the profile's link. On Windows
the daemon's pipe is named by `daemon/pipe.key`, which through the link is the primary's file, so
the pipe can't say whose daemon answers it. There clausona reads the profile's own `daemon.lock`
instead: a file of the profile's own, not a link, naming a running process. Windows soon gives a
dead daemon's pid to another program, so that process counts only if its command line is Claude
Code's daemon (`claude ... daemon run`), which PowerShell reads. When PowerShell can't say, it still
counts, and `--force` goes ahead. The stop command is then given for PowerShell:
`$env:CLAUDE_CONFIG_DIR='<profile dir>'; claude daemon stop; Remove-Item Env:CLAUDE_CONFIG_DIR`.
It clears the variable after: left set, every later `claude` in that window would run as that
profile.

While a profile linked the primary's `backups/`, Claude Code saved that profile's copies of
`.claude.json` there, as `.claude.json.backup.<ms>`. When the primary's `.claude.json` is lost,
Claude Code suggests restoring the newest copy in that folder, which could be another account's.
`clausona doctor` notes such copies on the primary as `foreign_account_backup`, a warning. It names
the profile whose account each copy is, or says another account's, and gives the command that
deletes them. clausona never deletes them itself. Claude Code keeps only the five newest copies, so
they also go once the primary has saved five of its own.

### What a Codex profile shares

A codex profile links only these entries of the primary's `~/.codex`:

- `config.toml` and every `*.config.toml`, `hooks.json`, `AGENTS.md` and every `AGENTS*.md`,
  `rules/`, `.sandbox_migration`, `skills/`, `plugins/`, `agents/`, `prompts/`,
  `vendor_imports/`, `pets/` and `.personality_migration`.
- With merged sessions, its conversation history as well: `sessions/`, `archived_sessions/`,
  `session_index.jsonl`, `history.jsonl`, `attachments/`, `visualizations/`,
  `thread-writer-locks/` and `rollout-migrations/`.
- With merged sessions on macOS and Linux, Codex's thread store too: `state_5.sqlite`,
  `goals_1.sqlite` and `thread_history_1.sqlite`.

Everything else stays in the profile. That includes every other SQLite database, and every
database's `-wal`, `-shm` and `-journal`, whatever it is called. Codex 0.148 to 0.159 added about
ten new entries of one account's to its home. With a list of what not to share, each of them was
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
  conversations reached the other account's prompts. They stay per profile with merged sessions
  too.

**The thread store, with merged sessions.** A goal (`/goal`) lives in `goals_1.sqlite`, keyed by
the thread, and Codex re-arms it when the thread is resumed. `codex resume --last` and the resume
picker find threads in `state_5.sqlite`. `thread_history_1.sqlite` indexes positions in the
shared rollout files. Kept per profile while the sessions themselves are merged, a thread resumed
in another account would come back without its goal, and `--last` and the picker would miss it.
So the three are shared as one unit with the session history, and only then:

- Only the database is linked, never its `-wal`, `-shm` or `-journal`. Through a symbolic link,
  SQLite keeps those beside the file the link leads to.
- The profile's own copies, with their companions, go into a backup when sessions are merged.
  Separating sessions again puts them back. Rows are never merged between two copies.
- A thread that is missing from the primary's `state_5.sqlite` shows in the picker after it has
  been resumed once by id, because Codex adds it then.
- On Windows the thread store stays in each profile. Windows' SQLite names a database's `-wal`
  after the path it was opened by, so two profiles would keep two logs for one database.
- `queue_1.sqlite` stays per profile. Each Codex process takes items off it under a lock of its
  own, so two homes could take the same item.

`packages/` is not shared either. It holds the app-server daemon's install, about 317 MB in each
Codex home. Sharing it would save that space, but the profiles would then share one updater,
which replaces the daemon every one of them runs.

`.env` is not shared. Codex loads `$CODEX_HOME/.env` into its environment at start, so it can hold
one account's own API keys. A profile that linked the primary's `.env` keeps a copy of it when the
link comes out, so nothing it loaded goes missing. A new or imported profile gets no copy: clausona
says the primary has one, and you copy it in if that account needs it.

While a profile shares sessions, what Codex writes to `archived_sessions/` and `attachments/` lands
in the primary's directories. Separating sessions again unlinks them, and that work stays in the
primary's. clausona doesn't split it back out.

Profiles set up by clausona 0.5.0-beta or earlier link some entries that are not on the list to
the primary's. `clausona doctor` reports each such link: `wrong_account_link` for the daemon's
directories, `.env` and the credential stores, and `shared_account_state` for the rest.
`clausona repair <profile>`, the session-mode toggle and `clausona init` unlink them:

- If clausona set aside the profile's own copy when it made the link, the newest one is moved
  back from `~/.clausona/backups/codex/<profile>/`. Repair and the toggle look at every backup of
  an entry the profile keeps for itself. `init` and `add` put back only what they have just
  unlinked.
- A database comes back together with the `-wal`, `-shm` and `-journal` set aside in the same
  pass, never with ones written beside another copy. A backup made before backups were
  timestamped pairs only with another such backup. Timestamped ones pair only when they were set
  aside within seconds of each other.
- If a companion was set aside on its own, so that it could belong to the database or not, the
  database and its companions all stay in the backups, and repair says so.
- A `-wal` or `-journal` already in the profile that was written after the database was set aside
  belongs to another copy, such as the primary's reached through an old hard link. It is moved
  into a backup before the database comes back. One left untouched since then is kept, and repair
  says so.
- If any move fails part way, everything moved goes back where it was, so the next repair finds
  what this one found.
- If there is no backup, the entry stays absent, Codex starts a fresh one, and repair names each
  link it removed that way.

The primary is never changed. SQLite through a link was never a corruption risk, because the
write-ahead log goes next to the file the link leads to. The problem was isolation only.

Quit Codex in a profile, and stop its daemon with `CODEX_HOME=<profile dir> codex app-server
daemon stop`, before you repair it, change its session mode or run `clausona init` over it.
These move files a running Codex holds open, such as its databases and the daemon's directories.
On macOS and Linux, each of them looks for a `codex` process running with the profile's
`CODEX_HOME` when it has something like that to move. If it finds one, it refuses and changes
nothing. On macOS, where that look asks `pgrep` and `ps`, a look they don't answer within 10
seconds refuses the same way and says the check timed out, since Codex may be running. Run it
again. `--force` goes ahead anyway: `clausona repair <profile> --force`,
`clausona config <profile> --merge-sessions --force`, `clausona init --auto --force`.

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
├── notices.json     # the day the dashboard first opened, and whether it has asked
│                    #   for a GitHub star (it asks once)
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
