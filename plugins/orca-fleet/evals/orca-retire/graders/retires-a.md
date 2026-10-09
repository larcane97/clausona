---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan removes worker A with `orca worktree rm --worktree path:/wt/a` after checking it. FAIL if A is kept without a reason or removed another way.
