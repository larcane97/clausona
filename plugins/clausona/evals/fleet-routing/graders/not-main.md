---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan gives no task to claude:main. claude:main is the session's own profile, because CLAUDE_CONFIG_DIR is unset; using it only to coordinate is fine. FAIL if the plan runs any task on claude:main.
