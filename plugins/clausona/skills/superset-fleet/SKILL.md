---
name: superset-fleet
description: Run several coding agents in parallel in Superset workspaces, each under its own clausona profile (other Claude accounts, or API models such as GLM or DeepSeek), then watch them, check their work and retire them. Use when the user wants work spread across accounts or models in Superset, when one account's limits would slow a fan-out, or says "split this across my accounts", "run these on GLM in Superset", "my account is near its limit, keep the workers going". Builds on superset:orchestrate.
---

# Superset fleet on clausona profiles

`superset:orchestrate` is the protocol: a coordinator table, one workspace per task, worker
briefs that end in a `SUPERSET_WORKER_DONE` or `SUPERSET_WORKER_BLOCKED` envelope, monitoring and
follow-ups. Load it and follow it. This skill adds what it leaves open when workers run on
different accounts: which profile each worker runs on, how to start it so it does not stall,
what to do when an account runs out, how to judge the result, and when to retire the worker.

A clausona profile is one Claude Code account or one API endpoint, with its own sign-in and
limits. Profiles share plugins and settings. `csn` is short for `clausona`.

## 1. Before anything

Stop and tell the user what is missing if any of these fails.

1. `clausona list --json` lists the profiles. Each has `name` and `configDir`. A subscription
   profile also has `quota.state`, `quota.session.usedPercent` (5H) and
   `quota.weekly.usedPercent` (7D). An API profile has `kind: "api"` and `model` instead.
2. `superset:orchestrate` is available.
3. Choose how to reach Superset:
   - If `superset auth whoami` succeeds, use the **CLI path**: the `superset` commands below,
     as orchestrate does. Check a command's `--help` before its first use, because the CLI
     changes quickly.
   - Otherwise use the **helper path**. `node <base>/scripts/superset-host.mjs status` must
     print `"ok": true`, where `<base>` is this skill's base directory.
     - The helper calls the Superset host service on this machine with the token from its
       manifest, and never prints the token.
     - Every helper command prints JSON.
     - If it says the host API has changed, stop and pass that message on.

Below, `H` means `node <base>/scripts/superset-host.mjs`. `H trust` is used on both paths.

| Step | CLI path | Helper path |
|---|---|---|
| Projects | `superset projects list --json` | `H projects` |
| Agent configs | `superset agents list --local --json` | `H agents configs` |
| New workspace | `superset ws create --local --project <id> --name <name> --branch <branch> --json` | `H workspaces create --project <id> --name <name> --branch <branch>` |
| Worktree path | `superset ws get --local <id> --json` | `H workspaces list --project <id>` (`worktreePath`) |
| Start a worker | `superset agents create --local --workspace <id> --agent <config> --prompt "<brief>" --json` | `H agents run --workspace <id> --agent <config> --prompt-file <brief file>` |
| Hand a task over | `superset agents create --local --workspace <id> --agent <config> --from-terminal <terminal> --json` | `H agents run --workspace <id> --agent <config> --from-terminal <terminal>` |
| Terminals | `superset terminals list --local --workspace <id> --json` | `H terminals list --workspace <id>` |
| Read | `superset terminals read --local --workspace <id> --terminal <terminal> --max-lines 240 --json` | `H terminals read --workspace <id> --terminal <terminal>` |
| Send | `superset terminals send --local --workspace <id> --terminal <terminal> --text "<text>" --json` | `H terminals send --workspace <id> --terminal <terminal> --text "<text>"` |
| Close | `superset terminals close --local --workspace <id> --terminal <terminal> --json` | `H terminals close --workspace <id> --terminal <terminal>` |
| Delete workspace | `superset ws delete --local <id> --json` | `H workspaces delete <id>` |

## 2. Profiles as Superset agents

A worker runs on a profile through a Superset agent config whose command is
`clausona run <profile> -- <claude args>`. List the configs and match each one's `args[1]` to a
profile.

- **Model and effort** go in the config's args, for example `--model claude-sonnet-5-5 --effort high`.
  Superset ignores a launch's model and effort for custom configs. Profiles share
  `settings.json`, so a worker without them runs the orchestrator's default model.
- **Permission mode**: ask the user which one their workers should run with, if no config
  shows it already. With `acceptEdits`, the user approves commands in the worker's tab.
- **API profiles** (`kind: "api"`) also get `--strict-mcp-config` and a short `--tools` list,
  for example `--tools=Bash,Read,Edit,Write,Grep,Glob`. This keeps tool definitions out of a
  small context window.
- **Label**: `<Tool> · <profile> (<model>)`, for example `Claude · work (Sonnet 5.5)`.

When a profile the plan needs has no config:

- **CLI path**: the CLI cannot add one. Give the user the label, the command (the output of
  `command -v clausona`) and the args, to add under Superset → Settings → Agents, and wait.
- **Helper path**: show the user the config. Only after they agree, run
  `H agents add-config --label "<label>" --profile <profile> --command "$(command -v clausona)" -- <claude args>`.

## 3. Routing tasks to profiles

Add a `profile` column to orchestrate's coordinator table, and fill it by these rules:

