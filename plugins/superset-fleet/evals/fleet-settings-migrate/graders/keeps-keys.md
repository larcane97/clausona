---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the new fleet.json keeps workers ["claude:work", "claude:glm"] and maxUsage 80, and adds retire "auto". FAIL if either old key is lost or retire is not auto.
