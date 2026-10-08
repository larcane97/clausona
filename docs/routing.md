# Routing

[← Back to the README](../README.md)

A route lets clausona choose the account for you. You give a group of accounts a name and a
rule, and `clausona run --route <name>` starts Claude Code or Codex on whichever account the rule
picks right now. The pick goes by how much of each account's plan limits is already used.

```bash
clausona route add main                            # every account, taking turns
clausona run --route main -- -p "run the tests"
```

```
→ claude:team · route main · usage 40% (5H) · round-robin
```

That line goes to stderr. The tool's own output stays on stdout, so you can still pipe it or
redirect it to a file. (`csn` works everywhere `clausona` does.)

Routes are made of subscription accounts. In this version an API profile cannot be part of one.

## How an account is picked

Each account gets one number, its usage: the higher of its 5-hour and 7-day windows. An account
at 0% of its 5-hour window and 99% of its week has a usage of 99%. Every rule below looks at that
number and nothing else, and it is the number `clausona route explain` shows.

clausona then goes through four stages and stops at the first one that finds someone.

1. First the pool: the accounts in `from` whose usage is under `maxUsage`, which is 80% unless
   you change it. The route's strategy picks one of them.
2. If nobody in the pool is under `maxUsage`, the fallback. clausona takes the first account in
   `fallback` that is.
3. If there is still nobody, the reserve. Any account of the route, pool or fallback, can be
   picked while its usage is under `reserveUsage` (95% unless you change it), and the one with
   the lowest usage wins. This is the last stretch that the 80% cut held back.
4. Otherwise nobody is picked. clausona lists the route's accounts, each with when it resets or
   why it was skipped, and exits with code 75. Nothing is launched.

An account that is signed out, or whose sign-in has expired, is skipped at every stage. So is one
whose quota could not be read. `clausona route explain` gives the reason for each.

Readings come from the same 5-minute cache that `clausona list` uses, and a lapsed token is
renewed the same way. When a new reading fails, the last numbers are used for up to an hour and
marked stale. After that the account is skipped. An account the route excludes is not read at
all.

### Strategies

The strategy only decides among pool members under the cut.

| Strategy | Picks | Good for |
|---|---|---|
| `round-robin` (default) | The account picked longest ago. One never picked goes first; a tie goes to the lower usage. | Spreading work evenly, and several runs at once |
| `headroom` | The lowest usage. | One run at a time, always on the account with the most room |
| `expiring` | Among accounts whose weekly limit resets within 24 hours, the lowest usage. With none, the same as `headroom`. | Spending weekly quota before it resets unused |

Round-robin keeps one record, `~/.clausona/route-picks.json`, with the time each account was
last picked. The time belongs to the account, not to a route. A pick on one route counts as that
account's turn on every route it is in.

Picks are made under a lock, and each one sees the picks before it. Start
`clausona run --route main` in four terminals at the same moment and they land on four
different accounts, as long as four are under the cut. If the lock stays busy for more than
2 seconds, the run goes ahead without recording its pick.

### Resumed sessions

Some runs carry on a session that lives in one account's history: `claude -c` or `--continue`,
`claude -r` or `--resume`, `claude --from-pr`, and `codex resume` or `codex fork` (under
`codex exec` too). For Codex, any argument that is exactly `resume` or `fork` counts.

A routed run like that uses only the accounts that see shared history. Those are the primary
account and the profiles with merged sessions (`clausona config <profile> --merge-sessions`).
The rest are skipped as "keeps its own sessions".

If none of them can take it, run the account that holds the session by name.

## Patterns

`--from`, `--exclude` and `--fallback` take a comma-separated list. An entry is a profile name or
a glob, and an entry with an `@` in it matches account emails instead. Quote the list so the
shell leaves the `*` alone.

| Pattern | Matches |
|---|---|
| `*` | Every subscription account of the route's tool, including ones you add later |
| `work` | The profile named `work` |
| `team-*`, `claude:team-*` | Profile names. `*` matches any run of characters, `?` matches one |
| `*@example.com` | Account emails |