- **The orchestrator's own profile is never a worker.** That is the profile whose `configDir`
  equals `$CLAUDE_CONFIG_DIR`, or `~/.claude` when the variable is unset. It coordinates
  only. (`isActive` in the list is something else: the profile `clausona use` picked.)
- **Skip profiles near or past their limits.** Never use a subscription profile whose
  `quota.state` is not `ok`, or whose 5H or 7D usage is 90% or more.
- **Prefer headroom.** Pick the profile with the most room left, and spread the workers so no
  one profile carries most of them.
- **Send wide, mechanical work to API profiles**, with small, explicit briefs: the file, the
  function, the change, and the command that checks it. Long exploratory briefs overflow
  their context.
- **Verification (section 6) runs on a third profile**, neither the worker's nor the
  orchestrator's.

Show the user the table, with each task's profile, before starting the workers.

## 4. Starting a worker

For each task: create the workspace, trust its worktree for the worker's profile, then start
the worker. Name the workspace `<short task> · <profile label>`, for example
`Paths · work (Opus 5.5)`, so the Superset sidebar shows which account runs where. Keep it
under 26 characters: the sidebar cuts longer names.

1. **Trust.** Superset does not pre-trust folders for custom configs, so a fresh worktree stops
   at Claude Code's folder-trust prompt.
   - Run `H trust --config-dir <profile configDir> --path <worktree path>`, wait 3 seconds,
     then run it again with `--check`.
   - If `trusted` is false, repeat.
   - A Claude Code that is starting rewrites that file and can drop an entry written just
     before. So start workers on the same profile one at a time, each after the previous one
     shows its first output.
   - A profile's first Claude Code session can stop at one-time questions, such as an API-key
     profile's "Detected a custom API key" (the answer must be Yes) or a Claude in Chrome
     notice. Before a profile's first worker, ask the user to start it once by hand
     (`clausona run <profile>`) and answer them. If a worker's screen shows such a question,
     tell the user, or answer it yourself when the highlighted default is the safe choice.
2. **The brief.** Write it to a file and start the worker with it. Besides the task, every
   brief says:
   - Work only in this worktree and branch. When done, commit and push the branch
     (`git push -u origin HEAD`).
   - Do not start other agents: no subagents, no `claude -p`, no review skills, no background
     agents.
   - End with orchestrate's DONE or BLOCKED envelope.
3. **Record** in the table: the workspace id, the terminal id (`sessionId`), the branch and the
   profile.
   The terminals listing shows each running agent with `account.directory`, the config dir it
   really runs on; check that it is the profile you chose.

The user can open any worker's tab in Superset, read along and type into it at any time.

## 5. When an account runs out

Read the workers as orchestrate does. Suppose a worker's screen shows a usage-limit or
rate-limit stop that will not clear soon:

1. Pick another profile by the rules in section 3.
2. Trust the worktree for that profile.
3. Hand the task over in the same workspace ("Hand a task over" in the table), using that
   profile's config and the stopped worker's terminal.
4. Close the old terminal and update the table.

## 6. Judging a worker done

A DONE envelope is a claim. Before marking a task completed, in its worktree:

- `git log --oneline <base>..HEAD` shows the work.
- `git status --porcelain` prints nothing.
- `git status -sb` shows the branch is not ahead of its upstream.
- Read the diff against what the brief asked.
- Run the brief's check commands yourself.
- For risky changes, also run a blind checker on a third profile, from the worktree:
  `clausona run <profile> -- -p "<checker prompt>" --model <model> --tools=Bash,Read,Grep,Glob --output-format json`.
  Its prompt lists the brief's acceptance criteria and asks for a verdict on each.

If something is missing, send the worker a follow-up that names each unmet criterion. In the
report, keep what you checked apart from what the worker claimed.

## 7. Retiring workers

Retiring a worker deletes its Superset workspace. That stops the agent, closes its terminals
and removes its worktree. The branch stays. Superset removes the worktree **even when it holds
uncommitted work**, so these conditions are the only guard.

A worker is retirable only when all three hold, checked again immediately before deleting:

1. The task was judged complete (section 6).
2. Its branch is pushed or merged: no commits ahead of its upstream.
3. `git status --porcelain` in its worktree prints nothing.

The retire mode is the first of these that applies:

1. What the user said in this conversation, such as "retire them when they're done" or "keep
   the workers".
2. `~/.clausona/superset-fleet.json`, for example `{"retire": "auto"}`.
3. The default, `ask`.

What each mode does:

- **`ask`**: at the end, list the retirable workers and retire the ones the user approves.
- **`auto`**: say at the start that finished workers will be retired, then retire each one as
  soon as it is retirable.

A worker that is not retirable is never retired; report why. After deleting, confirm the
worktree directory is gone.

If the user asks to change the default ("always retire finished workers", "stop retiring
them"), write `{"retire": "auto"}` or `{"retire": "ask"}` to `~/.clausona/superset-fleet.json`.

## 8. Final report

One line per task:

- profile and model;
- workspace and branch;
- verdict: checked, or only claimed;
- retired or kept, and why.
