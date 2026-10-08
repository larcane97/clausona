---
name: fleet-core
description: Shared rules for the clausona fleet skills (superset-fleet, herdr-fleet, orca-fleet). Load it only when one of those skills tells you to; it is not a task on its own.
user-invocable: false
---

# Fleet rules shared by every runner

A fleet is one main session (Claude Code or Codex) that splits work into tasks and runs each task as
a worker: a separate Claude Code or Codex session in its own git worktree, on a clausona profile. A
profile is one account or one API endpoint, with its own sign-in and limits. Profiles of one tool
share plugins and settings. `csn` is short for `clausona`.

The runner skill that loaded this one (Superset, herdr or Orca) says how to create worktrees, start
workers, read them and remove them. This skill says everything else.

**Shells.** Commands here are written for a POSIX shell. Claude Code runs them in Bash, on Windows
too (Git Bash). Codex on Windows runs PowerShell: there, read `"$(cat <file>)"` as
`(Get-Content -Raw <file>)`, and `<cmd> </dev/null` as `$null | <cmd>`. `~` is your home
directory: `%USERPROFILE%` on Windows.

## 1. Profiles and the main session

`clausona list --json` lists the profiles.

- Every profile has `name`, `tool` (`claude` or `codex`) and `configDir`.
- A subscription profile has `quota.state`, `quota.session.usedPercent` (5H) and
  `quota.weekly.usedPercent` (7D). It can also have `quota.scoped`: a weekly limit on one model,
  named in its `label`.
- An API profile has `kind: "api"` and `model` instead. These exist for Claude Code only.

The **main tool** is the tool you run in: `claude` in Claude Code, `codex` in Codex. The **main
profile** is the one whose `configDir` equals `$CLAUDE_CONFIG_DIR` (or `~/.claude` when it is unset)
in Claude Code, or `$CODEX_HOME` (or `~/.codex`) in Codex. It coordinates and is never a worker.
(`isActive` in the list is something else: the profile `clausona use` picked.)

## 2. Settings

Read `~/.clausona/fleet.json`. If it does not exist, read `~/.clausona/superset-fleet.json`, its
older name. The keys:

- `workers`: the only profiles that may be workers, for example `["claude:work", "claude:glm"]`.
  It also bounds checkers (section 10) and hand-overs (section 9).
- `routing`: the user's own rules, in words, for example `"claude:glm never edits files under src/"`.
- `maxUsage`: the usage threshold in section 3, in percent. The default is 90.
- `retire`: `ask` (the default) or `auto` (section 11).
- `permissions`: how workers run, per tool, for example `{"claude": "acceptEdits", "codex": "on-request"}`.
  `claude` is a Claude Code permission mode. `codex` is a Codex approval policy: `untrusted`,
  `on-failure`, `on-request` or `never`.

When you need a `permissions` value that is missing, and no worker config already shows one, ask
the user once, and save it when they agree.

