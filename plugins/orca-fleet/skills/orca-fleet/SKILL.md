---
name: orca-fleet
description: Run several coding agents in parallel in Orca worktrees, each under its own clausona profile (another Claude Code or Codex account, or an API model such as GLM or DeepSeek), then watch them, check their work and retire them. Use when the user works in Orca and wants work spread across accounts or models, when one account's limits would slow a fan-out, or says "split this across my accounts in Orca", "run these on DeepSeek in Orca".
---

# Orca fleet on clausona profiles

Orca runs agents side by side in git worktrees and lists them in its sidebar. clausona puts each
terminal's agent on the profile you choose.

## 0. Load the shared rules

Load the `fleet-core` skill first and follow it; this skill only adds the Orca steps. In Claude
Code, invoke it with the Skill tool. If that fails, or you run in Codex, read the first of these
files that exists, where `<base>` is this skill's base directory:

- `<base>/../../../fleet-core/skills/fleet-core/SKILL.md`
- `<base>/../../../../fleet-core/*/skills/fleet-core/SKILL.md`

If none exists, stop and tell the user to install it: `claude plugin install fleet-core@clausona`
in Claude Code, or `codex plugin add fleet-core@clausona` in Codex.

## 1. Before anything

Stop and tell the user what is missing if any of these fails.

1. `orca status` shows `runtimeReachable: true`. If Orca is not open, ask the user to open it.
2. `orca repo list --json` lists the repo. If not, ask before adding it with
   `orca repo add --path <repo> --json`: it adds the repo to the user's Orca sidebar.
3. The repo has a remote: workers push their branches.

Pass `--json` and read handles and paths from the reply; never guess them. Orca runs on macOS,
Linux and Windows, and the commands below are the same on each.

Orca has its own account switcher and orchestration commands. Do not use them for workers:
`clausona run` decides each worker's account. Orca also sets `CODEX_HOME` in its terminals, so a
bare `codex` there runs on Orca's account; `clausona run` overrides it.

## 2. Starting a worker

For each task, after `fleet-core` picked its profile:

1. **Worktree.** `orca worktree create --repo path:<repo> --name fleet-<task> --json`, and record
   `.result.worktree.path` (under `~/orca/workspaces/` by default). Then
   `orca worktree set --worktree path:<worktree> --display-name "<task> · <profile>"`, so the
   sidebar shows which account runs where. Keep it under 26 characters.
2. **Terminal.** `orca terminal create --worktree path:<worktree> --json`, and record
   `.result.terminal.handle`. Do not pass `--command`: the shell's start-up output can swallow it.
   Do not rely on `--title` either: the shell renames the tab.
3. **Wait for the shell.** Read `orca terminal show --terminal <handle> --json` once a second until
   its `lastOutputAt` is at least two seconds old, for at most 20 seconds. `orca terminal wait`
   does not work for a plain shell.
4. **Start.** `orca terminal send --terminal <handle> --text "clausona run <profile> -- <args>" --enter`,
   with the arguments from `fleet-core` section 4. Codex workers keep `--disable hooks`.
5. **Check it started.** After about 10 seconds, read the screen:
   `orca terminal show --terminal <handle> --json`, field `.result.terminal.preview`. It shows the
   current screen, including Claude Code's and Codex's full-screen views; `orca terminal read` does
   not. If the launch line never ran, send it once more. Otherwise tell the user what the screen
   shows.
6. **Folder trust.** The first worker of a profile in a repo that profile never trusted asks
   whether to trust the folder. Answer only that question, and only about this repository:
   - Claude Code ("Is this a project you created or one you trust?"): the highlighted answer is
     "No, exit". Send the down arrow, `orca terminal send --terminal <handle> --text $'\e[B'`
     (PowerShell: `--text "$([char]27)[B"`), then `orca terminal send --terminal <handle> --enter`.
   - Codex ("Trust this folder?"): the highlighted answer is "1. Trust and continue". Send
     `orca terminal send --terminal <handle> --enter`.
7. **Brief.** Write it as `fleet-core` section 5 says, then
   `orca terminal send --terminal <handle> --text "Read .fleet-brief.md in this folder and do what it says." --enter`,
   and start waiting on it (section 3).
8. **Record** the handle, worktree, branch and profile in the table.

Start workers on the same Claude Code profile one at a time, each after the previous one shows its
first output.

The user can open any worker's tab in Orca, read along and type into it at any time.

## 3. Waiting and reading

- **Wait:** right after each send, run
  `sleep 5; orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 1800000`
  (PowerShell: `Start-Sleep 5; orca terminal wait …`). In Claude Code, run it as a background task.
  The pause matters: right after a send the worker has not started, its screen is still idle, and
  `tui-idle` would return at once. The wait returns when the worker's screen goes idle: its turn
  ended, or it waits at a prompt.
- **Check it really stopped:** for a Claude Code worker, `orca worktree ps --json` lists the agent
  under its worktree with `state` and `lastAssistantMessage`, from Orca's hooks (clausona shares
  them across profiles). If `state` is still `working`, wait again without the pause. Codex workers
  do not appear there; read their screen.
- **Read:** `orca terminal show --terminal <handle> --json`, field `.result.terminal.preview`.
- **Follow-up:** write the file, then
  `orca terminal send --terminal <handle> --text "Read .fleet-followup-<n>.md in this folder and do what it says." --enter`,
  and wait as above.

Orca has no "until it works again" wait. For a worker the user is answering, follow `fleet-core`
section 7.

## 4. When an account runs out

1. Create a new terminal in the same worktree and start the new profile there, as in section 2,
   steps 2 to 7, with `fleet-core` section 9's brief.
2. `orca terminal close --terminal <old handle>`.

## 5. Retiring

After `fleet-core` section 11's checks, run `orca worktree rm --worktree path:<worktree> --json`.
Never add `--force`. Orca refuses a worktree with changes ("Failed to delete worktree"); then keep
the worker and report why. When it succeeds, Orca closes the worktree's terminals and **deletes its
local branch** too, so only the pushed branch remains: never retire before the push check. Confirm
the worktree directory is gone.

Never close terminals or remove worktrees you did not create.
