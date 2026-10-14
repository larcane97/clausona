# superset-fleet

Let one Claude Code or Codex session split a job across several agents in
[Superset](https://superset.sh), each in its own workspace and on its own account or API model, so
five agents don't drain one account's 5-hour window. Any worker's tab is yours to read or type into.

## What you need

[clausona](https://github.com/larcane97/clausona), which keeps several Claude Code and Codex
accounts on one machine, with a profile per account or API model (`clausona add claude:work`). Superset has to be running on the same machine, with its orchestrate
skill (`superset:orchestrate` in Claude Code, `superset-orchestrate` in Codex), which this plugin
builds on.

Each worker profile needs a custom agent (Superset's Settings, under Agents) whose command is
`clausona run <profile> -- …`. Without the Superset CLI logged in, the session can add these once
you agree.

`fleet-core`, the rules the fleet plugins share, comes along in Claude Code. In Codex, add it
yourself.

## Install

In Claude Code:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install superset-fleet@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add fleet-core@clausona
codex plugin add superset-fleet@clausona
```

## Try it

In a Superset project, ask:

> Split these across my accounts in Superset: add a `--json` flag to `notes list`, and fix the
> broken links in `docs/`.

It shows each task with the profile it picked, favoring the ones with the most quota left, and
waits for your OK if you named none.

## What it runs, and what it won't do

The plugin's one script, `scripts/superset-host.mjs`, talks to the Superset host service on this
machine with the token from that service's manifest, and never prints the token. The session uses
it to wait on workers and delete workspaces, and for the rest when the Superset CLI isn't logged
in. Before a Claude Code worker starts, the script also marks its worktree as trusted in that
profile's `.claude.json`.

Deleting a Superset workspace removes its worktree even with uncommitted work in it. So the session
deletes only through the script, which checks right before that the branch is pushed and the
worktree is clean, and refuses otherwise. It never answers a worker's permission prompt for you.

## More

- [How it works, with settings](https://github.com/larcane97/clausona/blob/main/docs/usecases/superset-fleet.md)
- [Guide: parallel Claude Code agents](https://larcane97.github.io/clausona/guides/parallel-claude-code-agents/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
