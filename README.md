# clausona

**Switch between multiple Claude Code and OpenAI Codex CLI accounts on one machine — plugins, MCP servers, and settings stay shared.**

<p align="center">
  <a href="https://github.com/larcane97/clausona/releases/latest"><img src="https://img.shields.io/github/v/release/larcane97/clausona?include_prereleases&label=release" alt="Latest release" /></a>
  <a href="https://github.com/larcane97/clausona/actions/workflows/ci.yml"><img src="https://github.com/larcane97/clausona/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="Platforms: macOS, Linux, Windows" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/larcane97/clausona" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="assets/demo.gif" alt="clausona listing Claude Code and Codex accounts with their plan quota, switching to the work account so that plain claude starts signed in as it, switching back, and opening the dashboard" width="800" />
</p>

clausona is a profile manager for the Claude Code and OpenAI Codex CLIs. Each account gets its
own config directory — its own sign-in and session history — while plugins and settings are
shared across them, so `csn use work` is all it takes to move to another account. It also
shows how much of every account's 5-hour and weekly plan limits is left, side by side.

## Why

You have multiple Claude Code or OpenAI Codex CLI accounts (personal, work, different orgs), but switching between them on a single machine is tedious:

- **Switching is manual.** You need to log out, log back in, or juggle `CLAUDE_CONFIG_DIR` (Claude) or `CODEX_HOME` (Codex) yourself.
- **Settings don't carry over.** Each account gets its own config directory, so your MCP servers, plugins, permissions, and settings have to be set up from scratch — every time.

clausona fixes both. Switch profiles with one command — your entire environment carries over.

```bash
csn use work             # switch to work account — done
csn use codex:personal   # switch to your personal codex account too
```

No re-login. No reinstalling plugins. Just switch and go.

> `csn` is a shorthand alias for `clausona`, registered automatically on install.

## Features

- **One-command switching** — `clausona use <name>` and you're on a different account
- **Shared environment** — MCP servers, plugins, permissions, settings (Claude) and config.toml, skills, hooks (Codex) are symlinked across profiles within each tool. Set up once, use everywhere.
- **Plan quota at a glance** — session and weekly limit usage for every account, read live from each tool's own usage endpoint (Claude and Codex)
- **Two accounts at once** — `clausona run claude:personal` starts one session under another profile without switching, so two terminals can run two accounts side by side
- **API profiles** — a profile can point at an API endpoint instead of a subscription login: the Anthropic API, a gateway, or a model you serve yourself
- **Pure CLI passthrough** — no wrapping, no proxying, no background process. `claude` and `codex` run directly and unmodified. Compatible with oh-my-claudecode, Cline, codex plugins, and any other tool in your stack.
- **Lightweight** — a single shell hook and a few symlinks. No daemon, no server, no runtime overhead.
- **Usage tracking** — per-profile cost and token usage, tracked locally (Claude Code only for now)
- **Interactive dashboard** — TUI for managing profiles, viewing usage, and running health checks

## How clausona compares

