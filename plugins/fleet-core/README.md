# fleet-core

The shared rules behind clausona's fleet plugins:
[superset-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/superset-fleet.md),
[herdr-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/herdr-fleet.md) and
[orca-fleet](https://github.com/larcane97/clausona/blob/main/docs/usecases/orca-fleet.md). Each of
those lets one Claude Code or Codex session run parallel workers, every one on its own clausona
account or API model. The runner plugin says how to drive its tool. This one decides which account
gets each task, and when a worker's work counts as done.

You don't call it yourself. A fleet skill loads it when it starts.

## What you need

[clausona](https://github.com/larcane97/clausona), and one of the fleet plugins above along with the
runner it's for: Superset, herdr or Orca.

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

Its settings live in `~/.clausona/fleet.json`, and you can change them by asking:

> Never use claude:personal for workers.

The session changes just that setting and tells you which file it wrote.

## What it won't do

It never puts a worker on the profile the coordinating session runs on, unless you pick it. A
worker's brief always goes through a file, never onto a command line, where the shell could run
what's in it.

A finished worker's branch gets checked before anything else. The worker is retired only once that
branch is pushed and the worktree is clean, and nothing is ever removed with `--force`. A worker's
permission prompt is always left for you.

## More

- [Settings, key by key](https://github.com/larcane97/clausona/blob/main/docs/usecases/superset-fleet.md#settings)
- [Guide: parallel Claude Code agents](https://larcane97.github.io/clausona/guides/parallel-claude-code-agents/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
