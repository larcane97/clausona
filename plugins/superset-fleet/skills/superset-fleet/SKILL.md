---
name: superset-fleet
description: Run several coding agents in parallel in Superset workspaces, each under its own clausona profile (another Claude Code or Codex account, or an API model such as GLM or DeepSeek), then watch them, check their work and retire them. Use when the user wants work spread across accounts or models in Superset, when one account's limits would slow a fan-out, or says "split this across my accounts", "run these on GLM in Superset", "my account is near its limit, keep the workers going". Builds on superset:orchestrate.
---

# Superset fleet on clausona profiles

`superset:orchestrate` (in Claude Code) or `superset-orchestrate` (in Codex) is the protocol: a
coordinator table, one workspace per task, worker briefs that end in a `SUPERSET_WORKER_DONE` or
`SUPERSET_WORKER_BLOCKED` envelope, monitoring and follow-ups. Load it and follow it. `fleet-core`
holds the clausona rules: which profile runs each worker, launch arguments, limits, judging,
retiring and the report. This skill adds the Superset steps.

## 0. Load the shared rules

Load the `fleet-core` skill first and follow it. In Claude Code, invoke it with the Skill tool. If
that fails, or you run in Codex, read the first of these files that exists, where `<base>` is this
skill's base directory:

- `<base>/../../../fleet-core/skills/fleet-core/SKILL.md`
- `<base>/../../../../fleet-core/*/skills/fleet-core/SKILL.md` (if several versions match, read the
  highest)

If none exists, stop and tell the user to install it: `claude plugin install fleet-core@clausona`
in Claude Code, or `codex plugin add fleet-core@clausona` in Codex.

## 1. Reaching Superset

Stop and tell the user what is missing if any of these fails.

1. `superset:orchestrate` (Claude Code) or `superset-orchestrate` (Codex) is available.
2. Choose how to reach Superset:
   - If `superset auth whoami` succeeds, use the **CLI path**: the `superset` commands below, as
     orchestrate does. Check a command's `--help` before its first use, because the CLI changes
     quickly.
   - Otherwise use the **helper path**. `node <base>/scripts/superset-host.mjs status` must print
     `"ok": true`.
     - The helper calls the Superset host service on this machine with the token from its
       manifest, and never prints the token.
     - Every helper command prints JSON.
     - If it says the host API has changed, stop and pass that message on.

Below, `H` means `node <base>/scripts/superset-host.mjs`. `H trust`, `H terminals wait` and
`H workspaces delete` are used on both paths.

| Step | CLI path | Helper path |
|---|---|---|
| Projects | `superset projects list --json` | `H projects` |
| Agent configs | `superset agents list --local --json` | `H agents configs` |
| New workspace | `superset ws create --local --project <id> --name <name> --branch <branch> --json` | `H workspaces create --project <id> --name <name> --branch <branch>` |
| Worktree path | `superset ws get --local <id> --json` | `H workspaces list --project <id>` (`worktreePath`) |
| Start a worker | `superset agents create --local --workspace <id> --agent <config> --prompt "$(cat <brief file>)" --json` | `H agents run --workspace <id> --agent <config> --prompt-file <brief file>` |
| Hand a task over | `superset agents create --local --workspace <id> --agent <config> --from-terminal <terminal> --json` | `H agents run --workspace <id> --agent <config> --from-terminal <terminal>` |
| Terminals | `superset terminals list --local --workspace <id> --json` | `H terminals list --workspace <id>` |
| Read | `superset terminals read --local --workspace <id> --terminal <terminal> --max-lines 240 --json` | `H terminals read --workspace <id> --terminal <terminal>` |
| Send | `superset terminals send --local --workspace <id> --terminal <terminal> --text "$(cat <text file>)" --json` | `H terminals send --workspace <id> --terminal <terminal> --text-file <text file>` |
| Close | `superset terminals close --local --workspace <id> --terminal <terminal> --json` | `H terminals close --workspace <id> --terminal <terminal>` |
| Wait for workers | `H terminals wait --workspace <id> --terminal <terminal> … --seen <mark> …` | same |
| Delete workspace | `H workspaces delete <id>` | same |

Write every brief and follow-up to a file and pass the file, as the table does. Start each one with
a word, not `-` or `---`: Claude Code reads a brief that starts with `-` as an option, and the
helper refuses one.

## 2. Profiles as Superset agents

A worker runs on a profile through a Superset agent config whose command is
`clausona run <profile> -- <args>`. List the configs and match each one's `args[1]` to a profile.

