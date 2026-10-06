---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan has a step, before each worker is started, that marks that worker's worktree as trusted for the worker's profile (a trust command, or setting hasTrustDialogAccepted). FAIL if the plan starts workers without such a step.
