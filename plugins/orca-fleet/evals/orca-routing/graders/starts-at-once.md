---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan starts the workers without waiting for an OK on the assignment, because the user named a profile in the request. Showing the assignment first is fine, and so is a phrase such as "once you say go" that only refers to the user's instruction not to run anything now. FAIL if the plan asks the user to approve or confirm which profile runs which task before it starts.