- **Claude Code configs** take the arguments from `fleet-core` section 4. Superset ignores a
  launch's model and effort for custom configs, so they go in the config's args.
- **Codex configs** take `-s <sandbox> -a <policy> -c check_for_update_on_startup=false -c mcp_servers={}`,
  with the sandbox and policy from `fleet-core` section 4, plus `-m` and
  `-c model_reasoning_effort=…` when wanted. Leave hooks on, unlike in `fleet-core`
  section 4: in a Superset terminal, the `codex` that clausona starts goes through Superset's
  wrapper, which turns hooks on and reports each turn's end to Superset. That is what
  `H terminals wait` reads.
- **Label**: `<Tool> · <profile> (<model>)`, for example `Claude · work (Sonnet 5.5)` or
  `Codex · personal (GPT-5.5)`.

When a profile the plan needs has no config:

- **CLI path**: the CLI cannot add one. Give the user the label, the command (the output of
  `command -v clausona`) and the args, to add under Superset → Settings → Agents, and wait.
- **Helper path**: show the user the config. Only after they agree, run
  `H agents add-config --label "<label>" --profile <profile> --command "$(command -v clausona)" -- <args>`.

## 3. Starting a worker

For each task: create the workspace, make its worktree trusted for the worker's profile, then
start the worker. Name the workspace `<short task> · <profile label>`, for example
`Paths · work (Opus 5.5)`, so the Superset sidebar shows which account runs where. Keep it under 26
characters: the sidebar cuts longer names.

1. **Trust.**
   - **Claude Code profiles:** before starting, run
     `H trust --config-dir <profile configDir> --path <worktree path>`, wait 3 seconds, then run it
     again with `--check`. If `trusted` is false, repeat. Never skip this: a worker that meets the
     trust question sits there, and Enter picks "No, exit".
   - A Claude Code that is starting rewrites that file and can drop an entry written just before.
     So start workers on the same profile one at a time, each after the previous one shows its
     first output.
   - **Codex profiles:** after starting, read the worker's screen. If it asks "Trust this
     folder?" about this repository, send Enter with `H terminals send --workspace <id> --terminal <terminal> --text ''`:
     the highlighted answer is "Trust and continue".
2. **The brief.** Write it to a file, as `fleet-core` section 5 says, and start the worker with it.
3. **Record** in the table: the workspace id, the terminal id (`sessionId`), the branch and the
   profile. The terminals listing shows each running agent with `account.directory`, the config dir
   it really runs on; check that it is the profile you chose.

The user can open any worker's tab in Superset, read along and type into it at any time.

## 4. Waiting

After starting the workers, and after handling each event, run `H terminals wait` with a
`--workspace` and a `--terminal` for every worker whose task is not finished. After a hand-over,
use the new terminal's id. A shell tab or an agent the user opened in the same workspace then does
not count. In Claude Code, run it as a background task. In Codex, run it in the foreground with
`--timeout 180`.

It returns as soon as one worker needs you. It judges this from Superset's record of each agent's
last hook event, not from the screen, for Claude Code and Codex workers alike:

- `stopped`: its turn ended. Read its screen (`fleet-core` section 8).
- `quiet`: no event for 5 minutes. Read its screen. It is often a permission prompt or a startup
  question: never answer a permission prompt yourself.
- `gone`: its terminal exited.
- `timeout`: nothing for the whole timeout. Read the screens, then wait again.

Each `stopped` and `quiet` result carries a `seen` mark. Pass back every mark you have handled, as
`--seen <mark>`, in every later wait. Otherwise a worker waiting at a prompt, or one that has not
yet picked up your follow-up, makes each wait return at once.

## 5. When an account runs out

Pick another profile by `fleet-core` section 3.

- **Same tool:** make the worktree trusted for the new profile (section 3), then hand the task over
  in the same workspace ("Hand a task over" in the table). Use that profile's config and the stopped
  worker's terminal.
- **Other tool:** start a new worker in the same workspace with the brief and the hand-over
  paragraph from `fleet-core` section 9.

Then close the old terminal, record the new terminal id, and wait on it from now on.

## 6. Retiring

Retiring a worker deletes its Superset workspace. That stops the agent, closes its terminals and
removes its worktree, **even when it holds uncommitted work**. Delete only with
`H workspaces delete <id>`, on both paths. Right before it deletes, it checks `fleet-core`
section 11's conditions 2 and 3 itself, and refuses when either fails. `superset ws delete` checks
nothing. After deleting, confirm the worktree directory is gone.
