# Plan quota

[← Back to the README](../README.md)

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
platform's credential store, or merely referenced — see [API profiles](api-profiles.md).
Results are cached for 5 minutes; `--refresh` forces a re-read and `--no-quota` skips the
network entirely.

## Profiles you have not used recently

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
  invalidated. It also takes Claude Code's own refresh and credential-write locks in the
  profile's config dir: while a running Claude Code is renewing the same sign-in, clausona
  leaves it to Claude Code and uses the token it stores, and neither overwrites the other's
  write.

Claude credentials stay in the macOS Keychain (or `.credentials.json` elsewhere) and
Codex credentials in `auth.json`, in place — unrelated contents of those stores, such as
Claude's `mcpOAuth` block, are preserved. On macOS, Claude Code saves to
`.credentials.json` instead when the Keychain refuses its write, and reads that file
whenever the Keychain has no item; clausona reads in the same order and writes a renewed
credential back to whichever of the two it came from. When the Keychain cannot be read at
that point, clausona writes the way Claude Code does: to the Keychain, and to the file only
if the Keychain refuses it.

## When a reading is unavailable

A dash means the reading could not be taken, and the reason is printed below the table:

| State | Meaning |
| --- | --- |
| `expired` | The sign-in has lapsed past renewal (refresh token older than ~14 days, or revoked). Run `clausona login <profile>`. |
| `missing` | No credential is stored for the profile. Run `clausona login <profile>`. |
| `cooldown` | The endpoint returned 429. clausona pauses that tool until the window lifts. |
| `error` | Network failure, timeout, or an unreadable response. |

Where numbers are already known, they stay on screen dimmed with their age, rather than
being blanked out.
