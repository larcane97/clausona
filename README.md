# clausona

**Switch between multiple Claude Code and OpenAI Codex CLI accounts on one machine — plugins, MCP servers, and settings stay shared.**

<p align="center">
  <img src="assets/dashboard.png" alt="clausona dashboard" width="700" />
</p>

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
- **Pure CLI passthrough** — no wrapping, no proxying, no background process. `claude` and `codex` run directly and unmodified. Compatible with oh-my-claudecode, Cline, codex plugins, and any other tool in your stack.
- **Lightweight** — a single shell hook and a few symlinks. No daemon, no server, no runtime overhead.
- **Usage tracking** — per-profile cost and token usage, tracked locally (Claude only in v0.1)
- **Interactive dashboard** — TUI for managing profiles, viewing usage, and running health checks

## Install

**Requirements:** Node.js >= 20, and at least one of:
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [OpenAI Codex CLI](https://github.com/openai/codex)

**Platform:** macOS, zsh

```bash
curl -fsSL https://github.com/larcane97/clausona/releases/latest/download/install.sh | bash
```

## Quick Start

```bash
clausona init             # discover existing Claude Code and Codex accounts
clausona use work         # switch to a profile (bare name if unique)
clausona use claude:work  # switch claude account (use prefix when both tools have "work")
clausona add codex:work   # add a codex profile
clausona use codex:personal  # switch codex account
clausona list             # see all profiles with weekly usage
clausona                  # open the interactive dashboard
```

## Commands

`<profile>` accepts either a bare name (e.g. `work`) when it is unique across all tools, or a `tool:name` prefix (e.g. `claude:work`, `codex:work`) when disambiguation is needed.

| Command | Description |
|---------|-------------|
| `clausona` | Interactive TUI dashboard |
| `clausona init` | Discover and register Claude Code and Codex accounts |
| `clausona add <profile> [--from <path>] [--merge-sessions]` | Add a profile manually |
| `clausona remove <profile>` | Remove a profile |
| `clausona use [profile]` | Switch active profile |
| `clausona run <profile> [-- args...]` | Run the tool's CLI with a specific profile |
| `clausona list [--json]` | List all profiles with usage |
| `clausona usage [profile] [--period=today\|week\|month\|all]` | View cost and token usage |
| `clausona current [--json]` | Show active profile |
| `clausona config <profile> --merge-sessions \| --separate-sessions` | Configure session mode |
| `clausona doctor [--json]` | Check profile health |
| `clausona repair <profile>` | Fix broken shared links |
| `clausona login <profile>` | Re-authenticate a profile |
| `clausona uninstall` | Uninstall clausona completely |

## How It Works

### Profile Switching

Shell wrappers for `claude` and `codex` are registered via `eval "$(clausona shell-init)"`:

1. **Before** each invocation — reads `~/.clausona/profiles.json` and sets the appropriate env var (`CLAUDE_CONFIG_DIR` for claude, `CODEX_HOME` for codex) to the active profile's config directory
2. **After** each `claude` invocation — detects usage changes via fingerprint comparison and records cost/token usage per profile

```
clausona use work
↓
claude             ← wrapper sets CLAUDE_CONFIG_DIR, then runs claude
↓
_track-usage       ← on exit, records any new cost/token usage

clausona use codex:personal
↓
codex              ← wrapper sets CODEX_HOME, then runs codex
```

### Shared Environment

When you register a new profile, clausona symlinks shared resources from your primary config directory into the new profile's config directory.

**Claude profile** (`clausona add claude:work`):

```
~/.claude-work/            (new claude profile)
├── .claude.json           ← own auth credentials (NOT shared)
├── projects/              ← own session history (NOT shared by default)
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

**Session separation** is the default: each profile keeps its own session directory, so `/resume` (Claude) and `codex resume` (Codex) only show that profile's conversations. To share session history across claude profiles, pass `--merge-sessions` when adding or initializing.

### Data Storage

All data stays local on your machine.

```
~/.clausona/
├── profiles.json    # registered profiles and active selection
├── usage.json       # per-profile usage history
└── backups/
    ├── claude/      # backups of imported claude profile directories
    └── codex/       # backups of imported codex profile directories

~/.claude-<name>/        # claude profile config directories (created by `clausona add`)
~/.codex-<name>/         # codex profile config directories (created by `clausona add codex:<name>`)
```

## Migration from 0.0.x

clausona 0.1.0-beta introduces multi-tool support. On first launch, the registry at `~/.clausona/profiles.json` is automatically migrated to v2 format:

- Profile names are prefixed with their tool: `work` → `claude:work`
- Per-tool active profiles, per-tool primary sources
- Backup files saved with `.v1.bak` suffix

To roll back: restore the `.v1.bak` files and install the previous clausona version.

## Contributing

Issues and pull requests are welcome at [github.com/larcane97/clausona](https://github.com/larcane97/clausona).

## License

MIT
