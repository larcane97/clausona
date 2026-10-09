# Routing

[← Back to the README](../README.md)

A route lets clausona choose the account for you. You give a group of accounts a name and a
rule, and `clausona run --route <name>` starts Claude Code or Codex on whichever account the rule
picks right now. The pick goes by how much of each account's plan limits is already used.

```bash
clausona route add main                            # every Claude Code account, taking turns
clausona run --route main -- -p "run the tests"
```

```
  ▸ claude:work  route main, next in turn, 34% of 7D used
```

That line goes to stderr. The tool's own output stays on stdout, so you can still pipe it or
redirect it to a file.

`csn` is an alias that clausona's shell hook adds to your interactive shell. A script or an
agent's shell doesn't have it, so this page and every hint clausona prints say `clausona`.

If you would rather see it all on one screen, run `clausona route` with nothing after it. That
opens the [Routes screen](#the-routes-screen), where you can look through your routes and create
or change one in a form.

Routes are made of subscription accounts. In this version an API profile cannot be part of one.

## How an account is picked

Each account gets one number, its usage: the higher of its 5-hour and 7-day windows. An account
at 0% of its 5-hour window and 99% of its week has a usage of 99%. Every rule below looks at that
number and nothing else. A run's note gives it, as in `34% of 7D used`, and so does
`clausona route explain --json`, as `usage`.

clausona then goes through four stages and stops at the first one that finds someone.

1. First the pool: the accounts in `from` whose usage is under `maxUsage`, which is 80% unless
   you change it. The route's strategy picks one of them.
2. If nobody in the pool is under `maxUsage`, the fallback. clausona takes the first account in
   `fallback` that is.
3. If there is still nobody, the account with the most left. Any account of the route, pool or
   fallback, can be picked while its usage is under 100%, and the one with the lowest usage wins,
   at 90% or at 99%.
4. Otherwise nobody is picked, because every account is at 100% or was skipped. clausona lists
   the route's accounts, each with when it resets or why it was skipped, and exits with code 75.
   Nothing is launched.

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
The rest are skipped as "keeps its own sessions", and their quota is not read.

If none of them can take it, run the account that holds the session by name.

## Patterns

`--from`, `--exclude` and `--fallback` take a comma-separated list. An entry is a profile name or
a glob, and an entry with an `@` in it matches account emails instead. Quote the list so the
shell leaves the `*` alone.

| Pattern | Matches |
|---|---|
| `*` | Every subscription account of the route's tool, including ones you add later. On an `all` route, those of both tools |
| `work` | The profile named `work` |
| `team-*`, `claude:team-*` | Profile names. `*` matches any run of characters, `?` matches one |
| `*@example.com` | Account emails |

Matching ignores case. A `claude:` or `codex:` prefix works on names and on email patterns, but
it has to name the route's own tool: `codex:work` in a Claude Code route is refused. On an `all`
route either prefix is fine, and a name without one matches in both tools, so `personal` there
means `claude:personal` and `codex:personal`.

A glob or an email pattern never matches an API profile. Naming one exactly is refused by
`route add` and `route set`, with the command to run it by name instead
(`clausona run claude:gw`), and a run skips one written into `routes.json` by hand. API profiles
are billed per use, and this version keeps them out of routes.

`exclude` applies to `from` and `fallback` alike. An account listed in both `from` and
`fallback` counts as a pool member. So a fallback only helps for accounts the pool leaves out,
and the form on the Routes screen offers only those.

A pattern that looks like an API key or a token is refused, and clausona does not print it back.
Route names get the same check.

## Managing routes

```bash
clausona route add main                                     # every Claude Code account, round-robin, skip at 80%
clausona route add any --tool all                           # Claude Code and Codex accounts in one route
clausona route add work --from '*@example.com' --exclude '*-share'
clausona route add solo --from work --fallback personal --strategy headroom
clausona route set main --exclude personal                  # replace one field
clausona route set solo --add contractor --drop work         # change from one entry at a time
clausona route set solo --no-fallback
clausona route rename work office
clausona route remove office
clausona route edit                                         # routes.json in $VISUAL or $EDITOR
clausona route list                                         # every route, how many are free, who is next
clausona route                                              # the Routes screen, in a terminal
```

A route name starts with a letter or a digit, and the rest is letters, digits, `.`, `_` and `-`.

The subcommands ask nothing. The one exception is `route edit`, which offers to open the file
again when what you saved has a problem.

### Which tool a route is for

A route is for Claude Code, for Codex, or for both. `route add` takes it from `--tool claude`,
`--tool codex` or `--tool all`. Without `--tool` it makes a Claude Code route.

The prefixes in `--from` can stand in for `--tool`. When every entry starts with `codex:`, as in
`--from 'codex:team,codex:personal'`, the route is for Codex. Entries with both prefixes make an
`all` route. If any entry has no prefix, the default holds.

An `all` route ranks the accounts of both tools together, by the same usage number, so a run on
it can land on either tool. [Running on an all route](#running-on-an-all-route) covers what that
means for the arguments you pass.

`route set` keeps the route's tool. To change it, use the Routes screen or `route edit`.

On a machine with only Codex accounts, `clausona route add main` still makes a Claude Code route,
and that route takes nobody. `route add` says so, and gives the commands that make it a Codex
route instead.

### What `route add` shows

`route add` writes the route straight away, then shows what it made: the settings in a box, and
every account in the route with its usage now.

```
$ clausona route add work --from '*@work.example' --exclude '*-share'
  ✔ Created route work

  ╭─ work ───────────────────────────────────────────────────────────╮
  │                                                                  │
  │  Tool       claude                                               │
  │  Strategy   round-robin (next in turn)                           │
  │  Limits     skip at 80%; if all are, the one with the most left  │
  │  Accounts   *@work.example except *-share                        │
  │  Fallback   none                                                 │
  │                                                                  │
  ╰──────────────────────────────────────────────────────────────────╯

    ACCOUNT            5H        7D       LAST PICKED
    ─────────────────────────────────────────────────
  ▸ claude:work       12% 3h    34% 4d    never        picked next
    claude:team        5% 1h    22% 3d    11h ago
    claude:ops-share  excluded by *-share

    Run on it: clausona run --route work
```

The table is the one `route explain` prints, described in
[Seeing the ranking](#seeing-the-ranking).

To look before you create, rank the route without saving it:
`clausona route explain --tool claude --from '*@work.example' --exclude '*-share'` prints the same
box and table, titled `inline route`, and writes nothing.

Earlier versions asked before creating a route in a terminal, and `--yes` (or `-y`) skipped the
question. The question is gone. `--yes` is still accepted, so scripts that pass it keep working,
and it changes nothing.

### Listing them

```
$ clausona route list

    ROUTE  TOOL            STRATEGY     SKIP AT  FREE NOW  NEXT
    ──────────────────────────────────────────────────────────────────────────────
    any    claude + codex  round-robin  80%      5 of 8    codex:team
    busy   claude          round-robin  80%      0 of 2    none, soonest in 1h 15m
    main   claude          round-robin  80%      2 of 5    claude:work
    solo   claude          headroom     80%      2 of 2    claude:work
```

`SKIP AT` is the cut. `FREE NOW` counts the accounts under the cut right now, out of every
account in the route. One that is signed out still counts as a member, just not as free. `NEXT`
is the account a run would get now. When nobody can be picked it says `none`, and when the first
account frees up.

`route list` records nothing. With `--no-quota` it reads no quota at all, and `FREE NOW` and
`NEXT` show `—`. They show the same dash when no reading could be had for any account of a route,
which is what happens offline.

On a narrow terminal the table drops columns rather than wrap a row: `TOOL` goes first, then
`SKIP AT`, then `STRATEGY`.

### Changing one

`route set` changes only the fields you pass, and each field option replaces its field.
`--exclude old` makes the exclude list just `old`, whatever it held before. `--from` replaces
the whole pool list. This is an edit of the saved route. A run's `--exclude` works differently
and adds to the list (see [Running on a route](#running-on-a-route)).

`--add` and `--drop` change `from` one entry at a time instead. `--drop` removes an entry that is
in `from` itself, so it cannot take one account out of `*` or `*@example.com`. Use `--exclude`
for that. A route needs at least one entry in `from`, so dropping the last one is refused unless
`--add` puts another in. `--no-fallback` removes the fallback list.

Like `add`, `route set` prints the route as it stands after the change.

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
      "maxUsage": 80
    }
  }
}
```

| Field | Default | Allowed |
|---|---|---|
| `tool` | required | `"claude"`, `"codex"` or `"all"` (both) |
| `from` | `["*"]` | a non-empty list of patterns |
| `exclude` | `[]` | a list of patterns |
| `strategy` | `"round-robin"` | `"round-robin"`, `"headroom"` or `"expiring"` |
| `maxUsage` | `80` | a number from 1 to 100 |
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
both `route list` and `route explain` point it out. They point out patterns that match nobody
too. `route list` puts both under its table:

```
  ⚠ ghost names 'gone', which is not a registered profile.
  ⚠ ghost: 'x-*' matches nobody.
```

## The Routes screen

In a terminal, `clausona route` with no arguments opens the dashboard's Routes screen. You can
also get there from the dashboard itself (`clausona`), where Routes is the item under Profiles.
Without a terminal, in a script or an agent's shell, `clausona route` prints the help instead.

The screen lists your routes on the left. Each line has the route's name, its tool, and how many
of its accounts are free now, as in `2/5`. On the right is the route under the cursor: its
settings, then every account with gauges for its 5H and 7D windows, the one a run would get
next, and why any other is held back. On a terminal under 100 columns the detail sits under the
list instead.

| Key | Does |
|---|---|
| `↑` `↓` | Move between routes |
| `n` | Open the form for a new route |
| `e` | Open the form on the selected route |
| `d` | Remove the selected route, once you answer `y` |
| `r` | Read the quota again |
| `esc` | Back to the dashboard, or out if you came in with `clausona route` |

The screen never records a pick. It writes `routes.json` only when you remove a route or save one
from the form. If the file cannot be used, the screen says what is wrong with it and points you
to `clausona route edit`.

### The form

`n` and `e` open the same form. It holds everything `route add` and `route set` can set.

| Field | What it holds |
|---|---|
| Name | The route's name. Changing it on an existing route renames the route |
| Tool | `claude`, `codex` or `claude + codex`, chosen with `←` `→` |
| Accounts | A row for every account (`*`), then a row per subscription account of the tool (of both, for `claude + codex`) with its 5H and 7D usage. `space` ticks and unticks |
| Patterns | More `from` and `exclude` patterns, such as `team-*` or `*@example.com` |
| Strategy | `round-robin`, `headroom` or `expiring`, chosen with `←` `→` |
| Limits | `skip at` is the cut. Left blank, the default applies. The line under it says what is picked when every account is at the cut |
| Fallback | Accounts tried in order when nobody in the pool is under the cut. `a` adds one, `x` removes it, `[` and `]` move it |

The ticks become the route's lists. With the `every account (*)` row ticked, `from` is `*`, and
each account you untick goes into the exclude list. An account you add later joins the route.
With that row unticked, `from` is the accounts you ticked, in the order you ticked them, and an
account you add later stays out.

Under the form, a `Now:` line says how many accounts are under the cut and who would be picked
next, for the route as the form holds it. The hints along the bottom change with the field you
are in.

`tab` moves to the next field and `shift+tab` back. `enter` saves from any field. `esc` leaves,
and if you changed something it asks first whether to throw the changes away.

A save goes through the same checks as `route add` and `route set`, so whatever they refuse is
refused here too. The field turns red, and the problem is listed under the form.

Another terminal may change `routes.json` while the form is open. A change to other routes is
kept, and the save goes ahead with what you typed. A change to the route you are editing is not
written over: the form reloads that route and says so, and you can look it over before you save
again. If that route was removed, the form says so and keeps what you typed. Press `enter` again
to save it back, or `esc` to leave it removed.

## Running on a route

```bash
clausona run --route main -- -p "run the tests"
clausona run --route main --strategy headroom -- -p "a long refactor"   # for this run only
clausona run claude --from 'team-*' --max-usage 90 -- -p "quick question"  # an unsaved route
clausona run codex --route any -- exec "review this"   # only the Codex accounts of an all route
clausona run claude -- -p "hi"            # no route: the active profile, as plain claude would
clausona run claude:team -- -p "hi"       # one account by name, whatever its quota
```

Routing options go before the tool's own arguments. The first argument that is not one of them
ends them, and so does a `--`, which is dropped. Everything after goes to the tool untouched. In
`clausona run --route main -p hi --strategy headroom`, Claude Code gets the `--strategy`.

You can name the tool too, as in `clausona run claude --route main`. A route saved for the other
tool is then refused. On an `all` route the tool word narrows the run instead (see
[Running on an all route](#running-on-an-all-route)).

`--strategy`, `--max-usage` and `--fallback` replace their field for one run. So does `--from`
next to `--route`.

`--exclude` adds to the route's own exclude list instead of replacing it. On a route that
excludes `*-share`, `--exclude old` leaves out `old` and the share accounts both. None of these
options is saved.

`--from` without `--route` makes an unsaved route, which the note calls an "inline route". Its
tool is the one you name, as in `clausona run codex --from …`. Without a tool word it goes by the
prefixes, as `route add` does, and otherwise it is a Claude Code route.

The field options need `--route` or `--from` to work on. On their own they are refused, so a
run never lands on an account you meant to exclude:

```
  ✘ --exclude needs --route <name> or --from <patterns>.
```

With no routing options at all, `clausona run claude` and `clausona run codex` run that tool's
active profile, and say so on stderr:

```
  ▸ claude:personal  active profile (no route)
```

If you have a profile named `claude` or `codex`, `clausona run claude` runs that profile.

A profile and routing options do not go together. In `clausona run --route main claude:work` the
tool would get `claude:work` as its prompt and start on some other account, so clausona stops
instead:

```
  ✘ Routing options cannot be combined with a profile. Run it by name: clausona run <profile> …, or put it after -- to pass it to the tool.
```

To run that account, name it alone: `clausona run claude:work`. After a `--` the name is the
tool's, like any other argument.

A first argument that is neither a profile nor a tool, such as a prompt typed without the tool,
is refused with the fix:

```
  ✘ 'fix the bug' is not a profile or a tool. To pass a prompt, name the tool: clausona run claude 'fix the bug'
```

### Running on an all route

```bash
clausona run --route any                                # interactive, in the picked account's tool
clausona run codex --route any -- exec "review this"
clausona run claude --route any -- -p "run the tests"
```

An `all` route holds accounts of both tools, so a pick can land on either one. With no arguments
for the tool that is fine. `clausona run --route any` starts an interactive session in whichever
tool the picked account belongs to.

Arguments are another matter, because Claude Code and Codex do not take the same ones. A run
with arguments has to say which tool they are for. Name the tool before `--route`, and only that
tool's accounts are ranked. Without it, clausona stops before it picks anything:

```
  ✘ Route any has claude and codex accounts. Say which tool these arguments are for: clausona run claude --route any … (or codex).
```

`route explain` and `route pick` narrow an `all` route the same way with `--tool`:
`clausona route pick any --tool claude` takes a turn among the Claude Code accounts only.

### A route that does not exist

In a terminal, an unknown `--route` offers to create the route. clausona says in a sentence what
the new route would take, lists those accounts with their usage now, and asks once:

```
$ clausona run --route nightly --exclude '*-share' -- -p "run the tests"

  Route nightly does not exist yet. It would take every claude account
  except *-share, taking turns and skipping any at 80% or more:

    claude:team 22%   claude:work 34%   claude:side 88% (over)   claude:personal 96% (over)
    claude:old (signed out)

  Create it and run? (Y/n)
```

Enter or `y` saves the route and starts the run on it. `n` creates nothing, runs nothing and
exits 1. The routing options you gave go into the new route. Its tool is the one you named, as
in `clausona run codex --route nightly`, else the one the `--from` prefixes say, else Claude
Code. Apart from `route edit` after a bad save, this is the only question the routing commands
ask.

A route that would take no account is not offered, since a run on it could only exit 75.
clausona asks nothing, creates nothing and exits 1. If the other tool has accounts the same
patterns would take, it names that run, such as `clausona run codex --route nightly`. Otherwise
it points you to `clausona list`.

Without a terminal nothing is created. clausona prints the command that would create it and
exits 1:

```
  ✘ Route 'nightly' does not exist. Existing routes: any, busy, main, solo. Create it: clausona route add nightly
```

### When nobody is free

```
$ clausona run --route busy -- -p "run the tests"
  ✘ No account in route busy is free right now.

    ACCOUNT            5H         7D       FREE AGAIN
    ────────────────────────────────────────────────────────────
    claude:personal  100% 1h     81% 2d    in 1h 15m (5H resets)   soonest
    claude:side      100% 1h     40% 3d    in 1h 57m (5H resets)

    Run again after 1h 15m, or see everything with: clausona route explain busy
```

The run exits with code 75 and launches nothing. That happens only when every account is at
100% of a window or is skipped. `FREE AGAIN` is when the account can run again, once every
window at 100% has reset, and the column says which one is last. An account that is skipped,
such as a signed-out one, is listed under the others with the reason. When every account is
skipped, no reset will help, and the last line says to look at those reasons instead.

On an `all` route narrowed to one tool, the message is about that tool's accounts only, as in
"No claude account in route any is free right now."

## Seeing the ranking

```
$ clausona route explain main

  ╭─ main ───────────────────────────────────────────────────────────╮
  │                                                                  │
  │  Tool       claude                                               │
  │  Strategy   round-robin (next in turn)                           │
  │  Limits     skip at 80%; if all are, the one with the most left  │
  │  Accounts   * except *-share                                     │
  │  Fallback   none                                                 │
  │                                                                  │
  ╰──────────────────────────────────────────────────────────────────╯

    ACCOUNT            5H        7D       LAST PICKED
    ─────────────────────────────────────────────────
  ▸ claude:work       12% 3h    34% 4d    never        picked next
    claude:team        5% 1h    22% 3d    11h ago
    claude:side       88% 1h    40% 3d                 over 80%
    claude:personal   96% 1h    81% 2d                 over 80%
    claude:old        —         —                      signed out (clausona login claude:old)
    claude:ops-share  excluded by *-share
```

The box is the route with every default filled in. Under it comes every account, with its 5H
and 7D use and the time until each resets. The `▸` and "picked next" mark the account a run
would get now. "over 80%" is an account at or above the cut, and a skipped account says why in
grey. At the bottom are the entries nothing was ranked for, such as an account the exclude list
took out or a name that is not registered. `LAST PICKED` appears on round-robin routes, the one
strategy that reads it.

`explain` launches nothing and records nothing. It exits 0 even when nobody could be picked, and
says so under the table:

```
  Nobody can be picked now; clausona run --route busy would exit 75.
```

It takes the same field options as a run. `--resume` ranks the route as a resumed run would, and
`--tool` narrows an `all` route to one tool's accounts. A route that is not saved is ranked with
`clausona route explain --tool claude --from '<patterns>'`.

Fallback members are marked `(fallback)`. A pick from the fallback says so, in the table and in
the run's note. Here `solo`'s cut is lowered for one look, so its only pool member is over it:

```
$ clausona route explain solo --max-usage 30
  …
    ACCOUNT                  5H        7D
    ──────────────────────────────────────────
  ▸ claude:team (fallback)   5% 1h    22% 3d    picked: fallback
    claude:work             12% 3h    34% 4d    over 30%
```

```
$ clausona run --route solo --max-usage 30 -- -p "run the tests"
  ▸ claude:team  route solo, fallback, 22% of 7D used
```

When every account is at the cut or over it, the one with the most left is picked, and that says
so too:

```
$ clausona route explain main
  …
    ACCOUNT            5H        7D       LAST PICKED
    ─────────────────────────────────────────────────
  ▸ claude:team       85% 1h    22% 3d    never        picked: most room left (all over 80%)
    claude:side       88% 1h    40% 3d                 over 80%
    claude:work       12% 3h    91% 4d                 over 80%
```

```
$ clausona run --route main -- -p "run the tests"
  ▸ claude:team  route main, most room left (all over 80%), 85% of 5H used
```

## For scripts and agents

A Claude Code or Codex session can drive routing for you. `clausona route --help` is written for
it, so have it read that first.

The Routes screen is for people. An agent's shell has no terminal, so `clausona route` with no
arguments only prints the help there, and the agent works with the subcommands below.

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

On an `all` route a pick can come back as an account of either tool, and `clausona run "$id"`
starts the right one. When the worker's arguments are for one tool, pick with `--tool`:
`clausona route pick any --tool codex`.

Create and change routes with `route add`, `route set` and `route remove` rather than by writing
`routes.json`. These never ask, in a terminal or not, so an agent creating a route for you should
first show you its accounts and wait for your OK. It can rank the route without saving it, with
`clausona route explain --tool claude --from '<patterns>'`.

Without a terminal an unknown `--route` creates nothing.

### `pick --json`

```json
{
  "profile": "claude:work",
  "route": "main",
  "stage": "pool",
  "usage": { "percent": 34, "window": "7D", "stale": false },
  "reason": "next in turn"
}
```

`stage` is `pool`, `fallback` or `reserve`. `reserve` is the third stage: every account was at the
cut or over it, and the one with the most left was picked. `route` is null for an unsaved route.

When nobody can be picked, the JSON is still printed on stdout, and the exit code is 75:

```json
{
  "profile": null,
  "route": "busy",
  "stage": null,
  "usage": null,
  "reason": "no account is available",
  "soonest": { "id": "claude:personal", "at": "2026-10-09T16:58:18.767Z" }
}
```

`soonest` is null when no reset time is known.

### `explain --json`

| Field | Value |
|---|---|
| `route` | The route's name, or null for an unsaved route |
| `resolvedBy` | `"flag"` for a saved route, `"inline"` for one made from `--from` |
| `settings` | The route with every default filled in: `tool`, `from`, `exclude`, `strategy`, `maxUsage`, `fallback`. `tool` is `"claude"`, `"codex"` or `"all"` |
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

An account picked at the `reserve` stage has the status `picked`, even though its usage is at or
over `maxUsage`. Percentages are not rounded in JSON. Fields are only ever added.

`route list --json` gives `{ "routes": [...] }`. Each entry has `name`, `route` (the settings
with defaults, where `tool` can be `"all"` too), `members` and `fallbackMembers` (profile ids,
after the exclude list), `excluded`, `unknownNames` and `emptyPatterns`.

### Exit codes

| Code | Meaning |
|---|---|
| the tool's own | The tool ran. |
| 1 | A usage error, an unknown route without a terminal (or answered `n` in one), or a `routes.json` that cannot be used. |
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