When the user asks to change a default ("never use claude:personal for workers", "always retire
finished workers"), update that key in `~/.clausona/fleet.json` and keep its other keys. If only
`superset-fleet.json` exists, first copy its keys into a new `fleet.json`, then change the key. Say
which file you wrote.

## 3. Choosing profiles

What the user says in this conversation comes first, then the settings file, then these defaults:

- **Same tool.** Workers use the main tool. A profile of the other tool is a worker only when the
  user names it in this conversation, or `workers` lists it.
- **Not the main profile** (section 1).
- **Skip profiles near or past their limits.** Never use a subscription profile whose
  `quota.state` is not `ok`, or whose 5H or 7D usage is at `maxUsage` or more. If its
  `quota.scoped` is at `maxUsage` or more, do not run the model in its `label` there.
- **Prefer headroom.** Pick the profile with the most room left, and spread the workers so no one
  profile carries most of them.
- **Send wide, mechanical work to API profiles**, with small, explicit briefs: the file, the
  function, the change, and the command that checks it. Long exploratory briefs overflow their
  context.
- **Checkers (section 10) run on a third profile** of the main tool: neither the worker's nor the
  main one.

If the user picks a profile these defaults would skip, such as one past its limits or the main
profile itself, use it and say what it risks.

**Before starting**, show the coordinator table (section 6) with each task's profile. If neither the
request nor the settings named a profile (in `workers` or `routing`), wait for the user's OK.
Otherwise, or if the user said to start right away, start at once. A request names profiles when it
gives a profile for any task, or says which accounts to use ("use my Claude accounts for the
rest"); the tasks it leaves open take the defaults above, and you still start at once.

## 4. Launch arguments

A worker always starts as `clausona run <profile> -- <args>`. Never start a bare `claude` or
`codex`. A runner may set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in its terminals (Orca does), and only
`clausona run` puts the worker on the profile you chose. The command line holds the profile and
flags only, never the brief.

**Claude Code workers:**

- `--permission-mode <permissions.claude>`.
- `--strict-mcp-config`, unless the task needs an MCP server. Without it, a worktree below a
  `.mcp.json` stops at Claude Code's "new MCP servers found" question, and the servers' tool
  definitions take up context.
- `--model <id>` and `--effort <level>` when the plan sets them. Profiles share `settings.json`, so
  a worker without them runs the main session's default model.
- API profiles also get `--tools=Bash,Read,Edit,Write,Grep,Glob`, to keep tool definitions out of a
  small context window.

**Codex workers:**

- `-s workspace-write -a <permissions.codex>`.
- `-c check_for_update_on_startup=false`. Otherwise Codex can open with an update question whose
  highlighted answer runs a global `npm install`.
- `-c 'mcp_servers={}'`, unless the task needs an MCP server: a worker would otherwise start every
  server in the shared config.
- `--disable hooks`, unless the runner skill says otherwise. With hooks on, Codex can stop at
  "Hooks need review", and trusting hooks is the user's call, never a worker's.
- `-m <model>` and `-c model_reasoning_effort=<level>` when the plan sets them.

**Folder trust.** Claude Code and Codex both ask once whether to trust a folder, and both key the
answer to the repository root, not the worktree: a worktree of a repo the profile already trusts
starts without asking. When a worker shows the question for the repository you are working in,
answer "trust" as the runner skill says. That is the repo the user asked you to work on.

**First run.** A profile's first session can stop at one-time notices, such as an API-key profile's
"Detected a custom API key" (the answer must be Yes) or a Claude in Chrome notice. Before a profile's
first worker, ask the user to start it once by hand (`clausona run <profile>`) and answer them. If a
worker's screen shows such a notice, answer it yourself only when its highlighted default is the
safe choice; otherwise tell the user. A permission prompt is never such a notice.

## 5. Briefs

Write every brief and follow-up to a file. Never paste one into a command line: the shell would
run any `$( )` or backticks in it. Start each one with a word, not `-`.

For herdr and Orca:

- Write the brief to `<worktree>/.fleet-brief.md`, and follow-ups to
  `<worktree>/.fleet-followup-<n>.md`.
- Make sure the line `/.fleet-*.md` is in the file `info/exclude` inside the directory that
  `git -C <worktree> rev-parse --git-common-dir` prints, so these files are never committed and
  `git status` stays clean.
- Send the worker one line: `Read .fleet-brief.md in this folder and do what it says.` (or the
  follow-up's file name).

Superset passes the brief file to its own commands (see superset-fleet).

Besides the task, every brief says:

- Work only in this worktree and branch. When done, commit and push the branch
  (`git push -u origin HEAD`).
- Do not start other agents: no subagents, no `claude -p`, no `codex exec`, no review skills, no
  background agents.
- End with the runner's DONE or BLOCKED line (section 6).

## 6. The coordinator table and the worker protocol

Keep a table with one row per task: task, profile, model, workspace, worktree, branch, worker
handle, and state (planned, running, waiting on the user, done, blocked, retired). Update it after
every event.

For herdr and Orca, a worker's last line is exactly one of:

- `FLEET_WORKER_DONE: <one-line summary>`
- `FLEET_WORKER_BLOCKED: <what it needs>`

Superset uses its own envelopes, from `superset:orchestrate` (Claude Code) or
`superset-orchestrate` (Codex).

## 7. Waiting

Never end your turn while a worker runs and nothing waits on it: no one would wake you, and the user
would have to.

- **In Claude Code**, run the runner's wait command for each unfinished worker as a background
  task. You are woken when one returns.
- **In Codex**, run one wait at a time in the foreground with a timeout of three minutes, handle
  what it returns, and wait again.

The runner skill says how to send and wait so that a wait never returns at once on a worker that
has not started its turn yet. Wait on a worker again only after you sent it something: a brief, a
follow-up, or keys. A worker that has already stopped makes most waits return at once, so waiting
on it again without sending anything only loops.

When a worker waits for the user (a permission prompt, or a question you passed on), use the
runner's "until it works again" wait if it has one. Otherwise, read that worker's screen whenever
another wait returns, or when the user says they answered. If no other worker runs, end your turn
and ask the user to tell you when they have answered.

Do not write your own loop that searches screens for a phrase. The phrase may be in the brief too,
in another language, or missing.

## 8. Reading an event

When a wait returns, read that worker's screen (the runner skill says how):

- A DONE or BLOCKED line: update the table. For DONE, go to section 10.
- A question: answer it from what you know, or ask the user.
- A permission prompt: never answer it yourself. Tell the user which worker waits, and for what.
- A usage-limit or rate-limit stop that will not clear soon: section 9.
- The folder-trust question: section 4.

## 9. When an account runs out

1. Pick another profile by section 3.
2. Start it in the same worktree (the runner skill says how). Give it the brief plus this
   paragraph: "A previous worker on another account stopped at its limit before finishing. Check
   `git status` and `git log` in this worktree, then continue the task." For herdr and Orca, write
   that to `.fleet-brief.md` again and send the one line.
3. Close the old worker. Record the new handle in the table, and wait on it from now on.

## 10. Judging a worker done

A DONE line is a claim. Before marking a task completed, in its worktree:

- `git log --oneline <base>..HEAD` shows the work.
- `git status --porcelain` prints nothing.
- `git rev-list --count @{u}..HEAD` prints 0: the branch is pushed. It fails when the branch has no
  upstream, that is, when it was never pushed.
- Read the diff against what the brief asked.
- Run the brief's check commands yourself.
- For risky changes, also run a blind checker on a third profile of the main tool, from the
  worktree. Write its prompt to a file: the brief's acceptance criteria, and a request for a
  verdict on each. Then run:
  - Claude Code: `clausona run <profile> -- -p "$(cat <file>)" --model <model> --tools=Bash,Read,Grep,Glob --output-format json`
  - Codex: `clausona run <profile> -- exec -s read-only "$(cat <file>)" </dev/null`. Keep stdin
    closed: `codex exec` otherwise waits for more input and never starts.

If something is missing, send the worker a follow-up that names each unmet criterion. In the
report, keep what you checked apart from what the worker claimed.

## 11. Retiring workers

Retiring removes a worker's worktree and its runner workspace. A worker is retirable only when all
three hold:

1. Its task was judged complete (section 10).
2. Its branch has an upstream, and no commits ahead of it.
3. `git status --porcelain` in its worktree prints nothing.

Check 2 and 3 right before removing. Condition 2 is what keeps the work: some runners delete the
local branch together with the worktree (Orca does), and then only the pushed branch remains. Remove
only with the command the runner skill names, never with `--force` or any other option that removes
a worktree holding changes. After removing, confirm the worktree directory is gone.

The retire mode is the first of these that applies:

1. What the user said in this conversation, such as "retire them when they're done" or "keep the
   workers".
2. `retire` in the settings.
3. The default, `ask`.

- **`ask`**: at the end, list the retirable workers and retire the ones the user approves.
- **`auto`**: say at the start that finished workers will be retired, then retire each one as soon
  as it is retirable.

A worker that is not retirable is never retired; report why.

## 12. Final report

One line per task:

- profile and model;
- workspace and branch;
- verdict: checked, or only claimed;
- retired or kept, and why.
