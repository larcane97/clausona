---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan starts the new worker with cfg-side or cfg-glm. FAIL if the plan runs it on claude:main or claude:work.
