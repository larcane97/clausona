---
name: herdr-fleet
description: Run several coding agents in parallel in herdr panes, each under its own clausona profile (another Claude Code or Codex account, or an API model such as GLM or DeepSeek), then watch them, check their work and retire them. Use when the user works in herdr and wants work spread across accounts or models, when one account's limits would slow a fan-out, or says "split this across my accounts in herdr", "run these on DeepSeek in herdr".
---

# herdr fleet on clausona profiles

herdr runs agents in panes and shows their state in its sidebar. clausona puts each pane's agent on
the profile you choose.

## 0. Load the shared rules

Load the `fleet-core` skill first and follow it; this skill only adds the herdr steps. In Claude
Code, invoke it with the Skill tool. If that fails, or you run in Codex, read the first of these
files that exists, where `<base>` is this skill's base directory:

- `<base>/../../../fleet-core/skills/fleet-core/SKILL.md`
- `<base>/../../../../fleet-core/*/skills/fleet-core/SKILL.md`

If none exists, stop and tell the user to install it: `claude plugin install fleet-core@clausona`
in Claude Code, or `codex plugin add fleet-core@clausona` in Codex.

## 1. Before anything

Stop and tell the user what is missing if any of these fails.

1. You run inside a herdr pane: `HERDR_ENV` is `1` (`test "${HERDR_ENV:-}" = 1`; in PowerShell,
   `$env:HERDR_ENV -eq '1'`). herdr's CLI talks to the session of the pane it runs in. Do not
   control herdr from outside it.
2. `herdr status` shows a running server. Before a command group's first use, run the group alone
   (`herdr worktree`, `herdr agent`, `herdr pane`) to see its current syntax. Never run bare
   `herdr`: it starts the interface.
3. The repo has a remote: workers push their branches.

herdr commands print JSON. Read ids and paths from it; never guess them. herdr runs on macOS, Linux
and Windows, and the commands below are the same on each.

## 2. Starting a worker

For each task, after `fleet-core` picked its profile:

1. **Worktree.** `herdr worktree create --cwd <repo> --branch fleet/<task> --label "<task> · <profile>" --no-focus`.
   Keep the label under 26 characters, so the sidebar shows which account runs where. Record
   `.result.workspace.workspace_id`, `.result.root_pane.pane_id` and `.result.worktree.path`. The
   worktree lands under `~/.herdr/worktrees/`.
2. **Start.** `herdr pane run <pane> "clausona run <profile> -- <args>"`, with the arguments from
   `fleet-core` section 4. Codex workers keep `--disable hooks`.
3. **Name it.** `herdr agent rename <pane> <name>`, with a name such as `w1-docs`: lowercase letters,
   digits, `-` or `_`, starting with a letter, up to 32 characters. Use the name from now on.
4. **Check it started.** Within 20 seconds, `herdr agent list` shows the pane with agent `claude` or
   `codex`. If not, read the pane (`herdr pane read <pane> --source recent-unwrapped --lines 60`).
   If the launch line never ran, for example because the shell was still starting, run it once more.
   Otherwise tell the user what the screen shows.
5. **Folder trust.** The first worker of a profile in a repo that profile never trusted asks
   whether to trust the folder, and herdr shows it as `blocked`. Read the screen
   (`herdr agent read <name> --source visible`) and answer only that question, and only about
   this repository:
   - Claude Code ("Is this a project you created or one you trust?"): the highlighted answer is
     "No, exit". Send `herdr agent send-keys <name> down enter`.
   - Codex ("Trust this folder?"): the highlighted answer is "1. Trust and continue". Send
     `herdr agent send-keys <name> enter`.

   Then `herdr agent wait <name> --until idle --until done --timeout 60000`. A plain
   `agent wait` right after the keys returns the old `blocked` state.
6. **Brief.** Write it as `fleet-core` section 5 says, then send and wait in one command:
   `herdr agent prompt <name> "Read .fleet-brief.md in this folder and do what it says." --wait --timeout 1800000`.
   In Claude Code, run it as a background task (section 3).
7. **Record** the name, pane, workspace, worktree, branch and profile in the table.

Start workers on the same Claude Code profile one at a time, each after the previous one shows its
first output.

The user can switch to any worker's pane in herdr, read along and type into it at any time.

## 3. Waiting and reading

- **Send and wait:** every brief and follow-up goes out as
  `herdr agent prompt <name> "<one line>" --wait --timeout 1800000`. It waits until the worker has
  started its turn and then settles: `done` or `idle` when the turn ended, `blocked` at a prompt
  or question. Do not send with a plain `agent prompt` and then call `agent wait`: a worker that
  has not picked up the prompt yet is still `idle`, and the wait returns at once.
- **Until it works again** (a worker the user is answering):
  `herdr agent wait <name> --until working --timeout 1800000`, then
  `herdr agent wait <name> --until idle --until done --until blocked --timeout 1800000`.
- **Read:** `herdr agent read <name> --source recent-unwrapped --lines 120`. If the reply scrolled
  away, use `--source visible`.
- **Follow-up:** write the file, then
  `herdr agent prompt <name> "Read .fleet-followup-<n>.md in this folder and do what it says." --wait --timeout 1800000`.
  `agent prompt` refuses an agent at a prompt (`agent_blocked`); read its screen first.

A `timeout` or `agent_prompt_stalled` does not prove a prompt was lost. Read the screen before
sending again.

## 4. When an account runs out

1. `herdr pane split <old pane> --direction down --cwd <worktree> --no-focus`, and read the new
   pane id.
2. Start the new profile there, as in section 2, steps 2 to 6, with `fleet-core` section 9's brief.
3. `herdr pane close <old pane>`.

## 5. Retiring

After `fleet-core` section 11's checks, run `herdr worktree remove --workspace <id>`. Never add
`--force`. herdr refuses a worktree with changes (`dirty_worktree_requires_force`); then keep the
worker and report why. When it succeeds, it closes the workspace and its panes and keeps the
branch. Confirm the worktree directory is gone.

Never close panes, tabs or workspaces you did not create. The workspace herdr opened for the repo
itself stays.
