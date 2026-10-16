---
name: tmux-fleet
description: Run several coding agents in parallel in tmux windows, each under its own clausona profile (another Claude Code or Codex account, or an API model such as GLM or DeepSeek), then watch them, check their work and retire them. Use when the user works in tmux, on their own machine or over SSH, and wants work spread across accounts or models, when one account's limits would slow a fan-out, or says "split this across my accounts in tmux", "run these on DeepSeek in tmux windows".
---

# tmux fleet on clausona profiles

tmux runs each worker in a window of the session you are in, and its status bar lists them.
clausona puts each window's agent on the profile you choose. tmux cannot tell what an agent is
doing, so the helper that ships with this skill gives each worker a way to report it, and waits on
those reports.

## 0. Load the shared rules

Load the `fleet-core` skill first and follow it; this skill only adds the tmux steps. In Claude
Code, invoke it with the Skill tool. If that fails, or you run in Codex, read the first of these
files that exists, where `<base>` is this skill's base directory:

- `<base>/../../../fleet-core/skills/fleet-core/SKILL.md`
- `<base>/../../../../fleet-core/*/skills/fleet-core/SKILL.md` (if several versions match, read the
  highest)

If none exists, stop and tell the user to install it: `claude plugin install fleet-core@clausona`
in Claude Code, or `codex plugin add fleet-core@clausona` in Codex.

## 1. Before anything

Below, `H` means `node <base>/scripts/tmux-fleet.mjs`. Write it out in full, or start the command
with the function `H() { node <base>/scripts/tmux-fleet.mjs "$@"; }`. Never put it in a variable:
zsh does not split a variable into words. Every `H` command prints JSON, except `H read`, which
prints the screen. Read window and pane ids from the JSON; never guess them.

Stop and tell the user what is missing if any of these fails.

1. `H status` prints `"ok": true`. It fails outside tmux: the helper drives the tmux session you
   run in, so do not drive tmux from outside it. In Codex, `TMUX` also looks unset when Codex hides
   the environment (`fleet-core`, Shells). If it does, do not tell the user they are outside tmux:
   tell them to start Codex again in this pane with `-c shell_environment_policy.inherit=all`.
   tmux runs on macOS, Linux and WSL. On Windows without WSL there is no tmux: suggest herdr-fleet
   or orca-fleet.
2. Pass on any `warnings` it prints. With `bell-action` set to `none` or `current` in the user's
   tmux (or `other`, while the user looks at that window), a Codex worker is noticed only by the
   quiet check (section 3).
3. The repo has a remote: workers push their branches.

## 2. Starting a worker

For each task, after `fleet-core` picked its profile:

1. **Worktree.** `git -C <repo> worktree add -b fleet/<task> ~/.clausona/worktrees/<repo name>/<task>`,
   where `<repo name>` is the name of the repo's folder. It branches from the commit the repo has
   checked out; add the base after the path if the user named one. If the branch or the path
   exists already, pick another task word.
2. **Start.** `H start --name <name> --label "<task> · <profile>" --worktree <worktree> --tool <claude|codex> -- <profile> <args>`,
   with the arguments from `fleet-core` section 4. Codex workers keep `--disable hooks`.
   - The name, such as `w1-docs`, is lowercase letters, digits, `-` or `_`, starts with a letter
     and has 32 characters at most. Use it from now on.
   - Keep the label to 20 characters or fewer, with a short task word such as `docs · ds-flash`:
     the status bar cuts longer names, and the profile at the end shows which account runs where.
   - It opens a window in your session without switching to it, gives the worker its way to
     report (below), and types `clausona run <profile> -- <args> …` into the window's shell.
     Record `.window` and `.pane`.
3. **Check it started.** About 10 seconds later, run `H read --name <name> --lines 40`. The tool has
   started when the screen shows its banner, its prompt or the trust question. If the screen still
   shows the shell and an error, tell the user what it says. Never type the launch line again into
   a screen that shows the tool: it would become the worker's first prompt.
4. **Folder trust.** The first worker of a profile in a repo that profile never trusted asks
   whether to trust the folder. Answer only that question, and only about this repository:
   - Claude Code ("Is this a project you created or one you trust?"): the highlighted answer is
     "No, exit". Send `H send --name <name> --keys Down Enter`.
   - Codex ("Trust this folder?"): the highlighted answer is "1. Trust and continue". Send
     `H send --name <name> --keys Enter`.

   Then read the screen again, until it shows the tool's prompt.
5. **Brief.** Write it as `fleet-core` section 5 says, then
   `H send --name <name> --text "Read .fleet-brief.md in this folder and do what it says."` and
   wait (section 3). In Codex, wait only once every worker has its brief.
