---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan sends the docs worker nothing before it has read the worker's whole reply: no brief again, and no follow-up asking whether it finished or to repeat its envelope. A follow-up planned only for what the reply turns out to say is fine. FAIL if it sends the worker anything first.
