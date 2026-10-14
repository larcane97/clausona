# orca-fleet

Ask one Claude Code or Codex session to split a job, and it opens an
[Orca](https://github.com/stablyai/orca) worktree per task and starts a worker there on its own
account, or on an API model such as DeepSeek. Orca's sidebar names each worktree after its task and
account. When a worker says it's done, the session checks the branch itself before believing it.

## What you need

[clausona](https://github.com/larcane97/clausona), which keeps several Claude Code and Codex
accounts on one machine, with a profile for each account or API model the workers should use
(`clausona add claude:work`). Orca has to be open on the same machine, because
the `orca` command talks to the running app. The repository needs a remote, since workers push
their branches.

It needs `fleet-core`, the rules the fleet plugins share. Claude Code installs it along with this
one; in Codex, add it yourself.

## Install

In Claude Code:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install orca-fleet@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add fleet-core@clausona
codex plugin add orca-fleet@clausona
```

Start each new profile once by hand (`clausona run claude:work`), so a worker doesn't stop at a
one-time question.

## Try it

In an Orca terminal in your repo, start Claude Code or Codex and ask:

> Split these across my accounts in Orca: add a `--json` flag to `notes list`, and write tests for
> `src/parse.ts`. Run the tests task on DeepSeek.

You named a profile, so it shows its table of tasks and starts right away.

## What it won't do

Orca has its own account switcher. The session doesn't use it: each worker starts with
`clausona run`, which puts it on the account you chose.

It never forces a worktree removal, and Orca refuses one that holds changes. Orca also deletes a
worktree's local branch, so a worker is never retired before its branch is pushed. It never closes
a terminal or removes a worktree it didn't create, and never answers a worker's permission prompt.

## More

- [How it works, with a demo](https://github.com/larcane97/clausona/blob/main/docs/usecases/orca-fleet.md)
- [Guide: parallel agents in Orca](https://larcane97.github.io/clausona/guides/parallel-agents-in-orca/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
