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
- **API profiles** — a profile can point at an API endpoint instead of a subscription login: the Anthropic API, a gateway, or a model you serve yourself
- **Pure CLI passthrough** — no wrapping, no proxying, no background process. `claude` and `codex` run directly and unmodified. Compatible with oh-my-claudecode, Cline, codex plugins, and any other tool in your stack.
- **Lightweight** — a single shell hook and a few symlinks. No daemon, no server, no runtime overhead.
- **Plan quota at a glance** — session and weekly limit usage for every account, read live from each tool's own usage endpoint (Claude and Codex)
- **Usage tracking** — per-profile cost and token usage, tracked locally (Claude only in v0.1)
- **Interactive dashboard** — TUI for managing profiles, viewing usage, and running health checks

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

The table adapts to the terminal: as it narrows, token counts give way first, then
cost, then the reset times — the quota columns and the profile name are the last things
to go, so the row never wraps into itself. A `MODEL` column, shown once any profile pins
a model, is kept ahead of the token counts and cost but goes before the quota columns or
their reset times would.

Readings come from each tool's own usage endpoint, authenticated with the credential that
tool already stored for that profile. For subscription profiles clausona holds no token of
its own. An API profile is different by nature: its key is either held by clausona in the
platform's credential store, or merely referenced — see [API profiles](#api-profiles).
Results are cached for 5 minutes; `--refresh` forces a re-read and `--no-quota` skips the
network entirely.

### Profiles you have not used recently

An access token lasts 8 hours, so a profile you have not touched today would otherwise
show nothing. clausona renews it on demand using the stored refresh token, which lasts
about 14 days — so every account you have used in the last two weeks reports its quota,
whether or not you have switched to it lately.

Renewal is lazy: a token is only renewed once it has actually lapsed (or if the endpoint
rejects it), never pre-emptively, so each profile rotates at most once per 8 hours.
`--no-renew` turns it off.

Two details make this safe to do on your behalf, and both are worth knowing if you touch
this code:

- **The refresh token rotates with no grace period.** The moment the provider answers,
  the previous refresh token is rejected. The renewed credential is therefore written
  and read back before the call returns; a write that cannot be verified is an error,
  never a silent fallback.
- **Renewal is locked per profile**, so two clausona processes cannot both rotate the
  same credential and leave one of them holding a token the provider has already
  invalidated.

Claude credentials stay in the macOS Keychain (or `.credentials.json` elsewhere) and
Codex credentials in `auth.json`, in place — unrelated contents of those stores, such as
Claude's `mcpOAuth` block, are preserved.

### When a reading is unavailable

A dash means the reading could not be taken, and the reason is printed below the table:

| State | Meaning |
| --- | --- |
| `expired` | The sign-in has lapsed past renewal (refresh token older than ~14 days, or revoked). Run `clausona login <profile>`. |
| `missing` | No credential is stored for the profile. Run `clausona login <profile>`. |
| `cooldown` | The endpoint returned 429. clausona pauses that tool until the window lifts. |
| `error` | Network failure, timeout, or an unreadable response. |

Where numbers are already known, they stay on screen dimmed with their age, rather than
being blanked out.

## API profiles

A profile can be backed by an API endpoint instead of a subscription login — the Anthropic
API, a gateway such as OpenRouter, or a model you serve yourself. It sits beside your
subscription profiles in `clausona list`, switches the same way, and shares the same
plugins, MCP servers, and settings. In this version API profiles are for Claude Code only:
`clausona add codex:<name> --api` is refused, before it asks for a key.

**An API profile needs clausona set up first**: one Claude Code account signed in
(`claude login`), then `clausona init`. API profiles are added next to that account; in this
version clausona cannot be set up from API profiles alone.

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

