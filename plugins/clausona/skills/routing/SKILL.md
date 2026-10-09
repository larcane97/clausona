---
name: routing
description: Run Claude Code or Codex on whichever clausona account has quota left, using clausona routes, and create, change or explain those routes for the user. Use when the user says "run this on an account with room", "spread these across my accounts", "make a route of my work accounts", "why did it pick that account", when a run stops on a usage limit, or when starting several workers that should not all land on one account.
---

# Routing runs across clausona accounts

clausona keeps several Claude Code and Codex accounts on one machine. A **route** is a named
group of those accounts and a rule for picking one of them by how much of its plan quota is
used. `clausona run --route <name>` starts the tool on the account the rule picks right now.
(`csn` is an alias for `clausona` that only the user's interactive shell has. Run `clausona`.)

Run `clausona route --help` once before anything else. It lists every command, option and exit
code of the installed version. Where it differs from this skill, it wins.

`clausona route` with no arguments opens the Routes screen, a TUI meant for a person at a
terminal. Do not run it; use the subcommands below. (In a shell without a terminal it only prints
the help.) A user who would rather look through routes on that screen can run it themselves.

## What decides the pick

- An account's **usage** is the higher of its 5H and 7D windows: 0% 5H with 99% 7D is 99%.
  That number, and nothing else, is ranked and shown.
- clausona stops at the first stage that finds someone:
  1. **pool**: `from` members under `maxUsage` (default 80), chosen by the strategy.
  2. **fallback**: the first `fallback` member, in listed order, under `maxUsage`.
  3. **reserve**: every member is at `maxUsage` or over it, so the one with the most left
     (lowest usage) is taken, pool or fallback, at 90% or 99% alike.
  4. **nobody**: every member is at 100% or skipped. Nothing is launched, exit code **75**.
- Strategies: `round-robin` (default; the account picked longest ago, a never-picked one
  first), `headroom` (lowest usage), `expiring` (lowest usage among accounts whose weekly limit
  resets within 24 hours; with none, as `headroom`).
- Signed-out, expired and unreadable accounts are skipped at every stage.
- Resumed runs (`-c`/`--continue`, `-r`/`--resume`, `--from-pr`, `codex resume` or `fork`) use
  only accounts that share sessions: the primary account and profiles with merged sessions. If
  none of them can take it, the account that holds the session has to be run by name.

## Looking before acting

```bash
clausona route list --json                 # routes, their settings with defaults, their members
clausona route explain <name> --json       # every member's usage and status; launches and records nothing
clausona list --json                       # every profile, with its email and quota
```

`explain --json` gives:

- `settings`: the route with its defaults. `settings.tool` is `claude`, `codex` or `all` (a route
  over the accounts of both tools).
- `outcome`: `{"kind": "picked", "id", "stage", "reason"}`, or `{"kind": "none"}` with
  `soonest` (`{"id", "at"}`) when a reset time is known. `explain` exits 0 even when nobody could
  be picked, so read `outcome.kind`.
- `members`, one per account: `status` is `picked`, `eligible` (under the cut, not picked),
  `over-limit` (at or above `maxUsage`) or `skipped`. A skipped one has `skipReason`:
  `signed-out`, `expired`, `no-reading`, `not-registered`, `keeps-own-sessions` or
  `api-not-supported`. Each also has `usage`, `fiveHour`, `sevenDay` and `lastPickedAt`.

Answer "why did it pick X" from `explain`: `outcome.stage` and `outcome.reason` for the pick, and
each other member's `status`, `skipReason` and usage. `explain` takes the same field options as a
run (`--strategy`, `--max-usage`, …) and `--resume`, to show what a run like that would get.

## Creating or changing a route for the user

`route add` and `route set` never ask, in a terminal or not. They write at once, and `route add`
then prints the route it made. So the asking is yours to do, before you write:

1. Show the user which accounts the route would hold. Rank it unsaved and show them the result:
   `clausona route explain --tool <claude|codex|all> --from '<patterns>' [--exclude '<patterns>']`.
   For a change, show the route as it is (`route explain <name>`) and as it would be.
2. Ask before including accounts that look like someone else's or shared: another person's name
   or email, `*-share`. Leave them out until the user says yes.
3. `*` takes every subscription account of the tool, including ones added later. When the user
   described a subset ("my work accounts"), use names (`work,work2`) or an email pattern
   (`*@example.com`) instead.
4. Never put an API profile in a route; `route add` and `route set` refuse one. A pattern never
   matches one, so `*` is safe. Run an API profile by name (`clausona run claude:glm`) only when
   the user asks for it: it is billed per use.
5. Wait for the user's OK, then write with the CLI. Never edit `~/.clausona/routes.json`
   yourself, and do not use `route edit`: it opens an editor for a person.

```bash
clausona route add <name> [--tool claude|codex|all] --from '<patterns>' [--exclude '<patterns>'] [--fallback '<patterns>'] [--strategy <s>] [--max-usage <n>]
clausona route set <name> [--from …] [--exclude …] [--fallback …] [--strategy …] [--max-usage …] [--add …] [--drop …] [--no-fallback]
clausona route rename <old> <new>
clausona route remove <name>
```

- `--tool` is the route's tool: `claude` (the default), `codex`, or `all` for one route over the
  accounts of both tools. Without `--tool`, `--from` entries that all carry one tool's prefix
  (`codex:a,codex:b`) make a route for that tool, and prefixes of both tools make an `all` route.
  Check `clausona list --json` for which tools have accounts. `route set` cannot change the tool.
- `--yes` is accepted and does nothing. You do not need it.
- Patterns are comma-separated profile names or globs (`team-*`, `claude:team-*`). A pattern
  with an `@` matches account emails. Matching ignores case. Quote the list.
- On an `all` route a name without a prefix matches in both tools: `personal` is
  `claude:personal` and `codex:personal`. Use the prefixed id to mean one account.
- In `route set`, each field option replaces its whole field: `--exclude old` makes the exclude
  list just `old`. To add to a list, pass its current entries too (from `route list --json`).
- `--add` and `--drop` change `from` one entry at a time. `--drop` removes only an entry written
  in `from`, so it cannot take one account out of `*` or `*@example.com`. Use `--exclude` for
  that.
- `rename` and `remove` act at once. Ask before removing a route.
- A route name starts with a letter or a digit, and the rest is letters, digits, `.`, `_` and
  `-`. Names and patterns that look like an API key or a token are refused, and clausona does
  not print them back. Never put a key in either.

## Running

```bash
clausona run --route <name> -- -p "<prompt>"                # Claude Code, non-interactive
clausona run --route <name> -- exec "<prompt>"              # a Codex route
clausona run codex --route <name> -- exec "<prompt>"        # an all route: name the tool
clausona run claude --from '<patterns>' -- -p "<prompt>"    # an unsaved route
clausona run --route <name> --strategy headroom -- -p "…"   # change a field for this run only
```

- Routing options (`--route`, `--from`, `--exclude`, `--strategy`, `--max-usage`, `--fallback`)
  go before the tool's own arguments. A `--` ends them, and everything after it goes to the tool
  untouched (`--model`, `--permission-mode`, `--output-format json`, …).
- The field options need `--route` or `--from`. On their own they are refused with exit 1.
- On an `all` route (`settings.tool` is `all`), put the tool word before `--route` whenever you
  pass arguments: `clausona run claude --route <name> -- -p "…"`. Only that tool's accounts are
  ranked. Arguments without a tool word are refused with exit 1, because Claude Code and Codex
  take different ones. `route explain` and `route pick` narrow the same way with `--tool`.
- Next to `--route`, `--exclude x` leaves `x` out for this run on top of the route's own
  excludes. The other field options replace their field for this run. Nothing is saved.
- Never put a profile right after routing options: `clausona run --route main claude:work` is
  refused, because the tool would get the name as its prompt. To run one account, name it alone
  (`clausona run claude:work`).
- `clausona run claude` with no routing options is not routed: it runs the active profile.
- Naming a profile (`clausona run claude:work`) always runs it, whatever its quota.
- A routed run names the account it picked, and why, on stderr. stdout is the tool's own.
- Without a terminal an unknown `--route` creates nothing: it exits 1 with
  "Create it: clausona route add <name>". Treat that as a new route: show the members and ask
  first, as above.
- `clausona run --route <name>` with no tool arguments is an interactive session. Give that
  command to the user instead of starting it from your shell.

## Several workers at once

Take one turn per worker on a round-robin route, and start each worker on its own pick:

```bash
id=$(clausona route pick main); code=$?            # one profile id on stdout; records the turn
clausona run "$id" -- -p "$(cat <brief file>)"     # start this worker in the background
```

Do both for each worker in turn, and check `code` every time: 0 starts the worker on `$id`; 75
means nobody is free, so start no more workers (next section); anything else is an error to show
the user.

- Each pick records the turn, so the next pick takes the next account under the cut. Never start
  every worker on one `pick` result, and never on ids copied from `explain`, which records nothing.
- With fewer accounts under the cut than workers, later picks come back to an account already in
  use. Once every account is over the cut, a pick (stage `reserve`) takes the one with the most
  left, not the next turn. Tell the user which workers share an account.
- One `clausona run --route main -- -p …` per worker also takes its own turn. Use `pick` when you
  want the id before you start.
- On an `all` route a pick can be an account of either tool. Pick with `--tool claude` (or
  `codex`) so every id is of the tool your worker command is written for.
- On a `headroom` or `expiring` route, picks made close together land on the same account
  (readings are cached for 5 minutes). Add `--strategy round-robin` to each `pick`, or use a
  round-robin route.
- `pick --json` prints `{"profile", "route", "stage", "usage", "reason"}`. When nobody is free it
  still prints JSON, with `"profile": null` and `soonest` (`{"id", "at"}`, or null), and exits 75.

## When nobody is free (exit 75)

Nothing was launched. Every account of the route is at 100% of a window, or was skipped. The
message on stderr lists each account with its usage and when it resets, or why it was skipped,
and marks the soonest reset (with `--json`, `soonest.at`). Tell the user which account frees up
first, and when, and which skipped ones `clausona login <profile>` would bring back. Workers
already started keep running.

A higher `--max-usage` does not help: past the cut, any account under 100% is already taken. Do
not run an account by name to get past the limit unless the user says so. If they do, name the
risk: that account is at its limit, so the session may stop at once.

## When a run stopped on a usage limit

Start it again on the route. The spent account is now at or above the cut, so another one is
picked. Readings are cached for up to 5 minutes: if `explain` still shows the spent account as
eligible, add `--exclude` with it for this run. The route's own excludes still apply. To carry on
the same session, pass `-c` or `--resume` after `--`; that run only goes to accounts that share
sessions.