Matching ignores case. A `claude:` or `codex:` prefix works on names and on email patterns, but
it has to name the route's own tool: `codex:work` in a Claude Code route is refused.

A glob or an email pattern never matches an API profile. Naming one exactly is refused by
`route add` and `route set`, with the command to run it by name instead
(`clausona run claude:gw`), and a run skips one written into `routes.json` by hand. API profiles
are billed per use, and this version keeps them out of routes.

`exclude` applies to `from` and `fallback` alike. An account listed in both `from` and
`fallback` counts as a pool member.

A pattern that looks like an API key or a token is refused, and clausona does not print it back.
Route names get the same check.

## Managing routes

```bash
clausona route add main                                     # every account, round-robin, 80% / 95%
clausona route add work --from '*@example.com' --exclude '*-share'
clausona route add solo --from work --fallback personal --strategy headroom
clausona route set main --exclude personal                  # replace one field
clausona route set solo --add contractor --drop work         # change from one entry at a time
clausona route set solo --no-fallback
clausona route rename work office
clausona route remove office
clausona route edit                                         # routes.json in $VISUAL or $EDITOR
clausona route list                                         # every route and its members
```

A route name starts with a letter or a digit, and the rest is letters, digits, `.`, `_` and `-`.

Each route is for one tool. `route add` takes it from `--tool claude` or `--tool codex`, or from
a prefix that every `--from` entry shares. If only one tool has subscription accounts, it uses
that one. Otherwise it asks in a terminal, and without a terminal it stops and asks for `--tool`.

### Creating one in a terminal

In a terminal, `route add` shows the accounts the route would use before it writes anything:

```
Create 'main' now?
  pool      * · 3 account(s) can be used now
            claude:old, claude:team, claude:work
            claude:personal (signed out (clausona login claude:personal))
  strategy  round-robin · max 80% · reserve 95%
[Y]es · [e]dit · [n]o
```

Enter or `y` creates it, and `n` leaves everything as it was.

`e` lists every subscription account of the tool with a number. Type numbers to tick or untick
accounts and press Enter when the list is right. Then name a strategy, or press Enter to keep
the one shown. The screen comes back with your changes.

Unticking an account makes the route's `from` the names you kept and drops its exclude list, so
an account you add later will not be in the route. If you leave the list as it was, the patterns
stay. A `*` route with every account ticked keeps `*` and drops its exclude list.

`--yes` (or `-y`) skips the question. Without a terminal, in a script or an agent's shell,
nothing is asked and the route is created as given.

### Changing one

`route set` changes only the fields you pass, and each field option replaces its field.
`--exclude old` makes the exclude list just `old`, whatever it held before. `--from` replaces
the whole pool list.

`--add` and `--drop` change `from` one entry at a time instead. `--drop` removes an entry that is
in `from` itself, so it cannot take one account out of `*` or `*@example.com`. Use `--exclude`
for that. `--no-fallback` removes the fallback list.

`route rename` and `route remove` act straight away. Neither one asks first.

### The file

Routes live in `~/.clausona/routes.json`:

```json
{
  "version": 1,
  "routes": {
    "main": {
      "tool": "claude",
      "from": ["*"],
      "exclude": ["personal"],
      "strategy": "round-robin",
      "maxUsage": 80,
      "reserveUsage": 95
    }
  }
}
```

| Field | Default | Allowed |
|---|---|---|
| `tool` | required | `"claude"` or `"codex"` |
| `from` | `["*"]` | a non-empty list of patterns |
| `exclude` | `[]` | a list of patterns |
| `strategy` | `"round-robin"` | `"round-robin"`, `"headroom"` or `"expiring"` |
| `maxUsage` | `80` | a number from 1 to 100 |
| `reserveUsage` | `95`, or `maxUsage` if that is higher | a number from `maxUsage` to 100 |
| `fallback` | `[]` | a list of patterns |

Any other key in a route is refused.

`route edit` opens the file in `$VISUAL` or `$EDITOR`, or an empty one when there is no file yet.
It checks the file when you save. A file with a problem is not written, and in a terminal you are
asked whether to edit again. If you save without changing anything, it says "Nothing was
changed." If `routes.json` changed while you were editing, your edit is not saved and you are
told to run `route edit` again.

