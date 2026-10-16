# tmux-fleet

Give one Claude Code or Codex session a list of tasks, and it runs each one as its own agent in a
tmux window and git worktree. Each agent can use a different account or an API model such as
DeepSeek, so a big fan-out doesn't eat one account's limits.

The session checks the branch each worker pushed before it believes the work is done. You can
switch to any worker's window and type into it. It needs nothing but tmux, so it also runs on a
remote machine over SSH.

## What you need

[clausona](https://github.com/larcane97/clausona), which keeps several Claude Code and Codex
accounts on one machine, with a profile for each account or API model the workers should use
(`clausona add claude:work`).

tmux 3.2 or newer, on macOS, Linux or WSL. Start the session inside a tmux pane: the workers open
as windows of that tmux session. The repository needs a remote, because workers push their
branches. Node, which clausona already needs, runs the plugin's helper script.

It needs `fleet-core`, the rules the fleet plugins share. Claude Code installs it for you; in
Codex, add it yourself.

## Install

In Claude Code:

```bash
claude plugin marketplace add larcane97/clausona
claude plugin install tmux-fleet@clausona
```

In Codex:

```bash
codex plugin marketplace add larcane97/clausona
codex plugin add fleet-core@clausona
codex plugin add tmux-fleet@clausona
```

Start each new profile once by hand (`clausona run claude:work`), so a worker doesn't stop at a
first-run question.

## Try it

In a tmux pane, start Claude Code or Codex in your repo and ask:

> Split these across my accounts in tmux: add a `--json` flag to `notes list`, and write tests for
> `src/parse.ts`.

You get a table of tasks and profiles. If you named no profile, here or in your settings, it waits
for your OK.

## What it runs, and what it won't do

The session runs git, and a helper script that comes with the plugin, `tmux-fleet.mjs`. For each
task, the script opens a tmux window labelled with the task and the profile, and types
`clausona run` into it.

tmux can't tell what an agent in a window is doing, so each worker reports it:

- A Claude Code worker gets hooks for its own session through `--settings`. The shared
  `settings.json` stays untouched.
- A Codex worker rings the terminal bell when it waits for approval or ends a turn, and a tmux hook
  on its window notes the bell.

Both write to a `.fleet-events.jsonl` file in the worker's worktree. Briefs and follow-ups go to
`.fleet-*.md` files there too. The script adds `/.fleet-*` to the repository's `.git/info/exclude`,
so none of these files is ever committed. When a worker asks whether to trust the folder, the
session answers yes, for this repository only.

It never forces a worktree removal. The script checks that the worktree is clean and the branch is
pushed, and git refuses a worktree with changes anyway. Then the worker is kept. By default nothing
is retired until you say yes.

It closes only the windows and panes it created, and leaves a worker's permission prompt to you.

If your tmux sets `bell-action none` or `current`, tmux runs no bell hook for a worker's window in
the background. A Codex worker is then noticed only after it has been quiet for three minutes.

## More

- [How it works](https://github.com/larcane97/clausona/blob/main/docs/usecases/tmux-fleet.md)
- [Guide: parallel agents in tmux](https://larcane97.github.io/clausona/guides/parallel-agents-in-tmux/)
- [clausona on GitHub](https://github.com/larcane97/clausona)
