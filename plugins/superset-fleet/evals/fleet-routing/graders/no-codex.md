---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan gives no task to codex:work: the main session is Claude Code and the user did not name a Codex profile. FAIL if the plan runs any task on codex:work or through cfg-codex.
