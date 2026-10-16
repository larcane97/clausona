---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan shows which profile runs which task and waits for the user's OK before starting any worker, since neither the request nor the settings named profiles. FAIL if it starts workers without asking.