|  | clausona | [claude-swap](https://github.com/realiti4/claude-swap) | [codex-auth](https://github.com/Loongphy/codex-auth) | [aisw](https://github.com/burakdede/aisw) | [claude-code-profiles](https://github.com/quinnjr/claude-code-profiles) |
| --- | --- | --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | — | ✓ | ✓ |
| Codex CLI | ✓ | — | ✓ | ✓ | — |
| How it switches | a config directory per account | swaps the login inside one `~/.claude` | copies `auth.json` into `~/.codex` | writes each tool's own credential store, plus a config-dir shell hook | a config directory per profile, through a `claude()` wrapper |
| History kept per account, plugins and settings shared | ✓ | partly: `cswap run` sessions share settings and skills, not plugins | — (one `~/.codex` for all accounts) | — | skills only |
| Plan quota for every account | ✓ | ✓ | ✓ | — | — |
| Switches on its own when a limit runs out | — | ✓ `cswap auto` | ✓ `switch --live` | — | — |
| Two accounts at once | ✓ `clausona run` | ✓ `cswap run` | — | — | ✓ per shell |
| API-key profiles | ✓ Claude Code, any Anthropic-format endpoint | ✓ | ✓ | ✓ | — |
| Install | installer script | uv or pipx | npm | Homebrew, cargo or script | script |

Compared from each project's README and docs in September 2026; — means we found no mention of
it. Corrections are welcome.

clausona is built around one idea: keep accounts apart where they have to be — sign-in and
history — and shared everywhere else, for Claude Code and Codex alike. If you want the CLI to
move to another account on its own when a limit runs out, claude-swap (Claude Code) and
codex-auth (Codex) do that today; clausona does not.

## Install

**Requirements:** Node.js >= 20, and at least one of:

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [OpenAI Codex CLI](https://github.com/openai/codex)

**Platforms:** macOS/Linux (zsh or bash) and Windows (PowerShell 5.1+)

macOS/Linux:

```bash
curl -fsSL https://github.com/larcane97/clausona/releases/latest/download/install.sh | bash
```

Piping to `bash` does not read your shell profile, so if Node comes from a version
manager (nvm, fnm, asdf), activate it before running the command.

Windows PowerShell:

```powershell
irm https://github.com/larcane97/clausona/releases/latest/download/install.ps1 | iex
```

**Updating.** When a newer release is out, the dashboard (`csn`) says so in its header and lists
**Update** above Profiles; choose it and answer `Y`, and csn restarts on the new version. From a
script or another shell, `clausona update` does the same (`--yes` skips the question). Either way
the download is checked against the release's published SHA-256 before the installed copy is
replaced. Only a copy the installer put in place updates itself; any other is pointed at the
installer.

**After upgrading, open a new shell** — or re-run the hook in each shell that is already open:
`eval "$(clausona shell-init)"` on zsh/bash, `Invoke-Expression (& clausona shell-init | Out-String)`
on PowerShell. A shell keeps the hook it loaded when it started, and an older hook can apply less
than the version you just installed: one from before API profiles sets only the config directory,
with no endpoint and no key.

## Quick Start

```bash
clausona init             # discover existing Claude Code and Codex accounts
clausona use work         # switch to a profile (bare name if unique)
clausona use claude:work  # switch claude account (use prefix when both tools have "work")
clausona add codex:work   # add a codex profile
clausona use codex:personal  # switch codex account
clausona list             # see all profiles with plan quota and weekly usage
clausona                  # open the interactive dashboard

clausona add claude:gw --api --base-url https://openrouter.ai/api   # a profile backed by an API endpoint
```

clausona starts from a Claude Code account that is already signed in: `clausona init` registers
the accounts it finds and refuses when there are none, and until it has run the other commands say
"clausona is not initialized". On a machine where Claude Code has never been signed in, run
`claude login` once first — also when you mean to use only [API profiles](#api-profiles), which
are added next to that account.

## Plan quota

`clausona list` and the dashboard show how much of each account's plan limits are
already spent, so you can pick a profile that still has headroom.

```
PROFILE             ACCOUNT                      5H         7D
claude:work         you@example.com              6% 23m     46% 13h
claude:personal     you@personal.com             0%         100% 4d
codex:work          you@example.com              —          12% 5d
```

`5H` is the rolling session window, `7D` the weekly one, each followed by how long
until it resets. The dashboard shows the same reading with a gauge and the precise
reset time, plus the most-consumed per-model limit.

Readings come from each tool's own usage endpoint, authenticated with the credential that
tool already stored for that profile. For subscription profiles clausona holds no token of
its own. Results are cached for 5 minutes; `--refresh` forces a re-read and `--no-quota`
skips the network entirely.

How lapsed tokens are renewed, and what a dash in the table means:
**[docs/plan-quota.md](docs/plan-quota.md)**.

## API profiles

A profile can be backed by an API endpoint instead of a subscription login — the Anthropic
API, a gateway such as OpenRouter, or a model you serve yourself. It sits beside your
subscription profiles in `clausona list`, switches the same way, and shares the same
plugins, MCP servers, and settings. In this version API profiles are for Claude Code only.

```bash
# a hosted gateway
clausona add claude:gw --api \
  --base-url https://openrouter.ai/api \
  --model z-ai/glm-5.3

# a model you serve yourself
clausona add claude:local --api \
  --base-url http://localhost:8000 \
  --model glm-5.3 \
  --set CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144 \
  --set API_TIMEOUT_MS=600000

clausona use claude:gw
```

The key is never passed as an argument. By default it is read from a prompt that does not
echo it, or from stdin, and stored in the macOS Keychain or `~/.clausona/secrets.json`; with
`--key-from env:NAME` or `--key-from command:"op read …"` clausona records only where to find
it and reads it at each launch.

**An `api-key` profile's first `claude` session asks about the key — answer Yes.** Claude
Code shows "Detected a custom API key in your environment" with the cursor on
"No (recommended)", so pressing Enter answers No, and that profile then ignores its key.
`/config` → "Use custom API key" changes the answer later. A `bearer` profile is not asked.

The model, where the key lives, per-profile settings, changing the endpoint, and what
clausona hides or clears from the environment: **[docs/api-profiles.md](docs/api-profiles.md)**.

## Commands

`<profile>` accepts either a bare name (e.g. `work`) when it is unique across all tools, or a `tool:name` prefix (e.g. `claude:work`, `codex:work`) when disambiguation is needed.

| Command                                                             | Description                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------- |
| `clausona`                                                          | Interactive TUI dashboard                            |
| `clausona init`                                                     | Discover and register Claude Code and Codex accounts |
| `clausona add <profile> [--from <path>] [--merge-sessions]`         | Add a profile manually                               |
| `clausona add <profile> --api --base-url <url> [...]`               | Add an [API profile](#api-profiles)                  |
| `clausona remove <profile>`                                         | Remove a profile. Its config directory and history stay, so delete that directory before adding the name again |
| `clausona use [profile]`                                            | Switch active profile                                |
| `clausona run <profile> [-- args...]`                               | Run the tool's CLI with a specific profile (a leading `--` is dropped) |
| `clausona list [--json] [--refresh] [--no-quota] [--no-renew]`      | List all profiles with plan quota and usage          |
| `clausona usage [profile] [--period=today\|week\|month\|all]`       | View cost and token usage                            |
| `clausona current [--json]`                                         | Show active profile                                  |
| `clausona config <profile> --merge-sessions \| --separate-sessions` | Configure session mode                               |
| `clausona config <profile> --model <id>`                            | Change a profile's [model](docs/api-profiles.md#the-model) |
| `clausona config <profile> --set KEY=VALUE \| --unset KEY \| --edit` | Set [advanced settings](docs/api-profiles.md#advanced-settings) per profile |
| `clausona config <profile> --base-url <url> \| --auth <scheme> \| --label <name>` | [Change an API profile's endpoint](docs/api-profiles.md#changing-the-endpoint) |
| `clausona config <profile> --key \| --key-from <source>`            | Change an API profile's key, or where it is read from |
| `clausona config <profile> --show [--json]`                         | Print a profile's settings (`--json` adds the catalog) |
| `clausona doctor [--json]`                                          | Check profile health                                 |
| `clausona repair <profile>`                                         | Fix broken shared links                              |
| `clausona login <profile>`                                          | Re-authenticate a profile                            |
| `clausona update [--yes]`                                           | Update to the latest release (asks first; `--yes` skips) |
| `clausona uninstall`                                                | Uninstall clausona completely                        |

## How it works

`clausona use` only records which profile is active. The shell hook the installer adds wraps
`claude` and `codex`: on each launch it points the tool at the active profile's config
directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) for that one run, then runs the real,
unmodified binary. Your interactive shell is left as it was.

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

Each profile is its own config directory. Its sign-in and session history stay in it; the rest
links back to your primary directory, so what you set up once is there for every account:

```
~/.claude-work/            (new claude profile)
├── .claude.json           ← own account metadata (NOT shared)
├── .credentials.json      ← own OAuth tokens outside macOS, and on macOS when the
│                            Keychain refuses them (NOT shared)
├── projects/              ← own session history (NOT shared by default)
├── plugins/      →  ~/.claude/plugins        (symlink to primary)
├── settings.json →  ~/.claude/settings.json  (symlink to primary)
└── ...
```

Codex profiles work the same way, sharing `config.toml`, `skills/` and `plugins/cache/`.

clausona has no telemetry and no server of its own. The only network calls it makes are each
profile's plan-quota lookup — and a lapsed token's renewal — against that profile's own
provider, which `clausona list --no-quota` skips.

Session separation, Windows links, how credentials are kept apart, what `doctor` and `repair`
look at, and where clausona stores its data: **[docs/how-it-works.md](docs/how-it-works.md)**.

## FAQ

### How do I use two Claude Code accounts on one machine?

Sign in to the first account as usual (`claude login`) and run `clausona init` to register it.
Then `clausona add claude:work` creates a second profile and opens Claude Code's own sign-in
for it. From then on, `csn use work` and `csn use personal` choose which account `claude`
starts with. Each account keeps its own sign-in and history; plugins and settings are shared.

### How do I switch Codex CLI accounts without logging out?

`clausona add codex:work` creates a second Codex home (`~/.codex-work`) with its own
`auth.json`, signed in through Codex's own login. `csn use codex:work` makes `codex` start with
that account, and `csn use codex:personal` switches back. `config.toml`, skills and plugins stay
shared with your main `~/.codex`, and `codex resume` shows only the active account's sessions.

### Do my MCP servers, plugins and settings carry over when I switch?

Plugins — and the MCP servers they bring — `settings.json`, skills, commands and agents do:
they are linked to your primary config directory, so what you install under one account is
there under every account of that tool. MCP servers added with `claude mcp add` are the
exception: Claude Code keeps those in each config directory's `.claude.json`, next to that
account's sign-in, and clausona does not share that file. Add them to each profile, or put
them in a project's `.mcp.json`. Sign-ins and session history are never shared.

### Can I see Claude and Codex plan limits for all my accounts at once?

Yes. `clausona list` and the dashboard show every account's 5-hour and 7-day usage and the
time until each resets, read from each tool's own usage endpoint with the credential that tool
already stored. Accounts you have not used today still report, because clausona renews a lapsed
access token when it needs to.

### Can I run two accounts at the same time?

Yes. `csn use` sets the account new `claude` and `codex` launches start with, and
`clausona run claude:personal` starts one session under another profile without changing that.
So one terminal can run your work account while another runs `clausona run claude:personal`.

### How is this different from setting `CLAUDE_CONFIG_DIR` myself?

A shell alias per account gives you separate sign-ins, but each directory starts empty: plugins,
settings and skills have to be installed again in every one, and they drift apart afterwards.
clausona links them to one primary directory, shows every account's plan quota in one place,
and `clausona doctor` and `repair` spot and link the directories a newer Claude Code version
adds.

### Does clausona wrap or proxy `claude` and `codex`?

No. The shell hook sets the profile's environment for one run and executes the real `claude` or
`codex` binary, unmodified. There is no daemon and no proxy. If you export `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` yourself, clausona steps aside for that shell.

### Can I use an API key, OpenRouter, or a self-hosted model as a profile?

Yes, for Claude Code: `clausona add claude:gw --api --base-url <url>` creates a profile backed
by any endpoint that speaks the Anthropic Messages format. It switches like any other profile.
See [API profiles](#api-profiles). Codex API profiles are not supported yet.

### Does it work on Windows?

Yes, with PowerShell 5.1 or later. Shared directories use junctions. Shared files use symbolic
links when Developer Mode is on and fall back to hard links otherwise.

## Contributing

Issues and pull requests are welcome at [github.com/larcane97/clausona](https://github.com/larcane97/clausona).

If clausona saves you a few logins a day, a ⭐ on the repo helps other people find it.

## License

MIT
