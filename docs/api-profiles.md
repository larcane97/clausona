# API profiles

[← Back to the README](../README.md)

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
applies a profile for one run without it. See [Profile Switching](how-it-works.md#profile-switching).

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

## The model

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

## Profile names

A name must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, because it becomes a directory name,
and names are compared without case, so `Work` and `work` are the same profile. A name that
looks like an API key — longer than 64 characters, or starting with `sk-` — is refused
outright: `ps` shows every process's arguments to every user on the machine, so a key never
belongs in an argument.

## Where the key lives

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

## Advanced settings

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

## Changing the endpoint

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

## What clausona prints

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

## What an API profile clears from your environment

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

## What `list` shows

The `ACCOUNT` column holds the account email for a subscription profile and the label for an
API one — the endpoint's host, unless you passed `--label` (or set one since with
`config --label`). `5H` and `7D` show a dash: those are subscription plan windows, an API
endpoint bills per token, and there is nothing to read.
**The dash is not an error** — unlike the dashes described under [When a reading is
unavailable](plan-quota.md#when-a-reading-is-unavailable), no state and no reason line accompany it. The
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

## What `doctor` checks

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
