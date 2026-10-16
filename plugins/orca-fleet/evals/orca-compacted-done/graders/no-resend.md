---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan sends the docs worker nothing that asks it to redo the task or to report again. FAIL if it sends the brief again, or a follow-up asking whether it finished or to print its DONE line again.
