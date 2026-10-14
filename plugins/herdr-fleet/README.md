# herdr-fleet

Give one Claude Code or Codex session a list of tasks, and it runs each one as its own agent in a
[herdr](https://github.com/herdrdev/herdr) pane and git worktree. Each agent can use a different
account or an API model such as DeepSeek, so a big fan-out doesn't eat one account's limits.

The session checks the branch each worker pushed before it believes the work is done. You can
switch to any worker's pane and type into it.

## What you need

[clausona](https://github.com/larcane97/clausona), which keeps several Claude Code and Codex
accounts on one machine, with a profile for each account or API model the workers should use
(`clausona add claude:work`).

Start the session inside a herdr pane, since herdr's CLI only talks to the session it runs in. The
repository needs a remote, because workers push their branches.

It needs `fleet-core`, the rules the fleet plugins share. Claude Code installs it for you; in
Codex, add it yourself.

## Install

In Claude Code:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install herdr-fleet@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add fleet-core@clausona
codex plugin add herdr-fleet@clausona
```

Start each new profile once by hand (`clausona run claude:work`), so a worker doesn't stop at a
first-run question.

## Try it

In a herdr pane, start Claude Code or Codex in your repo and ask:

> Split these across my accounts in herdr: add a `--json` flag to `notes list`, and write tests for
> `src/parse.ts`.

You get a table of tasks and profiles. If you named no profile, here or in your settings, it waits
for your OK.

## What it runs, and what it won't do

It never forces a worktree removal. herdr refuses one that holds changes, and then the worker is
kept. By default nothing is retired until you say yes.

It closes only the panes and workspaces it created, and leaves a worker's permission prompt to you.

The plugin has no hooks or scripts. The session runs herdr and git commands in your shell and starts
each worker with `clausona run`. It writes each brief and follow-up to a `.fleet-*.md` file in the
worker's worktree, and adds `/.fleet-*.md` to the repository's `.git/info/exclude` so they're never
committed. When a worker asks whether to trust the folder, the session answers yes, for this
repository only.

## More

- [How it works, with a demo](https://github.com/larcane97/clausona/blob/main/docs/usecases/herdr-fleet.md)
- [Guide: parallel agents in herdr](https://larcane97.github.io/clausona/guides/parallel-agents-in-herdr/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