`clausona use` records which profile is active; it is the shell hook the installer adds that
applies it each time `claude` starts — `eval "$(clausona shell-init)"` in your zsh or bash rc
file, `Invoke-Expression (& clausona shell-init | Out-String)` in your PowerShell profile. In
a shell without the hook, `use` changes nothing `claude` sees — `clausona run claude:gw`
applies a profile for one run without it. See [Profile Switching](#profile-switching).

`--base-url` must be an absolute `http://` or `https://` URL carrying no username or
password, no query parameter named for a credential (`apikey`, or any name with `key`,
`token`, `secret`, `password`, `passwd`, `sig`, `signature`, `auth` or `credential` — or its
plural — as one of its `_`-separated parts, such as `api_key`, `x-api-key`, `client_secret`
or `auth_token`; matched without case and with `-` read as `_`, so `page_token` and `key_id`
are refused too), and nothing shaped like an API key anywhere in it — a
credential in the URL would be stored in `profiles.json` in plain text, which is exactly what
the key source exists to avoid. The shape check can be wrong about a URL with a long
random-looking segment in it; if none of it is a key, write the URL into `api.baseUrl` in
`~/.clausona/profiles.json` by hand, and `doctor` will go on naming it. Plain `http://` is
accepted, with a note unless the host is this machine (`localhost`, an address in
`127.0.0.0/8`, `::1`): the key would cross the network unencrypted. `--auth` picks how the
key is presented:
`api-key` passes it as `ANTHROPIC_API_KEY`, which Claude Code sends as Anthropic's
`X-Api-Key` header, and is the default for `anthropic.com` and its subdomains; `bearer`
passes it as `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer`, and is the default
everywhere else. `--model` is stored as `ANTHROPIC_MODEL` and is whatever your endpoint calls
the model; clausona never contacts the endpoint, so a typo there surfaces as an error from
`claude` rather than from `clausona add`; [it can be changed later](#the-model). `--label`
sets the name shown in `list`, which otherwise defaults to the endpoint's host. All of these
can be [changed later](#changing-the-endpoint) without typing the key again.

**An `api-key` profile's first `claude` session asks about the key — answer Yes.** Claude
Code (as of 2.1.278) shows "Detected a custom API key in your environment" and asks "Do you
want to use this API key?", with the cursor on "No (recommended)", so pressing Enter answers
No. No makes that profile ignore its key from then on. It asks again after the key changes,
such as after `config --key`. To change the answer later, run `/config` in Claude Code and
set "Use custom API key". A `bearer` profile is not asked.

Claude Code speaks the Anthropic Messages format, which recent SGLang, vLLM, llama.cpp and
OpenRouter's Anthropic endpoint all serve natively. An endpoint that only speaks the OpenAI
format needs a translation proxy of your own (LiteLLM, claude-code-router); point
`--base-url` at that proxy.

The dashboard registers one too — **Profiles → add → API endpoint** walks the same fields,
and says under a field what the CLI would print for it: that an `http://` endpoint off this
machine sends the key unencrypted, or that a setting whose name says it holds a secret is
stored in plain text. Its key field shows a constant mask, never the key: a paste there
replaces whatever the field held, and a key pressed with Alt or Option types nothing into it.

### The model

```bash
clausona config claude:gw --model z-ai/glm-5.3-flash   # the profile's model from now on
clausona config claude:gw --unset ANTHROPIC_MODEL      # back to Claude Code's own choice
```

`--model` writes `ANTHROPIC_MODEL` in the profile's env map. That is the variable Claude Code
reads and the only place clausona keeps the model, so `--set ANTHROPIC_MODEL=…` and `--edit`
change the same value, and passing `--model` with a `--set` or `--unset` of that variable is
refused. It works on a subscription profile too, where it pins a model for that account; a
Codex profile refuses it, because Codex never reads the variable. A blank model is refused
rather than taken to mean "clear it", whether it comes from `--model`, `--set` or `--edit` —
`--unset ANTHROPIC_MODEL` is how to clear it. A blank one would be exported to Claude Code
while `list` showed no model at all. A model id that looks like an API key is refused too,
by the same routes — `--model "$KEY"` with the wrong variable would send the key as the
model's name — and so is a `--label` that does; one stored before that is shown as
`<hidden>`. If the check is wrong about a model id, `claude --model <id>` takes it for a
session.
`clausona list` shows each profile's model in a `MODEL` column, and `list --json` carries it as
`model`.

**Do you need a profile per model? No.** From cheapest to heaviest:

1. `claude --model <id>` changes the model for one session and leaves the profile alone.
2. `clausona config <profile> --model <id>` changes the profile's default.
3. A second profile, only when you want separate *state*: a profile is a config directory —
   its own history, settings and MCP servers — plus its own line of usage in `list`.

Same endpoint, same key, only the model differs: one profile. A different endpoint, a
different key, or wanting separate history or cost tracking: separate profiles. When you do
want one per model, `--merge-sessions` gives them a shared history and `--key-from env:NAME`
lets them read one key rather than each storing a copy — while they point at the same
endpoint. A key belongs to one endpoint: once a profile moves to another, give it its own
(see [Changing the endpoint](#changing-the-endpoint)).

**The context window belongs to the endpoint, not to the model name.** The same model can be
served with very different limits — OpenRouter advertises `z-ai/glm-5.3` at 1,310,720 tokens,
while a server you run yourself may be configured for a fraction of that. So set
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` on each profile from what its endpoint actually serves, and
do not copy it from one profile to another.

**`[claude-code:unrecognized_model]` is that setting missing, not a broken profile.** For a
model id it does not know — any non-Anthropic one, such as `z-ai/glm-5.3` — Claude Code (seen
with 2.1.280) prints this warning and assumes a 200k-token window, so it compacts the
conversation early on an endpoint that serves more, and too late on one that serves less.
The requests themselves go through. Tell it the endpoint's window and it works to that
instead:

```bash
clausona config claude:gw --set CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144   # the endpoint's window
```

### Profile names

A name must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, because it becomes a directory name,
and names are compared without case, so `Work` and `work` are the same profile. A name that
looks like an API key — longer than 64 characters, or starting with `sk-` — is refused
outright: `ps` shows every process's arguments to every user on the machine, so a key never
belongs in an argument.

### Where the key lives

`--key-from` decides, both on `add` and later on `config`:

| Value | Where the key lives | When it is read |
| --- | --- | --- |
| `keychain` (default) | clausona stores it — in the macOS Keychain on a Mac, otherwise in `~/.clausona/secrets.json`. That includes Linux: in this version a stored key goes to that file, written owner-only (mode 0600) so that only you can read it, not to `secret-tool` or your desktop keyring. On Windows a file mode means nothing; the file is private because it sits inside your user profile, which Windows opens only to you, SYSTEM and administrators. `clausona doctor`'s text report ends by saying which. On a Mac a key longer than about 2,000 bytes is refused — it does not fit the one line the Keychain is handed it on — so point at such a key with `env:` or `command:` | at every launch, from that store |
| `env:NAME` | your shell; clausona records only the variable name | at every launch, **in the shell that runs `claude`** — so `NAME` has to be exported there, not only where you ran `clausona add` |
| `command:"…"` | wherever the command gets it — `op read`, `pass show`, `vault kv get` | at every launch, on every `clausona doctor`, and each time the dashboard's Health check screen opens — never by the dashboard itself; the first line of its output is the key |

`profiles.json` never holds the key itself, only which of these to use. `env:` takes the
variable's *name*: many keys are valid names too (`hf_…`, `gsk_…`, `sk_live_…`), so a `NAME`
that looks like an API key is refused, and one stored before is shown as `env:<hidden>` and
left out of every message. If a real variable's name is refused, copy it to a plainer one
(`export GW_KEY="$THAT_VARIABLE"`) and pass that.

A `command:` source runs in `sh -c` on macOS and Linux, and in
`powershell -NoProfile -Command` on Windows, so write it for that shell: `type %USERPROFILE%\…`
is cmd.exe's, and fails there. In PowerShell, quote the whole value with single quotes, so that
nothing in it is expanded before clausona stores it — for example with SecretManagement's
`Get-Secret`:

```powershell
clausona add claude:vault --api --base-url https://openrouter.ai/api --key-from 'command:Get-Secret gw -AsPlainText'
```

Never pass a key as an argument. With the default `keychain` source the key is read from a
prompt that does not echo it, or from stdin when something is piped in — which is how to
register a profile without a terminal:

```bash
printf %s "$MY_API_KEY" | clausona add claude:gw --api --base-url https://openrouter.ai/api
printf %s "$MY_API_KEY" | clausona config claude:gw --key     # rotate it later
```

The key's ends are trimmed, so one piped or pasted with its newline is fine. A key with a
space or a line break inside it is refused, whether it was piped, typed, or pasted into the
dashboard's form: an API key has neither, and two lines run together are not a key. So is a
key with any character outside printable ASCII — an invisible space, an accent or a curly
quote that a web page or a chat copied along with it. No API key has one, and the macOS
Keychain would hand such a key back as hex.
`pass show` prints more than the key; `--key-from command:"pass show gw"` takes only its
first line.

Or keep the key out of clausona entirely:

```bash
clausona add claude:gw --api --base-url https://openrouter.ai/api --key-from env:MY_API_KEY
clausona add claude:vault --api --base-url https://openrouter.ai/api --key-from command:"pass show gw"
```

Rotating depends on the source. With `env:` or `command:` there is nothing to run — change
the variable, or what the command returns, and the next launch picks it up. With `keychain`,
pipe the new key into `clausona config <profile> --key`; that always means "store this in the
credential store", so on a profile currently reading `env:` or `command:` it switches the
source to `keychain` as well. `clausona config <profile> --key-from env:NAME` or
`--key-from command:"…"` moves a profile to that source without typing a key, and deletes
the stored one when you move away from `keychain` — its success line says so. Here and on
`add`, a `NAME` that is not set in the shell you run it from gets a warning, not a refusal: it
only has to be set where `claude` runs. `--key-from keychain` needs the key,
piped in or typed at the prompt, as `--key` does.

`clausona config <profile> --show` prints the endpoint, the auth scheme and the key's
*source* — never the key, and for a `command:` source not the command line either. Neither
does `doctor`, in either output form; see [What clausona prints](#what-clausona-prints).
`--show` only reads, so next to a change it is refused and nothing is changed.

The credential reaches Claude Code through its environment, so **processes Claude Code
starts — including its own Bash tool calls — can read it**. Use `env:` or `command:` with a
short-lived token if that matters for your threat model.

### Advanced settings

Anything Claude Code reads from the environment can be set per profile:

```bash
clausona config claude:gw --set CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144
clausona config claude:gw --set CLAUDE_CODE_MAX_RETRIES=8
clausona config claude:gw --unset DISABLE_PROMPT_CACHING
clausona config claude:gw --edit          # open the whole map in $VISUAL or $EDITOR
clausona config claude:gw --show          # what this profile sets
clausona config claude:gw --show --json   # the same, plus every variable clausona knows about
```

`--show --json` is the discovery mechanism: next to the profile it prints the full catalog
under `catalog` — for each variable its `key`, a short `label`, a one-line `hint`, its `kind`
(`number`, `bool`, `string` or `json`) and its `group` (`model`, `context`, `limits`,
`timeouts`, `compat` or `transport`). The catalog is a convenience,
not an allowlist: a variable a future Claude Code release introduces can be set today, as
long as the name is one a shell can export.

An API profile's endpoint is not one of these settings. `--set ANTHROPIC_BASE_URL=…` is
refused on an API profile, in any case — set the endpoint with `--base-url`, which checks the
URL and says when the key would go to a new host. The env map is applied after the endpoint,
so one a hand edit leaves there still wins at launch; `doctor` warns about it, with
`config <profile> --unset ANTHROPIC_BASE_URL` and then `--base-url`.

Two are worth knowing about for a self-hosted model. Claude Code assumes a conservative
context window for a model it does not recognise and compacts early, so declare the real one
with `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. And a cold GPU server is slow to first byte, so raise
`API_TIMEOUT_MS` and `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`.

**The env map is stored in plain text** in `~/.clausona/profiles.json`. The API key does not
belong in it — not as `--set ANTHROPIC_API_KEY=…`, and not as an `Authorization` header under
`--set ANTHROPIC_CUSTOM_HEADERS=…`. Use `--key` or `--key-from` instead. A value shaped like
an API key under a name that does not say it holds a secret — `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
say — is refused by `add --set`, `config --set` and `config --edit` alike, and no refusal
repeats the value. clausona warns when you set one of those credential names, on any profile,
and names the commands that undo it:

- an API profile whose key is in the credential store: `config <profile> --key` to store the
  key, then `config <profile> --unset <NAME>` to drop the plain-text copy, which would
  otherwise still be what Claude Code is handed;
- an API profile whose key comes from `env:` or `command:`: only the `--unset`. The key
  already lives outside `profiles.json`, and `--key` would replace the source you chose with
  the keychain;
- an API profile a hand edit left with no endpoint recorded, which `--key` refuses:
  `clausona remove <profile>` and `clausona add <new-name> --api --base-url <url>`, which
  takes the plain-text copy away with the old profile;
- a subscription profile, which signs in with its account and has nowhere to store a key:
  only the `--unset`.

It warns too for a secret that is not the profile's key — any name that says it holds one,
such as `OTEL_EXPORTER_OTLP_HEADERS` or `AWS_BEARER_TOKEN_BEDROCK`. There is no per-profile
store for those. Your shell's environment can hold one instead, and the hook passes it
through — but to every profile of that tool launched from that shell, not just this one; if
that is fine, `--unset` the copy. If only this profile should have it, leave it in the env
map, where output hides it. `doctor` keeps warning — but only for an **API** profile. A
subscription profile's env map is never checked, so a clean `doctor` does not mean no profile
on this machine holds a plaintext key.

### Changing the endpoint

Everything `add --api` set can be changed afterwards without typing the key again:

```bash
clausona config claude:gw --base-url http://localhost:8000
clausona config claude:gw --auth api-key
clausona config claude:gw --label "Gateway"
```

Each value goes through the rule `add` applies, so a URL `add` would refuse is refused here
too, and an empty `--label` is refused rather than leaving a blank row in `list`. The three
can be given together, as one change. Three things happen that you might not expect:

- **The key is kept.** After `--base-url`, the next launch sends the same key to the new
  host, and clausona says so when the host changes. If the new endpoint takes a different
  key, what to do depends on where the key comes from:
  - the credential store (`keychain`): pipe the new one into `clausona config <profile> --key`;
  - `env:` or `command:`, read by this profile alone: change the variable or what the
    command prints, or read another with `--key-from` (`--key` would replace the source
    with the credential store);
  - `env:` or `command:` that another profile reads too: changing it would send the new key
    to that profile's endpoint as well, so give this profile its own —
    `clausona config <profile> --key-from env:<ANOTHER_NAME>`, or `--key` to store it. The
    note `--base-url` prints names the profiles that share the source, leaving out any that
    already point at the new endpoint, since they want the same key.
- **What `add` chose by itself follows the new host** while it is still the old host's:
  a label that is the old host, and the auth scheme — `api-key` for `anthropic.com`,
  `bearer` elsewhere — so moving from a gateway to Anthropic's own API does not leave the key
  in a header Anthropic does not read. clausona does not record which values you typed, so
  it goes by the value: a label that is the old host, or a scheme that is the old host's
  default, follows even if you typed it; any other stays. When a kept scheme differs from
  what a new host usually takes, clausona says so, once, when the host changes, and names
  the `--auth` that would switch it.
- **A move to plain `http://` is noted** unless the host is this machine (`localhost`, an
  address in `127.0.0.0/8`, `::1`): the key would cross the network unencrypted. A name is
  judged as a name, so `127.gw.example.com` and `gw.localhost` are noted.

A subscription profile has no endpoint, and `list` names it by its account email, so all
three refuse one. Do not edit `~/.clausona/profiles.json` by hand for any of this — a
hand-edited file is the one way a base URL gets broken.

### What clausona prints

`config --show`, `current`, `list`, `doctor` and the dashboard, in text and in `--json`, all
go through one rule for what they print about a profile:

- the value under a credential name (`ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS` and the
  rest), under any name that says it holds a secret (a `TOKEN`, `SECRET`, `PASSWORD`,
  `API_KEY`, `PRIVATE_KEY`, `MASTER_KEY`, `PAT`, `PWD`, `COOKIE`, `CONNECTION_STRING`,
  `HEADERS` and the like, in any case, so `OTEL_EXPORTER_OTLP_HEADERS`,
  `AWS_BEARER_TOKEN_BEDROCK`, `PGPASSWORD` and `LITELLM_MASTER_KEY` too, but not a count such
  as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`), and under a json setting (`CLAUDE_CODE_EXTRA_BODY`,
  where a gateway's auth field goes) prints as `<hidden>`;
- a setting whose *name* is shaped like an API key — a key pasted where the name goes — prints
  as `<hidden>`, value and all. `--set` refuses one, and launch skips one a hand edit left,
  with a warning that does not quote it; `doctor` reports one on an API profile without
  naming it, with the `config <profile> --edit` that removes it;
- a URL's userinfo, query and fragment print as `<hidden>`, in the base URL and in any
  setting — `HTTPS_PROXY=http://user:pass@proxy:8080` shows as
  `http://<hidden>@proxy:8080/`. That includes the scheme-less `user:pass@host` form, and a
  URL anywhere in a value, after other words or on another line. A base URL that does not
  parse, or that carries something shaped like an API key, is hidden whole;
- a `command:` key source shows as `command`. Its command line can carry a vault token or the
  key itself, so it is only in `~/.clausona/profiles.json`, and a message about it says what
  failed ("secret command exited with 1") rather than quoting it. A key source that is none of
  `keychain`, `env:` and `command:` — a hand edit — shows as `unknown`, and `doctor` reports it;
- a field clausona does not define is left out, and an env map a hand edit left as a list or
  a string — not a map of settings — is hidden whole. `doctor` reports that one, with the
  `config <profile> --edit` that fixes it; until then `--set`, `--unset` and `--model` refuse
  to change it. An empty list or `null` applies what `{}` does, and is read as that. A value
  that is not a string in quotes — a hand edit's `"API_TIMEOUT_MS": 600000` — is hidden too
  and listed in `hiddenEnvKeys`; launch skips that one entry, with a warning, and applies the
  rest, and `doctor` reports it with the same `--edit`;
- a control character — an escape sequence a hand edit left in a profile's label, kind or
  auth scheme, or one given in a model id or a setting's value — is dropped, so printing a
  profile cannot drive your terminal. Only the printed copy loses it; the stored value and
  what reaches `claude` keep it. `doctor`
  reports a kind that is not `subscription` or `api`, and an auth scheme that is not
  `bearer` or `api-key`, with the command that fixes it. For the kind, the fix is `remove` and
  then `add` under a new name, since `remove` keeps the config directory; `remove` deletes a key
  clausona stored for the profile whatever its kind says.

Only what is printed changes, not what is stored or what reaches `claude`. The two
exceptions are the ones whose job is the values: the shell hook, which hands them to the
tool, and `config --edit`, whose file has to carry them to save them back.

### What an API profile clears from your environment

Claude Code takes a credential from whichever source it finds first, and sends `X-Api-Key`
and `Authorization` together when it has both — so an `ANTHROPIC_API_KEY` you exported for
something else would reach this profile's endpoint, often a third party, next to the
profile's own key or in its place. So with an API profile active, clausona removes every
credential and endpoint-routing variable it knows about from that run, unless the profile's
own env map sets it:

- the auth variables — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`
  — and `ANTHROPIC_CUSTOM_HEADERS`, which can carry an `Authorization` header of its own
- a subscription's OAuth refresh token
- the four file-descriptor credential sources
- the workload-identity-federation set: the identity token or its file, and the rule-id and
  organization-id pair that switches it on
- a host's credentials, a remote session's token, and the background handoff snapshot
- the provider switches (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and the rest),
  `ANTHROPIC_UNIX_SOCKET`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and
  `CLAUDE_CODE_CUSTOM_OAUTH_URL` — each of which would route the run somewhere other than the
  base URL you configured

Only that run is affected; your interactive shell keeps whatever it had, and subscription
profiles inherit your environment exactly as they always did.

**An API profile refuses to launch** if it cannot set or clear one of the variables it
manages — a `readonly ANTHROPIC_API_KEY` in your shell, say. It names the variable and stops,
rather than starting the tool with the wrong credential:

```
clausona: ANTHROPIC_API_KEY is read-only in this shell, so clausona cannot set or clear it for this profile. Not starting the tool.
```

**`apiKeyHelper` is a second path to the same leak, and one the environment rules cannot
cover.** `settings.json` is shared with your primary profile, so a helper written for a
subscription account also runs for every API profile, and the key it prints can reach that
profile's endpoint — whatever auth scheme the profile uses. `clausona doctor` reports it;
removing it removes it for every profile.

**So is an `env` block in that `settings.json`.** Claude Code applies it over the environment
it was started with, so over everything the profile sets and clears: an `ANTHROPIC_API_KEY`
there reaches this profile's endpoint next to the profile's key, an `ANTHROPIC_BASE_URL` sends
the profile's key to another host, and a provider switch such as `CLAUDE_CODE_USE_BEDROCK`
routes the run away from the endpoint. `clausona doctor` reports each such name, in any case,
as an error — `ANTHROPIC_MODEL` there as a warning — without quoting its value, and each
launch of an API profile warns about the ones that move the key or the traffic. The fix is to
move the setting out of `settings.json` into the profile that needs it:
`clausona config <that profile> --set KEY=VALUE`.

### What `list` shows

The `ACCOUNT` column holds the account email for a subscription profile and the label for an
API one — the endpoint's host, unless you passed `--label` (or set one since with
`config --label`). `5H` and `7D` show a dash: those are subscription plan windows, an API
endpoint bills per token, and there is nothing to read.
**The dash is not an error** — unlike the dashes described under [When a reading is
unavailable](#when-a-reading-is-unavailable), no state and no reason line accompany it. The
profile is never queried, so `--refresh` and `--no-quota` change nothing for it.

```
PROFILE             ACCOUNT                      MODEL                   5H         7D
claude:work         you@example.com              —                       6% 23m     46% 13h
claude:gw           openrouter.ai                z-ai/glm-5.3            —          —
```

`MODEL`, once any profile pins a model, shows each profile's `ANTHROPIC_MODEL`, subscription
profiles included; a dash means the profile pins none and Claude Code picks, or, on a Codex
row, that Codex does not read the variable. An id too long for the column loses its middle
rather than its end, so `openrouter/z-ai/glm-5.3-flash` and `…-air` stay told apart;
`list --json` has the whole id. It is the same value the dashboard's preview shows, cut the
same way, and `clausona config <profile> --model` changes it.

`COST`, `INPUT` and `OUTPUT` do count for an API profile, but they come from clausona's own
local record of what ran through it, not from the provider — they are not a bill. Claude
Code's accounting has no price table for third-party models, so cost may read as zero while
the token counts stay accurate.

In `clausona list --json` an API profile carries `kind: "api"` and `label`; a subscription
profile carries neither key. Any profile that pins a model carries `model`, which is the only
value from the env map the listing includes. Neither form ever carries the key or its source — `clausona
config <profile> --show` is where the source is visible.

### What `doctor` checks

An API profile has no account file and no stored login, so `doctor` looks for neither and
reports neither missing. It checks these instead:

- that the profile's config directory is still there. `clausona repair` alone cannot rebuild
  one — it only links into a directory that exists — so the fix is to create the directory again,
  empty, at the path doctor names, then run `clausona repair <profile>`: that links it back, with
  the key, the endpoint and every setting as they were. Failing that, remove and re-add the
  profile: `clausona remove <profile>`, then `clausona add <profile> --api ...` under the same
  name — which deletes a stored key, and a provider may not show a key twice. `remove` does not
  bring a deleted directory back; if the profile's backup under `~/.clausona/backups` holds
  anything, it is left there and `remove` says where
- the base URL, which only a hand-edited `profiles.json` can break. The URL is never quoted
  back, because a hand-edited one can carry a password; `config <profile> --show` is where to
  read it, and `config <profile> --base-url <url>` is how to put it right. A profile with no
  endpoint recorded at all has no key source for `config` to keep, so doctor names `remove`
  and `add` for that one instead. An auth scheme that is not `bearer` or `api-key` is
  reported too, with the `config <profile> --auth` that sets one
- that the key resolves. **A `command:` source is executed**, in a shell, every time doctor
  runs — so a vault round-trip or a touch-ID prompt happens on every `clausona doctor`, and each
  time the dashboard's Health check screen opens. The dashboard itself resolves no key, so the
  health it shows beside a profile does not say whether the key resolves. An
  `env:` source is read from doctor's own environment, which is not necessarily the
  environment the profile will run in. A key source that is none of `keychain`, `env:` and
  `command:` is reported as unknown rather than resolved, with the `config <profile> --key`
  (or `--key-from`) that gives it one
- `apiKeyHelper` in `settings.json`, and a credential name in the profile's env map. Both are
  warnings: they describe a key that could reach the endpoint, not a profile that is broken,
  so the profile still reads as healthy
- an `env` block in `settings.json` that sets the base URL, a credential or a provider switch,
  which Claude Code applies over the profile: an error, since the key or the traffic then goes
  somewhere else. `ANTHROPIC_MODEL` there is a warning
- one `env:` or `command:` key source read by API profiles on different endpoints (compared by
  scheme, host and port): whichever key it holds goes to each of them. Also a warning, reported on
  each of them with the `config <profile> --key-from env:<ANOTHER_NAME>` that separates them.
  `add --api --key-from` says the same when it creates that state

No request is made to the endpoint. A healthy report means the profile is configured and its
key resolves, not that the endpoint answered — run `claude` itself to find that out. When a
profile's key is stored by clausona, the text report ends by saying where: the macOS Keychain,
or `~/.clausona/secrets.json` everywhere else. `--json` leaves that line out.

In `clausona doctor --json` each profile carries `kind` and `label` exactly as `list --json`
does: an API profile has `kind: "api"`, its label under `label` and an empty `email`; a
subscription profile carries neither key. Each finding has a `kind`, a `message`, and
`severity: "warning"` when it is advice rather than a problem.

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
| `clausona config <profile> --model <id>`                            | Change a profile's [model](#the-model)                |
| `clausona config <profile> --set KEY=VALUE \| --unset KEY \| --edit` | Set [advanced settings](#advanced-settings) per profile |
| `clausona config <profile> --base-url <url> \| --auth <scheme> \| --label <name>` | [Change an API profile's endpoint](#changing-the-endpoint) |
| `clausona config <profile> --key \| --key-from <source>`            | Change an API profile's key, or where it is read from |
| `clausona config <profile> --show [--json]`                         | Print a profile's settings (`--json` adds the catalog) |
| `clausona doctor [--json]`                                          | Check profile health                                 |
| `clausona repair <profile>`                                         | Fix broken shared links                              |
| `clausona login <profile>`                                          | Re-authenticate a profile                            |
| `clausona uninstall`                                                | Uninstall clausona completely                        |

## How It Works

### Profile Switching

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

### Shared Environment

When you register a new profile, clausona symlinks shared resources from your primary config directory into the new profile's config directory.

**Claude profile** (`clausona add claude:work`):

```
~/.claude-work/            (new claude profile)
├── .claude.json           ← own account metadata (NOT shared)
├── .credentials.json      ← own OAuth tokens outside macOS (NOT shared)
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
isolated by the tool itself. Everywhere else the tokens are a plain
`.credentials.json` next to the config, and clausona keeps that file profile-local.
Profiles created by clausona 0.2.2-beta or earlier on Linux and Windows may hold a link
to the primary's credential; `clausona doctor` reports it as `stale_symlink` and
`clausona repair <profile>` removes it, after which that profile signs in on its own.

`clausona doctor` checks whichever store the platform uses: the Keychain item on macOS
(`missing_keychain`) and the credential file everywhere else (`missing_oauth`). A profile
that has just had a stale credential link removed reports `missing_oauth` until it signs
in, so doctor points those findings at `clausona login <profile>` rather than at
`clausona repair`, which rebuilds shared links and cannot produce a credential.

`settings.json` is shared, though, and an `apiKeyHelper` in it runs for every profile that
links to it — including API profiles, whose endpoint the key it prints would then reach. See
[What an API profile clears from your environment](#what-an-api-profile-clears-from-your-environment).

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

### Data Storage

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

## Contributing

Issues and pull requests are welcome at [github.com/larcane97/clausona](https://github.com/larcane97/clausona).

## License

MIT
