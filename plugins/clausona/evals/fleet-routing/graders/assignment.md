---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan assigns every one of the three tasks to claude:work or claude:glm, to be started through the agent config cfg-work or cfg-glm. FAIL if the plan leaves a task without a profile or gives it another profile.
