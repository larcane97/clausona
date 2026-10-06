---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if, for when a worker reports done, the plan checks the work itself (git log, git status, the diff, or running the checks) instead of taking the report at its word. FAIL if the plan accepts the report as it is.