When `routes.json` cannot be used, every command that reads it stops with exit code 1 and lists
what is wrong. That includes `clausona run claude` with no route named. `clausona run <profile>`
does not read the file.

Removing a profile leaves its routes alone. A name that is no longer registered is skipped, and
both `route list` and `route explain` point it out. `route list` also warns about patterns that
match nobody.

## Running on a route

```bash
clausona run --route main -- -p "run the tests"
clausona run --route main --strategy headroom -- -p "a long refactor"   # for this run only
clausona run claude --from 'team-*' --max-usage 90 -- -p "quick question"  # an unsaved route
clausona run claude -- -p "hi"            # no route: the active profile, as plain claude would
clausona run claude:team -- -p "hi"       # one account by name, whatever its quota
```

Routing options go before the tool's own arguments. The first argument that is not one of them
ends them, and so does a `--`, which is dropped. Everything after goes to the tool untouched. In
`clausona run --route main -p hi --strategy headroom`, Claude Code gets the `--strategy`.

You can name the tool too, as in `clausona run claude --route main`. A route saved for the other
tool is then refused.

`--exclude`, `--strategy`, `--max-usage`, `--reserve-usage` and `--fallback` change the route for
one run and are not saved. So does `--from` next to `--route`. If `--max-usage` goes above the
route's reserve, the reserve moves up with it for that run.

`--from` without `--route` makes an unsaved route, which the note calls an "inline route". It
needs to know its tool, so write `clausona run claude --from …` or put a `claude:` or `codex:`
prefix on every entry.

The field options need `--route` or `--from` to work on. On their own they are refused, so a
run never lands on an account you meant to exclude:

```
  ✘ --exclude needs --route <name> or --from <patterns>.
```

With no routing options at all, `clausona run claude` and `clausona run codex` run that tool's
active profile, and say so on stderr:

```
→ claude:work · active profile (no route)
```

If you have a profile named `claude` or `codex`, `clausona run claude` runs that profile.

### A route that does not exist

In a terminal, an unknown `--route` offers to create the route. You get the same screen as
`route add`, ending in `[Y]es and run`, and the routing options you gave go into the new route.
If clausona cannot tell which tool it is for, it asks first. Answer yes and the run starts on it.

Without a terminal nothing is created. clausona prints the command that would create it and
exits 1:

```
  ✘ Route 'nightly' does not exist. Existing routes: main. Create it: clausona route add nightly
```

### When nobody is free

```
  ✘ No account is available for route busy.
    claude:old       99% 7D, resets in 19h 59m   ← soonest
    claude:personal  signed out (clausona login claude:personal)
  Retry later, or name a profile: clausona run claude:old
```

The run exits with code 75 and launches nothing. The reset time is when the account drops back
under the route's reserve.

## Seeing the ranking

```
$ clausona route explain main
route main (claude · round-robin · max 80% · reserve 95%)
    PROFILE            5H    7D  USAGE            LAST PICKED
    claude:old         0%   99%  99% 7D           1d ago       at or above 80%
    claude:personal     —     —  —                —            skipped: signed out (clausona login claude:personal)
  → claude:team       40%   30%  40% 5H           never        picked: next in turn
    claude:work       20%   70%  70% 7D           3m ago
```

The arrow marks the account a run would get now. `explain` launches nothing and records
nothing. It exits 0 even when nobody could be picked, and says so under the table.

It takes the same field options as a run. `--resume` ranks the route as a resumed run would, and
`clausona route explain --tool claude --from '<patterns>'` ranks a route that is not saved.

Fallback members are marked `(fallback)` in the table. A run that picks at the fallback or
reserve stage says so in its note:

```
→ claude:team · route solo (fallback) · usage 40% (5H) · every pool member at or above 80%
```

## For scripts and agents

A Claude Code or Codex session can drive routing for you. `clausona route --help` is written for
it, so have it read that first.

