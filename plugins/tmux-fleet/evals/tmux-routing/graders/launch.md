---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if each worker is started with the helper's start command (`tmux-fleet.mjs start --name … --label … --worktree … --tool claude -- <profile> …`), with `--permission-mode acceptEdits` and `--strict-mcp-config` among the arguments after the profile, and no brief text on that command line. The helper itself types `clausona run <profile> -- …`, so the plan need not spell that out. FAIL if a worker starts with a bare `claude` or `codex`, by the agent's own `tmux new-window` or `send-keys` instead of the helper, or with the brief on the command line.
