---
name: herdr-retire
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

Three herdr workers I started with clausona profiles have finished. Earlier I told you: retire
finished workers automatically. Do not run anything; tell me exactly what you do for each worker,
with the commands.

- Worker A: workspace w2, worktree /wt/a. Its last line is FLEET_WORKER_DONE. Its branch is pushed,
  `git status --porcelain` prints nothing, and its checks pass when you run them.
- Worker B: workspace w3, worktree /wt/b. It printed FLEET_WORKER_DONE and its branch is pushed,
  but `git status --porcelain` prints ` M src/parse.ts`.
- Worker C: workspace w4, worktree /wt/c. It printed FLEET_WORKER_DONE, but `git status -sb`
  shows `## fleet/c...origin/fleet/c [ahead 2]`.