6. **Record** the name, window, pane, worktree, branch and profile in the table.

Start workers on the same Claude Code profile one at a time, each after the previous one shows its
first output.

The user can switch to any worker's window (the tmux prefix, then the window's number), read along
and type into it at any time.

**How a worker reports.** A Claude Code worker gets `--settings <worktree>/.fleet-claude.json`: hooks
for that session only, on top of the shared settings, which record when a turn starts, ends or
fails, when it stops at a permission prompt, and when the session ends. A Codex worker gets
`-c tui.notifications=true -c tui.notification_method=bel -c tui.notification_condition=always`:
it rings the terminal bell when it waits for approval and when a turn ends, and a tmux hook on its
window records the bell. The records go to `<worktree>/.fleet-events.jsonl`. The helper adds
`/.fleet-*` to the repo's `info/exclude`, so none of these files, and no brief, is ever committed.

## 3. Waiting and reading

- **Wait:** in Claude Code, run `H wait --name <name>` as a background task for each worker whose
  task is not finished: right after you send it something, and again after you handle what its
  wait returned. You are woken when one returns. One wait per worker is enough; a second one does
  no harm, since each event is reported by one wait only. In Codex, see the last item below. A wait
  returns as soon as its worker needs you, with the worker's `name` and an `event`:
  - `stopped`: its turn ended. `message` holds a Claude Code worker's last reply, or its last 8000
    characters when it is longer. Look for the DONE or BLOCKED line there first. When `message` is
    missing or has none, use `fleet-core`'s `last-reply.mjs`, then the screen (`fleet-core`
    section 8).
  - `failed`: its turn ended on an API error, such as a usage or rate limit; `message` says which.
    For a limit that will not clear soon, see section 4.
  - `blocked`: it waits at a permission prompt or a question in a dialog. Read its screen.
  - `bell`: a Codex worker ended its turn or waits for approval. Read its screen to see which.
  - `idle`: a Claude Code worker has sat at its prompt for a minute without ending a turn. The user
    turned its prompt down, or your line never reached it. Read its screen.
  - `ended`: its session ended. Read its screen.
  - `quiet`: it should be working, but has printed nothing for three minutes and reported nothing.
    Read its screen: it is often a prompt or a question that nothing reported.
  - `gone`: its window or pane is gone; someone closed it. `H retire` needs the window, so keep
    the worker: report it with its worktree and branch, and let the user decide.
  - `timeout`: nothing happened for 30 minutes. Read the screens, then wait again.

  Each event is reported once, so a wait never returns at once on an event you already handled.
  Keep a worker that waits on the user in the wait: its next event comes when it ends its turn or
  stops at another prompt, or, if the user turned the prompt down with Esc, a minute later as
  `idle`.
- **Read:** `H read --name <name> --lines 120`.
- **Follow-up:** read the screen first, then write the file and send
  `H send --name <name> --text "Read .fleet-followup-<n>.md in this folder and do what it says."`,
  and wait. A worker at a prompt or in a dialog needs keys, not text: typed letters and digits
  would answer it. `H send --text` refuses a Claude Code worker that waits at a permission prompt;
  check a Codex worker's screen yourself.
- **A question in a dialog**, such as a list to pick from: answer it with keys, for example
  `H send --name <name> --keys Down Enter`, only when you know the answer. Otherwise ask the user.
  A permission prompt is never yours to answer: tell the user which worker waits, and for what.
- **In Codex** (one foreground wait at a time, three minutes each): give every worker its brief
  before you wait on any. Then run `H wait --name <a> --name <b> … --timeout 180`, handle what it
  returns, and wait again.

Do not loop over `H read` yourself, looking for a phrase.

## 4. When an account runs out

1. `H start --name <name> --handover --label "<task> · <new profile>" --tool <claude|codex> -- <new profile> <args>`.
   It opens a new pane in the worker's window, in the same worktree, and starts the new profile
   there. It also renames the window to the new label, so the status bar names the new account.
   Record `.pane`; `.replaces` is the old pane.
2. Check that it started, answer the trust question, and give it `fleet-core` section 9's brief, as
   in section 2, steps 3 to 5.
3. `tmux kill-pane -t <the .replaces id>`. The worker keeps its name: wait on it as before.

## 5. Retiring

After `fleet-core` section 11's checks, run `H retire --name <name>`. Right before it removes
anything, it checks again that the worktree is clean and the branch pushed. Then it runs
`git worktree remove` without `--force`, closes the worker's window and keeps the branch. When it
refuses, keep the worker and report why. When it succeeds, its JSON says `"removed": true`, and it
has checked that the worktree directory is gone.

Never remove a worktree any other way, and never with `--force`. Never close windows or panes you
did not create. The window you run in stays.
