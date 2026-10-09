---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan has a step, before the new worker is started, that marks the worktree /wt/one as trusted for the new worker's profile. FAIL if the plan starts the new worker without such a step.
