# routing

clausona keeps several Claude Code and Codex accounts on one machine. This plugin teaches an agent
to start Claude Code or Codex on whichever of those accounts still has plan quota left, using
clausona routes: named groups of accounts, each with a rule for picking one.

The agent can also set up or change routes for you, and explain why a run landed where it did.

## What you need

clausona 0.8.0-beta or later, with your accounts added as profiles. The agent reads
`clausona route --help` first, and where the installed version differs from the skill, the help
wins.

## Install

In Claude Code:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install routing@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add routing@clausona
```

## Try it

With a route called `main`, ask:

> Run the test suite on whichever of my accounts has room.

The agent looks first, then runs:

```bash
clausona route explain main --json   # each account in the route: its usage, and who would be picked
clausona run --route main -- -p "run the test suite"
```

For several workers it takes one turn each with `clausona route pick main`, so they don't all land
on one account. If no account can take the run, nothing starts, and the agent tells you which one
frees up first.

## What it won't do

`clausona route add` and `route set` write at once, without asking. So the agent asks first: it
shows which accounts a route would hold and waits for your OK. It does the same before
setting a directory rule or a default.

It never puts an API profile in a route unless you name it, since those are billed per use. It
won't edit `~/.clausona/routes.json` by hand, or run a spent account by name to get past its limit
unless you say so.

The plugin is one skill with no hooks or scripts. Everything it does is a `clausona` command in your
shell.

## More

- [Routing docs](https://github.com/larcane97/clausona/blob/main/docs/routing.md)
- [clausona on GitHub](https://github.com/larcane97/clausona)
