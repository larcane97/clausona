# fleet-core

The shared rules behind clausona's fleet plugins:
[superset-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/superset-fleet.md),
[herdr-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/herdr-fleet.md),
[orca-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/orca-fleet.md) and
[tmux-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/tmux-fleet.md). Each of
those lets one Claude Code or Codex session run parallel workers, every one on its own clausona
account or API model. The runner plugin says how to drive its tool. This one decides which account
gets each task, and when a worker's work counts as done.

You don't call it yourself. A fleet skill loads it when it starts. It's one skill and no hooks, plus
one small script that reads a Claude Code worker's last reply from Claude Code's own session file,
for when the screen no longer shows it.

It reads your profiles with `clausona list` and its settings from `~/.clausona/fleet.json` (or the
older `superset-fleet.json`). Workers start in the permission mode set there, or else the one a
Superset agent config or the profile's own settings already use. If none sets one, it asks you
once and, if you agree, saves your answer to `fleet.json`. For a risky change, it can also start a
checker session on a third profile, neither the worker's nor the one the coordinating session
runs on.

## What you need

[clausona](https://github.com/larcane97/clausona), and one of the fleet plugins above along with the
runner it's for: Superset, herdr, Orca or tmux.

## Install

In Claude Code it comes along when you install a fleet plugin, which lists it as a dependency. To
add it on its own:

```bash
claude plugin install fleet-core@clausona
```

Codex has no plugin dependencies, so add it next to the runner's plugin:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add fleet-core@clausona
```

## Try it

Its settings live in `~/.clausona/fleet.json`. Ask the session that runs your fleet to change one:

> Never use claude:personal for my herdr fleet workers.

The session changes just that setting and tells you which file it wrote.

## What it won't do

It never puts a worker on the profile the coordinating session runs on, unless you pick it. A
worker's brief always goes through a file, never onto a command line, where the shell could run
what's in it.

When a worker says it's done, the session checks its branch before it counts the task as done. The
worker is retired only once that branch is pushed and the worktree is clean, and nothing is ever
removed with `--force`. A worker's permission prompt is always left for you.

## More

- [Settings, key by key](https://github.com/larcane97/clausona/blob/main/docs/usecases/superset-fleet.md#settings)
- [Guide: parallel Claude Code agents](https://larcane97.github.io/clausona/guides/parallel-claude-code-agents/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
