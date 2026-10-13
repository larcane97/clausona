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

You can also leave out `--route` and let the directory decide. A
[dir rule](#dir-rules-and-defaults) gives a directory a route, and a default covers everywhere
else, so a plain `clausona run claude` lands on a route too.

If you would rather see it all on one screen, run `clausona route` with nothing after it. That
opens the [Routes screen](#the-routes-screen), where you can look through your routes and create
or change one in a form.

Routes are made of subscription accounts. An API profile can join one too, by its exact name,
once it has a spend limit: see [API profiles in routes](#api-profiles-in-routes).

## How an account is picked

Each account gets one number, its usage: the higher of its 5-hour and 7-day windows. An account
at 0% of its 5-hour window and 99% of its week has a usage of 99%. Every rule below looks at that
number and nothing else. A run's note gives it, as in `34% of 7D used`, and so does
`clausona route explain --json`, as `usage`. An API profile's usage is its spend as a share of
its limit, and goes through the same stages.

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
   Nothing is launched. With `--wait` it waits for the soonest reset instead, and starts again
   at stage 1 (see [Waiting for an account](#waiting-for-an-account)).

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

An older reading can carry a weekly reset time that has already passed. `expiring` counts that
account too, since its week is over, and the run's note says `weekly limit has reset` instead of
`weekly limit resets within 24h`.

Round-robin keeps one record, `~/.clausona/route-picks.json`, with the time each account was
last picked. The time belongs to the account, not to a route. A pick on one route counts as that
account's turn on every route it is in. A profile you remove drops out of the record at the next
pick. A record written by a newer clausona is left alone: picks go on, but are not recorded until
you update.

Picks are made under a lock, and each one sees the picks before it. Start
`clausona run --route main` in four terminals at the same moment and they land on four
different accounts, as long as four are under the cut. If the lock stays busy for more than
2 seconds, the run goes ahead without recording its pick.

### Limits on one model

Some plans also have a limit on one model, such as Claude's weekly limit on Opus, or Codex's on
GPT-5.3-Codex-Spark. When the tool's arguments name a model, the account's limit on that model
counts too, and the usage is the highest of them all:

```bash
clausona run --route main -- --model opus -p "plan the migration"
clausona run codex --route cx -- exec -m gpt-5.3-codex-spark "fix the lint"
```

```
  ▸ claude:work  route main, next in turn, 40% of 7D used
```

Here `claude:team` is at 10% of its 5 hours and 20% of its week, but its Opus limit is at 95%,
over the cut, so an Opus run goes to another account. A run that names no model can still
take `claude:team`. When the model's limit is the highest of an account's windows, the note
says so, as in `62% of the Opus limit used`.

A Codex limit on a model can have two windows, like the account's own: 5 hours and a week.
Either can run out first, so the higher of the two counts, as with the account's 5H and 7D. The
note names the window, as in `62% of the GPT-5.3-Codex-Spark 7D limit used`, and so does the
model's column in `route explain` and on the Routes screen. Claude's model limits are all weekly
and are named without one.

clausona reads the model from `--model` for Claude Code, and from `-m` or `--model` for Codex,
also after a subcommand such as `exec`. It stops reading at a `--`, and hands the arguments to
the tool as they were. A model falls under a limit when the limit's name is a word of the
model's name, in any case. `opus`, `claude-opus-4-5` and `opus[1m]` fall under Opus, and
`gpt-5.3-codex-spark` under GPT-5.3-Codex-Spark. A version number is one word, so
`gpt-5.3-codex` does not fall under GPT-5.3-Codex-Spark, and nor does a short name the limit
does not spell out, such as `codex-spark`.

A hyphen ends a word, though, so a limit whose name is the start of a longer model name counts
for that model too. A limit named GPT-5.3-Codex would also count for `gpt-5.3-codex-spark` runs,
which in Codex's naming is another model. No such limit is reported today, and the extra match
errs on the side of caution: it can only make an account look fuller than it is.

A run that names no model counts no model's limit, even when the account's default model is
the one with the tight limit. clausona does not read a profile's settings to find its default
model. It does not read Codex's `-c model=…` or a Codex config profile (`-p`) either, and
`opusplan`, which runs Opus only while planning, falls under no limit. If you mostly run a
model that has its own limit, name it in the run.

`route explain --model <name>` and `route pick --model <name>` rank the way a run of that model
does. So does the [Routes screen](#the-routes-screen), once `m` picks the model.

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

A glob or an email pattern never matches an API profile, so `*` is never one. An API profile is
billed per use, and joins a route only by its exact name, once it has a spend limit. See
[API profiles in routes](#api-profiles-in-routes).

`exclude` applies to `from` and `fallback` alike. An account listed in both `from` and
`fallback` counts as a pool member. So a fallback only helps for accounts the pool leaves out,
and the form on the Routes screen offers only those.

A pattern that looks like an API key or a token is refused, and clausona does not print it back.
Route names get the same check. The one exception is the exact name of a profile you registered,
with or without its tool prefix. A long name can look like a key to that check, such as a
CamelCase name with digits through it, and a profile of that name can still be put in a route.

The exception lasts only while the profile does. Remove that profile, and its name is checked as
a key again: every route that names it cannot be used, and says it "looks like an API key, or
names a profile that is no longer registered". Take the name out of the route with
`clausona route edit` or `clausona route set <route> --from …`, or remove the route.

## Managing routes

```bash
clausona route add main                                     # every Claude Code account, round-robin, skip at 80%
clausona route add any --tool all                           # Claude Code and Codex accounts in one route
clausona route add work --from '*@example.com' --exclude '*-share'
clausona route add solo --from work --fallback team --strategy headroom
clausona route set main --exclude personal                  # replace one field
clausona route set solo --add contractor --drop work         # change from one entry at a time
clausona route set solo --no-fallback
clausona route rename work office                           # and the dir rules and defaults that name it
clausona route remove office                                # and the dir rules and defaults that name it
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
account in the route. One that is signed out still counts as a member, just not as free, and so
does an API profile with no spend limit, or whose spend could not be read. `NEXT` is the account
a run would get now.
When nobody can be picked it says `none`, and when the first account frees up.

`route list` records nothing. With `--no-quota` it reads no quota at all, and `FREE NOW` and
`NEXT` show `—`. They show the same dash when no reading could be had for any account of a route,
which is what happens offline.

On a narrow terminal the table drops columns rather than wrap a row: `TOOL` goes first, then
`SKIP AT`, then `STRATEGY`.

When you have [dir rules or defaults](#dir-rules-and-defaults), a second table under the routes
lists them, as `clausona route dir` does.

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

A [dir rule or default](#dir-rules-and-defaults) that names the route follows it. `route rename`
points each one at the new name, and `route remove` removes them and says which. The Routes
screen does the same when you remove a route there, and its question says what goes with it:
`Remove route work and the dir rule that names it? (y/N)`. Renaming a route in its form renames
the rules too. Changing its tool there removes the rules the new tool cannot take, and says
which.

```
$ clausona route remove office
  ✔ Removed route office
    Also removed the dir rule for ~/work (claude) and the claude default.
```

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
  },
  "dirs": { "~/work": { "claude": "main" } },
  "defaults": { "claude": "main" },
  "budgets": { "claude:gateway": { "usd": 20, "per": "month" } }
}
```

`dirs` and `defaults` are the [dir rules and defaults](#dir-rules-and-defaults). Each maps
`claude` and `codex` to a route's name, and `dirs` keys each such map by its directory: `~` for
your home, or an absolute path. `budgets` are the API profiles' spend limits, by profile id:
`usd` is a number of dollars above 0, and `per` is `day`, `week` or `month` (see
[API profiles in routes](#api-profiles-in-routes)). All three can be left out.

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
changed." If `routes.json` changed while you were editing, your edit is not saved over it.
It is kept in `~/.clausona/routes.edit.json`, which only you can read. Run `route edit` again
and paste it in. Once an edit saves what that file holds, the file is deleted.

When `routes.json` cannot be read as routes at all (it is not JSON, say, or it comes from a
newer clausona), every command that reads it stops with exit code 1 and lists what is wrong.
A run with `--from` and `clausona run <profile>` do not read the file, so they are never stopped
by it. Nor is `clausona run claude` with no route named. It reads the file for its dir rules and
defaults, and when it cannot, it says why in one line on stderr and runs the active profile:

```
  ⚠ /home/you/.clausona/routes.json cannot be used, so no dir rule or default applies: not valid JSON (line 4, column 1). Fix it with clausona route edit.
  ▸ claude:personal  active profile (no route)
```

A problem in one route stops only the commands that use that route. `clausona run --route main`
and `route pick main` work while route `old` has a typo. `route list` and `route explain` show
the other routes as usual and warn about each problem:

```
  ⚠ routes.old.strategy: must be one of round-robin, headroom, expiring
  ⚠ Fix it with clausona route edit, or remove the route: clausona route remove old.
```

A change that would save the file with such a problem still in it is refused, with the same
problems and the same way out. So while `old` is broken, `route add` and `route set` on other
routes stop and ask you to fix it first. `route remove old` works, and so does a `route set old`
that fixes the problem, such as `route set old --strategy headroom`.

A dir rule or default that cannot be read, such as `"claude": 5` or a directory that is not a
path, works the same way. Runs pass over it, `route list` warns about it, and a change is refused
until it is fixed with `route edit` or cleared with `route dir <path> --clear`. `route edit` itself
refuses to save one.

So does a budget that cannot be read, such as `"usd": "20"` or a `per` of `year`. The others still
apply, and the profile it was for counts against its key's own limit. `route list` and
`route budget` warn about it, and a change is refused until it is fixed with `route edit`, or set
again with `route budget <profile> --usd … --per …`. A budget for a profile that is not registered,
or is not an API profile, is only a warning.

Removing a profile leaves its routes alone. A name that is no longer registered is skipped, and
both `route list` and `route explain` point it out. The one exception is a name the key check
would refuse, which a route can hold only while the profile is registered (see
[Patterns](#patterns)): once it is removed, that route cannot be used until the name is taken
out. They point out patterns that match nobody too, each one once, and an `exclude` entry that
matches nobody. That one matters most: a typo there leaves in the account it was meant to leave
out. `route list` puts them under its table:

```
  ⚠ ghost names 'gone', which is not a registered profile.
  ⚠ ghost: 'x-*' matches nobody.
  ⚠ ghost: exclude 'persnal' matches nobody.
```

Before `clausona init` no profile is registered, so `route list` names none of them as unknown.

`clausona doctor` lists these warnings too, after its profiles, without reading any quota.

## The Routes screen

In a terminal, `clausona route` with no arguments opens the dashboard's Routes screen. You can
also get there from the dashboard itself (`clausona`), where Routes is the item under Profiles.
Without a terminal, in a script or an agent's shell, `clausona route` prints the help instead.

The screen lists your routes on the left. Each line has the route's name, its tool, and how many
of its accounts are free now, as in `2/5`. On the right is the route under the cursor: its
settings, then every account with gauges for its 5H and 7D windows, the one a run would get
next, and why any other is held back. On a terminal under 100 columns the detail sits under the
list instead.

When the route's accounts report a limit on one model, a line under the table names those models,
as in `Model limits: Opus, Sonnet`. `m` ranks the route as a run of the first of them would, the
way `clausona route explain <route> --model opus` does. The model's limit gets a column beside 5H
and 7D, the account an Opus run would get is marked next, and the count in the list is of the
accounts free for that run. The settings say `ranked as --model opus`. Press `m` again for the
next model, and after the last one the route is ranked as a run that names no model. Moving to
another route does that too. The cells keep their form as `m` moves: if the table for any model is
too wide for gauges, the route shows percentages for every model and for none.

On an `all` route, a run that names a model names its tool too, so only the accounts of the tool
that reports the limit are ranked: for Opus, the Claude Code accounts, as
`clausona run claude --route <route> -- --model opus` ranks them. The settings then say
`ranked as --tool claude --model opus`, the options that rank the same with `route explain`.

| Key | Does |
|---|---|
| `↑` `↓` | Move between routes |
| `n` | Open the form for a new route |
| `e` | Open the form on the selected route |
| `d` | Remove the selected route, once you answer `y` |
| `r` | Read the quota again |
| `m` | Rank the selected route as a run of one model would, then the next model, then none; only when its accounts report a limit on a model |
| `tab` | Switch to the [dir rules and defaults](#dir-rules-and-defaults), and back |
| `b` | Switch to the [budgets](#budgets-on-the-screen) of your API profiles; `tab` comes back |
| `esc` | Back to the dashboard, or out if you came in with `clausona route` |

The screen never records a pick. It writes `routes.json` only when you remove a route, save one
from the form, change a dir rule or default, or set or clear a budget. If the file cannot be used, the screen says what is wrong with it and points you
to `clausona route edit`. A route with a problem is left off the list, and one line under it
says so and points you to `clausona route list`, which shows the problem.

### Dir rules on the screen

`tab` swaps the list of routes for a table of your dir rules, one row per directory with the
route each tool takes there, and a `default` row under them. A route that is gone, or is for the
other tool, is in yellow, and a line under the table says what is wrong with it. While a rule
needs a look, the routes list says so in one line.

`n` adds a dir rule and `e` changes the selected one, or the defaults on their row. The form has
the directory and a choice of route for each tool, where `none` leaves that tool to the next rule.
A directory you type is read from where you started clausona, so `.` is that directory. With many
routes, each choice shows the ones around the selected route, and `←` `→` move through the rest.

The form saves only what you changed, as `route dir` does. A new rule for a directory that already
has one adds to it, and keeps the other tool's route there. A route that is gone, or for the other
tool, is shown in yellow as one more choice, and stays as it is while you leave it alone.

`d` clears the selected rule, once you answer `y`. `tab` goes back to the routes.

### Budgets on the screen

`b` swaps the list of routes for your API profiles, one row each, with its usage and its spend
against its limit, and whose limit that is. One with no limit, or whose provider does not report
spend, says so instead.

`e` opens a small editor for the selected profile's budget: the dollars, and `day`, `week` or
`month`, chosen with `←` `→`. It saves as `route budget <profile> --usd … --per …` does. `d` clears
the budget, once you answer `y`. `tab` goes back to the routes.

### The form

`n` and `e` open the same form. It holds everything `route add` and `route set` can set.

| Field | What it holds |
|---|---|
| Name | The route's name. Changing it on an existing route renames the route |
| Tool | `claude`, `codex` or `claude + codex`, chosen with `←` `→` |
| Accounts | A row for every account (`*`), then a row per subscription account of the tool (of both, for `claude + codex`) with its 5H and 7D usage, and per API profile that has a spend limit, marked `API`, with its budget's use. `space` ticks and unticks |
| Patterns | More `from` and `exclude` patterns, such as `team-*` or `*@example.com` |
| Strategy | `round-robin`, `headroom` or `expiring`, chosen with `←` `→` |
| Limits | `skip at` is the cut. Left blank, the default applies. The line under it says what is picked when every account is at the cut |
| Fallback | Accounts tried in order when nobody in the pool is under the cut. `a` adds one, `x` removes it, `[` and `]` move it |

The ticks become the route's lists. With the `every account (*)` row ticked, `from` is `*`, and
each account you untick goes into the exclude list. An account you add later joins the route.
With that row unticked, `from` is the accounts you ticked, in the order you ticked them, and an
account you add later stays out. An API profile is never among every account: ticked, it goes
into `from` by its name either way, and unticked it is simply not in the route.

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
clausona run claude -- -p "hi"            # no route named: a dir rule's or the default's, else the active profile
clausona run claude:team -- -p "hi"       # one account by name, whatever its quota
clausona run --route main --wait=2h -- -p "run the tests"   # nobody free: wait up to 2h for someone
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

With no routing options at all, `clausona run claude` and `clausona run codex` take their route
from your [dir rules and defaults](#dir-rules-and-defaults). When none applies, they run that
tool's active profile, and say so on stderr:

```
  ▸ claude:personal  active profile (no route)
```

Without a tool word they need `--route` or `--from`. `clausona run -- -p hi` is refused, dir rules
or not, since nothing says which tool it is for.

If you have a profile named `claude` or `codex`, `clausona run claude` runs that profile.

A profile and routing options do not go together. In `clausona run --route main claude:work` the
tool would get `claude:work` as its prompt and start on some other account, so clausona stops
instead:

```
  ✘ Routing options cannot be combined with a profile. Run it by name: clausona run <profile> …, or put it after -- to pass it to the tool.
```

To run that account, name it alone: `clausona run claude:work`. After a `--` the name is the
tool's, like any other argument.

The same goes for a profile right after the tool word. `clausona run claude claude:work` would
start some other account with `claude:work` as its prompt, so clausona stops and names both ways
on:

```
  ✘ claude:work is a profile. Run it by name: clausona run claude:work …, or put it after -- to pass it to claude: clausona run claude -- claude:work
```

Only a word that is exactly a registered profile's name stops the run. Any other word is the
tool's first argument. So a profile named like one of the tool's own commands, such as `exec`,
needs the `--` in front of the command: `clausona run codex -- exec …`.

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

Nor is a route offered while another route in `routes.json` cannot be used, since saving it would
be refused. clausona reads no quota, asks nothing and exits 1 with the problem and how to fix it.

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

    Run again after 1h 15m or with --wait, or see everything with: clausona route explain busy
```

The run exits with code 75 and launches nothing. That happens only when every account is at
100% of a window or is skipped. `FREE AGAIN` is when the account can run again, once every
window at 100% has reset, and the column says which one is last. An account that is skipped,
such as a signed-out one, is listed under the others with the reason. When every account is
skipped, no reset will help, and the last line says to look at those reasons instead.

The last line offers `--wait`. When the soonest reset is more than the 5 hours a bare `--wait`
waits, it offers one long enough, as in `--wait=48h`. A run that names a model shows the
accounts' limits on it in a column of their own, and `FREE AGAIN` can then say `(Opus resets)`
or `(GPT-5.3-Codex-Spark 7D resets)`. In a terminal too narrow for that, `FREE AGAIN` gives the
time alone rather than wrap a row.

On an `all` route narrowed to one tool, the message is about that tool's accounts only, as in
"No claude account in route any is free right now."

### Waiting for an account

With `--wait`, a run that finds nobody free waits instead of exiting:

```
$ clausona run --route busy --wait -- -p "run the tests"
  waiting until 14:05 for claude:personal (5H resets) …
  ▸ claude:personal  route busy, next in turn, 41% of 7D used
```

It sleeps until 30 seconds after the soonest moment an account can run again. For an account
at 100%, that is when the last of its full windows resets. On the way it reads quota again at
least every 30 minutes, so an account that frees up sooner is seen. When it wakes, it reads
quota afresh and ranks the route from the first stage. The line on stderr says until when, in
local time (with the date when it is not today), for which account, and which window it waits
for.

A bare `--wait` waits up to 5 hours. Give it another cap after `=`: `--wait=30m`, `--wait=2h` or
`--wait=1h30m`. If the soonest reset is past the cap, or no account at 100% has a known reset
time, the run does not wait. It exits 75 at once with the usual table, and says why:

```
    Nothing comes free within the 1h wait. Wait longer with --wait=2h, run again after 1h 59m, or see everything with:
    clausona route explain busy
```

A waiting run records nothing until it picks, and then picks under the same lock as any other
run. Several runs that wake together still land on different accounts, as long as enough have
come free.

A quota read that is refused while the run waits (the endpoint answered 429, and clausona leaves
it alone for a while, an hour unless it says otherwise) or that fails does not end the wait. The
run ranks on the last reading while it is under an hour old. Once it is older, or when an account
still reads as full after its reset, the account is read again every 5 minutes, with no request
sent until the 429's pause is over. The line on stderr then says `(for a new quota reading)`,
once, with the latest the run will wait: the end of the cap. The wait goes on until an account
is free or the cap runs out. It ends sooner only when no account could come free at all, such as
when every one is signed out. An account whose quota this run never managed to read is skipped,
as on any run, and keeps nothing waiting.

When it wakes, the run reads again only what was read before the reset it waited for. A reading
that another waiting run took since then is used as it is, so runs that wake one after another do
not each ask for every account again.

Ctrl-C while waiting stops the run with exit code 130. Nothing is launched or recorded.

`clausona route pick --wait` waits the same way (see [Waiting in scripts and cron](#waiting-in-scripts-and-cron)).

## Dir rules and defaults

```bash
clausona route dir ~/work work                   # in ~/work and below, clausona run claude takes route work
clausona route dir ~/oss cx                      # cx is a Codex route, so this is clausona run codex's
clausona route dir ~/both any                    # an all route fills both tools
clausona route dir ~/both any --tool codex       # ...or only the one --tool names
clausona route default main                      # everywhere else, clausona run claude takes route main
clausona route dir                               # every dir rule and default
clausona route dir ~/work --clear                # remove the rule (--tool codex: only codex's)
clausona route default --clear --tool claude     # --tool is needed here: claude, codex or all
```

A dir rule gives a directory a route for each tool. When you run `clausona run claude` there, or
in any directory below it, with no `--route` and no `--from`, the run takes that route. When
several rules hold, the deepest one wins, so a rule for `~/work/oss` beats one for `~/work`.
Where no rule holds, the tool's default applies. With neither, the run takes the tool's active
profile, as it always has.

Each tool has its own slot. A rule for `~/work/oss` that only sets Codex leaves Claude Code to
the next rule up, `~/work`'s, and then to the default.

```
$ cd ~/work/app && clausona run claude -p "run the tests"
  ▸ claude:work  route work (dir rule ~/work), next in turn, 34% of 7D used
```

The path can be relative, absolute or start with `~`. It is stored with `~` when it is under
your home. A rule matches its directory through symlinks, and it ignores case on macOS and
Windows, as their file systems do. On Linux, `~/Work` and `~/work` are two directories. The
directory does not have to exist yet: `route dir` says so, and the rule holds once it does.

A Claude Code route fills Claude Code's slot, and a Codex route Codex's. An `all` route fills
both, unless `--tool` names one. Naming the other tool for a one-tool route is refused, and so
is a route that does not exist.

### When a rule cannot be used

A rule can end up naming a route that is gone, or that is for the other tool, say after a hand
edit. That is not an error. The run passes over the rule, says so on stderr, and goes on to the
next rule up, then the default, then the active profile:

```
  ⚠ Skipped the dir rule for ~/work: route 'old' does not exist.
  ▸ claude:team  route main (default), next in turn, 22% of 7D used
```

`route list`, `route explain`, `clausona doctor` and the Routes screen point these out too.
`route rename` and `route remove` keep them from happening on their own.

A rule that cannot be read at all, such as one whose directory is not a path, applies nowhere.
So a run cannot say it skipped it. Instead, every run that names no route says in one line that
`routes.json` has one, until it is fixed:

```
  ⚠ /home/you/.clausona/routes.json has a dir rule or default that cannot be read: clausona route list says why.
```

### What a run here would take

`clausona route explain` with no name says what `clausona run claude` and `clausona run codex`
would each take in the current directory, and which rule says so. Then it explains each route
they would take, as `route explain <name>` does:

```
$ cd ~/work/app && clausona route explain

  In ~/work/app

    RUN                  USES        BECAUSE
    ─────────────────────────────────────────────────────────
    clausona run claude  route work  dir rule ~/work
    clausona run codex   codex:team  active profile (no route)

  ╭─ work ───────────────────────────────────────────────────────────╮
  …
```

`--tool claude` (or `codex`) limits it to one tool.

## API profiles in routes

An API profile is billed per use, so a route takes one only when you name it, and only once it
has a spend limit. Its usage is then its spend as a share of that limit, and it goes through the
same cut, strategies, fallback and overflow as an account does. Setting the limit is the consent.
There is no prompt and no extra flag.

```bash
clausona route budget claude:gateway --usd 20 --per month   # a clausona budget
clausona route set main --add claude:gateway                # it joins by its exact name
clausona route explain main                                 # its spend, and whose limit counts it
```

```
  ▸ claude:gateway  route main, next in turn, API, billed per use · usage 35% of $20/month
```

`route explain` shows its usage in a `BUDGET` column, and after its status what it has spent and
whose limit that is:

```
    ACCOUNT           5H        7D       BUDGET
    ─────────────────────────────────────────────
  ▸ claude:gateway   —         —         35% 18d   picked next · $7.00 of $20/month (clausona budget)
    claude:personal  85% 1h    60% 2d    —         over 80%
```

The limit is the clausona budget when you set one. It replaces the limit set on the provider key,
and the two are not compared. Without a budget, the key's own limit counts, when the provider
reports one. With neither, the profile has no spend limit, and `route add`, `route set` and the
form refuse it:

```
✘ claude:gateway has no spend limit, so it cannot join a route.
  Set a limit on the provider key, or: clausona route budget claude:gateway --usd 20 --per month
```

A route that already names it, written by hand, skips it on every run as `no spend limit`.
Running it by name, `clausona run claude:gateway`, works as it always has, whatever it has spent.

A budget stops new routed sessions. It does not stop one that is already running, and it does not
block requests: the limit on the provider key is what does that. Set one there too if spending
past it would hurt.

### Where the spend comes from

Spend is always read from the provider, with the profile's own key, sent in one request header to
the provider and to nothing else. Two kinds of provider report it:

| Provider | Asked | Told apart by |
|---|---|---|
| OpenRouter | `GET https://openrouter.ai/api/v1/key` | a base URL on `openrouter.ai` |
| A LiteLLM proxy | `GET <base URL>/key/info` | any other base URL |

A 401 or 403 from the spend request reads as "the provider refused the spend request (401/403)".
That is the request, not necessarily the key: a gateway can refuse `/key/info` alone for a key
that works for everything else.

`/key/info` is asked under the base URL's own path, with its query and fragment left off:
`https://gw.example.com/team-a` is asked at `https://gw.example.com/team-a/key/info`. A LiteLLM
proxy reached through a path of its own, such as its `/anthropic` pass-through, has `/key/info` at
its root instead, so it answers 404 there and reads as not reporting spend.

A provider that answers `/key/info` with a 404, or with anything but LiteLLM's JSON, gives no
spend reading. Such a profile cannot join a route, budget or not, and `route budget` and
`route explain` say "the provider does not report spend". A LiteLLM proxy behind another gateway
often does not pass `/key/info` on, and reads this way. It stops nothing else.

clausona's own record of what a profile cost is not used. That is Claude Code's estimate at
Anthropic's prices, and it is only written once a session ends.

Readings go into the same 5-minute cache as plan quota, so a run does not ask on every launch, and
a 429 pauses the reads of that one profile. A reading that fails leaves the profile out of that
run as `spend could not be read`, and never holds up the others. That includes the key: a
`command:` key source that has not answered within the reading's 5 seconds, such as a vault
waiting to be unlocked, is stopped, with everything it started. So is one that clausona is
waiting on when you press Ctrl-C, and clausona then exits as it always has. Unlike an account's, its last
numbers are not used in its place. On macOS and Linux, a job a key command leaves running in the
background when it is read for spend is stopped when the command exits; an agent that runs in a
session of its own, as gpg-agent and ssh-agent do, is left running.

### Periods

A budget is per `day`, `week` or `month`, in UTC: a day from midnight, a week from Monday, a month
from the 1st. It renews when its period does, which is the reset `--wait` waits for.

OpenRouter reports the spend of the current day, week and month. A LiteLLM proxy reports one
running total, so a budget counts from the total at clausona's first reading in the period. What
was spent before that reading is not counted. If the proxy sets its own count back to 0 (a key
with a `budget_duration`), what the period had spent by the last reading is kept.

### `route budget`

```
$ clausona route budget

    PROFILE         LIMIT      SOURCE           SPENT   USAGE  RENEWS
    ─────────────────────────────────────────────────────────────────
    claude:bare     no spend limit: clausona route budget claude:bare --usd 20 --per month
    claude:gateway  $20/month  clausona budget  $7.00   35%    23d
    claude:or       $50/month  provider limit   $12.50  25%    23d
    claude:proxy    the provider does not report spend
```

With no profile it lists every API profile, with its spend read now (through the cache).
`route budget <profile>` shows one. `--usd <n> --per day|week|month` sets a budget, and `--clear`
removes it and says which limit counts after. Each takes `--json`. Setting a budget is not checked
against the routes: whether a route can take the profile is checked by `route add` and
`route set`, and on every run.

`clausona list` and the dashboard show each API profile's last reading, as `budget 35%`, across the
5H and 7D columns. They read nothing for it, since that would send its key to its provider each
time; a reading older than five minutes is dimmed. In `clausona list --json`, an API profile's
`quota` is `{ "state", "fetchedAt", "budget" }`, `budget` being the window `explain --json` gives,
when there is a reading.

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
would get now. "over 80%" is an account at or above the cut, which can still be picked when
nobody is under it. "at 100%" is one at its limit, which no stage picks. A skipped account says
why in grey. At the bottom are the entries nothing was ranked for, such as an account the
exclude list took out or a name that is not registered. `LAST PICKED` appears on round-robin
routes, the one strategy that reads it.

Percentages are rounded to whole numbers, except that one under the cut never reads as the cut.
An account at 79.6% of a window can be picked under an 80% cut, so it reads 79%, here, in the
run's note and on the Routes screen. One under 100% never reads 100% either.

`explain` launches nothing and records nothing. It exits 0 even when nobody could be picked, and
says so under the table:

```
  Nobody can be picked now; clausona run --route busy would exit 75.
```

It takes the same field options as a run. `--resume` ranks the route as a resumed run would, and
`--tool` narrows an `all` route to one tool's accounts. A route that is not saved is ranked with
`clausona route explain --tool claude --from '<patterns>'`.

`--model` ranks the route as a run of that model would. The box says whether the model has a
limit of its own, and each account's limit on it is a column, named by the limit:

```
$ clausona route explain main --model opus
  …
  │  Model      opus: the Opus limit counts too                      │
  …
    ACCOUNT       5H        7D       OPUS      LAST PICKED
    ──────────────────────────────────────────────────────
  ▸ claude:work  30% 2h    40% 2d    10% 2d    never        picked next
    claude:team  10% 1h    20% 2d    95% 2d                 over 80%
```

When no account has a limit on the model, the box says `no account reports a limit on it`, and
there is no column. A Codex limit's column shows the higher of its windows, and says which:

```
$ clausona route explain cx --model gpt-5.3-codex-spark
  …
    ACCOUNT   5H        7D       GPT-5.3-CODEX-SPARK
    ────────────────────────────────────────────────
  ▸ codex:c   3% 1h     3% 2d     5% 7D 4d            picked next
    codex:b  12% 1h    34% 2d    60% 7D 4d
    codex:a   5% 1h    22% 2d    90% 5H 3h            over 80%
```

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

When no account is under the cut, the one with the most left is picked, and that says so too. The
others may be at the cut, over it, or skipped, so the reason says "none under", not "all over":

```
$ clausona route explain main
  …
    ACCOUNT            5H        7D       LAST PICKED
    ─────────────────────────────────────────────────
  ▸ claude:team       85% 1h    22% 3d    never        picked: most room left (none under 80%)
    claude:side       88% 1h    40% 3d                 over 80%
    claude:work       12% 3h    91% 4d                 over 80%
```

```
$ clausona run --route main -- -p "run the tests"
  ▸ claude:team  route main, most room left (none under 80%), 85% of 5H used
```

## For scripts and agents

A Claude Code or Codex session can drive routing for you. `clausona route --help` is written for
it, so have it read that first.

The Routes screen is for people. An agent's shell has no terminal, so `clausona route` with no
arguments only prints the help there, and the agent works with the subcommands below.

```bash
clausona route list --json                 # every route and its members, and the dir rules
clausona route explain main --json         # the state of every member; records nothing
clausona route explain --json              # what clausona run claude and codex take here, and why
id=$(clausona route pick main)             # take a turn and record it
clausona run "$id" -- -p "run the tests"   # start the tool on that account
```

`route pick` prints the picked profile id on stdout and nothing else. It records the pick the way
a run does. To start several workers, call `pick` once per worker on a round-robin route, and
each call takes the next account. On a `headroom` or `expiring` route, picks made close together
land on the same account, because their readings are cached for 5 minutes. With `--model`, a
pick counts each account's limit on the model the worker will run.

On an `all` route a pick can come back as an account of either tool, and `clausona run "$id"`
starts the right one. When the worker's arguments are for one tool, pick with `--tool`:
`clausona route pick any --tool codex`.

Create and change routes with `route add`, `route set` and `route remove` rather than by writing
`routes.json`. These never ask, in a terminal or not, so an agent creating a route for you should
first show you its accounts and wait for your OK. It can rank the route without saving it, with
`clausona route explain --tool claude --from '<patterns>'`.

Without a terminal an unknown `--route` creates nothing.

### Waiting in scripts and cron

`--wait` turns "nobody is free" into a wait, for `run` and for `pick` alike. While it waits it
writes one line to stderr, so stdout stays the tool's output, or `pick`'s id or JSON.

```bash
#!/bin/sh
# Nightly review: wait up to 4 hours for a free account, then run.
cd ~/work/app || exit 1
clausona run claude --route nightly --wait=4h -- -p "review yesterday's commits" > review.md
case $? in
  0) ;;
  75) echo "no account came free within 4h" >&2; exit 75 ;;
  *) exit 1 ;;
esac
```

```
# crontab -e: every night at 2:00, with the waiting line and any error in the log
0 2 * * * $HOME/bin/nightly-review.sh >> $HOME/nightly-review.log 2>&1
```

cron runs with a short `PATH`, so give the script one that reaches `clausona`, `claude` and
`node`, or use their full paths. There is no terminal, so an unknown route exits 1 instead of
asking. Exit 75 means nobody came free within the cap; the log has the table that says when
each account frees up.

An orchestrator that takes a turn per worker can wait in `pick`:

```bash
id=$(clausona route pick main --wait=1h) || exit $?   # 75: nobody free within the hour
clausona run "$id" -- -p "run the tests"
```

With `--json`, stdout carries only the final JSON, and exit 75 still prints the `pick` JSON
with `profile` null. Ctrl-C while waiting exits 130 and leaves no pick recorded.

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

`stage` is `pool`, `fallback` or `overflow`. `overflow` is the third stage: no account was under
the cut, and the one with the most left was picked. `route` is null for an unsaved route.
`usage.window` is `"5H"` or `"7D"`, or the name of the limit on the model `--model` named, such
as `"Opus"`, when that limit is the highest. A Codex limit is named with its window, as in
`"GPT-5.3-Codex-Spark 7D"`.

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
| `resolvedBy` | `"flag"` for a saved route, `"inline"` for one made from `--from`. With no name (below), `"dir:<path>"` for a dir rule, with its path as stored (`"dir:~/work"`), `"default"` for the tool's default, or `"active"` when no route applies |
| `settings` | The route with every default filled in: `tool`, `from`, `exclude`, `strategy`, `maxUsage`, `fallback`. `tool` is `"claude"`, `"codex"` or `"all"` |
| `model` | The model `--model` named, or null |
| `outcome` | `{ "kind": "picked", "id", "stage", "reason" }`, or `{ "kind": "none" }` plus `soonest` (`{ "id", "at" }`) when a reset time is known |
| `members` | One entry per account, below |
| `excluded` | Accounts the exclude list took out, as `{ "profile", "matchedBy" }` |
| `emptyPatterns` | Glob and email patterns in `from` or `fallback` that match nobody, each once |
| `emptyExcludes` | Entries of `exclude` that match nobody, names as well as patterns |

Each entry in `members`:

| Field | Value |
|---|---|
| `profile` | The profile id, such as `claude:team` |
| `role` | `"pool"` or `"fallback"` |
| `matchedBy` | The pattern that brought it in |
| `status` | `"picked"`, `"eligible"` (under the cut, not picked), `"over-limit"` (at or above `maxUsage`, not picked) or `"skipped"` |
| `skipReason` | null, or one of `"signed-out"`, `"expired"`, `"no-reading"`, `"not-registered"`, `"keeps-own-sessions"` (a resumed run), and for an API profile `"no-spend-limit"`, `"spend-not-reported"` or `"spend-unread"` |
| `usage` | `{ "percent", "window", "stale" }` with `window` `"5H"`, `"7D"`, the name of the limit on the model (`"Opus"`, `"GPT-5.3-Codex-Spark 7D"`) when that is the highest, or `"budget"` for an API profile, or null |
| `fiveHour`, `sevenDay` | `{ "usedPercent", "resetsAt" }` with `resetsAt` an ISO time or null, or null |
| `scoped` | The account's limit on the model `--model` named, as `{ "label", "usedPercent", "resetsAt" }` (of a Codex limit with two windows, the higher), or null without `--model` or such a limit |
| `budget` | An API profile's spend against its limit, as `{ "usedPercent", "resetsAt", "spentUsd", "limitUsd", "source", "per" }`, or null. `source` is `"budget"` (a clausona budget) or `"provider"` (the key's own limit); `per` is `"day"`, `"week"`, `"month"` or null |
| `lastPickedAt` | The ISO time of the last pick, or null |

An account picked at the `overflow` stage has the status `picked`, even though its usage is at or
over `maxUsage`. Percentages are not rounded in JSON. Fields are only ever added.

With no name, `route explain --json` gives `{ "directory", "runs": [...] }`: the directory it
looked from, and one entry per tool, or only the one `--tool` names. A tool whose run takes a
route has the fields above for that route, with `resolvedBy` saying which rule chose it, plus
`tool` and `skipped`. A tool whose run takes no route has `{ "tool", "route": null,
"resolvedBy": "active", "profile", "skipped" }`, with `profile` null when the tool has no active
profile.

```json
{
  "directory": "/home/you/work/app",
  "runs": [
    { "tool": "claude", "route": "work", "resolvedBy": "dir:~/work", "settings": { … }, "outcome": { … }, "skipped": [] },
    {
      "tool": "codex",
      "route": null,
      "resolvedBy": "active",
      "profile": "codex:team",
      "skipped": [{ "rule": "default", "reason": "route 'cx' does not exist" }]
    }
  ]
}
```

`skipped` lists the rules the run would pass over on its way, as `{ "rule", "reason" }`, with
`rule` either `"dir:<path>"` or `"default"`.

### `list --json`

`route list --json` gives `{ "routes": [...], "problems": [...] }`. Each route is ranked the way
`explain` ranks it, so its members are the accounts a run would consider. Each entry in `routes`:

| Field | Value |
|---|---|
| `name` | The route's name |
| `route` | The route with every default filled in, as `settings` in `explain --json` |
| `members`, `fallbackMembers` | Profile ids of the pool and of the fallback, after the exclude list, API profiles among them |
| `excluded` | Profile ids the exclude list took out of `from` or `fallback` |
| `unknownNames` | Names in `from` or `fallback` that are not registered profiles, as written |
| `emptyPatterns`, `emptyExcludes` | As in `explain --json` |
| `freeNow` | `{ "free", "members" }`, what the `FREE NOW` column shows, or null |
| `next` | Who a run would get now, as `outcome` in `explain --json`, or null |

`freeNow` and `next` are null with `--no-quota`, and when no reading could be had for any account
of the route. Before `clausona init` there is nobody to rank: the lists are empty, and both are
null. `list --json` reads quota as the table does; add `--no-quota` when you only need the
members.

`problems` lists, as text, what is wrong with each route that cannot be used, with each dir
rule or default that cannot be read, and with each budget that cannot be read. Those routes are
not in `routes`. `budgetWarnings` lists the budgets for a profile that is not registered, or is
not an API profile.

It also has the [dir rules and defaults](#dir-rules-and-defaults):

| Field | Value |
|---|---|
| `dirs` | Each dir rule's directory, as stored, with the route each tool's slot names: `{ "~/work": { "claude": "work" } }` |
| `defaults` | The route each tool's default names: `{ "claude": "main" }` |
| `ruleWarnings` | As text, each rule that names a route that is gone, cannot be used or is for the other tool |

### `budget --json`

`route budget --json` gives `{ "profiles": [...], "problems": [...], "warnings": [...] }`, and
`route budget <profile> --json` one entry, with `changed` when it set or cleared a budget. Each
entry:

| Field | Value |
|---|---|
| `profile` | The API profile's id |
| `budget` | The clausona budget, `{ "usd", "per" }`, or null |
| `limit` | The limit that counts, `{ "source", "usd", "per", "resetsAt" }`, or null when there is no reading or no limit. `source` is `"budget"` or `"provider"` |
| `spentUsd` | The spend that counts against it, or null |
| `usage` | The spend as a percent of the limit, or null |
| `spend` | `"ok"`, `"no-limit"`, `"not-reported"` or `"unread"` |
| `reason` | Why there is no usage, as the table says it, or null |
| `routes` | The routes that name it |

`problems` and `warnings` are what is wrong with `budgets`, as in `list --json`.

### Exit codes

| Code | Meaning |
|---|---|
| the tool's own | The tool ran. |
| 1 | A usage error, an unknown route without a terminal (or answered `n` in one), or a `routes.json` or a named route that cannot be used. |
| 75 | No account is available now, from `run` or `pick`: nobody is free, or a `--wait` found the soonest reset past its cap, or none known. Retry later or with `--wait`, or name a profile. |
| 130 | Ctrl-C while `--wait` waited. Nothing was launched or recorded. |

### Errors

With `--json`, a `route` command that fails prints one object on stdout, and nothing else on
stderr (`pick --wait` still says there what it waits for).
It is the shape the [Extensions commands](extensions.md#errors) use, and the exit code is the
same as without `--json`:

```json
{
  "version": 1,
  "error": "not-found",
  "message": "Route 'nope' does not exist. Existing routes: main. Create it: clausona route add nope"
}
```

| `error` | Exit code | When |
|---|---|---|
| `usage` | 1 | Bad usage: an unknown option or subcommand, a bad option value, or no route named |
| `not-found` | 1 | No route has that name, or no profile, for `route budget` |
| `failed` | 1 | Anything else, such as clausona not set up yet. When `routes.json`, or the route named, cannot be used, it adds `file`, the file's path, and `problems`, what is wrong, as `route list` words it |
| `failed` | 130 | `pick --wait` stopped by Ctrl-C |

`message` is what the command prints without `--json`. Read `error` to tell failures apart. Exit
75 from `pick --json` is not an error object: it prints the `pick` JSON above, with `profile`
null.

### The routing skill

The `routing` plugin has a skill of the same name that teaches a session all of this.
clausona shares plugins across profiles, so one install reaches every account:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install routing@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add routing@clausona
```