```bash
clausona route list --json                 # every route and its members
clausona route explain main --json         # the state of every member; records nothing
id=$(clausona route pick main)             # take a turn and record it
clausona run "$id" -- -p "run the tests"   # start the tool on that account
```

`route pick` prints the picked profile id on stdout and nothing else. It records the pick the way
a run does. To start several workers, call `pick` once per worker on a round-robin route, and
each call takes the next account. On a `headroom` or `expiring` route, picks made close together
land on the same account, because their readings are cached for 5 minutes.

Create and change routes with `route add`, `route set` and `route remove` rather than by writing
`routes.json`. An agent creating a route for you should show you its accounts first:
`clausona route explain --tool claude --from '<patterns>'` ranks a route without saving it.

Without a terminal, `route add` never asks, and an unknown `--route` creates nothing.

### `pick --json`

```json
{
  "profile": "claude:team",
  "route": "main",
  "stage": "pool",
  "usage": { "percent": 40, "window": "5H", "stale": false },
  "reason": "next in turn"
}
```

`stage` is `pool`, `fallback` or `reserve`. `route` is null for an unsaved route.

When nobody can be picked, the JSON is still printed on stdout, and the exit code is 75:

```json
{
  "profile": null,
  "route": "busy",
  "stage": null,
  "usage": null,
  "reason": "no account is available",
  "soonest": { "id": "claude:old", "at": "2026-10-09T14:25:27.529Z" }
}
```

`soonest` is null when no reset time is known.

### `explain --json`

| Field | Value |
|---|---|
| `route` | The route's name, or null for an unsaved route |
| `resolvedBy` | `"flag"` for a saved route, `"inline"` for one made from `--from` |
| `settings` | The route with every default filled in: `tool`, `from`, `exclude`, `strategy`, `maxUsage`, `reserveUsage`, `fallback` |
| `outcome` | `{ "kind": "picked", "id", "stage", "reason" }`, or `{ "kind": "none" }` plus `soonest` (`{ "id", "at" }`) when a reset time is known |
| `members` | One entry per account, below |
| `excluded` | Accounts the exclude list took out, as `{ "profile", "matchedBy" }` |
| `emptyPatterns` | Glob and email patterns in `from` or `fallback` that match nobody |

Each entry in `members`:

| Field | Value |
|---|---|
| `profile` | The profile id, such as `claude:team` |
| `role` | `"pool"` or `"fallback"` |
| `matchedBy` | The pattern that brought it in |
| `status` | `"picked"`, `"eligible"` (under the cut, not picked), `"over-limit"` (at or above `maxUsage`, not picked) or `"skipped"` |
| `skipReason` | null, or one of `"signed-out"`, `"expired"`, `"no-reading"`, `"not-registered"`, `"keeps-own-sessions"` (a resumed run), `"api-not-supported"` |
| `usage` | `{ "percent", "window", "stale" }` with `window` `"5H"` or `"7D"`, or null |
| `fiveHour`, `sevenDay` | `{ "usedPercent", "resetsAt" }` with `resetsAt` an ISO time or null, or null |
| `lastPickedAt` | The ISO time of the last pick, or null |

An account picked at the reserve stage has the status `picked`, even though its usage is over
`maxUsage`. Percentages are not rounded in JSON. Fields are only ever added.

`route list --json` gives `{ "routes": [...] }`. Each entry has `name`, `route` (the settings
with defaults), `members` and `fallbackMembers` (profile ids, after the exclude list),
`excluded`, `unknownNames` and `emptyPatterns`.

### Exit codes

| Code | Meaning |
|---|---|
| the tool's own | The tool ran. |
| 1 | A usage error, an unknown route without a terminal, or a `routes.json` that cannot be used. |
| 75 | No account is available now, from `run` or `pick`. Retry later, or name a profile. |

### The routing skill

The clausona plugin for Claude Code has a `routing` skill that teaches a session all of this.
clausona shares plugins across profiles, so one install reaches every account:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install clausona@clausona
```

For Codex, copy `plugins/clausona/skills/routing/SKILL.md` from this repository into
`~/.agents/skills/clausona-routing/`.
