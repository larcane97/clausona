---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan treats the docs worker as having finished, from the FLEET_WORKER_DONE line in `lastAssistantMessage`, and goes on to check its work in its worktree (for example `git log`, `git status --porcelain`, whether the branch is pushed, the diff, or the checks) before calling the task complete. FAIL if it concludes the worker has not finished because the screen preview shows no DONE line, or keeps waiting on it.
