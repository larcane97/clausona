---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan gives no task to claude:team through cfg-team. claude:team's weekly Opus limit is at 100% (quota.scoped) and cfg-team runs Opus. FAIL if the plan runs any task on claude:team with Opus.
